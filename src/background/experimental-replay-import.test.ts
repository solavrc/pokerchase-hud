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
    port = { postMessage: jest.fn() } as unknown as chrome.runtime.Port
    importer.attachPort(port)
  })

  afterEach(async () => {
    importer.detachPort(port)
    db.close()
    await db.delete()
  })

  test('queues HandIds during play and dispatches only after 309', async () => {
    await importer.observeApiEvent({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Id: 'sng-1',
      BattleType: BattleType.SIT_AND_GO,
      timestamp: 100
    })
    await importer.observeApiEvent({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 123, timestamp: 200 })

    expect((await db.experimentalReplayHands.get(123))?.status).toBe('pending')
    expect(port.postMessage).not.toHaveBeenCalled()

    await importer.observeApiEvent({ ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 300 })
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: REPLAY_PORT_FETCH,
      handIds: [123]
    }))
    expect((await db.experimentalReplayHands.get(123))?.status).toBe('ready')
  })

  test('stores sanitized detail and never persists response credentials', async () => {
    await importer.observeApiEvent({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Id: 'ring-1',
      BattleType: BattleType.RING_GAME,
      timestamp: 100
    })
    await importer.observeApiEvent({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 456, timestamp: 200 })
    await importer.observeApiEvent({ ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 300 })
    const request = (port.postMessage as jest.Mock).mock.calls[0][0]

    expect(importer.handlePortMessage({
      type: REPLAY_PORT_RESULT,
      requestId: request.requestId,
      results: [{
        handId: 456,
        ok: true,
        detail: { Code: 0, session: 'secret', Replay: { HandId: 456, requestKey: 'secret-2' } }
      }]
    })).toBe(true)
    await importer.whenIdle()

    expect(await db.experimentalReplayHands.get(456)).toEqual(expect.objectContaining({
      status: 'complete',
      detail: { Code: 0, Replay: { HandId: 456 } }
    }))
    expect(JSON.stringify(await db.experimentalReplayHands.get(456))).not.toContain('secret')
  })

  test('keeps the same MTT session across table-move 201 events', async () => {
    await importer.observeApiEvent({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Id: 'mtt-1',
      BattleType: BattleType.TOURNAMENT,
      timestamp: 100
    })
    await importer.observeApiEvent({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 1, timestamp: 200 })
    await importer.observeApiEvent({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Id: 'mtt-1',
      BattleType: BattleType.TOURNAMENT,
      timestamp: 300
    })

    expect((await db.experimentalReplayHands.get(1))?.status).toBe('pending')
    expect(port.postMessage).not.toHaveBeenCalled()
  })

  test('keeps interleaved game tabs in separate session buckets', async () => {
    const tabA = {}
    const tabB = {}
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

  test('uses the next non-MTT 201 as a missing-309 fallback', async () => {
    await importer.observeApiEvent({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Id: 'ring-stage',
      BattleType: BattleType.RING_GAME,
      timestamp: 100
    })
    await importer.observeApiEvent({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 99, timestamp: 200 })
    await importer.observeApiEvent({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Id: 'ring-stage',
      BattleType: BattleType.RING_GAME,
      timestamp: 400
    })

    expect((await db.experimentalReplayHands.get(99))?.status).toBe('ready')
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ handIds: [99] }))
  })

  test('re-dispatches a durable ready row when a game port reconnects', async () => {
    importer.detachPort(port)
    await importer.observeApiEvent({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Id: 'sng-reconnect',
      BattleType: BattleType.SIT_AND_GO,
      timestamp: 100
    })
    await importer.observeApiEvent({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 321, timestamp: 200 })
    await importer.observeApiEvent({ ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 300 })
    expect((await db.experimentalReplayHands.get(321))?.status).toBe('ready')

    const replacementPort = { postMessage: jest.fn() } as unknown as chrome.runtime.Port
    importer.attachPort(replacementPort)
    await importer.whenIdle()
    expect(replacementPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: REPLAY_PORT_FETCH,
      handIds: [321]
    }))
    importer.detachPort(replacementPort)
  })

  test('does nothing while the opt-in flag is disabled', async () => {
    ;(chrome.storage.local.get as jest.Mock).mockResolvedValue({})
    const disabled = new ExperimentalReplayImporter(db, service)
    await disabled.ready

    await disabled.observeApiEvent({ ApiTypeId: ApiType.EVT_HAND_RESULTS, HandId: 777, timestamp: 1 })
    expect(await db.experimentalReplayHands.count()).toBe(0)
  })
})
