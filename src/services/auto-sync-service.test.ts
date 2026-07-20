import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { PokerChaseDB } from '../db/poker-chase-db'
import { ApiType, BattleType } from '../types'
import type { ApiEvent } from '../types'
import { DATABASE_CONSTANTS } from '../constants/database'
import { AutoSyncService } from './auto-sync-service'
import { firestoreBackupService } from './firestore-backup-service'
import * as minVersionGate from './min-version-gate'

describe('AutoSyncService cloud downloads', () => {
  let db: PokerChaseDB

  beforeEach(async () => {
    const sendMessageMock = chrome.runtime.sendMessage as jest.Mock
    sendMessageMock.mockResolvedValue(undefined)
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    db.close()
    await db.delete()
  })

  test('persists older cloud pages without deriving a cursor from local history', async () => {
    const localEvent = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'stage-101',
      IsRetire: false,
      timestamp: 101
    } as ApiEvent
    const cloudEvent = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'stage-100',
      IsRetire: false,
      timestamp: 100
    } as ApiEvent
    await db.apiEvents.put(localEvent)

    const syncSpy = jest.spyOn(firestoreBackupService, 'syncFromCloud')
      .mockImplementation(async options => {
        expect(options).not.toHaveProperty('afterEvent')
        await options.onBatch([cloudEvent])
        options.onProgress?.({ current: 1, total: 1 })
        return 1
      })

    const service = new AutoSyncService(db)
    await service.performSync('download')

    expect(syncSpy).toHaveBeenCalledTimes(1)
    expect(await db.apiEvents.count()).toBe(2)
    expect(await db.apiEvents.get([100, ApiType.EVT_ENTRY_QUEUED])).toEqual(cloudEvent)
    expect(service.getSyncState()).toMatchObject({
      status: 'success',
      localLastTimestamp: 101,
      progress: { current: 1, total: 1, direction: 'download' }
    })
    expect((await db.meta.get('importStatus'))?.value).toMatchObject({
      lastProcessedTimestamp: 101,
      lastProcessedEventCount: 2
    })
  })

  test('upload: filters non-application noise before syncing, and still advances past a chunk that is 100% noise', async () => {
    // apiEvents is the raw Lake -- seed one full raw chunk (SYNC_CHUNK_SIZE)
    // of nothing but non-application keepalive noise, followed by a single
    // valid application event just past that chunk boundary. Without
    // advancing the upload cursor on the *raw* chunk boundary (rather than
    // the app-type-filtered subset), the first chunk would filter down to
    // zero events, `lastEvent` would be undefined, lastProcessedTimestamp
    // would never advance, and the loop would refetch the same all-noise
    // chunk forever.
    const chunkSize = DATABASE_CONSTANTS.SYNC_CHUNK_SIZE
    const noiseEvents = Array.from({ length: chunkSize }, (_, i) => ({
      ApiTypeId: 202, Code: 0, timestamp: i + 1
    }))
    const validEvent = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'stage-past-noise',
      IsRetire: false,
      timestamp: chunkSize + 1
    } as ApiEvent

    await db.apiEvents.bulkAdd(noiseEvents as any)
    await db.apiEvents.add(validEvent)

    jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockResolvedValue(null)
    const syncBatchSpy = jest.spyOn(firestoreBackupService, 'syncToCloudBatch')
      .mockResolvedValue({ totalEvents: 1, syncedEvents: 1, lastSyncTime: new Date() })

    const service = new AutoSyncService(db)
    await service.performSync('upload')

    // Loop must have terminated (performSync resolved) and reached the second,
    // real chunk -- proving the cursor advanced past the all-noise first chunk.
    expect(syncBatchSpy).toHaveBeenCalledTimes(1)
    const [uploadedChunk] = syncBatchSpy.mock.calls[0]!
    expect(uploadedChunk).toEqual([validEvent])
    expect(service.getSyncState().status).toBe('success')
  }, 15000)

  test('latches _isSyncing BEFORE the awaited min-version gate so two concurrent performSync() calls cannot both pass the guard (codex review P2, race fix)', async () => {
    const service = new AutoSyncService(db)

    // Hold the gate check open so both performSync() calls' synchronous
    // prologue (up to their first await) runs before either resolves --
    // this is exactly the interleaving window the old code (which set
    // `_isSyncing = true` AFTER awaiting the gate) was vulnerable to: a
    // second call arriving in that window used to see `_isSyncing === false`
    // and slip through the guard too.
    let resolveGate: ((blocked: boolean) => void) | undefined
    const gateSpy = jest.spyOn(minVersionGate, 'isCloudSyncBlockedByMinVersionGate')
      .mockImplementation(() => new Promise<boolean>(resolve => { resolveGate = resolve }))
    const getCloudMaxTimestampSpy = jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp')
      .mockResolvedValue(null)

    const firstSync = service.performSync('upload')
    const secondSync = service.performSync('upload')

    // By the time both calls have been issued (synchronously, before the
    // gate promise resolves), the latch must already be set -- proving the
    // first call set it before yielding at the `await` for the gate.
    expect((service as any)._isSyncing).toBe(true)

    resolveGate?.(false) // gate: not blocked
    await firstSync
    await secondSync

    // The second call must have short-circuited on the `_isSyncing` check
    // synchronously (before ever reaching the gate/cloud calls) -- if the
    // latch race were still present, both calls would reach the gate and
    // both would call getCloudMaxTimestamp.
    expect(gateSpy).toHaveBeenCalledTimes(1)
    expect(getCloudMaxTimestampSpy).toHaveBeenCalledTimes(1)
    expect((service as any)._isSyncing).toBe(false)
  })

  test('releases the _isSyncing latch (via finally) even when the min-version gate blocks the sync', async () => {
    const service = new AutoSyncService(db)
    jest.spyOn(minVersionGate, 'isCloudSyncBlockedByMinVersionGate').mockResolvedValue(true)

    await service.performSync('upload')

    expect(service.getSyncState().status).toBe('error')
    expect((service as any)._isSyncing).toBe(false)

    // Latch was released, so a subsequent sync attempt is not blocked by a
    // stuck `_isSyncing` flag (only by the gate itself, re-checked below).
    jest.spyOn(minVersionGate, 'isCloudSyncBlockedByMinVersionGate').mockResolvedValue(false)
    jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockResolvedValue(null)
    await service.performSync('upload')
    expect(service.getSyncState().status).toBe('success')
  })
})
