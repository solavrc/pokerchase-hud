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
import { trackServiceForTeardown } from '../utils/test-service-teardown'
import { ApiType } from '../types'
import { registerEventIngestion } from './event-ingestion'
import { REPLAY_PORT_LEDGER } from '../replay/protocol'
import { REPLAY_LEDGER_AUDIT_META_ID } from './replay-ledger-audit'
import { connectedPorts } from './ports'
import {
  getUndecodedEventStats,
  INVALID_API_TYPE_ID_BUCKET,
  resetUndecodedEventStats,
  UNDECODED_EVENT_STATS_KEY
} from './undecoded-event-tracker'
import { captureSchemaValidationFailure } from '../observability/sentry'
import { MTT_TABLE_MOVE_FIXTURE } from '../test-fixtures/mtt-table-move-lifecycle'
import { STATS_PENDING_HAND_DERIVATION_META_PREFIX } from '../stats/stat-ledger'

jest.mock('../observability/sentry', () => ({
  captureHandledException: jest.fn(),
  captureSchemaValidationFailure: jest.fn()
}))

describe('registerEventIngestion (Raw Event Lake)', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let onMessageHandler: (message: any) => Promise<void>
  let disconnectHandlers: Array<() => void>
  let mockPort: any

  beforeEach(async () => {
    jest.mocked(captureSchemaValidationFailure).mockClear()
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    // undecoded-event-tracker caches its in-memory state at module scope
    // (mirrors production, where there's exactly one db for the service
    // worker's lifetime); reset it so tests don't leak counts across the
    // fresh `db` instance each test creates.
    await resetUndecodedEventStats(db)
    service = trackServiceForTeardown(new PokerChaseService({ db }))
    await service.ready

    ;(chrome.runtime as any).onConnect = { addListener: jest.fn() }
    registerEventIngestion(service)
    const connectListener = (chrome.runtime as any).onConnect.addListener.mock.calls[0][0]

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

  // Codexレビュー指摘: awaitIngestionDrain() が待つのは processEvent() までで、
  // 同関数は handAggregateStream.write() で下流を起動するだけ。WriteEntityStream が
  // hands を書き終える前に照会すると、生成中のハンドを派生欠落として永続化する。
  test('台帳監査は派生パイプラインが空になるまで待つ', async () => {
    let releaseIdle!: () => void
    const idleGate = new Promise<void>(resolve => { releaseIdle = resolve })
    let observeWhenIdle!: () => void
    const whenIdleCalled = new Promise<void>(resolve => { observeWhenIdle = resolve })
    const whenIdleSpy = jest.spyOn(service.handAggregateStream, 'whenIdle')
      .mockImplementation(() => {
        observeWhenIdle()
        return idleGate
      })

    await onMessageHandler({
      type: REPLAY_PORT_LEDGER,
      battleType: 0,
      cardOpenEndDate: 0,
      isExpiredCardOpen: false,
      hands: []
    })

    // 下流が空になるまで監査は走らない。固定時間ではなく、監査キューが
    // 実際にwhenIdleへ到達したことを同期点にする（並列test負荷に依存させない）。
    await whenIdleCalled
    expect(whenIdleSpy).toHaveBeenCalled()
    expect(await db.meta.get(REPLAY_LEDGER_AUDIT_META_ID)).toBeUndefined()

    releaseIdle()
    for (let i = 0; i < 50; i++) {
      if (await db.meta.get(REPLAY_LEDGER_AUDIT_META_ID)) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(await db.meta.get(REPLAY_LEDGER_AUDIT_META_ID)).toBeDefined()
    whenIdleSpy.mockRestore()
  })

  test('a valid application event is stored and forwarded to the single real-time stream', async () => {
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

  test('assigned raw sequence is forwarded and DEAL-less RESULTS retain failed exact fences for recovery', async () => {
    const aggregateSpy = jest.spyOn(service.handAggregateStream, 'write')
    const first = structuredClone(MTT_TABLE_MOVE_FIXTURE.events[5]!) as any
    first.timestamp = 123_456
    const second = structuredClone(first)
    // same timestamp/type/HandIdでも別payloadならsequence=1の独立raw行。
    second.HandLog = 'distinct-result-payload'

    await onMessageHandler(first)
    await onMessageHandler(second)
    await service.handAggregateStream.whenIdle()

    const forwardedResults = aggregateSpy.mock.calls
      .map(([event]) => event)
      .filter(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)
    expect(forwardedResults.map(event => event.sequence)).toEqual([0, 1])
    expect(await db.apiEvents.get([123_456, ApiType.EVT_HAND_RESULTS, 0])).toBeDefined()
    expect(await db.apiEvents.get([123_456, ApiType.EVT_HAND_RESULTS, 1])).toBeDefined()
    const fences = await db.meta.where('id')
      .startsWith(STATS_PENDING_HAND_DERIVATION_META_PREFIX)
      .toArray()
    expect(fences).toHaveLength(2)
    expect(fences.map(fence => (fence.value as { rawKey: number[] }).rawKey)).toEqual([
      [123_456, ApiType.EVT_HAND_RESULTS, 0],
      [123_456, ApiType.EVT_HAND_RESULTS, 1],
    ])
    expect(fences.every(fence => (fence.value as { failed?: boolean }).failed === true)).toBe(true)
  })

  test('a logger failure after raw RESULTS commit marks its exact derivation fence failed', async () => {
    const first = structuredClone(MTT_TABLE_MOVE_FIXTURE.events[5]!) as any
    first.timestamp = 123_457
    await onMessageHandler(first)
    await service.handAggregateStream.whenIdle()

    // 同一timestamp/type/HandIdの別payloadをsequence=1として保存させる。
    // sequence無しの受信messageでなく、actual-added raw keyをfailed化することを固定する。
    const result = structuredClone(first)
    result.HandLog = 'logger-failure-payload'
    jest.spyOn(service, 'eventLogger').mockImplementation(() => {
      throw new Error('injected event logger failure')
    })

    await expect(onMessageHandler(result)).rejects.toThrow('injected event logger failure')

    expect(await db.apiEvents.get([
      result.timestamp,
      ApiType.EVT_HAND_RESULTS,
      1,
    ])).toBeDefined()
    const fences = await db.meta.where('id')
      .startsWith(STATS_PENDING_HAND_DERIVATION_META_PREFIX)
      .toArray()
    expect(fences).toHaveLength(2)
    expect(fences.find(fence =>
      (fence.value as { rawKey?: number[] }).rawKey?.[2] === 1
    )?.value).toEqual(expect.objectContaining({
      handId: result.HandId,
      rawKey: [result.timestamp, ApiType.EVT_HAND_RESULTS, 1],
      failed: true,
    }))
  })

  test('an exception after aggregate handoff does not mark the RESULTS fence failed', async () => {
    const result = structuredClone(MTT_TABLE_MOVE_FIXTURE.events[5]!) as any
    result.timestamp = 123_458
    jest.spyOn(service.handAggregateStream, 'write').mockImplementation(() => undefined)
    jest.spyOn(service.realTimeStatsStream, 'write').mockImplementation(() => {
      throw new Error('injected downstream stream failure')
    })

    await expect(onMessageHandler(result)).rejects.toThrow('injected downstream stream failure')

    const fences = await db.meta.where('id')
      .startsWith(STATS_PENDING_HAND_DERIVATION_META_PREFIX)
      .toArray()
    expect(fences).toHaveLength(1)
    expect(fences[0]?.value).toEqual(expect.objectContaining({
      handId: result.HandId,
      rawKey: [result.timestamp, ApiType.EVT_HAND_RESULTS, 0],
    }))
    expect(fences[0]?.value).not.toEqual(expect.objectContaining({ failed: true }))
  })

  test('schema-rejected RESULTS keeps the raw row but terminally clears its derivation fence', async () => {
    const brokenResult = {
      ApiTypeId: ApiType.EVT_HAND_RESULTS,
      timestamp: 234_567,
      HandId: 765_432,
      // その他の必須フィールドを意図的に欠落させる。
    }

    await onMessageHandler(brokenResult)

    expect(await db.apiEvents.get([234_567, ApiType.EVT_HAND_RESULTS, 0])).toEqual({
      ...brokenResult,
      sequence: 0,
    })
    expect(await db.meta.where('id')
      .startsWith(STATS_PENDING_HAND_DERIVATION_META_PREFIX)
      .count()).toBe(0)
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
