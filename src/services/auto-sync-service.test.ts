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

  test('upload: a normal chunk of only valid application events uploads and advances the cloud watermark past every event (unaffected by the unparseable-row guard)', async () => {
    const firstEntry = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'stage-1',
      IsRetire: false,
      timestamp: 100
    } as ApiEvent
    const secondEntry = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'stage-2',
      IsRetire: false,
      timestamp: 200
    } as ApiEvent
    await db.apiEvents.bulkAdd([firstEntry, secondEntry] as any)

    jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockResolvedValue(null)
    const syncBatchSpy = jest.spyOn(firestoreBackupService, 'syncToCloudBatch')
      .mockResolvedValue({ totalEvents: 2, syncedEvents: 2, lastSyncTime: new Date() })

    const service = new AutoSyncService(db)
    await service.performSync('upload')

    expect(syncBatchSpy).toHaveBeenCalledTimes(1)
    const [uploadedChunk, floor] = syncBatchSpy.mock.calls[0]!
    expect(uploadedChunk).toEqual([firstEntry, secondEntry])
    expect(floor).toBeNull() // no cloud data yet, no unparseable rows -- scan floor unchanged
    expect(service.getSyncState().status).toBe('success')
    // No unparseable-application rows were ever seen, so no floor marker is persisted.
    expect(await db.meta.get('syncUnparseableFloor')).toBeUndefined()
  })

  test('unparseable application-typed row is never permanently skipped by the cloud watermark, and a later schema-recovery re-includes it (PR #142 review r3611258695)', async () => {
    const firstEntry = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'stage-1',
      IsRetire: false,
      timestamp: 100
    } as ApiEvent
    // ApiTypeId 309 (EVT_SESSION_RESULTS) is an application type, but this raw
    // row is missing every required field -- it fails Zod validation exactly
    // like the season-3 payload break did. It's still stored in the Raw Event
    // Lake (event-ingestion.ts stores raw rows regardless of parseability),
    // just not forwarded to the pipeline or included in the app-type-filtered
    // upload chunk.
    const brokenSessionResults = { ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 200 }
    // A later session's start event -- newer than the broken row, and what
    // would (without this fix) push Firestore's own max timestamp past it.
    const nextSessionEntry = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'stage-2',
      IsRetire: false,
      timestamp: 300
    } as ApiEvent

    await db.apiEvents.bulkAdd([firstEntry, brokenSessionResults, nextSessionEntry] as any)

    const cloudMaxSpy = jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp')
    const syncBatchSpy = jest.spyOn(firestoreBackupService, 'syncToCloudBatch')
      .mockResolvedValue({ totalEvents: 0, syncedEvents: 2, lastSyncTime: new Date() })

    const service = new AutoSyncService(db)

    // --- Sync #1: first ever sync, nothing in Firestore yet ---------------
    cloudMaxSpy.mockResolvedValueOnce(null)
    await service.performSync('upload')

    expect(syncBatchSpy).toHaveBeenCalledTimes(1)
    const [firstChunk] = syncBatchSpy.mock.calls[0]!
    // The broken 309 is excluded from the upload chunk -- only the two valid
    // events go to Firestore. In the real service, Firestore's own max
    // timestamp becomes 300 (the highest *uploaded* row), which is what the
    // next getCloudMaxTimestamp() call is simulating below.
    expect(firstChunk).toEqual([firstEntry, nextSessionEntry])

    // The fix must have recorded the broken row so it isn't orphaned once the
    // cloud watermark moves past it.
    expect((await db.meta.get('syncUnparseableFloor'))?.value).toBe(200)

    // --- Sync #2: before any schema fix, cloud max is already past the ------
    // broken row (300). The buggy version of this code computes
    // `totalCount = count(timestamp > 300) = 0` here and returns immediately
    // without ever looking at the broken row again -- permanently orphaning
    // it even after a future fix. The fixed version must rewind its scan
    // floor below the pending marker and keep re-offering it.
    cloudMaxSpy.mockResolvedValueOnce(300)
    await service.performSync('upload')

    expect(syncBatchSpy).toHaveBeenCalledTimes(2)
    const [secondChunk, secondFloor] = syncBatchSpy.mock.calls[1]!
    // Still can't upload the broken row (schema hasn't been fixed), but the
    // scan floor was rewound to just below the pending marker (200 - 1 = 199)
    // instead of trusting the real cloud max (300) -- proving the row is
    // still being re-scanned, not skipped.
    expect(secondFloor).toBe(199)
    // firstEntry (timestamp 100) sits below the rewound floor (199), so it's
    // not re-scanned -- only rows from the broken row's timestamp onward are.
    expect(secondChunk).toEqual([nextSessionEntry])
    expect((await db.meta.get('syncUnparseableFloor'))?.value).toBe(200) // still pending

    // --- Simulate the schema recovery --------------------------------------
    // The raw bytes for this exact [timestamp, ApiTypeId] key are replaced
    // with a shape that now validates -- the closest a unit test can get to
    // "PokerChase's schema break gets fixed and the app re-validates the same
    // raw row" without swapping Zod schemas at runtime. This mirrors the
    // actual recovery mechanism documented for `filterValidApplicationEvents`
    // (src/utils/database-utils.ts): the exact same raw row is re-validated,
    // no separate promotion step exists.
    const recoveredSessionResults = {
      ApiTypeId: ApiType.EVT_SESSION_RESULTS,
      timestamp: 200,
      Ranking: 3,
      IsLeave: false,
      IsRebuy: false,
      TotalMatch: 100,
      RankReward: {
        IsSeasonal: true,
        RankPoint: 10,
        RankPointDiff: 1,
        Rank: { RankId: 'gold', RankName: 'ゴールド', RankLvId: 'gold', RankLvName: 'ゴールド' },
        SeasonalRanking: 0
      },
      Rewards: [],
      EventRewards: [],
      Charas: [],
      Costumes: [],
      Decos: [],
      Items: [],
      Money: { FreeMoney: -1, PaidMoney: -1 },
      Emblems: []
    } as unknown as ApiEvent
    await db.apiEvents.put(recoveredSessionResults)

    // --- Sync #3: schema is fixed, next sync uploads the recovered row -----
    cloudMaxSpy.mockResolvedValueOnce(300)
    await service.performSync('upload')

    expect(syncBatchSpy).toHaveBeenCalledTimes(3)
    const [thirdChunk] = syncBatchSpy.mock.calls[2]!
    expect(thirdChunk).toEqual(expect.arrayContaining([
      expect.objectContaining({ ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 200 })
    ]))

    // Fully resolved: no unparseable rows remain, so the floor marker clears
    // and future syncs stop rewinding.
    expect(await db.meta.get('syncUnparseableFloor')).toBeUndefined()
  })

  test('backfills the sync floor from a pre-existing unparseable row below the cloud watermark on first sync after upgrade (codex review r3614189343)', async () => {
    // Simulates a user who already has a season-3-style unparseable 309 in
    // their local Raw Event Lake, uploaded by an OLDER version of the
    // extension -- before this floor mechanism (or this ordering fix)
    // existed -- so the cloud watermark is already past it and no
    // `syncUnparseableFloor` marker was ever recorded. Without a backfill,
    // the very first `scanFloor` computation would trust `cloudMaxTimestamp`
    // outright and never look at this row again.
    const oldValidEntry = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'stage-pre-upgrade',
      IsRetire: false,
      timestamp: 100
    } as ApiEvent
    const preExistingOrphan = { ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 200 }
    const newEntryAboveCloudMax = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'stage-post-upgrade',
      IsRetire: false,
      timestamp: 400
    } as ApiEvent

    await db.apiEvents.bulkAdd([oldValidEntry, preExistingOrphan, newEntryAboveCloudMax] as any)

    // Cloud already advanced to 300 by the pre-fix version of the extension
    // -- strictly past the orphan (200) -- with a completely fresh `meta`
    // table (no floor, no backfill-done flag), simulating first sync after
    // upgrading to this fix.
    const cloudMaxSpy = jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockResolvedValue(300)
    const syncBatchSpy = jest.spyOn(firestoreBackupService, 'syncToCloudBatch')
      .mockResolvedValue({ totalEvents: 1, syncedEvents: 1, lastSyncTime: new Date() })

    expect(await db.meta.get('syncUnparseableFloor')).toBeUndefined()
    expect(await db.meta.get('syncUnparseableFloorBackfillDone')).toBeUndefined()

    const service = new AutoSyncService(db)
    await service.performSync('upload')

    // The backfill scan must have found the pre-existing orphan and seeded
    // the floor from it BEFORE trusting the cloud max as the scan start.
    expect((await db.meta.get('syncUnparseableFloor'))?.value).toBe(200)
    expect((await db.meta.get('syncUnparseableFloorBackfillDone'))?.value).toBe(true)

    // With the floor seeded, the scan floor rewinds to 199 -- re-offering
    // the orphan even though the cloud max (300) is well past it -- and the
    // newer row (400) still uploads normally.
    expect(syncBatchSpy).toHaveBeenCalledTimes(1)
    const [uploadedChunk, floor] = syncBatchSpy.mock.calls[0]!
    expect(floor).toBe(199)
    expect(uploadedChunk).toEqual([newEntryAboveCloudMax])

    // --- Second sync: the backfill must not run again (one-time, idempotent) ---
    cloudMaxSpy.mockResolvedValueOnce(300)
    await service.performSync('upload')
    // Only one more syncToCloudBatch call (the rewound re-offer of the still-
    // broken orphan's chunk) -- not a third from a re-triggered backfill scan
    // re-discovering and re-uploading the same already-synced row.
    expect(syncBatchSpy).toHaveBeenCalledTimes(2)
  })

  test('holds the sync floor at its old value across a failed upload of a just-recovered row, and only advances it once that upload is confirmed (codex review r3614189347)', async () => {
    // Pre-seed state as if a previous pass already recorded row@100 as the
    // pending floor (it was unparseable then). Also mark the backfill done
    // so this test exercises only the advance/hold behavior, not backfill.
    await db.meta.put({ id: 'syncUnparseableFloor', value: 100, updatedAt: Date.now() })
    await db.meta.put({ id: 'syncUnparseableFloorBackfillDone', value: true, updatedAt: Date.now() })

    // row@100 has SINCE become parseable (the schema fix landed) -- it will
    // be included in this pass's upload chunk. row@200 is a DIFFERENT,
    // newly-discovered still-unparseable row in the very same raw chunk.
    // row@300 is an ordinary valid row after both.
    const recoveredRow = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'stage-recovered',
      IsRetire: false,
      timestamp: 100
    } as ApiEvent
    const newOrphan = { ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 200 }
    const laterValidRow = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'stage-later',
      IsRetire: false,
      timestamp: 300
    } as ApiEvent
    await db.apiEvents.bulkAdd([recoveredRow, newOrphan, laterValidRow] as any)

    jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockResolvedValue(500)
    const syncBatchSpy = jest.spyOn(firestoreBackupService, 'syncToCloudBatch')

    // --- Sync #1: the upload of this chunk (which includes the recovered ---
    // row@100) fails, simulating a Firestore write error or the service
    // worker dying mid-batch.
    syncBatchSpy.mockRejectedValueOnce(new Error('simulated Firestore write failure'))

    const service = new AutoSyncService(db)
    await service.performSync('upload')

    expect(syncBatchSpy).toHaveBeenCalledTimes(1)
    const [firstAttemptChunk, firstAttemptFloor] = syncBatchSpy.mock.calls[0]!
    // Scan floor rewound to just below the OLD pending marker (100 - 1 =
    // 99), re-offering row@100 despite the newer cloud max (500).
    expect(firstAttemptFloor).toBe(99)
    expect(firstAttemptChunk).toEqual([recoveredRow, laterValidRow])

    // The critical assertion (P1 #2): even though this chunk's raw scan
    // discovered a NEW later orphan (row@200) and the recovered row@100 was
    // about to be uploaded, the failed upload must NOT have left the floor
    // advanced to 200 -- if it had, the next sync would rewind only to 199
    // and never re-offer row@100, which was never actually confirmed
    // uploaded. The floor must still be exactly the OLD value (100).
    expect((await db.meta.get('syncUnparseableFloor'))?.value).toBe(100)
    expect(service.getSyncState().status).toBe('error')

    // --- Sync #2: the same upload now succeeds. ------------------------------
    syncBatchSpy.mockResolvedValueOnce({ totalEvents: 2, syncedEvents: 2, lastSyncTime: new Date() })
    await service.performSync('upload')

    expect(syncBatchSpy).toHaveBeenCalledTimes(2)
    const [secondAttemptChunk, secondAttemptFloor] = syncBatchSpy.mock.calls[1]!
    // Still rewound the same way -- row@100 is re-offered again (proving it
    // was never dropped after the failed attempt).
    expect(secondAttemptFloor).toBe(99)
    expect(secondAttemptChunk).toEqual([recoveredRow, laterValidRow])

    // Only now -- after this upload was awaited and confirmed -- is it safe
    // to advance the floor, and it advances to the new orphan's timestamp
    // (200), not clear entirely (row@200 is still pending).
    expect((await db.meta.get('syncUnparseableFloor'))?.value).toBe(200)
    expect(service.getSyncState().status).toBe('success')
  })

  test('persists the unparseable floor to meta BEFORE uploading any later-timestamped valid row in the same chunk (codex review r3614064524, crash-window regression)', async () => {
    const firstEntry = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'stage-1',
      IsRetire: false,
      timestamp: 100
    } as ApiEvent
    // Application-typed but unparseable, same as the season-3 payload break.
    const brokenSessionResults = { ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 200 }
    // Newer than the broken row -- the row whose upload would (pre-fix) be
    // allowed to advance Firestore's own max past the still-unrecorded orphan.
    const nextSessionEntry = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'stage-2',
      IsRetire: false,
      timestamp: 300
    } as ApiEvent

    await db.apiEvents.bulkAdd([firstEntry, brokenSessionResults, nextSessionEntry] as any)

    jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockResolvedValue(null)

    // Record the interleaving of the durable meta write (what actually makes
    // the floor crash-safe -- a real IndexedDB write via fake-indexeddb, not
    // just an in-memory variable) against the Firestore upload call that is
    // what allows a subsequent getCloudMaxTimestamp() to observe a cloud max
    // past the orphan. This is the exact ordering the crash window depends
    // on: if the service worker were terminated between these two calls, a
    // durable floor (persisted first) survives; without it (persisted only
    // after), the row is permanently orphaned -- which is what the pre-fix
    // code did (it deferred the sole `persistUnparseableSyncFloor` call to
    // after the whole while-loop, i.e. after every chunk's upload).
    const callOrder: string[] = []
    const realMetaPut = db.meta.put.bind(db.meta)
    ;(jest.spyOn(db.meta, 'put') as jest.SpyInstance).mockImplementation((item: any) => {
      callOrder.push(`meta.put:${item.id}=${JSON.stringify(item.value)}`)
      return realMetaPut(item)
    })
    jest.spyOn(firestoreBackupService, 'syncToCloudBatch').mockImplementation(async (chunk: ApiEvent[]) => {
      callOrder.push(`syncToCloudBatch:${chunk.map(e => e.timestamp).join(',')}`)
      return { totalEvents: chunk.length, syncedEvents: chunk.length, lastSyncTime: new Date() }
    })

    const service = new AutoSyncService(db)
    await service.performSync('upload')

    // The uploaded chunk is [firstEntry(100), nextSessionEntry(300)] -- the
    // broken row (200) is filtered out of the upload but nextSessionEntry
    // (300) is timestamped AFTER it and sits in the very same raw chunk.
    const floorPutIndex = callOrder.findIndex(entry => entry.startsWith('meta.put:syncUnparseableFloor=200'))
    const uploadIndex = callOrder.findIndex(entry => entry.startsWith('syncToCloudBatch:100,300'))

    expect(floorPutIndex).toBeGreaterThanOrEqual(0)
    expect(uploadIndex).toBeGreaterThanOrEqual(0)
    // happens-before: the durable floor write must complete before the
    // upload call that could push the cloud max past the orphan it guards.
    expect(floorPutIndex).toBeLessThan(uploadIndex)

    // Sanity: the persisted value actually is the orphan's timestamp.
    expect((await db.meta.get('syncUnparseableFloor'))?.value).toBe(200)
  })

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
