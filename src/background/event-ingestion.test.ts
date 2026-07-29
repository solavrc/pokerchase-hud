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
import {
  registerEventIngestion,
  SESSION_ORIGIN_TOKEN_KEY,
} from './event-ingestion'
import { connectedPorts, getLastKnownStats, setLastKnownStats } from './ports'
import {
  getUndecodedEventStats,
  INVALID_API_TYPE_ID_BUCKET,
  resetUndecodedEventStats,
  UNDECODED_EVENT_STATS_KEY
} from './undecoded-event-tracker'
import { MTT_TABLE_MOVE_FIXTURE } from '../test-fixtures/mtt-table-move-lifecycle'
import { setOperationState } from './operation-state'
import { captureSchemaValidationFailure } from '../observability/sentry'
import { isSafeToUpdate } from './update-manager'
import { orderApiEventsForReplay } from '../utils/api-event-key'
import {
  SYNC_RESCAN_BACKFILL_DONE_META_KEY,
  SYNC_RESCAN_FLOOR_META_KEY,
} from '../constants/sync'
import { getEventSessionScope } from '../utils/session-event-scope'

jest.mock('../observability/sentry', () => ({
  captureHandledException: jest.fn(),
  captureSchemaValidationFailure: jest.fn()
}))

describe('registerEventIngestion (Raw Event Lake)', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let onMessageHandler: (message: any) => Promise<void>
  let connectListener: (port: any) => void
  let tabRemovedHandler: (tabId: number) => Promise<void>
  let tabUpdatedHandler: (
    tabId: number,
    changeInfo: { url?: string }
  ) => Promise<void> | void
  let disconnectHandlers: Array<() => void>
  let mockPort: any

  const entry = (
    timestamp: number,
    id: string,
    battleType = BattleType.RING_GAME
  ) => ({
    ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
    timestamp,
    Code: 0,
    BattleType: battleType,
    Id: id,
    IsRetire: false,
  })
  const sessionResults = (timestamp: number) => ({
    ApiTypeId: ApiType.EVT_SESSION_RESULTS,
    timestamp,
  })
  const connectTab = (tabId: number) => {
    const port = {
      name: PokerChaseService.POKER_CHASE_SERVICE_EVENT,
      sender: { tab: { id: tabId } },
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn() },
      postMessage: jest.fn(),
    }
    connectListener(port)
    return port.onMessage.addListener.mock.calls[0][0] as (
      message: any
    ) => Promise<void>
  }
  const dealAt = (timestamp: number, playerIdOffset = 0) => {
    const deal = structuredClone(
      MTT_TABLE_MOVE_FIXTURE.events[3]!
    ) as ApiEvent<ApiType.EVT_DEAL>
    deal.timestamp = timestamp
    if (playerIdOffset !== 0) {
      deal.SeatUserIds = deal.SeatUserIds.map(id => id + playerIdOffset)
    }
    return deal
  }
  const waitForPresentationStreams = () => Promise.all([
    service.handLogStream.whenIdle(),
    service.realTimeStatsStream.whenIdle(),
  ])

  beforeEach(async () => {
    setOperationState({ type: 'idle' })
    jest.mocked(captureSchemaValidationFailure).mockClear()
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
    ;(chrome.tabs as any).onUpdated = { addListener: jest.fn() }
    registerEventIngestion(service)
    await service.sessionOriginsReady
    connectListener = (chrome.runtime as any).onConnect.addListener.mock.calls[0][0]
    tabRemovedHandler = (chrome.tabs as any).onRemoved.addListener.mock.calls[0][0]
    tabUpdatedHandler = (chrome.tabs as any).onUpdated.addListener.mock.calls[0][0]

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
        scopeKey: expect.stringMatching(/^run:0:stage000_003:111:/),
        id: 'stage000_003',
        battleType: BattleType.SIT_AND_GO,
        startedAt: 111,
        originId: expect.any(String),
        authorityGeneration: 1,
      },
    })

    expect(handLogSpy).toHaveBeenCalledTimes(1)
    expect(aggregateSpy).toHaveBeenCalledTimes(1)
    expect(realTimeSpy).toHaveBeenCalledTimes(1)
  })

  test('publishes the browser-session token only after its empty local snapshot is durable', () => {
    const localSet = chrome.storage.local.set as jest.Mock
    const sessionSet = chrome.storage.session.set as jest.Mock
    const snapshotCallIndex = localSet.mock.calls.findIndex(([value]) =>
      value.activeSessionOriginsV1?.scopes?.length === 0
    )
    const tokenCallIndex = sessionSet.mock.calls.findIndex(([value]) =>
      typeof value[SESSION_ORIGIN_TOKEN_KEY] === 'string'
    )

    expect(snapshotCallIndex).toBeGreaterThanOrEqual(0)
    expect(tokenCallIndex).toBeGreaterThanOrEqual(0)
    expect(localSet.mock.invocationCallOrder[snapshotCallIndex])
      .toBeLessThan(sessionSet.mock.invocationCallOrder[tokenCallIndex]!)
    expect(localSet.mock.calls[snapshotCallIndex]![0].activeSessionOriginsV1)
      .toMatchObject({
        browserSessionToken:
          sessionSet.mock.calls[tokenCallIndex]![0][SESSION_ORIGIN_TOKEN_KEY],
        scopes: [],
        currentTabId: null,
      })
  })

  test('a stored 201 with a widened raw shape starts the scope before schema validation', async () => {
    const invalidEntry = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 211,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'raw-first-session',
      // IsRetire is deliberately absent so the current Zod schema rejects it.
    }
    await onMessageHandler(invalidEntry)

    const deal = structuredClone(MTT_TABLE_MOVE_FIXTURE.events[3]!)
    deal.timestamp = 212
    await onMessageHandler(deal)

    const storedEntry = await db.apiEvents.get([211, ApiType.EVT_ENTRY_QUEUED, 0]) as any
    const storedDeal = await db.apiEvents.get([212, ApiType.EVT_DEAL, 0]) as any
    expect(storedEntry.__pokerChaseHudSessionContext).toMatchObject({
      id: 'raw-first-session',
      startedAt: 211,
    })
    expect(storedDeal.__pokerChaseHudSessionContext).toEqual(
      storedEntry.__pokerChaseHudSessionContext
    )
  })

  test('same-millisecond reused session ids receive origin-specific scope keys', async () => {
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
    const entry = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'shared-room',
      IsRetire: false,
    }

    await onMessageHandler(structuredClone(entry))
    await secondHandler(structuredClone(entry))

    const contexts = (await db.apiEvents.toArray())
      .filter(event =>
        event.timestamp === entry.timestamp &&
        event.ApiTypeId === entry.ApiTypeId
      )
      .map(event => (event as any).__pokerChaseHudSessionContext)
    expect(contexts).toHaveLength(2)
    expect(contexts[0].originId).not.toBe(contexts[1].originId)
    expect(contexts[0].scopeKey).not.toBe(contexts[1].scopeKey)
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
    const firstCompletedHand = MTT_TABLE_MOVE_FIXTURE.events
      .slice(3, 6)
      .map(event => structuredClone(event))
    await onMessageHandler(firstCompletedHand[0])
    await waitForPresentationStreams()
    const handLogOutput = jest.fn()
    const realtimeOutput = jest.fn()
    service.handLogStream.on('data', handLogOutput)
    service.realTimeStatsStream.on('data', realtimeOutput)
    await secondHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 2000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'tab-b',
      IsRetire: false,
    })
    expect(service.getCurrentSessionScope()).toEqual({ id: 'tab-b', startedAt: 2000 })
    expect(handLogOutput).toHaveBeenCalledWith({ type: 'removeIncomplete' })
    expect(realtimeOutput).toHaveBeenCalledWith(expect.objectContaining({
      stats: { heroStats: {}, playerStats: {} },
    }))

    for (const event of firstCompletedHand.slice(1)) {
      await onMessageHandler(event)
    }
    await service.handAggregateStream.whenIdle()
    expect(await db.hands.get(MTT_TABLE_MOVE_FIXTURE.handIds.oldAccepted))
      .toBeDefined()

    await secondHandler(dealAt(2100, 10_000))
    await waitForPresentationStreams()
    handLogOutput.mockClear()
    realtimeOutput.mockClear()

    // 309の詳細が将来壊れてparseできない場合でも、raw ApiTypeIdとoriginで
    // tab Bだけを閉じる。古いtab Aは保持済みhandの帰属先に留まり、
    // authoritative sessionへは戻さない。
    await secondHandler({ ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 3000 })
    expect(service.getCurrentSessionScope()).toBeUndefined()
    expect(isSafeToUpdate()).toBe(true)
    expect(handLogOutput).toHaveBeenCalledWith({ type: 'removeIncomplete' })
    expect(realtimeOutput).toHaveBeenCalledWith(expect.objectContaining({
      stats: { heroStats: {}, playerStats: {} },
    }))

    await onMessageHandler({ ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 4000 })
    expect(service.getCurrentSessionScope()).toBeUndefined()
    expect(isSafeToUpdate()).toBe(true)
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
    await secondHandler(dealAt(2100, 10_000))
    await waitForPresentationStreams()
    const tabBStats = [{ playerId: 202, statResults: [] }]
    const handLogOutput = jest.fn()
    const realtimeOutput = jest.fn()
    service.handLogStream.on('data', handLogOutput)
    service.realTimeStatsStream.on('data', realtimeOutput)
    setLastKnownStats(tabBStats)

    await onMessageHandler({
      ApiTypeId: ApiType.EVT_SESSION_RESULTS,
      timestamp: 3000,
    })

    expect(service.getCurrentSessionScope()).toEqual({ id: 'tab-b', startedAt: 2000 })
    expect(getLastKnownStats()).toEqual(tabBStats)
    expect(handLogOutput).not.toHaveBeenCalled()
    expect(realtimeOutput).not.toHaveBeenCalled()
    expect((service.handLogStream as any).scopedStates.size).toBe(1)
    expect((service.realTimeStatsStream as any).scopedStreams.size).toBe(1)
    setLastKnownStats([])
  })

  test('a delayed older-origin entry cannot reclaim authority from the newest origin', async () => {
    const tabA = connectTab(101)
    const tabB = connectTab(202)
    await tabA(entry(2000, 'old-tab'))
    await tabB(entry(1000, 'new-tab'))

    // This frame was queued by the old logged-out tab before the newer login
    // became authoritative, then reached the worker late.
    await tabA(entry(2500, 'old-tab-delayed'))

    expect(service.getCurrentSessionScope()).toEqual({ id: 'new-tab', startedAt: 1000 })
    const first = await db.apiEvents.get([2000, ApiType.EVT_ENTRY_QUEUED, 0]) as any
    const current = await db.apiEvents.get([1000, ApiType.EVT_ENTRY_QUEUED, 0]) as any
    const stored = await db.apiEvents.get([2500, ApiType.EVT_ENTRY_QUEUED, 0]) as any
    expect(stored.__pokerChaseHudSessionContext).toMatchObject({
      id: 'old-tab-delayed',
      startedAt: 2500,
      authorityGeneration: 1,
    })
    expect(first.__pokerChaseHudSessionContext.authorityGeneration).toBe(1)
    expect(current.__pokerChaseHudSessionContext.authorityGeneration).toBe(2)
  })

  test('a later-arriving new origin wins an equal-millisecond entry tie', async () => {
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
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'tab-b',
      IsRetire: false,
    })

    expect(service.getCurrentSessionScope()).toEqual({
      id: 'tab-b',
      startedAt: 1000,
    })
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

    expect(service.getCurrentSessionScope()).toBeUndefined()
    expect(isSafeToUpdate()).toBe(true)
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
    const tokenWrite = (chrome.storage.session.set as jest.Mock).mock.calls
      .map(([value]) => value)
      .find(value => typeof value[SESSION_ORIGIN_TOKEN_KEY] === 'string')
    expect(tokenWrite).toBeDefined()
    const browserSessionToken = tokenWrite[SESSION_ORIGIN_TOKEN_KEY]
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      activeSessionOriginsV1: expect.objectContaining({
        browserSessionToken,
        scopes: expect.arrayContaining([
          [101, expect.objectContaining({ id: 'mtt-6078', startedAt: 1000 })],
        ]),
      }),
    })

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

    expect(service.getCurrentSessionScope()).toBeUndefined()
  })

  test('legacy worker snapshots migrate the selected origin above retained scopes', async () => {
    const tabA = connectTab(101)
    const tabB = connectTab(202)
    await tabA(entry(2000, 'table-a', BattleType.TOURNAMENT))
    await tabB(entry(1000, 'table-b'))

    const legacySnapshot = structuredClone(
      (await chrome.storage.local.get('activeSessionOriginsV1'))
        .activeSessionOriginsV1
    ) as any
    delete legacySnapshot.authorityGeneration
    delete legacySnapshot.lastAuthoritativeOriginId
    legacySnapshot.authoritativeStartedAt = 1000
    for (const [, scope] of legacySnapshot.scopes) {
      delete scope.authorityGeneration
    }
    await chrome.storage.local.set({
      activeSessionOriginsV1: legacySnapshot,
    })
    service.endSession()

    registerEventIngestion(service)
    await service.sessionOriginsReady
    expect(service.getCurrentSessionScope()).toEqual({
      id: 'table-b',
      startedAt: 1000,
    })

    const restoredConnectListener =
      (chrome.runtime as any).onConnect.addListener.mock.calls[1][0]
    connectListener = restoredConnectListener
    const restoredTabA = connectTab(101)
    const restoredTabB = connectTab(202)
    await restoredTabB(sessionResults(1100))
    await restoredTabA(entry(3000, 'table-a', BattleType.TOURNAMENT))

    expect(service.getCurrentSessionScope()).toBeUndefined()
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
    expect(isSafeToUpdate()).toBe(true)
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

  test('cross-origin tab navigation closes the scope while same-origin navigation preserves it', async () => {
    const gamePort = {
      name: PokerChaseService.POKER_CHASE_SERVICE_EVENT,
      sender: {
        url: 'https://game.poker-chase.com/play/index.html',
        tab: { id: 202, url: 'https://game.poker-chase.com/play/index.html' },
      },
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn() },
      postMessage: jest.fn(),
    }
    connectListener(gamePort)
    const gameHandler = gamePort.onMessage.addListener.mock.calls[0][0]
    await gameHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'navigating-tab',
      IsRetire: false,
    })

    tabUpdatedHandler(202, {
      url: 'https://game.poker-chase.com/play/another-table',
    })
    expect(isSafeToUpdate()).toBe(false)

    await tabUpdatedHandler(202, { url: 'https://example.com/' })
    expect(isSafeToUpdate()).toBe(true)
    const closure = (await db.apiEvents.toArray()).find(event =>
      (event as any).__pokerChaseHudClosureReason === 'tab-navigated'
    ) as any
    expect(closure.__pokerChaseHudSessionContext).toMatchObject({
      id: 'navigating-tab',
    })
  })

  test('a later clock-backward live row atomically rewinds cloud scan floors past a synthetic closure', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(500)
    try {
      mockPort.sender = { tab: { id: 101 } }
      await onMessageHandler({
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        timestamp: 1000,
        Code: 0,
        BattleType: BattleType.RING_GAME,
        Id: 'tab-a',
        IsRetire: false,
      })
      await db.meta.put({
        id: `${SYNC_RESCAN_BACKFILL_DONE_META_KEY}:user-a`,
        value: true,
        updatedAt: 1,
      })

      await tabRemovedHandler(101)

      const rawEvents = await db.apiEvents.toArray() as any[]
      const closure = rawEvents.find(event =>
        event.__pokerChaseHudClosureReason === 'tab-removed'
      )
      expect(closure.timestamp).toBe(1001)
      expect(orderApiEventsForReplay(rawEvents)
        .filter(event => event.ApiTypeId === ApiType.EVT_ENTRY_QUEUED || event.ApiTypeId === 203)
        .map(event => event.ApiTypeId)).toEqual([
          ApiType.EVT_ENTRY_QUEUED,
          203,
        ])
      expect(await db.meta.get(
        `${SYNC_RESCAN_FLOOR_META_KEY}:user-a`
      )).toBeUndefined()

      // A sync may now upload the synthetic 1001 tombstone. If the device
      // clock remains behind, the next real event still lands below that
      // watermark. Its raw row and protective floor must commit atomically.
      await onMessageHandler({
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        timestamp: 600,
        Code: 0,
        BattleType: BattleType.RING_GAME,
        Id: 'clock-backward-tab',
        IsRetire: false,
      })
      expect((await db.meta.get(
        `${SYNC_RESCAN_FLOOR_META_KEY}:user-a`
      ))?.value).toBe(600)
    } finally {
      nowSpy.mockRestore()
    }
  })

  test('a failed clock-backward floor write rolls back the raw row before live processing', async () => {
    await db.apiEvents.put({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      sequence: 0,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'already-stored',
      IsRetire: false,
    })
    await db.meta.put({
      id: `${SYNC_RESCAN_BACKFILL_DONE_META_KEY}:user-a`,
      value: true,
      updatedAt: 1,
    })
    jest.spyOn(db.meta, 'put')
      .mockRejectedValueOnce(new Error('floor write failed'))
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const handLogSpy = jest.spyOn(service.handLogStream, 'write')
    const aggregateSpy = jest.spyOn(service.handAggregateStream, 'write')
    const realTimeSpy = jest.spyOn(service.realTimeStatsStream, 'write')

    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 600,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'clock-backward-tab',
      IsRetire: false,
    })

    expect(await db.apiEvents.get([
      600,
      ApiType.EVT_ENTRY_QUEUED,
      0,
    ])).toBeUndefined()
    expect(await db.meta.get(
      `${SYNC_RESCAN_FLOOR_META_KEY}:user-a`
    )).toBeUndefined()
    expect(handLogSpy).not.toHaveBeenCalled()
    expect(aggregateSpy).not.toHaveBeenCalled()
    expect(realTimeSpy).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Raw Event Lake write failed'),
      expect.any(Error),
      expect.objectContaining({ timestamp: 600 })
    )
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

  test('tab close does not reopen the raw lake once deletion owns the database', async () => {
    mockPort.sender = { tab: { id: 101 } }
    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'tab-a',
      IsRetire: false,
    })
    const transactionSpy = jest.spyOn(db, 'transaction')
    setOperationState({ type: 'delete' })

    await tabRemovedHandler(101)

    expect(transactionSpy).not.toHaveBeenCalled()
    expect((await db.apiEvents.toArray()).some(event =>
      (event as any).__pokerChaseHudClosureReason === 'tab-removed'
    )).toBe(false)
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

  test('closing the newest tab does not restore an older origin lineup', async () => {
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

    expect(service.getCurrentSessionScope()).toBeUndefined()
    expect(statsWriteSpy).not.toHaveBeenCalled()
    expect(service.isSessionDisplayDealAvailable()).toBe(false)

    const delayedOldDeal = structuredClone(firstDeal)
    delayedOldDeal.timestamp = 5000
    await onMessageHandler(delayedOldDeal)

    expect(service.getCurrentSessionScope()).toBeUndefined()
    expect(isSafeToUpdate()).toBe(true)
    expect(statsWriteSpy).not.toHaveBeenCalled()
    expect(service.isSessionDisplayDealAvailable()).toBe(false)
  })

  test('newest session results do not restore an older origin lineup', async () => {
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

    expect(service.getCurrentSessionScope()).toBeUndefined()
    expect(statsWriteSpy).not.toHaveBeenCalled()
    expect(service.isSessionDisplayDealAvailable()).toBe(false)

    await onMessageHandler(entry(5000, 'tab-a-delayed'))
    expect(service.getCurrentSessionScope()).toBeUndefined()
  })

  test('ending the newest origin does not restore older player metadata', async () => {
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
    const seatAssigned = structuredClone(
      MTT_TABLE_MOVE_FIXTURE.events.find(
        event => event.ApiTypeId === ApiType.EVT_PLAYER_SEAT_ASSIGNED
      )!
    ) as ApiEvent<ApiType.EVT_PLAYER_SEAT_ASSIGNED>
    seatAssigned.timestamp = 1100
    seatAssigned.TableUsers[0]!.UserName = 'Restored Player'

    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'tab-a',
      IsRetire: false,
    })
    await onMessageHandler(seatAssigned)
    const restoredUser = seatAssigned.TableUsers[0]!
    await secondHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 2000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'tab-b',
      IsRetire: false,
    })
    expect(service.session.players.get(restoredUser.UserId)).toBeUndefined()

    await secondHandler({
      ApiTypeId: ApiType.EVT_SESSION_RESULTS,
      timestamp: 3000,
    })

    expect(service.getCurrentSessionScope()).toBeUndefined()
    expect(service.session.players.get(restoredUser.UserId)).toBeUndefined()
  })

  test('worker restart restores the selected origin deal before a new event arrives', async () => {
    mockPort.sender = { tab: { id: 101 } }
    const deal = structuredClone(
      MTT_TABLE_MOVE_FIXTURE.events.find(
        event => event.ApiTypeId === ApiType.EVT_DEAL
      )!
    ) as ApiEvent<ApiType.EVT_DEAL>
    deal.timestamp = 1200

    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.TOURNAMENT,
      Id: 'mtt-6078',
      IsRetire: false,
    })
    await onMessageHandler(deal)
    service.liveEvtDeal = undefined
    service.latestEvtDeal = undefined
    service.endSession()
    const serializedSnapshot = structuredClone(
      (await chrome.storage.local.get('activeSessionOriginsV1'))
        .activeSessionOriginsV1
    )
    await chrome.storage.local.set({
      activeSessionOriginsV1: serializedSnapshot,
    })

    registerEventIngestion(service)
    await service.sessionOriginsReady

    expect(service.liveEvtDeal).toEqual(deal)
    expect(service.latestEvtDeal).toEqual(deal)
    expect(service.playerId).toBe(deal.SeatUserIds[deal.Player!.SeatIndex])
    expect(getEventSessionScope(service.latestEvtDeal!)).toMatchObject({
      id: 'mtt-6078',
      startedAt: 1000,
    })
  })

  test('a new session start is accepted after the previous authority ended even if the device clock moved backward', async () => {
    mockPort.sender = { tab: { id: 101 } }
    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 2000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'newer-clock-session',
      IsRetire: false,
    })
    await onMessageHandler({
      ApiTypeId: ApiType.EVT_SESSION_RESULTS,
      timestamp: 3000,
    })

    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'clock-reset-session',
      IsRetire: false,
    })

    expect(service.getCurrentSessionScope()).toEqual({
      id: 'clock-reset-session',
      startedAt: 1000,
    })
    expect(service.session.active).toBe(true)
    expect(isSafeToUpdate()).toBe(false)
  })

  test('authoritative session results clear cached stats without broadcasting an empty lineup over the local hero-preserving end event', async () => {
    mockPort.sender = { tab: { id: 101 } }
    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'hero-session',
      IsRetire: false,
    })
    setLastKnownStats([{ playerId: 1 }] as any)
    mockPort.postMessage.mockClear()

    await onMessageHandler({
      ApiTypeId: ApiType.EVT_SESSION_RESULTS,
      timestamp: 2000,
    })

    expect(getLastKnownStats()).toEqual([])
    expect(mockPort.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ stats: [] })
    )
  })

  test('tab closure discards the scoped hand-log and realtime processors', async () => {
    mockPort.sender = { tab: { id: 101 } }
    const deal = structuredClone(
      MTT_TABLE_MOVE_FIXTURE.events.find(
        event => event.ApiTypeId === ApiType.EVT_DEAL
      )!
    ) as ApiEvent<ApiType.EVT_DEAL>
    deal.timestamp = 1200

    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'closing-tab',
      IsRetire: false,
    })
    await onMessageHandler(deal)
    await Promise.all([
      service.handLogStream.whenIdle(),
      service.realTimeStatsStream.whenIdle(),
    ])

    expect((service.handLogStream as any).scopedStates.size).toBe(1)
    expect((service.realTimeStatsStream as any).scopedStreams.size).toBe(1)

    await tabRemovedHandler(101)

    expect((service.handLogStream as any).scopedStates.size).toBe(0)
    expect((service.realTimeStatsStream as any).scopedStreams.size).toBe(0)
  })

  test('worker restart keeps the hero anchor when the selected origin latest deal is spectator-only', async () => {
    mockPort.sender = { tab: { id: 101 } }
    const heroDeal = structuredClone(
      MTT_TABLE_MOVE_FIXTURE.events.find(
        event => event.ApiTypeId === ApiType.EVT_DEAL
      )!
    ) as ApiEvent<ApiType.EVT_DEAL>
    heroDeal.timestamp = 1200
    const spectatorDeal = structuredClone(heroDeal) as any
    spectatorDeal.timestamp = 1300
    delete spectatorDeal.Player

    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.TOURNAMENT,
      Id: 'mtt-6078',
      IsRetire: false,
    })
    await onMessageHandler(heroDeal)
    await onMessageHandler(spectatorDeal)
    expect(service.latestEvtDeal).toEqual(heroDeal)

    service.liveEvtDeal = undefined
    service.endSession()
    registerEventIngestion(service)
    await service.sessionOriginsReady

    expect(service.liveEvtDeal).toEqual(spectatorDeal)
    expect(service.latestEvtDeal).toEqual(heroDeal)
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

  test('an older origin DEAL does not warm the authoritative HUD', async () => {
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
    const deal = structuredClone(
      MTT_TABLE_MOVE_FIXTURE.events.find(
        event => event.ApiTypeId === ApiType.EVT_DEAL
      )!
    ) as ApiEvent<ApiType.EVT_DEAL>
    deal.timestamp = 3000
    await db.hands.add({
      id: 1,
      approxTimestamp: 500,
      seatUserIds: deal.SeatUserIds,
      winningPlayerIds: [],
      smallBlind: 100,
      bigBlind: 200,
      session: {
        scopeKey: 'historical',
        id: 'shared-room',
        battleType: BattleType.RING_GAME,
      },
      results: [],
    })

    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'shared-room',
      IsRetire: false,
    })
    await secondHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 2000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'shared-room',
      IsRetire: false,
    })
    service.sessionOnlyFilter = true
    const calcStatsSpy = jest.spyOn(service.statsOutputStream, 'calcStats')

    await onMessageHandler(deal)
    await service.handAggregateStream.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 0))
    await service.statsOutputStream.whenIdle()

    expect(service.getCurrentSessionScope()).toEqual({ id: 'shared-room', startedAt: 2000 })
    expect(calcStatsSpy).not.toHaveBeenCalled()
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
    const firstCompletedHand = MTT_TABLE_MOVE_FIXTURE.events
      .slice(3, 6)
      .map(event => structuredClone(event))
    const competingDeal = structuredClone(firstCompletedHand[0]!) as ApiEvent<ApiType.EVT_DEAL>
    competingDeal.timestamp = (firstCompletedHand[0]!.timestamp ?? 0) + 1
    competingDeal.SeatUserIds = competingDeal.SeatUserIds.map(id => id + 10_000)

    // A and B can both have durable origin scopes during a stale-tab handoff.
    // The aggregate buffer must remain isolated even when their DEAL frames
    // interleave before A's ACTION/RESULTS complete.
    await onMessageHandler(firstCompletedHand[0])
    await secondHandler(competingDeal)
    for (const event of firstCompletedHand.slice(1)) {
      await onMessageHandler(structuredClone(event))
    }
    await service.handAggregateStream.whenIdle()

    const hand = await db.hands.get(MTT_TABLE_MOVE_FIXTURE.handIds.oldAccepted)
    expect(hand?.session).toMatchObject({
      scopeKey: expect.stringContaining('run:'),
      id: 'tab-a',
      battleType: BattleType.SIT_AND_GO,
    })
    expect(service.getCurrentSessionScope()).toEqual({ id: 'tab-b', startedAt: 2000 })
    expect(calcStatsSpy).not.toHaveBeenCalled()
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

  test('a session name arriving after DEAL is persisted on the completed hand', async () => {
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
    const [deal, action, results] = MTT_TABLE_MOVE_FIXTURE.events
      .slice(3, 6)
      .map(event => structuredClone(event))
    deal!.timestamp = 3000
    action!.timestamp = 3200
    results!.timestamp = 3300

    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1000,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'tab-a',
      IsRetire: false,
    })
    await onMessageHandler(deal)
    await onMessageHandler(sessionDetails(3100, 'Late Table A'))
    await onMessageHandler(action)
    await onMessageHandler(results)
    await service.handAggregateStream.whenIdle()

    const hand = await db.hands.get(MTT_TABLE_MOVE_FIXTURE.handIds.oldAccepted)
    expect(hand?.session).toMatchObject({
      id: 'tab-a',
      name: 'Late Table A',
    })
  })

  test('origin persistence failure does not drop a durable event from live streams', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    ;(chrome.storage.local.set as jest.Mock).mockRejectedValueOnce(new Error('quota'))
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
    const brokenDealEvent = {
      ApiTypeId: 303,
      timestamp: 222,
      Alice: {
        UserId: 129532369
      }
    }
    await onMessageHandler(brokenDealEvent)

    const stored = await db.apiEvents.get([222, 303, 0])
    expect(stored).toEqual({ ...brokenDealEvent, sequence: 0 })

    expect(handLogSpy).not.toHaveBeenCalled()
    expect(aggregateSpy).not.toHaveBeenCalled()
    expect(realTimeSpy).not.toHaveBeenCalled()
    expect(captureSchemaValidationFailure).toHaveBeenCalledWith(
      ApiType.EVT_DEAL,
      expect.any(Function)
    )
    const telemetryArgs = jest.mocked(captureSchemaValidationFailure).mock.calls[0]
    expect(telemetryArgs).toHaveLength(2)
    const diagnostic = telemetryArgs?.[1]()
    expect(diagnostic).toEqual(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: expect.any(String),
            code: expect.any(String),
            actualType: expect.any(String)
          })
        ]),
        payloadShape: expect.arrayContaining([
          '$: object',
          'ApiTypeId: integer',
          'timestamp: integer'
        ]),
        sanitizedPayload: expect.objectContaining({
          ApiTypeId: 303,
          timestamp: 222
        })
      })
    )
    expect(diagnostic).toEqual(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: expect.any(String),
            code: expect.any(String),
            actualType: expect.any(String)
          })
        ]),
        payloadShape: expect.any(Array),
        sanitizedPayload: expect.objectContaining({
          ApiTypeId: 303,
          timestamp: 222
        }),
        shapeTruncated: expect.any(Boolean),
        payloadTruncated: expect.any(Boolean)
      })
    )
    expect(diagnostic?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.any(String),
          code: expect.any(String),
          actualType: expect.any(String)
        })
      ])
    )
    expect(JSON.stringify(diagnostic)).not.toContain('Alice')
    expect(JSON.stringify(diagnostic)).not.toContain('129532369')
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
    const unknownEvent = {
      ApiTypeId: 9999,
      timestamp: 444,
      Alice: {
        UserId: 129532369,
        Chip: 1200
      }
    }
    await onMessageHandler(unknownEvent)
    await new Promise(resolve => setTimeout(resolve, 550))

    const stats = await getUndecodedEventStats(db)
    expect(stats.total).toBe(1)
    expect(stats.perApiTypeId[9999]).toEqual({ count: 1, lastSeen: 444 })

    const diagnostic =
      jest.mocked(captureSchemaValidationFailure).mock.calls[0]?.[1]()
    expect(diagnostic).toBeDefined()
    if (!diagnostic) throw new Error('expected unknown-event diagnostic')
    expect(diagnostic.payloadShape).toEqual(expect.arrayContaining([
      '[dynamic-key]: object',
      '[dynamic-key].UserId: integer',
      '[dynamic-key].Chip: integer'
    ]))
    expect(JSON.stringify(diagnostic)).not.toContain('Alice')
    expect(JSON.stringify(diagnostic)).not.toContain('129532369')
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

  test('an invalid ApiTypeId is still reported and counted in a bounded bucket', async () => {
    await onMessageHandler({ ApiTypeId: '303', timestamp: 555 })
    await onMessageHandler({ timestamp: 556 })

    expect(await db.apiEvents.count()).toBe(0)
    expect(captureSchemaValidationFailure).toHaveBeenCalledTimes(2)
    expect(captureSchemaValidationFailure).toHaveBeenNthCalledWith(
      1,
      INVALID_API_TYPE_ID_BUCKET,
      expect.any(Function)
    )
    expect(captureSchemaValidationFailure).toHaveBeenNthCalledWith(
      2,
      INVALID_API_TYPE_ID_BUCKET,
      expect.any(Function)
    )

    const firstDiagnostic =
      jest.mocked(captureSchemaValidationFailure).mock.calls[0]?.[1]()
    expect(firstDiagnostic).toEqual(expect.objectContaining({
      payloadShape: expect.arrayContaining([
        'ApiTypeId: string',
        'timestamp: integer'
      ])
    }))
    expect(JSON.stringify(firstDiagnostic)).not.toContain('"303"')

    const stats = await getUndecodedEventStats(db)
    expect(stats.total).toBe(2)
    expect(stats.perApiTypeId[INVALID_API_TYPE_ID_BUCKET]).toEqual({
      count: 2,
      lastSeen: 556
    })
  })

  test('keepalive messages are ignored entirely (not stored, not forwarded)', async () => {
    await onMessageHandler({ type: 'keepalive' })
    expect(await db.apiEvents.count()).toBe(0)
  })
})
