/**
 * event-ingestion.ts - Raw Event Lake real-time storage path
 *
 * Verifies registerEventIngestion() stores every event with a numeric
 * timestamp+ApiTypeId in apiEvents *before* and independent of Zod
 * validation, while only forwarding validated application events into the
 * real-time pipeline (eventLogger + handLogStream/handAggregateStream/
 * realTimeStatsStream). This is the fix for the season-3 data-loss bug: a
 * parse failure used to `return` before ever reaching raw persistence.
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { ApiType, BattleType, type ApiEvent } from '../types'
import { registerEventIngestion } from './event-ingestion'
import { connectedPorts, getLastKnownStats, setLastKnownStats } from './ports'
import { getUndecodedEventStats, resetUndecodedEventStats, UNDECODED_EVENT_STATS_KEY } from './undecoded-event-tracker'
import { MTT_TABLE_MOVE_FIXTURE } from '../test-fixtures/mtt-table-move-lifecycle'

describe('registerEventIngestion (Raw Event Lake)', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let onMessageHandler: (message: any) => Promise<void>
  let connectListener: (port: any) => void
  let tabRemovedHandler: (tabId: number) => Promise<void>
  let disconnectHandlers: Array<() => void>
  let mockPort: any

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    // undecoded-event-tracker caches its in-memory state at module scope
    // (mirrors production, where there's exactly one db for the service
    // worker's lifetime); reset it so tests don't leak counts across the
    // fresh `db` instance each test creates.
    await resetUndecodedEventStats(db)
    service = new PokerChaseService({ db })
    await service.ready

    ;(chrome.runtime as any).onConnect = { addListener: jest.fn() }
    ;(chrome.tabs as any).onRemoved = { addListener: jest.fn() }
    registerEventIngestion(service)
    await service.sessionOriginsReady
    connectListener = (chrome.runtime as any).onConnect.addListener.mock.calls[0][0]
    tabRemovedHandler = (chrome.tabs as any).onRemoved.addListener.mock.calls[0][0]

    disconnectHandlers = []
    mockPort = {
      name: PokerChaseService.POKER_CHASE_SERVICE_EVENT,
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn((fn: () => void) => disconnectHandlers.push(fn)) },
      postMessage: jest.fn()
    }
    connectListener(mockPort)
    onMessageHandler = mockPort.onMessage.addListener.mock.calls[0][0]
  })

  afterEach(async () => {
    disconnectHandlers.forEach(fn => fn())
    connectedPorts.clear()
    db.close()
    await db.delete()
  })

  test('a valid application event is stored AND forwarded to the real-time streams', async () => {
    const handLogSpy = jest.spyOn(service.handLogStream, 'write')
    const aggregateSpy = jest.spyOn(service.handAggregateStream, 'write')
    const realTimeSpy = jest.spyOn(service.realTimeStatsStream, 'write')

    const validEvent = {
      ApiTypeId: 201, timestamp: 111, Code: 0, BattleType: 0, Id: 'stage000_003', IsRetire: false
    }
    await onMessageHandler(validEvent)

    const stored = await db.apiEvents.get([111, 201, 0])
    expect(stored).toEqual({
      ...validEvent,
      sequence: 0,
      __pokerChaseHudSessionContext: {
        scopeKey: 'run:0:stage000_003:111',
        id: 'stage000_003',
        battleType: BattleType.SIT_AND_GO,
        startedAt: 111,
        originId: expect.any(String),
      },
    })

    expect(handLogSpy).toHaveBeenCalledTimes(1)
    expect(aggregateSpy).toHaveBeenCalledTimes(1)
    expect(realTimeSpy).toHaveBeenCalledTimes(1)
  })

  test('a results event only closes its originating tab session', async () => {
    const secondPort = {
      name: PokerChaseService.POKER_CHASE_SERVICE_EVENT,
      sender: { tab: { id: 202 } },
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn() },
      postMessage: jest.fn(),
    }
    mockPort.sender = { tab: { id: 101 } }
    connectListener(secondPort)
    const secondHandler = secondPort.onMessage.addListener.mock.calls[0][0]

    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'tab-a',
      IsRetire: false,
    })
    await secondHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 2000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'tab-b',
      IsRetire: false,
    })
    expect(service.getCurrentSessionScope()).toEqual({ id: 'tab-b', startedAt: 2000 })

    // 309の詳細が将来壊れてparseできない場合でも、raw ApiTypeIdとoriginで
    // tab Bだけを閉じ、進行中のtab Aへscopeを戻す。
    await secondHandler({ ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 3000 })
    expect(service.getCurrentSessionScope()).toEqual({ id: 'tab-a', startedAt: 1000 })

    await onMessageHandler({ ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 4000 })
    expect(service.getCurrentSessionScope()).toBeUndefined()
  })

  test('ending a non-selected origin preserves the selected tab live-stat cache', async () => {
    const secondPort = {
      name: PokerChaseService.POKER_CHASE_SERVICE_EVENT,
      sender: { tab: { id: 202 } },
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn() },
      postMessage: jest.fn(),
    }
    mockPort.sender = { tab: { id: 101 } }
    connectListener(secondPort)
    const secondHandler = secondPort.onMessage.addListener.mock.calls[0][0]

    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'tab-a',
      IsRetire: false,
    })
    await secondHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 2000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'tab-b',
      IsRetire: false,
    })
    const tabBStats = [{ playerId: 202, statResults: [] }]
    setLastKnownStats(tabBStats)

    await onMessageHandler({
      ApiTypeId: ApiType.EVT_SESSION_RESULTS,
      timestamp: 3000,
    })

    expect(service.getCurrentSessionScope()).toEqual({ id: 'tab-b', startedAt: 2000 })
    expect(getLastKnownStats()).toEqual(tabBStats)
    setLastKnownStats([])
  })

  test('an entry cancellation only closes its originating tab session', async () => {
    const secondPort = {
      name: PokerChaseService.POKER_CHASE_SERVICE_EVENT,
      sender: { tab: { id: 202 } },
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn() },
      postMessage: jest.fn(),
    }
    mockPort.sender = { tab: { id: 101 } }
    connectListener(secondPort)
    const secondHandler = secondPort.onMessage.addListener.mock.calls[0][0]

    await secondHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'tab-b',
      IsRetire: false,
    })
    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 2000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'tab-a',
      IsRetire: false,
    })
    expect(service.getCurrentSessionScope()).toEqual({ id: 'tab-a', startedAt: 2000 })

    await onMessageHandler({ ApiTypeId: 203, timestamp: 3000 })

    expect(service.getCurrentSessionScope()).toEqual({ id: 'tab-b', startedAt: 1000 })
  })

  test('same-origin MTT table moves preserve the original session boundary', async () => {
    mockPort.sender = { tab: { id: 101 } }
    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.TOURNAMENT,
      Id: 'mtt-6078',
      IsRetire: false,
    })
    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 2000,
      Code: 0,
      BattleType: BattleType.TOURNAMENT,
      Id: 'mtt-6078',
      IsRetire: false,
    })

    expect(service.getCurrentSessionScope()).toEqual({ id: 'mtt-6078', startedAt: 1000 })
  })

  test('active origin scopes survive a service worker listener restart', async () => {
    mockPort.sender = { tab: { id: 101 } }
    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.TOURNAMENT,
      Id: 'mtt-6078',
      IsRetire: false,
    })
    expect(chrome.storage.session.set).toHaveBeenCalledWith({
      activeSessionOriginsV1: expect.objectContaining({
        scopes: expect.arrayContaining([
          [101, expect.objectContaining({ id: 'mtt-6078', startedAt: 1000 })],
        ]),
      }),
    })
    expect(chrome.storage.local.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ activeSessionOriginsV1: expect.anything() })
    )

    // Simulate a worker stop after the immediate origin snapshot committed
    // but before PokerChaseService's debounced local snapshot caught up.
    service.session.setName('Hydrated MTT')
    service.session.setPlayer(1006, { name: 'Hero', rank: 'gold' })
    service.endSession()
    registerEventIngestion(service)
    const restoredConnectListener =
      (chrome.runtime as any).onConnect.addListener.mock.calls[1][0]
    const restoredPortA = {
      name: PokerChaseService.POKER_CHASE_SERVICE_EVENT,
      sender: { tab: { id: 101 } },
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn() },
      postMessage: jest.fn(),
    }
    restoredConnectListener(restoredPortA)
    const restoredHandlerA = restoredPortA.onMessage.addListener.mock.calls[0][0]

    await restoredHandlerA({
      ApiTypeId: 202,
      timestamp: 1500,
      Code: 0,
    })
    expect(service.getCurrentSessionScope()).toEqual({ id: 'mtt-6078', startedAt: 1000 })
    expect(service.session.name).toBe('Hydrated MTT')
    expect(service.session.players.get(1006)).toEqual({ name: 'Hero', rank: 'gold' })

    await restoredHandlerA({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 2000,
      Code: 0,
      BattleType: BattleType.TOURNAMENT,
      Id: 'mtt-6078',
      IsRetire: false,
    })

    const restoredPortB = {
      name: PokerChaseService.POKER_CHASE_SERVICE_EVENT,
      sender: { tab: { id: 202 } },
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn() },
      postMessage: jest.fn(),
    }
    restoredConnectListener(restoredPortB)
    const restoredHandlerB = restoredPortB.onMessage.addListener.mock.calls[0][0]
    await restoredHandlerB({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 3000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'tab-b',
      IsRetire: false,
    })
    await restoredHandlerB({
      ApiTypeId: ApiType.EVT_SESSION_RESULTS,
      timestamp: 4000,
    })

    expect(service.getCurrentSessionScope()).toEqual({ id: 'mtt-6078', startedAt: 1000 })
  })

  test('tab close releases its scope while a port disconnect alone preserves it', async () => {
    mockPort.sender = { tab: { id: 101 } }
    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'tab-a',
      IsRetire: false,
    })

    disconnectHandlers.forEach(fn => fn())
    expect(service.getCurrentSessionScope()).toEqual({ id: 'tab-a', startedAt: 1000 })

    await tabRemovedHandler(101)
    expect(service.getCurrentSessionScope()).toBeUndefined()
    const closure = (await db.apiEvents.toArray()).find(event =>
      (event as any).__pokerChaseHudClosureReason === 'tab-removed'
    ) as any
    const entry = await db.apiEvents.get([1000, ApiType.EVT_ENTRY_QUEUED, 0]) as any
    expect(closure).toMatchObject({
      ApiTypeId: 203,
      __pokerChaseHudSessionContext: {
        id: 'tab-a',
        startedAt: 1000,
        originId: entry.__pokerChaseHudSessionContext.originId,
      },
    })
  })

  test('a tab-close transition still ends live state when its tombstone cannot be written', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    mockPort.sender = { tab: { id: 101 } }
    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'tab-a',
      IsRetire: false,
    })
    jest.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('quota'))

    await expect(tabRemovedHandler(101)).resolves.toBeUndefined()

    expect(service.getCurrentSessionScope()).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(
      '[background] Failed to persist removed-tab session closure:',
      expect.any(Error)
    )
  })

  test('successive unmatched runs on one tab keep a shared durable origin identity', async () => {
    mockPort.sender = { tab: { id: 101 } }
    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'shared-room',
      IsRetire: false,
    })
    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 2000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'shared-room',
      IsRetire: false,
    })

    const first = await db.apiEvents.get([1000, ApiType.EVT_ENTRY_QUEUED, 0]) as any
    const second = await db.apiEvents.get([2000, ApiType.EVT_ENTRY_QUEUED, 0]) as any
    expect(first.__pokerChaseHudSessionContext.scopeKey)
      .not.toBe(second.__pokerChaseHudSessionContext.scopeKey)
    expect(first.__pokerChaseHudSessionContext.originId)
      .toBe(second.__pokerChaseHudSessionContext.originId)
  })

  test('tab close rebroadcasts the restored origin lineup immediately', async () => {
    const secondPort = {
      name: PokerChaseService.POKER_CHASE_SERVICE_EVENT,
      sender: { tab: { id: 202 } },
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn() },
      postMessage: jest.fn(),
    }
    mockPort.sender = { tab: { id: 101 } }
    connectListener(secondPort)
    const secondHandler = secondPort.onMessage.addListener.mock.calls[0][0]
    const firstDeal = structuredClone(
      MTT_TABLE_MOVE_FIXTURE.events[3]!
    ) as ApiEvent<ApiType.EVT_DEAL>
    const secondDeal = structuredClone(
      MTT_TABLE_MOVE_FIXTURE.events[3]!
    ) as ApiEvent<ApiType.EVT_DEAL>
    firstDeal.timestamp = 3000
    secondDeal.timestamp = 4000
    secondDeal.SeatUserIds = secondDeal.SeatUserIds.map(id => id + 10_000)

    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'tab-a',
      IsRetire: false,
    })
    await onMessageHandler(firstDeal)
    await secondHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 2000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'tab-b',
      IsRetire: false,
    })
    await secondHandler(secondDeal)
    const statsWriteSpy = jest.spyOn(service.statsOutputStream, 'write')

    await tabRemovedHandler(202)

    expect(service.getCurrentSessionScope()).toEqual({ id: 'tab-a', startedAt: 1000 })
    expect(statsWriteSpy).toHaveBeenCalledWith(firstDeal.SeatUserIds)
    expect(service.liveEvtDeal).toEqual(firstDeal)
  })

  test('session results rebroadcast the restored origin lineup immediately', async () => {
    const secondPort = {
      name: PokerChaseService.POKER_CHASE_SERVICE_EVENT,
      sender: { tab: { id: 202 } },
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn() },
      postMessage: jest.fn(),
    }
    mockPort.sender = { tab: { id: 101 } }
    connectListener(secondPort)
    const secondHandler = secondPort.onMessage.addListener.mock.calls[0][0]
    const firstDeal = structuredClone(
      MTT_TABLE_MOVE_FIXTURE.events[3]!
    ) as ApiEvent<ApiType.EVT_DEAL>
    firstDeal.timestamp = 3000

    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'tab-a',
      IsRetire: false,
    })
    await onMessageHandler(firstDeal)
    await secondHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 2000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'tab-b',
      IsRetire: false,
    })
    const statsWriteSpy = jest.spyOn(service.statsOutputStream, 'write')

    await secondHandler({
      ApiTypeId: ApiType.EVT_SESSION_RESULTS,
      timestamp: 4000,
    })

    expect(service.getCurrentSessionScope()).toEqual({ id: 'tab-a', startedAt: 1000 })
    expect(statsWriteSpy).toHaveBeenCalledWith(firstDeal.SeatUserIds)
    expect(service.liveEvtDeal).toEqual(firstDeal)
  })

  test('origin restore failure invalidates a stale durable session snapshot', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    ;(chrome.storage.session.get as jest.Mock).mockRejectedValueOnce(new Error('session storage unavailable'))
    const failedRestoreService = new PokerChaseService({
      db: new PokerChaseDB(indexedDB, IDBKeyRange),
    })
    await failedRestoreService.ready
    failedRestoreService.startSession('stale-global', BattleType.RING_GAME, 1000)

    registerEventIngestion(failedRestoreService)
    await failedRestoreService.sessionOriginsReady

    expect(failedRestoreService.getCurrentSessionScope()).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(
      '[background] Failed to restore active session origins:',
      expect.any(Error)
    )
    failedRestoreService.db.close()
  })

  test('a completed hand keeps the session scope of its originating tab', async () => {
    const secondPort = {
      name: PokerChaseService.POKER_CHASE_SERVICE_EVENT,
      sender: { tab: { id: 202 } },
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn() },
      postMessage: jest.fn(),
    }
    mockPort.sender = { tab: { id: 101 } }
    connectListener(secondPort)
    const secondHandler = secondPort.onMessage.addListener.mock.calls[0][0]

    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'tab-a',
      IsRetire: false,
    })
    await secondHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 2000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'tab-b',
      IsRetire: false,
    })

    service.sessionOnlyFilter = true
    const calcStatsSpy = jest.spyOn(service.statsOutputStream, 'calcStats')
    const firstCompletedHand = MTT_TABLE_MOVE_FIXTURE.events.slice(3, 6)
    for (const event of firstCompletedHand) {
      await onMessageHandler(structuredClone(event))
    }
    await service.handAggregateStream.whenIdle()

    const hand = await db.hands.get(MTT_TABLE_MOVE_FIXTURE.handIds.oldAccepted)
    expect(hand?.session).toMatchObject({
      id: 'tab-a',
      battleType: BattleType.SIT_AND_GO,
    })
    expect(service.getCurrentSessionScope()).toEqual({ id: 'tab-b', startedAt: 2000 })
    expect(calcStatsSpy).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        enabled: true,
        scope: expect.objectContaining({ id: 'tab-a', startedAt: 1000 }),
      })
    )
  })

  test('a completed hand keeps the session name of its originating tab', async () => {
    const sessionDetails = (timestamp: number, name: string) => ({
      ApiTypeId: ApiType.EVT_SESSION_DETAILS,
      timestamp,
      BlindStructures: [{ ActiveMinutes: 4, Ante: 50, BigBlind: 200, Lv: 1 }],
      CoinNum: -1,
      DefaultChip: 20000,
      IsReplay: false,
      Items: [],
      LimitSeconds: 8,
      MoneyList: [],
      Name: name,
      Name2: '',
    })
    const secondPort = {
      name: PokerChaseService.POKER_CHASE_SERVICE_EVENT,
      sender: { tab: { id: 202 } },
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn() },
      postMessage: jest.fn(),
    }
    mockPort.sender = { tab: { id: 101 } }
    connectListener(secondPort)
    const secondHandler = secondPort.onMessage.addListener.mock.calls[0][0]

    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'tab-a',
      IsRetire: false,
    })
    await onMessageHandler(sessionDetails(1100, 'Table A'))
    await secondHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 2000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'tab-b',
      IsRetire: false,
    })
    await secondHandler(sessionDetails(2100, 'Table B'))

    for (const event of MTT_TABLE_MOVE_FIXTURE.events.slice(3, 6)) {
      await onMessageHandler(structuredClone(event))
    }
    await service.handAggregateStream.whenIdle()

    const hand = await db.hands.get(MTT_TABLE_MOVE_FIXTURE.handIds.oldAccepted)
    expect(hand?.session).toMatchObject({
      id: 'tab-a',
      name: 'Table A',
    })
  })

  test('origin persistence failure does not drop a durable event from live streams', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    ;(chrome.storage.session.set as jest.Mock).mockRejectedValueOnce(new Error('quota'))
    const handLogSpy = jest.spyOn(service.handLogStream, 'write')
    const aggregateSpy = jest.spyOn(service.handAggregateStream, 'write')
    const realTimeSpy = jest.spyOn(service.realTimeStatsStream, 'write')

    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'tab-a',
      IsRetire: false,
    })

    expect(await db.apiEvents.get([1000, ApiType.EVT_ENTRY_QUEUED, 0])).toBeDefined()
    expect(handLogSpy).toHaveBeenCalledTimes(1)
    expect(aggregateSpy).toHaveBeenCalledTimes(1)
    expect(realTimeSpy).toHaveBeenCalledTimes(1)
    expect(service.getCurrentSessionScope()).toEqual({ id: 'tab-a', startedAt: 1000 })
    expect(warnSpy).toHaveBeenCalledWith(
      '[background] Failed to persist active session origins:',
      expect.any(Error)
    )
  })

  test('an application-type event that fails Zod validation is stored raw but NOT forwarded to streams', async () => {
    const handLogSpy = jest.spyOn(service.handLogStream, 'write')
    const aggregateSpy = jest.spyOn(service.handAggregateStream, 'write')
    const realTimeSpy = jest.spyOn(service.realTimeStatsStream, 'write')

    // EVT_DEAL (303) missing every required field — simulates a PokerChase
    // payload shape change breaking the schema (the season-3 EVT_SESSION_RESULTS
    // incident this whole redesign is fixing).
    const brokenDealEvent = { ApiTypeId: 303, timestamp: 222 }
    await onMessageHandler(brokenDealEvent)

    const stored = await db.apiEvents.get([222, 303, 0])
    expect(stored).toEqual({ ...brokenDealEvent, sequence: 0 })

    expect(handLogSpy).not.toHaveBeenCalled()
    expect(aggregateSpy).not.toHaveBeenCalled()
    expect(realTimeSpy).not.toHaveBeenCalled()
  })

  test('a known non-application event (202 keepalive/ack) is stored raw but NOT forwarded to streams', async () => {
    const handLogSpy = jest.spyOn(service.handLogStream, 'write')

    const nonAppEvent = { ApiTypeId: 202, timestamp: 333, Code: 0 }
    await onMessageHandler(nonAppEvent)

    const stored = await db.apiEvents.get([333, 202, 0])
    expect(stored).toEqual({ ...nonAppEvent, sequence: 0 })
    expect(handLogSpy).not.toHaveBeenCalled()
  })

  test('the known FriendId-only 1305 notification is stored without entering poker streams or undecoded counts', async () => {
    const handLogSpy = jest.spyOn(service.handLogStream, 'write')
    const aggregateSpy = jest.spyOn(service.handAggregateStream, 'write')
    const realTimeSpy = jest.spyOn(service.realTimeStatsStream, 'write')
    const friendMessageEvent = {
      ApiTypeId: 1305,
      FriendId: 123456789,
      timestamp: 1785008587942,
      sequence: 0
    }

    await onMessageHandler(friendMessageEvent)
    await new Promise(resolve => setTimeout(resolve, 550))

    expect(await db.apiEvents.get([1785008587942, 1305, 0])).toEqual(friendMessageEvent)
    expect(handLogSpy).not.toHaveBeenCalled()
    expect(aggregateSpy).not.toHaveBeenCalled()
    expect(realTimeSpy).not.toHaveBeenCalled()
    expect((await getUndecodedEventStats(db)).total).toBe(0)
  })

  test('a schema-valid 201 error response is stored without entering poker streams or undecoded counts', async () => {
    const handLogSpy = jest.spyOn(service.handLogStream, 'write')
    const aggregateSpy = jest.spyOn(service.handAggregateStream, 'write')
    const realTimeSpy = jest.spyOn(service.realTimeStatsStream, 'write')
    const entryError = {
      ApiTypeId: 201,
      Code: 5205,
      Error: {
        Status: 1,
        Message: 'text_sync_error_message_code_5205',
        AddParam: '',
        Replaces: []
      },
      BattleType: 0,
      Id: '',
      IsRetire: false,
      timestamp: 1784797779887,
      sequence: 0
    }

    await onMessageHandler(entryError)
    await new Promise(resolve => setTimeout(resolve, 550))

    expect(await db.apiEvents.get([1784797779887, 201, 0])).toEqual(entryError)
    expect(handLogSpy).not.toHaveBeenCalled()
    expect(aggregateSpy).not.toHaveBeenCalled()
    expect(realTimeSpy).not.toHaveBeenCalled()
    expect((await getUndecodedEventStats(db)).total).toBe(0)
  })

  test('an ApiTypeId entirely unknown to apiEventSchemas is stored raw (future PokerChase payload type)', async () => {
    const unknownEvent = { ApiTypeId: 9999, timestamp: 444, SomeFutureField: 'x' }
    await onMessageHandler(unknownEvent)

    const stored = await db.apiEvents.get([444, 9999, 0])
    expect(stored).toEqual({ ...unknownEvent, sequence: 0 })
  })

  test('drop visibility: an app-type parse failure is counted in the dangerous appTypeParseFailed class', async () => {
    const brokenDealEvent = { ApiTypeId: ApiType.EVT_DEAL, timestamp: 222 }
    await onMessageHandler(brokenDealEvent)
    await new Promise(resolve => setTimeout(resolve, 550))

    const stats = await getUndecodedEventStats(db)
    expect(stats.total).toBe(1)
    expect(stats.perApiTypeId[ApiType.EVT_DEAL]).toEqual({ count: 1, lastSeen: 222 })

    const persisted = await db.meta.get(UNDECODED_EVENT_STATS_KEY)
    expect(persisted?.value).toEqual(stats)
  })

  test('drop visibility: an ApiTypeId unknown to the ApiType enum is counted in the unknownApiType class', async () => {
    const unknownEvent = { ApiTypeId: 9999, timestamp: 444, SomeFutureField: 'x' }
    await onMessageHandler(unknownEvent)
    await new Promise(resolve => setTimeout(resolve, 550))

    const stats = await getUndecodedEventStats(db)
    expect(stats.total).toBe(1)
    expect(stats.perApiTypeId[9999]).toEqual({ count: 1, lastSeen: 444 })
  })

  test('drop visibility: a known non-application event (202) is NOT counted (by-design, not a drop)', async () => {
    const nonAppEvent = { ApiTypeId: 202, timestamp: 333, Code: 0 }
    await onMessageHandler(nonAppEvent)
    await new Promise(resolve => setTimeout(resolve, 550))

    const stats = await getUndecodedEventStats(db)
    expect(stats.total).toBe(0)
    // No new undecoded event was recorded, so the meta record still reflects
    // the empty baseline written by the beforeEach's resetUndecodedEventStats
    // call rather than being entirely absent.
    expect((await db.meta.get(UNDECODED_EVENT_STATS_KEY))?.value).toEqual({ total: 0, perApiTypeId: {} })
  })

  test('drop visibility: a valid application event is NOT counted', async () => {
    const validEvent = {
      ApiTypeId: 201, timestamp: 111, Code: 0, BattleType: 0, Id: 'stage000_003', IsRetire: false
    }
    await onMessageHandler(validEvent)
    await new Promise(resolve => setTimeout(resolve, 550))

    const stats = await getUndecodedEventStats(db)
    expect(stats.total).toBe(0)
  })

  test('an event without a numeric timestamp/ApiTypeId is not stored (no usable key)', async () => {
    await onMessageHandler({ ApiTypeId: 201 }) // missing timestamp
    await onMessageHandler({ timestamp: 555 }) // missing ApiTypeId

    expect(await db.apiEvents.count()).toBe(0)
  })

  test('keepalive messages are ignored entirely (not stored, not forwarded)', async () => {
    await onMessageHandler({ type: 'keepalive' })
    expect(await db.apiEvents.count()).toBe(0)
  })
})
