import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { ApiType, BattleType } from '../types'
import {
  EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY,
  REPLAY_PORT_FETCH,
  REPLAY_PORT_RESULT
} from '../replay/protocol'
import { ExperimentalReplayImporter } from './experimental-replay-import'

describe('ExperimentalReplayImporter', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let importer: ExperimentalReplayImporter
  let port: chrome.runtime.Port
  let observe: (message: Record<string, unknown>) => Promise<void>

  beforeEach(async () => {
    ;(chrome.storage.local.get as jest.Mock).mockResolvedValue({
      [EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY]: true
    })
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = new PokerChaseService({ db })
    await service.ready
    importer = new ExperimentalReplayImporter(db, service)
    await importer.ready
    port = {
      postMessage: jest.fn(),
      sender: { tab: { id: 10 }, frameId: 0 }
    } as unknown as chrome.runtime.Port
    importer.attachPort(port)
    observe = message => importer.observePortEvent(message, port)
  })

  afterEach(async () => {
    importer.detachPort(port)
    db.close()
    await db.delete()
  })

  test('queues HandIds during play and dispatches only after 309', async () => {
    await observe({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Id: 'sng-1',
      BattleType: BattleType.SIT_AND_GO,
      timestamp: 100
    })
    await observe({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 123, timestamp: 200 })

    expect((await db.experimentalReplayHands.get(123))?.status).toBe('pending')
    expect(port.postMessage).not.toHaveBeenCalled()

    await observe({ ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 300 })
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: REPLAY_PORT_FETCH,
      handIds: [123]
    }))
    expect((await db.experimentalReplayHands.get(123))?.status).toBe('ready')
  })

  test('stores sanitized detail and never persists response credentials', async () => {
    await observe({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Id: 'ring-1',
      BattleType: BattleType.RING_GAME,
      timestamp: 100
    })
    await observe({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 456, timestamp: 200 })
    await observe({ ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 300 })
    const request = (port.postMessage as jest.Mock).mock.calls[0][0]

    expect(importer.handlePortMessage({
      type: REPLAY_PORT_RESULT,
      requestId: request.requestId,
      results: [{
        handId: 456,
        ok: true,
        detail: { Code: 0, session: 'secret', Replay: { HandId: 456, requestKey: 'secret-2' } }
      }]
    }, port)).toBe(true)
    await importer.whenIdle()

    expect(await db.experimentalReplayHands.get(456)).toEqual(expect.objectContaining({
      status: 'complete',
      detail: { Code: 0, Replay: { HandId: 456 } }
    }))
    expect(JSON.stringify(await db.experimentalReplayHands.get(456))).not.toContain('secret')
  })

  test('keeps the same MTT session across table-move 201 events', async () => {
    await observe({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Id: 'mtt-1',
      BattleType: BattleType.TOURNAMENT,
      timestamp: 100
    })
    await observe({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 1, timestamp: 200 })
    await observe({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Id: 'mtt-1',
      BattleType: BattleType.TOURNAMENT,
      timestamp: 300
    })

    expect((await db.experimentalReplayHands.get(1))?.status).toBe('pending')
    expect(port.postMessage).not.toHaveBeenCalled()
  })

  test('keeps interleaved game tabs in separate session buckets', async () => {
    const tabA = 'tab-a'
    const tabB = 'tab-b'
    await importer.observeApiEvent({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED, Id: 'a', BattleType: BattleType.SIT_AND_GO, timestamp: 100
    }, tabA)
    await importer.observeApiEvent({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 11, timestamp: 110 }, tabA)
    await importer.observeApiEvent({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED, Id: 'b', BattleType: BattleType.RING_GAME, timestamp: 120
    }, tabB)
    await importer.observeApiEvent({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 22, timestamp: 130 }, tabB)

    await importer.observeApiEvent({ ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 140 }, tabA)
    expect((await db.experimentalReplayHands.get(11))?.status).toBe('ready')
    expect((await db.experimentalReplayHands.get(22))?.status).toBe('pending')
  })

  test('dispatches replay rows only through their originating tab', async () => {
    const tabA = {
      postMessage: jest.fn(), sender: { tab: { id: 20 }, frameId: 0 }
    } as unknown as chrome.runtime.Port
    const tabB = {
      postMessage: jest.fn(), sender: { tab: { id: 21 }, frameId: 0 }
    } as unknown as chrome.runtime.Port
    importer.attachPort(tabA)
    importer.attachPort(tabB)

    await importer.observePortEvent({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED, Id: 'a', BattleType: BattleType.SIT_AND_GO, timestamp: 100
    }, tabA)
    await importer.observePortEvent({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 31, timestamp: 110 }, tabA)
    await importer.observePortEvent({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED, Id: 'b', BattleType: BattleType.RING_GAME, timestamp: 120
    }, tabB)
    await importer.observePortEvent({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 32, timestamp: 130 }, tabB)
    await importer.observePortEvent({ ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 140 }, tabA)

    expect(tabA.postMessage).toHaveBeenCalledWith(expect.objectContaining({ handIds: [31] }))
    expect(tabB.postMessage).not.toHaveBeenCalled()
    importer.detachPort(tabA)
    importer.detachPort(tabB)
  })

  test('uses a repeated non-MTT 308 as a missing-309 boundary', async () => {
    await observe({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Id: 'ring-308',
      BattleType: BattleType.RING_GAME,
      timestamp: 100
    })
    await observe({ ApiTypeId: ApiType.EVT_SESSION_DETAILS, Name: 'Ring', timestamp: 110 })
    await observe({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 41, timestamp: 120 })
    await observe({ ApiTypeId: ApiType.EVT_SESSION_DETAILS, Name: 'Ring', timestamp: 200 })

    expect((await db.experimentalReplayHands.get(41))?.status).toBe('ready')
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ handIds: [41] }))

    await observe({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 42, timestamp: 220 })
    expect((await db.experimentalReplayHands.get(42))?.status).toBe('pending')
  })

  test('absorbs repeated 308 events inside the same MTT', async () => {
    await observe({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Id: 'mtt-308',
      BattleType: BattleType.TOURNAMENT,
      timestamp: 100
    })
    await observe({ ApiTypeId: ApiType.EVT_SESSION_DETAILS, Name: 'MTT', timestamp: 110 })
    await observe({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 51, timestamp: 120 })
    await observe({ ApiTypeId: ApiType.EVT_SESSION_DETAILS, Name: 'MTT table 2', timestamp: 200 })

    expect((await db.experimentalReplayHands.get(51))?.status).toBe('pending')
    expect(port.postMessage).not.toHaveBeenCalled()
  })

  test('uses the next non-MTT 201 as a missing-309 fallback', async () => {
    await importer.observeApiEvent({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Id: 'ring-stage',
      BattleType: BattleType.RING_GAME,
      timestamp: 100
    })
    await observe({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 99, timestamp: 200 })
    await observe({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Id: 'ring-stage',
      BattleType: BattleType.RING_GAME,
      timestamp: 400
    })

    expect((await db.experimentalReplayHands.get(99))?.status).toBe('ready')
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ handIds: [99] }))
  })

  test('re-dispatches a durable ready row when a game port reconnects', async () => {
    await observe({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Id: 'sng-reconnect',
      BattleType: BattleType.SIT_AND_GO,
      timestamp: 100
    })
    await observe({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 321, timestamp: 200 })
    await observe({ ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 300 })
    expect((await db.experimentalReplayHands.get(321))?.status).toBe('ready')
    expect(port.postMessage).toHaveBeenCalled()
    importer.detachPort(port)

    const replacementPort = {
      postMessage: jest.fn(),
      sender: { tab: { id: 10 }, frameId: 0 }
    } as unknown as chrome.runtime.Port
    importer.attachPort(replacementPort)
    await importer.whenIdle()
    expect(replacementPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: REPLAY_PORT_FETCH,
      handIds: [321]
    }))
    importer.detachPort(replacementPort)
  })

  test('restores active session metadata after a service-worker restart', async () => {
    await observe({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Id: 'ring-restart',
      BattleType: BattleType.RING_GAME,
      timestamp: 100
    })
    await observe({ ApiTypeId: ApiType.EVT_SESSION_DETAILS, Name: 'Ring', timestamp: 110 })
    await observe({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 331, timestamp: 120 })
    importer.detachPort(port)

    importer = new ExperimentalReplayImporter(db, service)
    await importer.ready
    port = {
      postMessage: jest.fn(),
      sender: { tab: { id: 10 }, frameId: 0 }
    } as unknown as chrome.runtime.Port
    importer.attachPort(port)
    observe = message => importer.observePortEvent(message, port)

    // The restored detailsSeen flag makes this the repeated-308 fallback
    // boundary instead of fusing both ring sessions.
    await observe({ ApiTypeId: ApiType.EVT_SESSION_DETAILS, Name: 'Ring', timestamp: 200 })
    expect((await db.experimentalReplayHands.get(331))?.status).toBe('ready')
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ handIds: [331] }))
  })

  test('uses a replacement same-source port when the boundary port is stale', async () => {
    await observe({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Id: 'stale-port',
      BattleType: BattleType.SIT_AND_GO,
      timestamp: 100
    })
    await observe({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 341, timestamp: 200 })

    const boundary = observe({ ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 300 })
    importer.detachPort(port)
    const replacementPort = {
      postMessage: jest.fn(),
      sender: { tab: { id: 10 }, frameId: 0 }
    } as unknown as chrome.runtime.Port
    importer.attachPort(replacementPort)
    await boundary
    await importer.whenIdle()

    expect(replacementPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({ handIds: [341] }))
    importer.detachPort(replacementPort)
  })

  test('retries a success item that omits replay detail', async () => {
    await observe({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Id: 'missing-detail',
      BattleType: BattleType.SIT_AND_GO,
      timestamp: 100
    })
    await observe({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 351, timestamp: 200 })
    await observe({ ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 300 })
    const request = (port.postMessage as jest.Mock).mock.calls[0][0]

    expect(importer.handlePortMessage({
      type: REPLAY_PORT_RESULT,
      requestId: request.requestId,
      results: [{ handId: 351, ok: true }]
    }, port)).toBe(true)
    await importer.whenIdle()

    expect(await db.experimentalReplayHands.get(351)).toEqual(expect.objectContaining({
      status: 'ready',
      lastError: 'missing-result'
    }))
  })

  test('continues past a full batch of terminal failures', async () => {
    await observe({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Id: 'large-terminal-failure',
      BattleType: BattleType.SIT_AND_GO,
      timestamp: 100
    })
    const handIds = Array.from({ length: 101 }, (_, index) => 1_000 + index)
    for (const handId of handIds) {
      await observe({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: handId, timestamp: handId })
    }
    await observe({ ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 2_000 })
    const firstRequest = (port.postMessage as jest.Mock).mock.calls[0][0]
    expect(firstRequest.handIds).toHaveLength(100)

    expect(importer.handlePortMessage({
      type: REPLAY_PORT_RESULT,
      requestId: firstRequest.requestId,
      results: firstRequest.handIds.map((handId: number) => ({
        handId,
        ok: false,
        error: 'API Code 1',
        retryable: false
      }))
    }, port)).toBe(true)
    await importer.whenIdle()

    expect(port.postMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({ handIds: [1_100] }))
  })

  test('cancels retry work and rejects later writes when data deletion starts', async () => {
    await observe({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Id: 'delete-race',
      BattleType: BattleType.SIT_AND_GO,
      timestamp: 100
    })
    await observe({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 1_201, timestamp: 200 })
    await observe({ ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 300 })
    const request = (port.postMessage as jest.Mock).mock.calls[0][0]

    jest.useFakeTimers()
    try {
      expect(importer.handlePortMessage({
        type: REPLAY_PORT_RESULT,
        requestId: request.requestId,
        results: [{ handId: 1_201, ok: false, error: 'HTTP 503', retryable: true }]
      }, port)).toBe(true)
      await importer.whenIdle()
      await importer.prepareForDataDeletion()
      ;(port.postMessage as jest.Mock).mockClear()

      await jest.advanceTimersByTimeAsync(60_000)
      await importer.observePortEvent({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 1_202, timestamp: 400 }, port)
      await importer.whenIdle()

      expect(port.postMessage).not.toHaveBeenCalled()
      expect(await db.experimentalReplayHands.get(1_202)).toBeUndefined()
    } finally {
      jest.useRealTimers()
    }
  })

  test('retries an all-retryable batch with backoff while the tab stays open', async () => {
    await observe({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Id: 'retry-session',
      BattleType: BattleType.SIT_AND_GO,
      timestamp: 100
    })
    await observe({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 61, timestamp: 200 })
    await observe({ ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 300 })
    const request = (port.postMessage as jest.Mock).mock.calls[0][0]

    jest.useFakeTimers()
    try {
      expect(importer.handlePortMessage({
        type: REPLAY_PORT_RESULT,
        requestId: request.requestId,
        results: [{ handId: 61, ok: false, error: 'auth-envelope-unavailable', retryable: true }]
      }, port)).toBe(true)
      await importer.whenIdle()
      ;(port.postMessage as jest.Mock).mockClear()

      await jest.advanceTimersByTimeAsync(2_000)
      await importer.whenIdle()
      expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ handIds: [61] }))
    } finally {
      jest.useRealTimers()
    }
  })

  test('does nothing while the opt-in flag is disabled', async () => {
    ;(chrome.storage.local.get as jest.Mock).mockResolvedValue({})
    const disabled = new ExperimentalReplayImporter(db, service)
    await disabled.ready

    await disabled.observeApiEvent({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 777, timestamp: 1 })
    expect(await db.experimentalReplayHands.count()).toBe(0)
  })
})
