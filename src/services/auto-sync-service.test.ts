import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { PokerChaseDB } from '../db/poker-chase-db'
import { ApiType, ApiTypeValues, BattleType, BetStatusType } from '../types'
import type { ApiEvent } from '../types'
import { DATABASE_CONSTANTS } from '../constants/database'
import { EntityConverter } from '../entity-converter'
import { AutoSyncService, REBUILD_AFTER_DOWNLOAD_FAILED_MESSAGE } from './auto-sync-service'
import { firestoreBackupService } from './firestore-backup-service'
import { firebaseAuthService } from './firebase-auth-service'
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
      timestamp: 101,
      sequence: 0
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
    expect(await db.apiEvents.get([100, ApiType.EVT_ENTRY_QUEUED, 0])).toEqual({ ...cloudEvent, sequence: 0 })
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

  test('restores legacy-ID and sequence-ID cloud documents sharing timestamp+ApiTypeId as distinct local rows', async () => {
    const legacyDocument = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'legacy-document',
      IsRetire: false,
      timestamp: 500
    } as ApiEvent
    const sequenceDocument = {
      ...legacyDocument,
      Id: 'sequence-document',
      sequence: 1
    } as ApiEvent

    jest.spyOn(firestoreBackupService, 'syncFromCloud').mockImplementation(async options => {
      await options.onBatch([legacyDocument, sequenceDocument])
      options.onProgress?.({ current: 2, total: 2 })
      return 2
    })

    const service = new AutoSyncService(db)
    await service.performSync('download')

    const stored = await db.apiEvents
      .where('[timestamp+ApiTypeId]')
      .equals([500, ApiType.EVT_ENTRY_QUEUED])
      .sortBy('sequence') as any[]
    expect(stored).toEqual([
      { ...legacyDocument, sequence: 0 },
      sequenceDocument
    ])
  })

  test('a failed derived-table rebuild after download surfaces as a sync ERROR and is not marked as done (release audit 2026-07-21, finding 5)', async () => {
    const cloudEvent = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'stage-rebuild-fail',
      IsRetire: false,
      timestamp: 100
    } as ApiEvent

    // Download succeeds and durably stores the raw event...
    jest.spyOn(firestoreBackupService, 'syncFromCloud')
      .mockImplementation(async options => {
        await options.onBatch([cloudEvent])
        return 1
      })
    // ...but deriving hands/phases/actions from it fails (quota, transaction
    // abort, malformed chunk -- any error in the rebuild path).
    jest.spyOn(EntityConverter.prototype, 'convertEventChunk').mockImplementation(() => {
      throw new Error('QuotaExceededError: derived-table save failed')
    })

    const service = new AutoSyncService(db)
    await service.performSync('download')

    // The pass must NOT be reported as a success -- before this fix the
    // rebuild error was swallowed and the popup showed 成功 over stale stats.
    const state = service.getSyncState()
    expect(state.status).toBe('error')
    expect(state.error).toContain(REBUILD_AFTER_DOWNLOAD_FAILED_MESSAGE)
    expect(state.error).toContain('QuotaExceededError')

    // The error state reaches the popup via the same chrome.runtime message
    // channel every other sync-state change already uses.
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SYNC_STATE_UPDATE',
        state: expect.objectContaining({ status: 'error' })
      })
    )

    // Raw Event Lake invariant: the downloaded raw event stays stored -- only
    // the derived tables are stale.
    expect(await db.apiEvents.count()).toBe(1)

    // A failed rebuild is never marked complete: `importStatus` (the rebuild's
    // own completion bookkeeping) must remain untouched so nothing claims the
    // derived tables are current.
    expect(await db.meta.get('importStatus')).toBeUndefined()
  })

  test('partial download (page 1 durable, page 2 fails) with a failing rebuild still surfaces the DOWNLOAD error and leaves no completion bookkeeping (release audit 2026-07-21, coverage gap #5)', async () => {
    const pageOneEvent = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'stage-page-1',
      IsRetire: false,
      timestamp: 100
    } as ApiEvent

    // Page 1 lands via onBatch, then the next REST page fails.
    jest.spyOn(firestoreBackupService, 'syncFromCloud')
      .mockImplementation(async options => {
        await options.onBatch([pageOneEvent])
        throw new Error('Cloud sync failed: Firestore REST request failed: 503')
      })
    // The best-effort rebuild over the partial data fails as well.
    jest.spyOn(EntityConverter.prototype, 'convertEventChunk').mockImplementation(() => {
      throw new Error('derived-table save failed')
    })

    const service = new AutoSyncService(db)
    await service.performSync('download')

    // The download failure is the primary error surfaced (the rebuild
    // failure is logged, not allowed to mask the root cause).
    const state = service.getSyncState()
    expect(state.status).toBe('error')
    expect(state.error).toContain('503')

    // Page 1's raw events remain durable, and nothing marked the rebuild done.
    expect(await db.apiEvents.count()).toBe(1)
    expect(await db.meta.get('importStatus')).toBeUndefined()
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

  test('upload: reports raw, valid, filtered, deferred, and acknowledged counts without implying data loss', async () => {
    const validEvents = [100, 500].map(timestamp => ({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: `stage-${timestamp}`,
      IsRetire: false,
      timestamp
    } as ApiEvent))
    const nonApplicationNoise = [
      { ApiTypeId: 202, Code: 0, timestamp: 200 },
      { ApiTypeId: 311, NotifyCode: 1, timestamp: 300 }
    ]
    const unparseableApplicationEvent = {
      ApiTypeId: ApiType.EVT_SESSION_RESULTS,
      timestamp: 400
    }
    await db.apiEvents.bulkAdd([
      validEvents[0],
      nonApplicationNoise[0],
      nonApplicationNoise[1],
      unparseableApplicationEvent,
      validEvents[1]
    ] as any)

    jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockResolvedValue(null)
    jest.spyOn(firestoreBackupService, 'syncToCloudBatch')
      .mockResolvedValue({ totalEvents: 2, syncedEvents: 2, lastSyncTime: new Date() })
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})

    const service = new AutoSyncService(db)
    await service.performSync('upload')

    expect(logSpy).toHaveBeenCalledWith(
      '[AutoSync] Upload scan snapshot has 5 raw events; application-event validation runs per chunk'
    )
    expect(logSpy).toHaveBeenCalledWith(
      '[AutoSync] Upload pass complete: scanned raw=5; valid application=2; ' +
      'acknowledged Firestore writes=2; filtered non-application/unknown=2; ' +
      'deferred unparseable application=1'
    )
    expect(service.getSyncState().progress).toEqual({
      current: 5,
      total: 5,
      direction: 'upload'
    })
    expect((await db.meta.get('syncUnparseableFloor'))?.value).toBe(400)
  })

  test('upload: distinguishes the trigger snapshot from raw events arriving during the cloud watermark read', async () => {
    const initialEvents = [100, 200, 300].map(timestamp => ({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: `stage-${timestamp}`,
      IsRetire: false,
      timestamp
    } as ApiEvent))
    await db.apiEvents.bulkAdd(initialEvents)

    jest.spyOn(firebaseAuthService, 'getCurrentUser').mockReturnValue({ uid: 'test-user' } as any)
    jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp')
      .mockImplementationOnce(async () => {
        // Mirrors the reported runtime ordering: the trigger count is logged,
        // then more raw WebSocket events land while Firestore's watermark is
        // being fetched. The later upload scan correctly sees both snapshots.
        await db.apiEvents.bulkAdd([
          { ApiTypeId: 202, Code: 0, timestamp: 400 },
          { ApiTypeId: 311, NotifyCode: 1, timestamp: 500 }
        ] as any)
        return null
      })
      .mockResolvedValue(null)
    jest.spyOn(firestoreBackupService, 'syncToCloudBatch')
      .mockImplementation(async (events: ApiEvent[]) => ({
        totalEvents: events.length,
        syncedEvents: events.length,
        lastSyncTime: new Date()
      }))
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})

    const service = new AutoSyncService(db)
    ;(service as any).EVENTS_THRESHOLD = 3
    await service.onGameSessionEnd()

    expect(logSpy).toHaveBeenCalledWith(
      '[AutoSync] Game ended with 3 raw events since the last completed sync, performing upload sync...'
    )
    expect(logSpy).toHaveBeenCalledWith(
      '[AutoSync] Upload scan snapshot has 5 raw events; application-event validation runs per chunk'
    )
    expect(logSpy).toHaveBeenCalledWith(
      '[AutoSync] Upload pass complete: scanned raw=5; valid application=3; ' +
      'acknowledged Firestore writes=3; filtered non-application/unknown=2; ' +
      'deferred unparseable application=0'
    )
  })

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
    // still being re-scanned, not skipped. 198, not 199: the P1 fix
    // (auto-sync-service.ts) shifts the threshold syncToCloudBatch actually
    // receives one further millisecond earlier -- see the threshold-shift
    // comment in the backfill test below.
    expect(secondFloor).toBe(198)
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
      sequence: 0,
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

  test('backfills the sync floor from a pre-existing unparseable row below the cloud watermark on first sync after upgrade (codex review r3614189343; P1-fixed scan, r3614469177)', async () => {
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
    expect(await db.meta.get('syncUnparseableFloorBackfillDoneV2')).toBeUndefined()

    const service = new AutoSyncService(db)
    await service.performSync('upload')

    // The backfill (P1 fix) seeds from the EARLIEST local application row
    // regardless of current parseability -- here that's oldValidEntry@100,
    // not the orphan@200 -- forcing this pass's scan to rewind all the way
    // to 99 (see below) rather than trusting the old, narrower
    // "only currently-unparseable rows" scan. Within this SAME pass, the
    // orphan@200 is then found to still be unparseable, which is what
    // advances the floor's FINAL value to 200 by the end-of-loop commit
    // (see invariant spec: only unparseable rows STILL pending at the end of
    // a fully-confirmed pass keep the floor from clearing).
    expect((await db.meta.get('syncUnparseableFloor'))?.value).toBe(200)
    expect((await db.meta.get('syncUnparseableFloorBackfillDoneV2'))?.value).toBe(true)

    // The backfill's conservative seed (100) rewinds the scan floor to 99 --
    // sweeping oldValidEntry@100 into this pass's upload alongside the
    // genuinely new row (400) -- proving the one-time full reconciliation
    // re-offer actually happened, not just a narrower re-offer of the
    // specific orphan.
    expect(syncBatchSpy).toHaveBeenCalledTimes(1)
    const [uploadedChunk, floor] = syncBatchSpy.mock.calls[0]!
    // 98, not 99: syncToCloudBatch's own dedup filter is bare-timestamp-only
    // (`event.timestamp > threshold`), so the P1 compound-key-pagination fix
    // (auto-sync-service.ts) shifts the threshold it receives one
    // millisecond earlier than the scan floor itself -- makes that filter
    // INCLUSIVE of the scan floor's own millisecond, closing the gap where a
    // not-yet-uploaded row could share that exact millisecond with a
    // different ApiTypeId than whatever pushed the cloud watermark there.
    expect(floor).toBe(98)
    expect(uploadedChunk).toEqual([oldValidEntry, newEntryAboveCloudMax])

    // --- Second sync: the backfill must not run again (one-time, idempotent) ---
    cloudMaxSpy.mockResolvedValueOnce(300)
    await service.performSync('upload')
    // Only one more syncToCloudBatch call (the rewound re-offer of the still-
    // broken orphan's chunk, now from floor 200 -> scanFloor 199) -- not a
    // third from a re-triggered backfill scan re-discovering and
    // re-uploading the already-reconciled history.
    expect(syncBatchSpy).toHaveBeenCalledTimes(2)
    const [secondChunk, secondFloor] = syncBatchSpy.mock.calls[1]!
    expect(secondFloor).toBe(198) // 199 - 1, same P1 threshold shift as above
    expect(secondChunk).toEqual([newEntryAboveCloudMax])
  })

  test('recovers a row that failed to parse at upload time but already parses again by the time the backfill runs -- schema fix and floor mechanism ship in the same release (P1 fix, codex review r3614469177, the actual season-3 upgrade scenario)', async () => {
    // Unlike the previous test, NOTHING in the local Lake is currently
    // unparseable -- `recoveredRow` represents a row that failed to parse
    // and was skipped by an upload pass BEFORE this install ever upgraded,
    // but the schema fix that makes it valid again shipped in the SAME
    // release as this floor mechanism. By the time backfillUnparseableFloorIfNeeded
    // runs, isUnparseableApplicationEvent(recoveredRow) is already false --
    // the OLD backfill (scanning only for currently-unparseable rows) would
    // find nothing, mark itself done, and permanently orphan this row since
    // the normal scan only ever looks above the cloud max going forward.
    const recoveredRow = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'recovered-orphan',
      IsRetire: false,
      timestamp: 150
    } as ApiEvent
    // A row that WAS already uploaded successfully in the past -- its
    // presence is what let the cloud max reach 300 despite recoveredRow (150)
    // sitting below it and never having made it up.
    const alreadyUploadedRow = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'already-uploaded',
      IsRetire: false,
      timestamp: 250
    } as ApiEvent
    // A genuinely new row, above the cloud max -- must still upload normally.
    const genuinelyNewRow = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'genuinely-new',
      IsRetire: false,
      timestamp: 350
    } as ApiEvent
    await db.apiEvents.bulkAdd([recoveredRow, alreadyUploadedRow, genuinelyNewRow] as any)

    jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockResolvedValue(300)
    const syncBatchSpy = jest.spyOn(firestoreBackupService, 'syncToCloudBatch')
      .mockResolvedValue({ totalEvents: 3, syncedEvents: 3, lastSyncTime: new Date() })

    const service = new AutoSyncService(db)
    await service.performSync('upload')

    expect(service.getSyncState().status).toBe('success')
    // The backfill must have seeded the floor from recoveredRow (150) -- the
    // earliest LOCAL APPLICATION ROW, not the earliest currently-unparseable
    // one (there is none) -- and the pass rewound to re-offer it.
    expect(syncBatchSpy).toHaveBeenCalledTimes(1)
    const [uploadedChunk, floor] = syncBatchSpy.mock.calls[0]!
    // 148, not 149: see the P1 threshold-shift comment in the backfill test
    // above.
    expect(floor).toBe(148)
    // recoveredRow is actually included in the upload -- this is the
    // concrete "rows below watermark, parseable, absent from cloud -> floored
    // -> uploaded on next sync" regression the finding calls for.
    expect(uploadedChunk).toEqual([recoveredRow, alreadyUploadedRow, genuinelyNewRow])

    // Nothing in this pass is STILL unparseable, so the floor fully resolves
    // and clears once the pass is confirmed -- proving this was a genuine
    // one-time reconciliation, not a permanently-stuck marker.
    expect(await db.meta.get('syncUnparseableFloor')).toBeUndefined()
  })

  test('backfill scan issues one bounded, indexed [ApiTypeId+timestamp] lookup per application type -- not an unbounded filtered cursor over the whole Lake (codex review r3615140413, P2)', async () => {
    // A single valid application row is enough to exercise the backfill scan
    // -- this test cares about HOW the scan queries the DB, not about a
    // specific seeded-floor outcome (already covered by the other backfill
    // tests above).
    const validRow = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'stage-1',
      IsRetire: false,
      timestamp: 100
    } as ApiEvent
    await db.apiEvents.add(validRow)

    jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockResolvedValue(300)
    jest.spyOn(firestoreBackupService, 'syncToCloudBatch')
      .mockResolvedValue({ totalEvents: 1, syncedEvents: 1, lastSyncTime: new Date() })

    const whereSpy = jest.spyOn(db.apiEvents, 'where')

    const service = new AutoSyncService(db)
    await service.performSync('upload')

    // Exactly one indexed range query per application type (a small fixed
    // constant -- ApiTypeValues.length, currently 9 -- not proportional to
    // Lake size) against the [ApiTypeId+timestamp] compound index. The OLD
    // implementation instead issued a single `.orderBy('[timestamp+ApiTypeId]')`
    // cursor with a `.filter()` predicate that could walk arbitrarily far
    // (unbounded above cloudMaxTimestamp, and unable to skip non-matching
    // ApiTypeIds via the index) before finding a match.
    const indexLookups = whereSpy.mock.calls.filter(([index]) => typeof index === 'string' && index === '[ApiTypeId+timestamp]')
    expect(indexLookups.length).toBe(ApiTypeValues.length)
    // The backfill scan itself never falls back to an unbounded primary-key
    // cursor with a `.filter()` predicate (that's the whole point of this
    // test). `[timestamp+ApiTypeId+sequence]` IS legitimately used elsewhere
    // in this same pass now, though: the upload-pagination fix
    // 2026-07-21) made `syncToCloud()`'s own count and per-chunk cursor key
    // uses this exact primary index (see its doc comment) -- a BOUNDED range
    // query (`.above([cursor]).count()` / `.above([cursor]).limit(N)`), not
    // the old unbounded `.filter()`-cursor pattern this test guards against.
    // Exactly 2 calls are expected here: one for `totalCount`'s `.count()`,
    // one for the single chunk fetch (this test's Lake has only one row, so
    // the loop never needs a second page).
    const primaryKeyCursorCalls = whereSpy.mock.calls.filter(([index]) => typeof index === 'string' && index === '[timestamp+ApiTypeId+sequence]')
    expect(primaryKeyCursorCalls.length).toBe(2)
  })

  test('lowers an already-persisted LATER floor to a newly discovered EARLIER orphan before that chunk uploads (P2 fix, codex review r3614469176)', async () => {
    // Pre-seed a floor at 500, as if a previous pass already found and is
    // still protecting a row at that timestamp (not yet confirmed uploaded).
    await db.meta.put({ id: 'syncUnparseableFloor', value: 500, updatedAt: Date.now() })
    await db.meta.put({ id: 'syncUnparseableFloorBackfillDoneV2', value: true, updatedAt: Date.now() })

    // The cloud watermark is still BELOW the pending floor (500) -- this is
    // the exact precondition from the review comment ("a user imports older
    // raw events while a newer syncUnparseableFloor is pending and the cloud
    // watermark is still below that floor"): scanFloor is derived from
    // cloudMaxTimestamp (300), not from the pending floor, so a NEWLY
    // imported, EARLIER unparseable row at 350 (between the cloud max and
    // the pending floor) lands inside this pass's scanned range despite
    // being earlier than what's currently persisted.
    const earlierOrphan = { ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 350 }
    const laterValidRow = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'later-valid',
      IsRetire: false,
      timestamp: 600
    } as ApiEvent
    await db.apiEvents.bulkAdd([earlierOrphan, laterValidRow] as any)

    jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockResolvedValue(300)

    // Track ordering exactly like the r3614064524 crash-window test: the
    // durable floor write for the newly discovered earlier orphan must
    // precede the chunk upload that could push Firestore's real max past it.
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

    // The floor must have been LOWERED from 500 to the newly discovered
    // earlier orphan's timestamp (350), not left at the stale, now-
    // insufficient later value.
    expect((await db.meta.get('syncUnparseableFloor'))?.value).toBe(350)

    const floorPutIndex = callOrder.findIndex(entry => entry.startsWith('meta.put:syncUnparseableFloor=350'))
    const uploadIndex = callOrder.findIndex(entry => entry.startsWith('syncToCloudBatch:600'))
    expect(floorPutIndex).toBeGreaterThanOrEqual(0)
    expect(uploadIndex).toBeGreaterThanOrEqual(0)
    // happens-before: the lowered floor's durable write must complete before
    // the upload of the later row sharing this chunk -- otherwise a crash
    // right after that upload (which can advance the cloud's real max past
    // 350) but before any later commit would leave the floor stuck at the
    // stale 500, and the next sync would rewind only to 499, never
    // re-offering the orphan at 350 again.
    expect(floorPutIndex).toBeLessThan(uploadIndex)

    // Scan floor for THIS pass was derived from the OLD (pre-lowering) 500,
    // matching the scenario precondition, and the later row still uploaded.
    const syncBatchSpy = firestoreBackupService.syncToCloudBatch as jest.Mock
    const [uploadedChunk, floor] = syncBatchSpy.mock.calls[0]!
    // 299, not 300: see the P1 threshold-shift comment in the backfill test
    // above -- this pass's scanFloor happens to land exactly on
    // cloudMaxTimestamp (300) here, which is precisely the case the shift
    // protects.
    expect(floor).toBe(299)
    expect(uploadedChunk).toEqual([laterValidRow])
  })

  test('marks the one-time backfill done immediately when the cloud is proven empty (first sync ever, nothing uploaded yet)', async () => {
    const validEntry = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'stage-1',
      IsRetire: false,
      timestamp: 100
    } as ApiEvent
    await db.apiEvents.add(validEntry)

    // `null` here is the PROVEN-empty case (a successful query that found
    // zero cloud documents), not an error -- see getCloudMaxTimestamp's doc
    // comment and the "rejects instead of swallowing" test in
    // firestore-backup-service.test.ts.
    jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockResolvedValue(null)
    jest.spyOn(firestoreBackupService, 'syncToCloudBatch')
      .mockResolvedValue({ totalEvents: 1, syncedEvents: 1, lastSyncTime: new Date() })

    expect(await db.meta.get('syncUnparseableFloorBackfillDoneV2')).toBeUndefined()

    const service = new AutoSyncService(db)
    await service.performSync('upload')

    expect(service.getSyncState().status).toBe('success')
    expect((await db.meta.get('syncUnparseableFloorBackfillDoneV2'))?.value).toBe(true)
    expect(await db.meta.get('syncUnparseableFloor')).toBeUndefined() // nothing pending
  })

  test('a transient getCloudMaxTimestamp failure does NOT mark the one-time backfill done, and the next successful sync still runs it (codex review round 4 on PR #182)', async () => {
    // Before this fix, getCloudMaxTimestamp() swallowed auth/network/REST
    // errors to `null` -- indistinguishable from "cloud proven empty" --
    // which let backfillUnparseableFloorIfNeeded() permanently mark itself
    // done off a transient failure on the very first post-upgrade sync,
    // never getting a real chance to find a pre-existing unparseable row.
    const validEntry = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'stage-1',
      IsRetire: false,
      timestamp: 100
    } as ApiEvent
    // A pre-existing unparseable row, as if left behind by a pre-fix version
    // of the extension, sitting below where the cloud watermark will turn
    // out to be once it's actually reachable.
    const preExistingOrphan = { ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 200 }
    await db.apiEvents.bulkAdd([validEntry, preExistingOrphan] as any)

    const cloudMaxSpy = jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp')
    const syncBatchSpy = jest.spyOn(firestoreBackupService, 'syncToCloudBatch')
      .mockResolvedValue({ totalEvents: 0, syncedEvents: 0, lastSyncTime: new Date() })

    // --- Sync #1: getCloudMaxTimestamp fails (network blip / REST error) ---
    cloudMaxSpy.mockRejectedValueOnce(new Error('simulated network failure'))

    const service = new AutoSyncService(db)
    await service.performSync('upload')

    expect(service.getSyncState().status).toBe('error')
    // The unguarded getCloudMaxTimestamp() call at the top of syncToCloud()
    // aborted the whole sync attempt BEFORE backfillUnparseableFloorIfNeeded()
    // was ever reached -- neither marker was touched.
    expect(await db.meta.get('syncUnparseableFloorBackfillDoneV2')).toBeUndefined()
    expect(await db.meta.get('syncUnparseableFloor')).toBeUndefined()
    expect(syncBatchSpy).not.toHaveBeenCalled()

    // --- Sync #2: cloud max now resolves successfully (proven watermark) ---
    cloudMaxSpy.mockResolvedValueOnce(300)
    await service.performSync('upload')

    expect(service.getSyncState().status).toBe('success')
    // This time the backfill ran to completion against a proven cloud state
    // and found the pre-existing orphan below that watermark.
    expect((await db.meta.get('syncUnparseableFloorBackfillDoneV2'))?.value).toBe(true)
    expect((await db.meta.get('syncUnparseableFloor'))?.value).toBe(200)
  })

  test('holds the sync floor at its old value across a failed upload of a just-recovered row, and only advances it once that upload is confirmed (codex review r3614189347)', async () => {
    // Pre-seed state as if a previous pass already recorded row@100 as the
    // pending floor (it was unparseable then). Also mark the backfill done
    // so this test exercises only the advance/hold behavior, not backfill.
    await db.meta.put({ id: 'syncUnparseableFloor', value: 100, updatedAt: Date.now() })
    await db.meta.put({ id: 'syncUnparseableFloorBackfillDoneV2', value: true, updatedAt: Date.now() })

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
    // 99), re-offering row@100 despite the newer cloud max (500). 98, not
    // 99: the P1 fix (auto-sync-service.ts) shifts the threshold
    // syncToCloudBatch actually receives one further millisecond earlier --
    // see the threshold-shift comment in the backfill test below.
    expect(firstAttemptFloor).toBe(98)
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
    // was never dropped after the failed attempt). 98, not 99: same P1
    // threshold shift as the first attempt above.
    expect(secondAttemptFloor).toBe(98)
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
    // first call set it before yielding at its first await.
    expect((service as any)._isSyncing).toBe(true)

    // Flush microtasks until the first call's execution actually reaches
    // the gate check and `resolveGate` is captured -- performSync() now has
    // an earlier `await firebaseAuthService.ready()` ahead of the gate
    // check (r3615553034), so reaching it can take more than one microtask
    // hop; polling (rather than assuming a fixed hop count) keeps this
    // test robust to that either way.
    while (!resolveGate) {
      await Promise.resolve()
    }
    resolveGate(false) // gate: not blocked
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

  test('migrates the legacy unscoped autoSyncLastTime to whichever account consumes it first, deleting it so a later DIFFERENT account is never granted it (invariant (1))', async () => {
    // Other tests in this file may leave these scoped keys set (a plain
    // module-level object in test-setup.ts, not reset per test).
    await chrome.storage.local.remove(['autoSyncLastTime', 'autoSyncLastTime:user-a', 'autoSyncLastTime:user-b'])

    const userA = { uid: 'user-a', email: 'a@example.com' } as any
    const userB = { uid: 'user-b', email: 'b@example.com' } as any
    const getCurrentUserSpy = jest.spyOn(firebaseAuthService, 'getCurrentUser')
    jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockResolvedValue(null)

    // Simulates an upgraded profile that still has the pre-scoping legacy
    // value with no account attribution.
    const legacyIso = new Date('2026-01-01T00:00:00.000Z').toISOString()
    await chrome.storage.local.set({ autoSyncLastTime: legacyIso })

    const service = new AutoSyncService(db)
    // Simulate a successful sync (sets lastSyncTime) -- a plain no-op mock
    // would leave lastSyncTime unset, which now triggers initialize()'s
    // retry-on-incomplete-first-sync logic (invariant (2b)) and inflates
    // the call count this test asserts on; that retry behavior has its own
    // dedicated test below.
    const performSyncSpy = jest.spyOn(service, 'performSync').mockImplementation(async () => {
      (service as any).syncState.lastSyncTime = new Date()
      return { success: true } as const
    })

    // --- Account A is the first to sign in after upgrade -------------------
    getCurrentUserSpy.mockReturnValue(userA)
    await service.initialize()

    // The legacy value was migrated to A's OWN scoped key and consumed (not
    // just copied) -- A is treated as already synced (no phantom first sync).
    expect(performSyncSpy).not.toHaveBeenCalled()
    const migrated = await chrome.storage.local.get(['autoSyncLastTime:user-a', 'autoSyncLastTime'])
    expect(migrated['autoSyncLastTime:user-a']).toBe(legacyIso)
    expect(migrated['autoSyncLastTime']).toBeUndefined()

    // --- Account B signs in afterward on the same device -------------------
    getCurrentUserSpy.mockReturnValue(userB)
    await service.initialize()

    // B must NOT inherit A's migrated-and-consumed legacy value -- the
    // legacy key is gone, so B correctly looks like it has never synced and
    // gets its own first-time sync.
    expect(performSyncSpy).toHaveBeenCalledTimes(1)
    expect(await chrome.storage.local.get('autoSyncLastTime:user-b')).toEqual({ 'autoSyncLastTime:user-b': undefined })
  })

  test('aborts a sync pass with ZERO bookkeeping writes for the new account if the signed-in account changes mid-pass, before the pass reaches its final commit (invariant (2))', async () => {
    await chrome.storage.local.remove(['autoSyncLastTime:user-a', 'autoSyncLastTime:user-b'])

    const userA = { uid: 'user-a', email: 'a@example.com' } as any
    const userB = { uid: 'user-b', email: 'b@example.com' } as any
    const getCurrentUserSpy = jest.spyOn(firebaseAuthService, 'getCurrentUser').mockReturnValue(userA)
    // Real account switches always bump firebase-auth-service's own auth
    // generation counter (see its doc comment) -- mocking getCurrentUser()
    // alone does NOT, since the real signInWithGoogle()/signOut() methods
    // that own that counter are never called here. Mock getAuthGeneration()
    // too, with its own local counter incremented in lockstep with every
    // simulated account switch, so assertGenerationUnchanged() sees exactly
    // what it would in production.
    let generation = 1
    jest.spyOn(firebaseAuthService, 'getAuthGeneration').mockImplementation(() => generation)

    // An unparseable row (forces a mid-pass EAGER floor persist under A's
    // scope, BEFORE the account switch below -- this write is legitimate,
    // made while A was still live, and is expected to survive) followed by
    // a later valid row.
    const orphan = { ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 200 }
    const laterValidRow = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'later-valid',
      IsRetire: false,
      timestamp: 300
    } as ApiEvent
    await db.apiEvents.bulkAdd([orphan, laterValidRow] as any)

    jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockResolvedValue(null)
    // Simulates the account switching WHILE the upload network request for
    // this chunk is in flight -- by the time it resolves, a different
    // account is signed in. Per the owner-decided scope, this upload itself
    // is allowed to proceed/complete under whichever account ends up live
    // (accepted risk) -- what must NOT happen is committing bookkeeping
    // under the wrong account afterward.
    jest.spyOn(firestoreBackupService, 'syncToCloudBatch').mockImplementation(async (chunk: ApiEvent[]) => {
      generation++
      getCurrentUserSpy.mockReturnValue(userB)
      return { totalEvents: chunk.length, syncedEvents: chunk.length, lastSyncTime: new Date() }
    })

    const service = new AutoSyncService(db)
    await service.performSync('upload')

    // The pass aborted with a clear, attributable error -- not a silent
    // partial success reported as success.
    expect(service.getSyncState().status).toBe('error')
    expect(service.getSyncState().error).toContain('sync-floor commit')

    // The EAGER persist from BEFORE the switch is legitimately under A's
    // scope and stays -- this is not what the fix prevents.
    expect((await db.meta.get('syncUnparseableFloor:user-a'))?.value).toBe(200)

    // ZERO bookkeeping writes happened under B's scope, and A's final
    // lastSyncTime commit never ran either (the pass never reached it).
    expect(await db.meta.get('syncUnparseableFloor:user-b')).toBeUndefined()
    expect(await chrome.storage.local.get('autoSyncLastTime:user-a')).toEqual({ 'autoSyncLastTime:user-a': undefined })
    expect(await chrome.storage.local.get('autoSyncLastTime:user-b')).toEqual({ 'autoSyncLastTime:user-b': undefined })
  })

  test('sign-in-mistake round trip: switching to a different account and back leaves the original account\'s own bookkeeping intact, and its next sync uploads exactly what its own cloud still lacks (owner-decided scope)', async () => {
    await chrome.storage.local.remove(['autoSyncLastTime:user-a', 'autoSyncLastTime:user-b'])

    const userA = { uid: 'user-a', email: 'a@example.com' } as any
    const userB = { uid: 'user-b', email: 'b@example.com' } as any
    const getCurrentUserSpy = jest.spyOn(firebaseAuthService, 'getCurrentUser')
    const cloudMaxSpy = jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp')
    const syncBatchSpy = jest.spyOn(firestoreBackupService, 'syncToCloudBatch')
      .mockImplementation(async (chunk: ApiEvent[]) => ({ totalEvents: chunk.length, syncedEvents: chunk.length, lastSyncTime: new Date() }))

    const rowA1 = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED, Code: 0, BattleType: BattleType.SIT_AND_GO,
      Id: 'a1', IsRetire: false, timestamp: 100
    } as ApiEvent
    await db.apiEvents.add(rowA1)

    const service = new AutoSyncService(db)

    // --- Phase 1: signed in as A, first-ever sync for A --------------------
    getCurrentUserSpy.mockReturnValue(userA)
    cloudMaxSpy.mockResolvedValue(null) // persistent for this phase -- covers both the syncToCloud() call and updateTimestamps()'s own call
    await service.performSync('upload')

    expect(syncBatchSpy).toHaveBeenCalledTimes(1)
    expect(syncBatchSpy.mock.calls[0]![0]).toEqual([rowA1])
    const aLastSyncAfterPhase1 = (await chrome.storage.local.get('autoSyncLastTime:user-a'))['autoSyncLastTime:user-a']
    expect(aLastSyncAfterPhase1).toBeDefined()

    // --- Sign-in mistake: switch to B. Local capture (the shared, --------
    // unpartitioned apiEvents Lake) keeps recording regardless of which
    // account is signed in -- a poker session B plays here adds rowB1.
    const rowB1 = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED, Code: 0, BattleType: BattleType.SIT_AND_GO,
      Id: 'b1', IsRetire: false, timestamp: 200
    } as ApiEvent
    await db.apiEvents.add(rowB1)

    getCurrentUserSpy.mockReturnValue(userB)
    cloudMaxSpy.mockResolvedValue(null) // B's own cloud is empty
    await service.performSync('upload')

    // Owner-decided scope: this upload IS allowed to send the WHOLE shared
    // local backlog (including rowA1, which "belongs" to A's session) to
    // B's Firestore -- accepted data duplication, not blocked.
    expect(syncBatchSpy).toHaveBeenCalledTimes(2)
    expect(syncBatchSpy.mock.calls[1]![0]).toEqual([rowA1, rowB1])
    expect((await chrome.storage.local.get('autoSyncLastTime:user-b'))['autoSyncLastTime:user-b']).toBeDefined()

    // THE CORE INVARIANT: A's own bookkeeping is completely untouched by
    // B's entire session (both its cloud read and its upload/commit).
    expect((await chrome.storage.local.get('autoSyncLastTime:user-a'))['autoSyncLastTime:user-a']).toBe(aLastSyncAfterPhase1)

    // --- Sign back into A (the mistake is noticed and corrected) ---------
    const rowA2 = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED, Code: 0, BattleType: BattleType.SIT_AND_GO,
      Id: 'a2', IsRetire: false, timestamp: 300
    } as ApiEvent
    await db.apiEvents.add(rowA2)

    getCurrentUserSpy.mockReturnValue(userA)
    // A's OWN cloud watermark is still only 100 -- B's upload went to B's
    // Firestore, not A's -- so from A's perspective its cloud still lacks
    // rowB1 (200) and rowA2 (300). This is the concrete "no permanent
    // upload gap" assertion: A's bookkeeping survived B's session with
    // enough fidelity that A's own watermark (100) is still exactly right.
    cloudMaxSpy.mockResolvedValue(100)
    await service.performSync('upload')

    // A's next sync uploads rowB1 and rowA2 (what A's own cloud actually
    // lacks) -- PLUS a harmless redundant re-send of rowA1 itself. rowA1's
    // timestamp (100) is exactly A's own cloud watermark, and the P1 fix
    // (compound-key upload pagination, auto-sync-service.ts) makes the scan
    // INCLUSIVE of the watermark's own millisecond -- otherwise a
    // not-yet-uploaded row sharing that exact millisecond with a DIFFERENT
    // ApiTypeId than whatever cloud doc set the watermark there would be
    // silently, permanently skipped (the actual release-blocker bug this
    // fix addresses). Firestore writes are idempotent upserts keyed by
    // `${timestamp}_${ApiTypeId}`, so re-sending rowA1 is a no-op, not a
    // correctness issue -- see the fix's doc comment in syncToCloud().
    expect(syncBatchSpy).toHaveBeenCalledTimes(3)
    expect(syncBatchSpy.mock.calls[2]![0]).toEqual([rowA1, rowB1, rowA2])
    expect(service.getSyncState().status).toBe('success')
    // A's bookkeeping is intact and correctly advances -- no permanent gap.
    expect((await chrome.storage.local.get('autoSyncLastTime:user-a'))['autoSyncLastTime:user-a']).not.toBe(aLastSyncAfterPhase1)
  })

  test('detects an A -> B -> A round trip and aborts with zero bookkeeping writes, even though the live uid matches the snapshot again by the final commit (P1, ABA, codex review r3615389112)', async () => {
    await chrome.storage.local.remove(['autoSyncLastTime:user-a', 'autoSyncLastTime:user-b'])

    const userA = { uid: 'user-a', email: 'a@example.com' } as any
    const userB = { uid: 'user-b', email: 'b@example.com' } as any
    const getCurrentUserSpy = jest.spyOn(firebaseAuthService, 'getCurrentUser').mockReturnValue(userA)
    // A uid-string-only check would be fooled here: by the time
    // performSync()'s final commit assert runs, getCurrentUser() is back to
    // returning userA, string-equal to the pass-start snapshot. The auth
    // generation counter is not fooled -- two real transitions (A->B, B->A)
    // happened in between, advancing it by 2.
    let generation = 1
    jest.spyOn(firebaseAuthService, 'getAuthGeneration').mockImplementation(() => generation)

    const validRow = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED, Code: 0, BattleType: BattleType.SIT_AND_GO,
      Id: 'aba-row', IsRetire: false, timestamp: 100
    } as ApiEvent
    await db.apiEvents.add(validRow)

    jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockResolvedValue(null)
    // direction: 'download' below, so syncToCloud() (and its own internal
    // sync-floor commit-point assert, already covered by a separate test)
    // never runs -- this isolates performSync()'s OWN final
    // `autoSyncLastTime` commit-point assert as the thing that must catch
    // the ABA round trip.
    jest.spyOn(firestoreBackupService, 'syncFromCloud').mockImplementation(async () => {
      generation++
      getCurrentUserSpy.mockReturnValue(userB)
      generation++
      getCurrentUserSpy.mockReturnValue(userA)
      return 0
    })

    const service = new AutoSyncService(db)
    await service.performSync('download')

    expect(service.getSyncState().status).toBe('error')
    expect(service.getSyncState().error).toContain('final lastSyncTime commit')
    expect(await chrome.storage.local.get('autoSyncLastTime:user-a')).toEqual({ 'autoSyncLastTime:user-a': undefined })
    expect(await chrome.storage.local.get('autoSyncLastTime:user-b')).toEqual({ 'autoSyncLastTime:user-b': undefined })
  })

  test('re-runs initialize() fresh (does not publish a stale result) if the SAME account signs out and back in mid-computation (invariant (2b), codex review r3615389139/r3615389133)', async () => {
    await chrome.storage.local.remove(['autoSyncLastTime:user-a'])

    const userA = { uid: 'user-a', email: 'a@example.com' } as any
    jest.spyOn(firebaseAuthService, 'getCurrentUser').mockReturnValue(userA)
    let generation = 1
    jest.spyOn(firebaseAuthService, 'getAuthGeneration').mockImplementation(() => generation)

    // A sign-out+sign-in of the SAME account (uid unchanged) still advances
    // the generation by 2 -- simulated as a side effect of the FIRST
    // updateTimestamps() call's own getCloudMaxTimestamp() read, landing in
    // the gap between initialize()'s identity snapshot and its
    // result-application check.
    let cloudMaxCalls = 0
    jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockImplementation(async () => {
      cloudMaxCalls++
      if (cloudMaxCalls === 1) generation += 2
      return null
    })

    const service = new AutoSyncService(db)
    const performSyncSpy = jest.spyOn(service, 'performSync').mockImplementation(async () => {
      (service as any).syncState.lastSyncTime = new Date()
      return { success: true } as const
    })

    await service.initialize()

    // The FIRST attempt's computation (generation 1) was discarded once the
    // mismatch was detected; initialize() re-ran fresh under generation 3
    // and correctly triggered exactly one first sync from THAT attempt --
    // not zero (silently abandoned) and not two (the stale attempt also
    // publishing/triggering before being caught).
    expect(performSyncSpy).toHaveBeenCalledTimes(1)
    expect(cloudMaxCalls).toBe(2) // one per attempt (first discarded, second applied)
  })

  test('discards a stale initialize() result and never publishes it into syncState when the account changes mid-computation to a genuinely DIFFERENT account (invariant (2b))', async () => {
    await chrome.storage.local.remove(['autoSyncLastTime:user-a', 'autoSyncLastTime:user-b'])

    const userA = { uid: 'user-a', email: 'a@example.com' } as any
    const userB = { uid: 'user-b', email: 'b@example.com' } as any
    // A already has its OWN real lastSyncTime -- if this were incorrectly
    // published for whoever ends up live, initialize() would wrongly
    // conclude "already synced" and skip triggering a first sync.
    const staleIso = new Date('2020-01-01T00:00:00.000Z').toISOString()
    await chrome.storage.local.set({ 'autoSyncLastTime:user-a': staleIso })

    const getCurrentUserSpy = jest.spyOn(firebaseAuthService, 'getCurrentUser').mockReturnValue(userA)
    let generation = 1
    jest.spyOn(firebaseAuthService, 'getAuthGeneration').mockImplementation(() => generation)
    let cloudMaxCalls = 0
    jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockImplementation(async () => {
      cloudMaxCalls++
      if (cloudMaxCalls === 1) {
        // Account switches to B (a genuinely different, never-synced
        // account) while initialize() -- still computing for A -- awaits
        // this FIRST call inside updateTimestamps(). Only on the first call
        // -- the retry's own updateTimestamps() call must see a stable
        // account so the re-run actually converges.
        generation++
        getCurrentUserSpy.mockReturnValue(userB)
      }
      return null
    })

    const service = new AutoSyncService(db)
    const performSyncSpy = jest.spyOn(service, 'performSync').mockImplementation(async () => {
      (service as any).syncState.lastSyncTime = new Date()
      return { success: true } as const
    })

    await service.initialize()

    // A's stale lastSyncTime (2020) was never published -- the re-run
    // correctly re-evaluates for B (who has no scoped key at all) and
    // triggers B's own first sync, rather than silently applying A's
    // "already synced" conclusion to whoever happens to be live afterward.
    expect(performSyncSpy).toHaveBeenCalledTimes(1)
  })

  test('blocks the legacy migration/clear write if the account changes mid-computation, leaving the legacy key untouched for a later attempt to retry (invariant (2), codex review r3615389121)', async () => {
    await chrome.storage.local.remove(['autoSyncLastTime', 'autoSyncLastTime:user-a'])

    const userA = { uid: 'user-a', email: 'a@example.com' } as any
    const legacyIso = new Date('2026-01-01T00:00:00.000Z').toISOString()
    await chrome.storage.local.set({ autoSyncLastTime: legacyIso })

    jest.spyOn(firebaseAuthService, 'getCurrentUser').mockReturnValue(userA)
    let generation = 1
    jest.spyOn(firebaseAuthService, 'getAuthGeneration').mockImplementation(() => generation)

    // Bump the generation as a side effect of the ONE await between
    // initialize()'s identity snapshot and the legacy-migration commit
    // point: the chrome.storage.local.get() read of the scoped+legacy keys.
    // Capture the CURRENT implementation function (not just the mutable
    // `chrome.storage.local.get` property reference) before overriding it --
    // `chrome.storage.local.get` is already a jest.fn() from test-setup.ts,
    // so re-assigning its implementation via mockImplementation() below
    // would otherwise make a naively-captured "original" reference recurse
    // into the NEW implementation too (same underlying mock object).
    const originalStorageGetImpl = (chrome.storage.local.get as jest.Mock).getMockImplementation()!
    jest.spyOn(chrome.storage.local, 'get').mockImplementation((keys: any) => {
      const result = originalStorageGetImpl(keys)
      generation++
      return result
    })

    const service = new AutoSyncService(db)
    const performSyncSpy = jest.spyOn(service, 'performSync').mockResolvedValue({ success: true })

    await service.initialize()

    // The migration/clear write never happened -- the legacy key survives
    // untouched (available for a later, non-stale attempt), and no scoped
    // key was created from a computation already known to be stale. No
    // first sync was triggered off it either.
    expect(await chrome.storage.local.get('autoSyncLastTime')).toEqual({ autoSyncLastTime: legacyIso })
    expect(await chrome.storage.local.get('autoSyncLastTime:user-a')).toEqual({ 'autoSyncLastTime:user-a': undefined })
    expect(performSyncSpy).not.toHaveBeenCalled()
  })

  test('awaits auth restore before snapshotting identity, so a pass starting during Service Worker startup does not snapshot a pre-restore identity (P2, codex review r3615553034)', async () => {
    await chrome.storage.local.remove(['autoSyncLastTime:user-a'])

    const userA = { uid: 'user-a', email: 'a@example.com' } as any
    // Simulates firebaseAuthService's own constructor-kicked-off
    // restoreAuthState() not having resolved yet: getCurrentUser()/
    // getAuthGeneration() report "nobody signed in yet, generation 0" until
    // `restored` flips, mirroring how the real service looks before vs.
    // after its restorePromise settles.
    let restored = false
    let resolveReady: (() => void) | undefined
    jest.spyOn(firebaseAuthService, 'ready').mockImplementation(() => new Promise<void>(resolve => { resolveReady = resolve }))
    jest.spyOn(firebaseAuthService, 'getCurrentUser').mockImplementation(() => restored ? userA : null)
    jest.spyOn(firebaseAuthService, 'getAuthGeneration').mockImplementation(() => restored ? 1 : 0)

    jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockResolvedValue(null)
    jest.spyOn(firestoreBackupService, 'syncToCloudBatch')
      .mockResolvedValue({ totalEvents: 0, syncedEvents: 0, lastSyncTime: new Date() })

    const service = new AutoSyncService(db)
    const syncPromise = service.performSync('upload')

    // Restore "completes" while performSync() is awaiting
    // firebaseAuthService.ready() -- exactly the startup race the finding
    // describes. If the identity snapshot were taken BEFORE this await
    // (the bug), it would have already captured `{ uid: undefined,
    // generation: 0 }` synchronously, before this line ever runs.
    restored = true
    resolveReady?.()

    await syncPromise

    // Must have succeeded under the RESTORED identity's own scoped key --
    // not the bare/unscoped key a pre-restore `{ uid: undefined }` snapshot
    // would have written to, and not aborted by a later commit-point check
    // wrongly seeing "generation changed" relative to a stale pre-restore
    // snapshot.
    expect(service.getSyncState().status).toBe('success')
    expect((await chrome.storage.local.get('autoSyncLastTime:user-a'))['autoSyncLastTime:user-a']).toBeDefined()
    expect(await chrome.storage.local.get('autoSyncLastTime')).toEqual({ autoSyncLastTime: undefined })
  })

  test('re-checks the generation before publishing sync success into the shared syncState, closing the gap during updateTimestamps() (P2, codex review r3615553045)', async () => {
    await chrome.storage.local.remove(['autoSyncLastTime:user-a', 'autoSyncLastTime:user-b'])

    const userA = { uid: 'user-a', email: 'a@example.com' } as any
    const userB = { uid: 'user-b', email: 'b@example.com' } as any
    const getCurrentUserSpy = jest.spyOn(firebaseAuthService, 'getCurrentUser').mockReturnValue(userA)
    let generation = 1
    jest.spyOn(firebaseAuthService, 'getAuthGeneration').mockImplementation(() => generation)

    const validRow = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED, Code: 0, BattleType: BattleType.SIT_AND_GO,
      Id: 'x', IsRetire: false, timestamp: 100
    } as ApiEvent
    await db.apiEvents.add(validRow)

    jest.spyOn(firestoreBackupService, 'syncToCloudBatch')
      .mockResolvedValue({ totalEvents: 1, syncedEvents: 1, lastSyncTime: new Date() })

    let cloudMaxCalls = 0
    jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockImplementation(async () => {
      cloudMaxCalls++
      // Call #1 is syncToCloud()'s own watermark read (before any
      // bookkeeping write). Call #2 is updateTimestamps()'s own read,
      // which runs AFTER the scoped autoSyncLastTime write below has
      // already landed -- switch accounts exactly there, simulating the
      // account changing during that specific gap.
      if (cloudMaxCalls === 2) {
        generation++
        getCurrentUserSpy.mockReturnValue(userB)
      }
      return null
    })

    const service = new AutoSyncService(db)
    await service.performSync('upload')

    expect(service.getSyncState().status).toBe('error')
    expect(service.getSyncState().error).toContain('before publishing sync success')

    // The scoped bookkeeping WRITE already landed under A -- legitimate,
    // made while A was still live (before the switch inside updateTimestamps()).
    expect((await chrome.storage.local.get('autoSyncLastTime:user-a'))['autoSyncLastTime:user-a']).toBeDefined()

    // But the SHARED in-memory syncState.lastSyncTime was never published --
    // this is exactly what a newly-signed-in B's own
    // syncIfBacklogExceedsThreshold() would otherwise read and use to
    // (wrongly) shrink its own upload backlog.
    expect(service.getSyncState().lastSyncTime).toBeUndefined()
  })

  test('waits for an in-flight sync from a DIFFERENT pass to settle before retrying initialization, instead of burning through all retry attempts immediately (P2, codex review r3615664890)', async () => {
    await chrome.storage.local.remove(['autoSyncLastTime:user-b'])

    const userB = { uid: 'user-b', email: 'b@example.com' } as any
    jest.spyOn(firebaseAuthService, 'getCurrentUser').mockReturnValue(userB)
    jest.spyOn(firebaseAuthService, 'getAuthGeneration').mockReturnValue(1)
    jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockResolvedValue(null)
    // initialize()'s own performSync() call defaults to direction 'both' --
    // mock the download leg too (the mocked `userB` has no real
    // getIdToken(), so the REAL firestoreBackupService.syncFromCloud()
    // would fail authentication and mask this test's actual concern).
    jest.spyOn(firestoreBackupService, 'syncFromCloud').mockResolvedValue(0)

    const service = new AutoSyncService(db)

    // Simulate a DIFFERENT pass (e.g. account A's) already genuinely
    // holding the sync latch when initialize() is called for B -- mirrors
    // exactly what performSync() itself sets up at its own entry.
    let resolveOtherPass: (() => void) | undefined
    ;(service as any)._isSyncing = true
    ;(service as any).inFlightSyncPromise = new Promise<void>(resolve => { resolveOtherPass = resolve })

    const initializePromise = service.initialize()

    // Flush the microtask queue (a macrotask boundary drains it completely)
    // so initialize()'s first attempt actually reaches the "wait for the
    // in-flight pass" branch and is blocked on `await this.inFlightSyncPromise`
    // -- not still spinning through immediate, doomed retries.
    await new Promise(resolve => setTimeout(resolve, 0))

    // Release the OTHER pass, exactly as performSync()'s own `finally`
    // block would once that pass actually completes.
    ;(service as any)._isSyncing = false
    ;(service as any).inFlightSyncPromise = null
    resolveOtherPass?.()

    await initializePromise

    // B's own first sync succeeded once the latch was actually free -- not
    // abandoned after 3 immediate, doomed retries that all short-circuited
    // on the same still-held latch.
    expect((await chrome.storage.local.get('autoSyncLastTime:user-b'))['autoSyncLastTime:user-b']).toBeDefined()
  })

  test('removes the legacy autoSyncLastTime key BEFORE writing the scoped copy during migration, so a crash between them cannot leave it available for a different account to inherit (P2, codex review r3615664896)', async () => {
    await chrome.storage.local.remove(['autoSyncLastTime', 'autoSyncLastTime:user-a'])

    const userA = { uid: 'user-a', email: 'a@example.com' } as any
    jest.spyOn(firebaseAuthService, 'getCurrentUser').mockReturnValue(userA)
    jest.spyOn(firebaseAuthService, 'getAuthGeneration').mockReturnValue(1)
    jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockResolvedValue(null)

    const legacyIso = new Date('2026-01-01T00:00:00.000Z').toISOString()
    await chrome.storage.local.set({ autoSyncLastTime: legacyIso })

    // Track call order exactly like the existing r3614064524 crash-window
    // regression test does for the sync-floor commit -- capture the
    // CURRENT mock implementations (not just the mutable property
    // references) before overriding them, same fix as the earlier
    // recursive-mock issue in the "blocks the legacy migration/clear
    // write" test above.
    const callOrder: string[] = []
    const originalSet = (chrome.storage.local.set as jest.Mock).getMockImplementation()!
    const originalRemove = (chrome.storage.local.remove as jest.Mock).getMockImplementation()!
    jest.spyOn(chrome.storage.local, 'set').mockImplementation((items: any) => {
      callOrder.push(`set:${Object.keys(items).join(',')}`)
      return originalSet(items)
    })
    jest.spyOn(chrome.storage.local, 'remove').mockImplementation((keys: any) => {
      callOrder.push(`remove:${Array.isArray(keys) ? keys.join(',') : keys}`)
      return originalRemove(keys)
    })

    const service = new AutoSyncService(db)
    const performSyncSpy = jest.spyOn(service, 'performSync').mockResolvedValue({ success: true })

    await service.initialize()

    const removeIndex = callOrder.findIndex(entry => entry === 'remove:autoSyncLastTime')
    const setIndex = callOrder.findIndex(entry => entry === 'set:autoSyncLastTime:user-a')
    expect(removeIndex).toBeGreaterThanOrEqual(0)
    expect(setIndex).toBeGreaterThanOrEqual(0)
    // happens-before: the legacy key must already be gone before the
    // scoped copy is written, so a crash in between leaves no legacy value
    // for a later, different account to wrongly inherit.
    expect(removeIndex).toBeLessThan(setIndex)

    // Sanity: the migration still landed correctly for A.
    expect((await chrome.storage.local.get('autoSyncLastTime:user-a'))['autoSyncLastTime:user-a']).toBe(legacyIso)
    expect(performSyncSpy).not.toHaveBeenCalled()
  })

  test('clears the previous account\'s in-memory lastSyncTime immediately (before any awaits), so a session trigger firing during a direct A -> B sign-in cannot undercount B\'s backlog against A\'s stale value (P2, codex review r3615781411)', async () => {
    await chrome.storage.local.remove(['autoSyncLastTime:user-a', 'autoSyncLastTime:user-b'])

    const userB = { uid: 'user-b', email: 'b@example.com' } as any

    const service = new AutoSyncService(db)
    // Simulate account A's PREVIOUS successful sync having left a RECENT
    // lastSyncTime in the shared in-memory syncState -- exactly what a
    // real prior performSync() call for A would have set.
    ;(service as any).syncState.lastSyncTime = new Date('2026-07-20T00:00:00.000Z')

    jest.spyOn(firebaseAuthService, 'getCurrentUser').mockReturnValue(userB)
    jest.spyOn(firebaseAuthService, 'getAuthGeneration').mockReturnValue(1)
    jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockResolvedValue(null)

    // Capture syncState.lastSyncTime at the exact moment initialize()'s
    // storage read (scoped + legacy keys) is issued -- this is the window
    // the finding describes: a session-end/start trigger firing here would
    // read whatever is current.
    let lastSyncTimeDuringAwait: Date | undefined | 'not-observed' = 'not-observed'
    const originalGet = (chrome.storage.local.get as jest.Mock).getMockImplementation()!
    jest.spyOn(chrome.storage.local, 'get').mockImplementation((keys: any) => {
      if (lastSyncTimeDuringAwait === 'not-observed') {
        lastSyncTimeDuringAwait = (service as any).syncState.lastSyncTime
      }
      return originalGet(keys)
    })

    // Simulate a successful sync (sets lastSyncTime) -- a plain no-op mock
    // would leave lastSyncTime unset, triggering initialize()'s
    // retry-on-incomplete-first-sync logic (invariant (2b), its own
    // dedicated test elsewhere) and inflating the call count asserted below.
    const performSyncSpy = jest.spyOn(service, 'performSync').mockImplementation(async () => {
      (service as any).syncState.lastSyncTime = new Date()
      return { success: true } as const
    })

    await service.initialize()

    // Must already be cleared BEFORE the storage read below -- not A's
    // stale, more-recent value, which would otherwise make a concurrent
    // syncIfBacklogExceedsThreshold() undercount B's real backlog.
    expect(lastSyncTimeDuringAwait).toBeUndefined()
    // Sanity: B correctly triggers its own first sync afterward (B has
    // never synced).
    expect(performSyncSpy).toHaveBeenCalledTimes(1)
  })

  test('clears the in-memory lastSyncTime as soon as firebaseAuthService notifies an auth state change -- one layer earlier than initialize()\'s own window fix (P2, codex review r3615952256)', async () => {
    // Simulates account A having a real, recent lastSyncTime already in
    // memory, as a prior successful sync would leave.
    const service = new AutoSyncService(db)
    ;(service as any).syncState.lastSyncTime = new Date('2026-07-20T00:00:00.000Z')

    // firebaseAuthService.signInWithGoogle()/signOut() now notify
    // listeners SYNCHRONOUSLY as part of exposing a new identity -- before
    // their own persistAuthState()/storage-removal await, and well before
    // message-router.ts's explicit onAuthStateChanged(user) call (which is
    // what initialize()'s own r3615781411 fix guards) even runs.
    // AutoSyncService registers exactly such a listener in its constructor
    // -- invoke the notification directly here, the same way
    // notifyAuthStateListeners() does internally, to prove the registered
    // callback clears the stale value the instant it fires, independent of
    // whether onAuthStateChanged()/initialize() has run yet.
    const userB = { uid: 'user-b', email: 'b@example.com' } as any
    ;(firebaseAuthService as any).notifyAuthStateListeners(userB)

    expect((service as any).syncState.lastSyncTime).toBeUndefined()
  })

  test('rechecks the generation before the scoped legacy migration write, so an account switch during the remove() await cannot persist a stale uid\'s scoped key (P2, codex review r3616056817)', async () => {
    await chrome.storage.local.remove(['autoSyncLastTime', 'autoSyncLastTime:user-a'])

    const userA = { uid: 'user-a', email: 'a@example.com' } as any
    jest.spyOn(firebaseAuthService, 'getCurrentUser').mockReturnValue(userA)
    let generation = 1
    jest.spyOn(firebaseAuthService, 'getAuthGeneration').mockImplementation(() => generation)

    const legacyIso = new Date('2026-01-01T00:00:00.000Z').toISOString()
    await chrome.storage.local.set({ autoSyncLastTime: legacyIso })

    // Bump the generation as a side effect of the remove() call -- the
    // window BETWEEN the first assert (before remove()) and the scoped
    // set() that follows it, which is exactly what the finding describes.
    const originalRemove = (chrome.storage.local.remove as jest.Mock).getMockImplementation()!
    jest.spyOn(chrome.storage.local, 'remove').mockImplementation((keys: any) => {
      const result = originalRemove(keys)
      generation++
      return result
    })

    const service = new AutoSyncService(db)
    const performSyncSpy = jest.spyOn(service, 'performSync').mockResolvedValue({ success: true })

    await service.initialize()

    // The legacy key IS gone -- removing it is unconditionally safe
    // regardless of which account ends up live (r3615664896's ordering
    // fix), so that part still lands.
    expect(await chrome.storage.local.get('autoSyncLastTime')).toEqual({ autoSyncLastTime: undefined })
    // But the scoped write for the now-STALE uid never happened -- it
    // would have durably persisted a value this account never actually
    // earned, letting it wrongly look "already synced" on a later sign-in.
    expect(await chrome.storage.local.get('autoSyncLastTime:user-a')).toEqual({ 'autoSyncLastTime:user-a': undefined })
    expect(performSyncSpy).not.toHaveBeenCalled()
  })

  describe('P1 fix: compound-key upload pagination (release blocker, independent audit 2026-07-21)', () => {
    // apiEvents' primary key is the compound `[timestamp+ApiTypeId+sequence]`
    // (poker-chase-db.ts), so raw rows can legitimately share the exact
    // same millisecond and ApiTypeId. Before this fix,
    // `syncToCloud()` paginated uploads on bare `timestamp` alone -- a
    // CHUNK_SIZE-row page boundary (or, in the steady state, the very first
    // page's own boundary at the cloud watermark) that fell between two such
    // rows permanently excluded whichever one lost the tie, and the pass
    // still completed "successfully" (see auto-sync-service.ts's `syncToCloud`
    // doc comment for the full writeup).
    //
    // These tests scale `DATABASE_CONSTANTS.SYNC_CHUNK_SIZE` down (it's a
    // plain runtime object despite its `as const` type -- not frozen) so a
    // chunk boundary can be forced deterministically without seeding
    // thousands of rows.
    const originalChunkSize = DATABASE_CONSTANTS.SYNC_CHUNK_SIZE

    afterEach(() => {
      (DATABASE_CONSTANTS as any).SYNC_CHUNK_SIZE = originalChunkSize
    })

    test('a same-millisecond same-type sequence boundary split across a CHUNK_SIZE page break uploads BOTH rows exactly once', async () => {
      (DATABASE_CONSTANTS as any).SYNC_CHUNK_SIZE = 4

      // Four rows fill the first page exactly; the 5th shares the 4th row's
      // exact millisecond and ApiTypeId with sequence 1, so it sorts
      // immediately after row 4 (sequence 0) and lands as the
      // very first row of page 2 -- exactly the "row 5,000 and 5,001" chunk
      // boundary the audit describes, scaled down to 4/5.
      const row1 = { ApiTypeId: ApiType.EVT_ENTRY_QUEUED, Code: 0, BattleType: BattleType.SIT_AND_GO, Id: 'r1', IsRetire: false, timestamp: 100 } as ApiEvent
      const row2 = { ApiTypeId: ApiType.EVT_ENTRY_QUEUED, Code: 0, BattleType: BattleType.SIT_AND_GO, Id: 'r2', IsRetire: false, timestamp: 101 } as ApiEvent
      const row3 = { ApiTypeId: ApiType.EVT_ENTRY_QUEUED, Code: 0, BattleType: BattleType.SIT_AND_GO, Id: 'r3', IsRetire: false, timestamp: 102 } as ApiEvent
      // row4 and row5 tie on both timestamp and ApiTypeId. The sequence
      // component alone puts row4 last on page 1 and row5 first on page 2.
      const row4 = { ApiTypeId: ApiType.EVT_ENTRY_QUEUED, Code: 0, BattleType: BattleType.SIT_AND_GO, Id: 'r4', IsRetire: false, timestamp: 103, sequence: 0 } as ApiEvent
      const row5 = { ApiTypeId: ApiType.EVT_ENTRY_QUEUED, Code: 0, BattleType: BattleType.SIT_AND_GO, Id: 'r5', IsRetire: false, timestamp: 103, sequence: 1 } as ApiEvent
      await db.apiEvents.bulkAdd([row1, row2, row3, row4, row5] as any)

      jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockResolvedValue(null)
      const syncBatchSpy = jest.spyOn(firestoreBackupService, 'syncToCloudBatch')
        .mockImplementation(async (chunk: ApiEvent[]) => ({ totalEvents: chunk.length, syncedEvents: chunk.length, lastSyncTime: new Date() }))

      const service = new AutoSyncService(db)
      await service.performSync('upload')

      expect(service.getSyncState().status).toBe('success')
      // Two pages: [row1..row4], then [row5]. Without the fix, the second
      // page's `.where('timestamp').above(103)` query would return zero
      // rows (row5 also sits at 103), the loop would `break` early having
      // processed only 4 of the 5 total rows, and row5 would never appear
      // in any `syncToCloudBatch` call.
      expect(syncBatchSpy).toHaveBeenCalledTimes(2)
      expect(syncBatchSpy.mock.calls[0]![0]).toEqual([row1, row2, row3, row4])
      expect(syncBatchSpy.mock.calls[1]![0]).toEqual([row5])

      // Every row uploaded exactly once across the whole pass.
      const allUploaded = syncBatchSpy.mock.calls.flatMap(([chunk]) => chunk as ApiEvent[])
      expect(allUploaded).toHaveLength(5)
      expect(allUploaded).toEqual([row1, row2, row3, row4, row5])
    })

    test('incremental sync: a local row sharing the cloud watermark\'s exact millisecond with a different ApiTypeId is uploaded, not silently skipped, with no duplicate upload', async () => {
      // Mark the one-time unparseable-floor backfill already done (as it
      // would be on any real-world Nth sync, long after the one-time
      // post-upgrade backfill ran) -- this ISOLATES the bug under test.
      // Without this, `backfillUnparseableFloorIfNeeded()` would itself
      // notice `notYetUploaded` sitting at-or-below the cloud watermark and
      // seed a floor that rewinds `scanFloor` below 100 as a side effect,
      // accidentally masking the exact bug this test targets (that
      // mechanism is a one-time post-upgrade reconciliation, not a
      // substitute for correct steady-state pagination).
      await db.meta.put({ id: 'syncUnparseableFloorBackfillDoneV2', value: true, updatedAt: Date.now() })

      // Simulates the cross-pass version of the same bug: a PRIOR pass's
      // chunk boundary already landed exactly here -- `alreadyUploaded` is
      // what pushed the cloud watermark to exactly 100, and `notYetUploaded`
      // shares that same millisecond with a different, never-uploaded
      // ApiTypeId.
      const alreadyUploaded = { ApiTypeId: ApiType.EVT_ENTRY_QUEUED, Code: 0, BattleType: BattleType.SIT_AND_GO, Id: 'already-uploaded', IsRetire: false, timestamp: 100 } as ApiEvent
      const notYetUploaded = {
        ApiTypeId: ApiType.EVT_PLAYER_JOIN,
        timestamp: 100,
        JoinPlayer: { BetChip: 0, BetStatus: BetStatusType.NOT_IN_PLAY, Chip: 2000, SeatIndex: 3, Status: 0 },
        JoinUser: {
          UserId: 998, UserName: 'tie-player', FavoriteCharaId: 'chara02', CostumeId: 'costume02', EmblemId: 'emblem02',
          IsCpu: false, IsOfficial: false, SettingDecoIds: ['', '', '', '', '', '', ''],
          Rank: { RankId: 'silver', RankName: 'シルバー', RankLvId: 'silver', RankLvName: 'シルバー' }
        }
      } as unknown as ApiEvent
      const genuinelyNewRow = { ApiTypeId: ApiType.EVT_ENTRY_QUEUED, Code: 0, BattleType: BattleType.SIT_AND_GO, Id: 'genuinely-new', IsRetire: false, timestamp: 200 } as ApiEvent
      await db.apiEvents.bulkAdd([alreadyUploaded, notYetUploaded, genuinelyNewRow] as any)

      // Cloud watermark sits exactly at 100 -- the same millisecond as the
      // not-yet-uploaded row. Without the fix, `scanFloor` (== 100 here,
      // steady state, no pending unparseable floor) is used with a strict
      // `.above()` bound, so `notYetUploaded` (timestamp === 100) is
      // excluded from the very first query of the pass and never uploaded,
      // on this pass or any future one (the watermark never moves off 100
      // for this row's sake).
      jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockResolvedValue(100)
      const syncBatchSpy = jest.spyOn(firestoreBackupService, 'syncToCloudBatch')
        .mockImplementation(async (chunk: ApiEvent[]) => ({ totalEvents: chunk.length, syncedEvents: chunk.length, lastSyncTime: new Date() }))

      const service = new AutoSyncService(db)
      await service.performSync('upload')

      expect(service.getSyncState().status).toBe('success')
      expect(syncBatchSpy).toHaveBeenCalledTimes(1)
      const [uploadedChunk] = syncBatchSpy.mock.calls[0]!
      // notYetUploaded IS included -- the core regression this test guards.
      // alreadyUploaded is also harmlessly re-sent (Firestore's write is an
      // idempotent upsert keyed by `${timestamp}_${ApiTypeId}` -- see
      // firestore-backup-service.ts -- so this is a no-op, not data
      // corruption or a real duplicate in Firestore).
      expect(uploadedChunk).toEqual([alreadyUploaded, notYetUploaded, genuinelyNewRow])
      // No row appears more than once in the single upload call itself.
      expect(new Set(uploadedChunk.map((e: ApiEvent) => `${e.timestamp}_${e.ApiTypeId}_${e.sequence ?? 0}`)).size).toBe(uploadedChunk.length)
    })

    test('floor interplay: an unparseable row that loses a chunk-boundary tie is still discovered within the SAME pass, and the floor does not advance past it', async () => {
      (DATABASE_CONSTANTS as any).SYNC_CHUNK_SIZE = 2

      // rowA and rowB exactly fill page 1 (CHUNK_SIZE=2). rowB and the
      // unparseable row share timestamp 200; the unparseable row's ApiTypeId
      // (309, EVT_SESSION_RESULTS) is higher than rowB's (201), so it sorts
      // immediately after rowB -- landing as the first row of page 2, tied
      // with the page-1/page-2 boundary itself. rowD is a genuinely later,
      // valid row also in page 2.
      const rowA = { ApiTypeId: ApiType.EVT_ENTRY_QUEUED, Code: 0, BattleType: BattleType.SIT_AND_GO, Id: 'rowA', IsRetire: false, timestamp: 100 } as ApiEvent
      const rowB = { ApiTypeId: ApiType.EVT_ENTRY_QUEUED, Code: 0, BattleType: BattleType.SIT_AND_GO, Id: 'rowB', IsRetire: false, timestamp: 200 } as ApiEvent
      // Application-typed (309) but missing every required field -- fails
      // Zod validation exactly like the season-3 payload break (see the
      // unparseable-floor tests above).
      const unparseableAtBoundary = { ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 200 }
      const rowD = { ApiTypeId: ApiType.EVT_ENTRY_QUEUED, Code: 0, BattleType: BattleType.SIT_AND_GO, Id: 'rowD', IsRetire: false, timestamp: 300 } as ApiEvent
      await db.apiEvents.bulkAdd([rowA, rowB, unparseableAtBoundary, rowD] as any)

      jest.spyOn(firestoreBackupService, 'getCloudMaxTimestamp').mockResolvedValue(null)
      const syncBatchSpy = jest.spyOn(firestoreBackupService, 'syncToCloudBatch')
        .mockImplementation(async (chunk: ApiEvent[]) => ({ totalEvents: chunk.length, syncedEvents: chunk.length, lastSyncTime: new Date() }))

      const service = new AutoSyncService(db)
      await service.performSync('upload')

      expect(service.getSyncState().status).toBe('success')
      // Page 1: [rowA, rowB]. Page 2: [unparseableAtBoundary, rowD] -- without
      // the fix, page 2's `.where('timestamp').above(200)` would exclude
      // `unparseableAtBoundary` (also at 200) entirely; it would never be
      // examined by `isUnparseableApplicationEvent`, `earliestUnparseableThisPass`
      // would stay `null` for the whole pass, and the end-of-loop commit
      // would clear the floor to `null` -- permanently losing track of a row
      // that was never actually uploaded (it can't be; it's unparseable) and
      // that the cloud watermark (now advanced to rowD's 300 via the
      // uploaded chunks) has already sailed past.
      expect(syncBatchSpy).toHaveBeenCalledTimes(2)
      expect(syncBatchSpy.mock.calls[0]![0]).toEqual([rowA, rowB])
      expect(syncBatchSpy.mock.calls[1]![0]).toEqual([rowD]) // unparseable row filtered out of the upload itself

      // The floor must reflect the still-unparseable row's timestamp (200),
      // not be cleared -- this is what lets a future schema fix re-offer it
      // instead of it being permanently orphaned below the (now-advanced)
      // cloud watermark.
      expect((await db.meta.get('syncUnparseableFloor'))?.value).toBe(200)
    })
  })
})
