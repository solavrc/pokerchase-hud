import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { PokerChaseDB } from '../db/poker-chase-db'
import { ApiType, BattleType } from '../types'
import type { ApiEvent } from '../types'
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

  test('persists each cloud page and resumes after the latest local timestamp', async () => {
    const localEvent = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'stage-100',
      IsRetire: false,
      timestamp: 100
    } as ApiEvent
    const cloudEvent = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'stage-101',
      IsRetire: false,
      timestamp: 101
    } as ApiEvent
    await db.apiEvents.put(localEvent)

    const syncSpy = jest.spyOn(firestoreBackupService, 'syncFromCloud')
      .mockImplementation(async options => {
        expect(options.afterEvent).toEqual({
          timestamp: 100,
          apiTypeId: ApiType.EVT_ENTRY_QUEUED
        })
        await options.onBatch([cloudEvent])
        options.onProgress?.({ current: 1, total: 1 })
        return 1
      })

    const service = new AutoSyncService(db)
    await service.performSync('download')

    expect(syncSpy).toHaveBeenCalledTimes(1)
    expect(await db.apiEvents.count()).toBe(2)
    expect(await db.apiEvents.get([101, ApiType.EVT_ENTRY_QUEUED])).toEqual(cloudEvent)
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
})
