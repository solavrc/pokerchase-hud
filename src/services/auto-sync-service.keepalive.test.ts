import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { setImmediate as nodeSetImmediate } from 'node:timers'
import { PokerChaseDB } from '../db/poker-chase-db'
import { BattleType, ApiType, type ApiEvent } from '../types'
import * as databaseUtils from '../utils/database-utils'
import { setOperationState } from '../background/operation-state'
import { firestoreBackupService } from './firestore-backup-service'
import * as minVersionGate from './min-version-gate'
import { AutoSyncService, REBUILD_AFTER_DOWNLOAD_FAILED_MESSAGE } from './auto-sync-service'

const CLOUD_EVENT = {
  ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
  Code: 0,
  BattleType: BattleType.SIT_AND_GO,
  Id: 'cloud-rebuild-keepalive',
  IsRetire: false,
  timestamp: 100
} as ApiEvent

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  while (!predicate()) {
    await new Promise<void>(resolve => nodeSetImmediate(resolve))
  }
}

describe('AutoSyncService cloud-rebuild MV3 keepalive', () => {
  let db: PokerChaseDB

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    setOperationState({ type: 'idle' })
    ;(chrome.runtime.sendMessage as jest.Mock).mockResolvedValue(undefined)
    ;(chrome.runtime as any).getPlatformInfo = jest.fn().mockResolvedValue({})
    jest.spyOn(minVersionGate, 'isCloudSyncBlockedByMinVersionGate').mockResolvedValue(false)
    jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockResolvedValue(null)
  })

  afterEach(async () => {
    setOperationState({ type: 'idle' })
    jest.clearAllTimers()
    jest.useRealTimers()
    jest.restoreAllMocks()
    db.close()
    await db.delete()
  })

  test('keeps a cold worker alive through a replay longer than 30 seconds and clears the timer on success', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] })
    await db.apiEvents.add(CLOUD_EVENT)

    const realFilter = databaseUtils.filterValidApplicationEvents
    let releaseReplay: (() => void) | undefined
    jest.spyOn(databaseUtils, 'filterValidApplicationEvents').mockImplementationOnce(async events => {
      await new Promise<void>(resolve => { releaseReplay = resolve })
      return realFilter(events)
    })
    jest.spyOn(firestoreBackupService, 'syncFromCloud').mockImplementation(async options => {
      await options.onBatch([CLOUD_EVENT])
      return 1
    })
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval')

    const service = new AutoSyncService(db)
    const rebuild = service.performSync('download')
    await waitUntil(() => releaseReplay !== undefined)

    expect(chrome.runtime.getPlatformInfo).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(25_000)
    expect(chrome.runtime.getPlatformInfo).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(6_000)

    releaseReplay!()
    await expect(rebuild).resolves.toEqual({ success: true })

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(50_000)
    expect(chrome.runtime.getPlatformInfo).toHaveBeenCalledTimes(2)
  })

  test('clears the timer when replay rejects with an abort-like cancellation', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] })
    await db.apiEvents.add(CLOUD_EVENT)
    jest.spyOn(databaseUtils, 'filterValidApplicationEvents')
      .mockRejectedValueOnce(new DOMException('replay cancelled', 'AbortError'))
    jest.spyOn(firestoreBackupService, 'syncFromCloud').mockImplementation(async options => {
      await options.onBatch([CLOUD_EVENT])
      return 1
    })
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval')

    const service = new AutoSyncService(db)
    await expect(service.performSync('download')).resolves.toEqual({
      success: false,
      error: `${REBUILD_AFTER_DOWNLOAD_FAILED_MESSAGE} (replay cancelled)`
    })

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(50_000)
    expect(chrome.runtime.getPlatformInfo).toHaveBeenCalledTimes(1)
  })

  test('preserves a partial download failure as the primary error and still clears the recovery-rebuild timer', async () => {
    jest.spyOn(firestoreBackupService, 'syncFromCloud').mockImplementation(async options => {
      await options.onBatch([CLOUD_EVENT])
      throw new Error('Cloud sync failed: Firestore REST request failed: 503')
    })
    jest.spyOn(databaseUtils, 'filterValidApplicationEvents')
      .mockRejectedValueOnce(new Error('derived-table save failed'))
    const setIntervalSpy = jest.spyOn(global, 'setInterval')
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval')

    const service = new AutoSyncService(db)
    const outcome = await service.performSync('download')

    expect(outcome).toEqual({
      success: false,
      error: expect.stringContaining('Firestore REST request failed: 503')
    })
    expect(service.getSyncState().error).not.toContain('derived-table save failed')
    const keepAliveCallIndex = setIntervalSpy.mock.calls.findIndex(([, delay]) => delay === 25_000)
    expect(keepAliveCallIndex).toBeGreaterThanOrEqual(0)
    expect(clearIntervalSpy).toHaveBeenCalledWith(setIntervalSpy.mock.results[keepAliveCallIndex]!.value)
  })

  test('does not arm a timer when the operation gate blocks sync, and an overlapping sync cannot create a second timer', async () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval')

    setOperationState({ type: 'import' })
    const blockedService = new AutoSyncService(db)
    await expect(blockedService.performSync('download')).resolves.toEqual({
      success: false,
      error: expect.stringContaining('実行中'),
      reason: 'operation-busy'
    })
    expect(setIntervalSpy).not.toHaveBeenCalled()

    setOperationState({ type: 'idle' })
    await db.apiEvents.add(CLOUD_EVENT)
    let releaseReplay: (() => void) | undefined
    const realFilter = databaseUtils.filterValidApplicationEvents
    jest.spyOn(databaseUtils, 'filterValidApplicationEvents').mockImplementationOnce(async events => {
      await new Promise<void>(resolve => { releaseReplay = resolve })
      return realFilter(events)
    })
    jest.spyOn(firestoreBackupService, 'syncFromCloud').mockImplementation(async options => {
      await options.onBatch([CLOUD_EVENT])
      return 1
    })

    const ownerService = new AutoSyncService(db)
    const owner = ownerService.performSync('download')
    await waitUntil(() => releaseReplay !== undefined)
    const overlap = await ownerService.performSync('download')

    expect(overlap).toEqual({
      success: false,
      error: expect.stringContaining('実行中')
    })
    expect(setIntervalSpy.mock.calls.filter(([, delay]) => delay === 25_000)).toHaveLength(1)

    releaseReplay!()
    await expect(owner).resolves.toEqual({ success: true })
    expect(setIntervalSpy.mock.calls.filter(([, delay]) => delay === 25_000)).toHaveLength(1)
  })
})
