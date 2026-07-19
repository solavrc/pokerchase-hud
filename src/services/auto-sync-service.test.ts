import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { PokerChaseDB } from '../db/poker-chase-db'
import { ApiType, BattleType } from '../types'
import type { ApiEvent } from '../types'
import { DATABASE_CONSTANTS } from '../constants/database'
import { AutoSyncService } from './auto-sync-service'
import { firestoreBackupService } from './firestore-backup-service'

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
})
