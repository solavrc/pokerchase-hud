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
import { ApiType } from '../types'
import { registerEventIngestion } from './event-ingestion'
import { connectedPorts } from './ports'
import {
  getUndecodedEventStats,
  INVALID_API_TYPE_ID_BUCKET,
  resetUndecodedEventStats,
  UNDECODED_EVENT_STATS_KEY
} from './undecoded-event-tracker'
import { captureSchemaValidationFailure } from '../observability/sentry'

jest.mock('../observability/sentry', () => ({
  captureHandledException: jest.fn(),
  captureSchemaValidationFailure: jest.fn()
}))

const validSessionResult = (timestamp: number) => ({
  ApiTypeId: ApiType.EVT_SESSION_RESULTS,
  timestamp,
  Ranking: 3,
  IsLeave: false,
  IsRebuy: false,
  TotalMatch: 100,
  RankReward: {
    IsSeasonal: true,
    RankPoint: 10,
    RankPointDiff: 1,
    Rank: {
      RankId: 'gold',
      RankName: 'ゴールド',
      RankLvId: 'gold',
      RankLvName: 'ゴールド',
    },
    SeasonalRanking: 0,
  },
  Rewards: [],
  EventRewards: [],
  Charas: [],
  Costumes: [],
  Decos: [],
  Items: [],
  Money: { FreeMoney: -1, PaidMoney: -1 },
  Emblems: [],
})

describe('registerEventIngestion (Raw Event Lake)', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let onMessageHandler: (message: any) => Promise<void>
  let disconnectHandlers: Array<() => void>
  let connectListener: (port: any) => void

  const connectSource = (tabId: number) => {
    const port = {
      name: PokerChaseService.POKER_CHASE_SERVICE_EVENT,
      sender: { tab: { id: tabId } },
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn((fn: () => void) => disconnectHandlers.push(fn)) },
      postMessage: jest.fn()
    }
    connectListener(port)
    return {
      port,
      onMessage: port.onMessage.addListener.mock.calls[0][0] as (message: any) => Promise<void>
    }
  }

  beforeEach(async () => {
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
    registerEventIngestion(service)
    connectListener = (chrome.runtime as any).onConnect.addListener.mock.calls[0][0]

    disconnectHandlers = []
    const source = connectSource(1)
    onMessageHandler = source.onMessage
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
    expect(stored).toEqual({ ...validEvent, sequence: 0 })

    expect(handLogSpy).toHaveBeenCalledTimes(1)
    expect(aggregateSpy).toHaveBeenCalledTimes(1)
    expect(realTimeSpy).toHaveBeenCalledTimes(1)
  })

  test('stores raw immediately but waits for restored filters before forwarding live events', async () => {
    service.beginFiltersRestore()
    const handLogSpy = jest.spyOn(service.handLogStream, 'write')
    const aggregateSpy = jest.spyOn(service.handAggregateStream, 'write')
    const validEvent = {
      ApiTypeId: 201, timestamp: 112, Code: 0, BattleType: 0, Id: 'stage000_004', IsRetire: false
    }

    const pending = onMessageHandler(validEvent)
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(await db.apiEvents.get([112, 201, 0])).toEqual({ ...validEvent, sequence: 0 })
    expect(handLogSpy).not.toHaveBeenCalled()
    expect(aggregateSpy).not.toHaveBeenCalled()

    service.autoBattleTypeFilter = true
    service.markFiltersRestored()
    await pending

    expect(handLogSpy).toHaveBeenCalledTimes(1)
    expect(aggregateSpy).toHaveBeenCalledTimes(1)
  })

  test('delayed filter restoration does not block later events from reaching the Raw Event Lake', async () => {
    service.beginFiltersRestore()
    const aggregateSpy = jest.spyOn(service.handAggregateStream, 'write')
    const first = {
      ApiTypeId: 201, timestamp: 113, Code: 0, BattleType: 0, Id: 'stage000_005', IsRetire: false
    }
    const second = {
      ApiTypeId: 201, timestamp: 114, Code: 0, BattleType: 2, Id: 'stage000_006', IsRetire: false
    }

    const firstPending = onMessageHandler(first)
    const secondPending = onMessageHandler(second)
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(await db.apiEvents.get([113, 201, 0])).toEqual({ ...first, sequence: 0 })
    expect(await db.apiEvents.get([114, 201, 0])).toEqual({ ...second, sequence: 0 })
    expect(aggregateSpy).not.toHaveBeenCalled()

    service.markFiltersRestored()
    await Promise.all([firstPending, secondPending])

    expect(aggregateSpy.mock.calls.map(([event]) => event.timestamp)).toEqual([113, 114])
  })

  test('a session end queued during filter restoration wins over earlier session-start forwarding', async () => {
    service.beginFiltersRestore()
    service.autoBattleTypeFilter = true
    service.session.setBattleType(0)
    const entry = {
      ApiTypeId: 201, timestamp: 115, Code: 0, BattleType: 0, Id: 'stage000_007', IsRetire: false
    }
    // Deliberately malformed 309: the raw ApiTypeId must still end the session.
    const sessionEnd = { ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 116 }

    const entryPending = onMessageHandler(entry)
    const endPending = onMessageHandler(sessionEnd)
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(await db.apiEvents.get([115, 201, 0])).toEqual({ ...entry, sequence: 0 })
    expect(await db.apiEvents.get([116, ApiType.EVT_SESSION_RESULTS, 0])).toEqual({ ...sessionEnd, sequence: 0 })

    service.markFiltersRestored()
    await Promise.all([entryPending, endPending])
    await service.handAggregateStream.whenIdle()

    expect(service.session.battleType).toBeUndefined()
    expect(service.getEffectiveBattleTypeFilter()).toEqual([])
  })

  test('only a different tab can make a Friend SNG 309 non-terminal', async () => {
    service.autoBattleTypeFilter = true
    const foreignSource = connectSource(2)
    const entry = {
      ApiTypeId: 201,
      timestamp: 1161,
      Code: 0,
      BattleType: 2,
      Id: 'friend-sng-redacted',
      IsRetire: false,
    }
    const foreignSessionEnd = validSessionResult(1162)

    await onMessageHandler(entry)
    await foreignSource.onMessage(foreignSessionEnd)

    expect(service.session.id).toBe('friend-sng-redacted')
    expect(service.session.battleType).toBe(2)
    expect(service.getEffectiveBattleTypeFilter()).toEqual([0, 2, 6])

    // A result from the owning source is the ordinary terminal case.
    await onMessageHandler({
      ApiTypeId: ApiType.EVT_SESSION_RESULTS,
      timestamp: 1163,
    })
    expect(service.session.id).toBeUndefined()
    expect(service.session.battleType).toBeUndefined()
    expect(service.getEffectiveBattleTypeFilter()).toEqual([])
  })

  test('session source ownership survives a service-worker registration restart', async () => {
    service.autoBattleTypeFilter = true
    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1170,
      Code: 0,
      BattleType: 2,
      Id: 'persisted-source-friend',
      IsRetire: false,
    })

    // Re-registering creates fresh module-local boundary state, matching an
    // MV3 worker restart; trusted chrome.storage.local remains available.
    registerEventIngestion(service)
    connectListener = (chrome.runtime as any).onConnect.addListener.mock.calls[1][0]
    const foreignSource = connectSource(2)
    await foreignSource.onMessage(validSessionResult(1171))

    expect(service.session.id).toBe('persisted-source-friend')
    expect(service.session.battleType).toBe(2)
  })

  test('a seated deal rebinds ownership when the new tab has no captured 201', async () => {
    service.autoBattleTypeFilter = true
    const newSource = connectSource(2)
    const emittedStats: unknown[] = []
    service.statsOutputStream.on('data', stats => emittedStats.push(stats))
    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1173,
      Code: 0,
      BattleType: 2,
      Id: 'old-tab-friend',
      IsRetire: false,
    })

    // Missing the rest of the deal schema is intentional: raw Player
    // presence is the same fail-closed ownership signal used for activity.
    await newSource.onMessage({
      ApiTypeId: ApiType.EVT_DEAL,
      timestamp: 1174,
      Player: { SeatIndex: 0 },
    })

    expect(service.session.id).toBeUndefined()
    expect(service.session.battleType).toBeUndefined()
    expect(service.getEffectiveBattleTypeFilter()).toEqual([])
    expect(emittedStats.at(-1)).toEqual([])

    await newSource.onMessage(validSessionResult(1175))

    expect(service.session.id).toBeUndefined()
    expect(service.session.battleType).toBeUndefined()
    expect(service.getEffectiveBattleTypeFilter()).toEqual([])
  })

  test('a parse-failed successful entry recovers a minimally valid category', async () => {
    service.autoBattleTypeFilter = true

    // Missing IsRetire deliberately breaks the application schema while the
    // raw session identity/category remain usable.
    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1164,
      Code: 0,
      Id: 'raw-friend-entry',
      BattleType: 2,
    })

    expect(service.session.id).toBe('raw-friend-entry')
    expect(service.session.battleType).toBe(2)
    expect(service.getEffectiveBattleTypeFilter()).toEqual([0, 2, 6])
  })

  test('a parse-failed Friend Ring entry accepts its specified empty Id', async () => {
    service.autoBattleTypeFilter = true

    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1172,
      Code: 0,
      Id: '',
      BattleType: 5,
    })

    expect(service.session.id).toBe('')
    expect(service.session.battleType).toBe(5)
    expect(service.getEffectiveBattleTypeFilter()).toEqual([4, 5])
  })

  test('a parse-failed entry with unusable identity clears the previous automatic category', async () => {
    service.autoBattleTypeFilter = true
    service.session.setId('previous-ring')
    service.session.setBattleType(4)

    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1165,
      Code: 0,
      Id: '',
      BattleType: 99,
    })

    expect(service.session.id).toBeUndefined()
    expect(service.session.battleType).toBeUndefined()
    expect(service.getEffectiveBattleTypeFilter()).toEqual([])
  })

  test('an explicit failed entry response neither replaces category nor transfers source ownership', async () => {
    service.autoBattleTypeFilter = true
    const foreignSource = connectSource(2)
    await onMessageHandler({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1166,
      Code: 0,
      BattleType: 2,
      Id: 'owned-friend',
      IsRetire: false,
    })

    await foreignSource.onMessage({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1167,
      Code: 1,
      BattleType: 3,
      Id: 'failed-ring',
    })
    await foreignSource.onMessage({
      ApiTypeId: ApiType.EVT_SESSION_RESULTS,
      timestamp: 1168,
    })

    expect(service.session.id).toBe('owned-friend')
    expect(service.session.battleType).toBe(2)

    await onMessageHandler({
      ApiTypeId: ApiType.EVT_SESSION_RESULTS,
      timestamp: 1169,
    })
    expect(service.session.id).toBeUndefined()
  })

  test('entry cancellation clears an auto-selected queued session in application order', async () => {
    service.beginFiltersRestore()
    service.autoBattleTypeFilter = true
    const entry = {
      ApiTypeId: 201, timestamp: 117, Code: 0, BattleType: 2, Id: 'stage000_008', IsRetire: false
    }
    const cancellation = { ApiTypeId: 203, timestamp: 118, Code: 0 }

    const entryPending = onMessageHandler(entry)
    const cancellationPending = onMessageHandler(cancellation)
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(await db.apiEvents.get([117, 201, 0])).toEqual({ ...entry, sequence: 0 })
    expect(await db.apiEvents.get([118, 203, 0])).toEqual({ ...cancellation, sequence: 0 })

    service.markFiltersRestored()
    await Promise.all([entryPending, cancellationPending])
    await service.handAggregateStream.whenIdle()

    expect(service.session.id).toBeUndefined()
    expect(service.session.battleType).toBeUndefined()
    expect(service.getEffectiveBattleTypeFilter()).toEqual([])
  })

  test('entry cancellation does not finish ingestion until the cleared session is persisted', async () => {
    service.autoBattleTypeFilter = true
    service.session.setId('queued-session')
    service.session.setBattleType(0)

    const originalSet = (chrome.storage.local.set as jest.Mock).getMockImplementation()!
    let releaseWrite!: () => void
    let signalWriteStarted!: () => void
    const writeBlocked = new Promise<void>(resolve => { releaseWrite = resolve })
    const writeStarted = new Promise<void>(resolve => { signalWriteStarted = resolve })
    const setSpy = jest.spyOn(chrome.storage.local, 'set').mockImplementation((items: any) => {
      const state = (items as Record<string, any>)[PokerChaseService.STORAGE_KEY]
      if (state?.session?.id === undefined) {
        signalWriteStarted()
        return writeBlocked.then(() => originalSet(items))
      }
      return originalSet(items)
    })

    try {
      let settled = false
      const cancellation = onMessageHandler({ ApiTypeId: 203, timestamp: 1181, Code: 0 })
        .then(() => { settled = true })

      await writeStarted
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(service.session.id).toBeUndefined()
      expect(service.session.battleType).toBeUndefined()

      releaseWrite()
      await cancellation

      const persisted = setSpy.mock.calls
        .map(([items]) => (items as Record<string, any>)[PokerChaseService.STORAGE_KEY])
        .find(state => state?.session?.id === undefined)
      expect(persisted.session.battleType).toBeUndefined()
    } finally {
      setSpy.mockRestore()
    }
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
