/**
 * Auto Sync Service
 * Handles automatic synchronization between local and cloud storage
 */

import { firestoreBackupService } from './firestore-backup-service'
import { firebaseAuthService } from './firebase-auth-service'
import { PokerChaseDB } from '../db/poker-chase-db'
import { EntityConverter } from '../entity-converter'
import { ApiType, ApiTypeValues, isApiEventType, isApplicationApiEvent, isUnparseableApplicationEvent } from '../types'
import type { ApiEvent } from '../types'
import { processInChunks, saveEntities, filterValidApplicationEvents } from '../utils/database-utils'
import { DATABASE_CONSTANTS } from '../constants/database'
import { isCloudSyncBlockedByMinVersionGate } from './min-version-gate'

/** Shown in the popup and logged when the min-version gate stops cloud sync (#forced-update). */
export const MIN_VERSION_SYNC_BLOCKED_MESSAGE = 'このバージョンはサポートが終了しました。Chromeを再起動すると更新が適用されます'

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'success'
export type SyncDirection = 'upload' | 'download' | 'both'

export interface SyncState {
  status: SyncStatus
  lastSyncTime?: Date
  localLastTimestamp?: number
  cloudLastTimestamp?: number
  error?: string
  progress?: {
    current: number
    total: number
    direction: SyncDirection
  }
}

export class AutoSyncService {
  private db: PokerChaseDB
  private syncState: SyncState = { status: 'idle' }
  private _isSyncing = false
  private lastSyncAttempt = 0
  private readonly MIN_SYNC_INTERVAL_MS = 0 // No minimum interval restriction
  private readonly SYNC_STORAGE_KEY = 'autoSyncLastTime'
  private readonly EVENTS_THRESHOLD = 100 // 100イベント溜まったら同期
  /**
   * `meta`テーブルのキー。`syncToCloud()`のwatermarkガード（下記コメント参照）が
   * 「アプリケーション種別だが現在パースできない生行のうち、最も古いタイムスタンプ」
   * を永続化する場所。存在する限り、以降の全`syncToCloud()`呼び出しはこの値の
   * 直前までスキャン開始点を巻き戻す。
   */
  private readonly SYNC_UNPARSEABLE_FLOOR_KEY = 'syncUnparseableFloor'
  /**
   * `meta`テーブルのキー。一度だけ実行するバックフィルスキャン
   * （`backfillUnparseableFloorIfNeeded`、下記の invariant spec 参照）が
   * 完了したかどうかを記録する。存在する限り、以降の`syncToCloud()`は
   * バックフィルスキャンを二度と実行しない。
   */
  private readonly SYNC_UNPARSEABLE_BACKFILL_DONE_KEY = 'syncUnparseableFloorBackfillDone'

  constructor(db?: PokerChaseDB) {
    this.db = db ?? new PokerChaseDB(self.indexedDB, self.IDBKeyRange)
  }

  /**
   * `true` while an upload/download sync is in flight. Read-only outside this
   * class -- used by `src/background/update-manager.ts`'s safety predicate
   * (part of the "SAFE to auto-apply an update" check) so the extension never
   * reloads mid-sync.
   */
  get isSyncing(): boolean {
    return this._isSyncing
  }

  /**
   * Initialize auto sync service
   */
  async initialize(): Promise<void> {
    try {
      // Load last sync time from storage
      const stored = await chrome.storage.local.get(this.SYNC_STORAGE_KEY) as Record<string, any>
      if (stored[this.SYNC_STORAGE_KEY]) {
        this.syncState.lastSyncTime = new Date(stored[this.SYNC_STORAGE_KEY] as string | number)
      }

      // Update timestamps
      await this.updateTimestamps()

      // Check if user is authenticated
      const user = firebaseAuthService.getCurrentUser()
      if (!user) {
        console.log('[AutoSync] User not authenticated, skipping initialization')
        return
      }

      // Perform initial sync only if never synced before
      if (!this.syncState.lastSyncTime) {
        console.log('[AutoSync] First time sync, performing initial sync...')
        await this.performSync()
      } else {
        console.log('[AutoSync] Last sync was at:', this.syncState.lastSyncTime)
      }
    } catch (error) {
      console.error('[AutoSync] Initialization error:', error)
    }
  }


  /**
   * Perform sync with optional direction
   * @param direction - Optional sync direction: 'upload', 'download', or 'both' (default)
   */
  async performSync(direction: SyncDirection = 'both'): Promise<void> {
    // Check minimum interval (currently disabled)
    const now = Date.now()
    if (this.MIN_SYNC_INTERVAL_MS > 0 && now - this.lastSyncAttempt < this.MIN_SYNC_INTERVAL_MS) {
      console.log('[AutoSync] Skipping sync - too soon since last attempt')
      return
    }

    // Check if already syncing
    if (this._isSyncing) {
      console.log('[AutoSync] Sync already in progress')
      return
    }

    // Latch BEFORE the awaited gate check below (codex#3612092798): if we set
    // this after awaiting, two performSync() calls arriving close together can
    // both pass the `this._isSyncing` check above, both await the gate, and
    // then both proceed to sync concurrently -- reopening the double-sync
    // race this flag exists to prevent. Reset in `finally` so every return
    // path (gate-blocked or sync completed/failed) releases the latch.
    this._isSyncing = true

    try {
      // Remote min-version gate (kill switch, #forced-update): every sync entry
      // point funnels through performSync(), so a single guard here covers
      // manual sync, auto sync (session end/start triggers), and initialize()'s
      // first-time sync alike. Fail-open by design (see min-version-gate.ts) --
      // this only ever fires when the extension's own version has been
      // explicitly marked unsupported in the remote config.
      if (await isCloudSyncBlockedByMinVersionGate()) {
        console.warn('[AutoSync] Cloud sync blocked: extension version is below the remote minimum-supported version')
        this.updateSyncState({ status: 'error', error: MIN_VERSION_SYNC_BLOCKED_MESSAGE })
        return
      }

      this.lastSyncAttempt = now
      this.updateSyncState({ status: 'syncing' })

      try {
        // Perform sync based on direction
        if (direction === 'upload' || direction === 'both') {
          await this.syncToCloud()
        }

        if (direction === 'download' || direction === 'both') {
          await this.syncFromCloud()
        }

        // Update success state
        this.syncState.lastSyncTime = new Date()
        await chrome.storage.local.set({ [this.SYNC_STORAGE_KEY]: this.syncState.lastSyncTime.toISOString() })

        // Update timestamps after sync
        await this.updateTimestamps()

        this.updateSyncState({
          status: 'success',
          lastSyncTime: this.syncState.lastSyncTime,
          error: undefined
        })

        console.log(`[AutoSync] Sync completed successfully (direction: ${direction})`)
      } catch (error) {
        console.error('[AutoSync] Sync error:', error)
        this.updateSyncState({
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error'
        })
      }
    } finally {
      this._isSyncing = false
    }
  }

  /**
   * Sync local events to cloud
   */
  private async syncToCloud(): Promise<void> {
    console.log('[AutoSync] Starting upload to cloud...')

    // Get the latest timestamp from cloud first
    const cloudMaxTimestamp = await firestoreBackupService.getCloudMaxTimestamp()
    console.log(`[AutoSync] Cloud max timestamp: ${cloudMaxTimestamp || 'none'}`)

    // ==========================================================================
    // UNPARSEABLE-ROW SYNC FLOOR -- invariant spec (PR #142 review r3611258695;
    // hardened by codex reviews r3614064524, r3614189343, r3614189347 on #182)
    // ==========================================================================
    //
    // THE PROBLEM: `chunk = rawChunk.filter(isApplicationApiEvent)` below drops
    // any raw row whose ApiTypeId IS an application type but whose payload
    // currently fails Zod validation (e.g. a 309 broken by a PokerChase payload
    // change -- see docs/postmortems/2026-07-session-results-drop.md). That row
    // is never uploaded, but `lastProcessedTimestamp` -- and therefore
    // Firestore's own max timestamp, which `getCloudMaxTimestamp()` reads back
    // on every subsequent call -- would advance past it as soon as a *later*
    // valid event (same or a following session) gets uploaded, permanently
    // excluding the row from every future upload query, even after a future
    // schema fix makes it parseable again (and `syncFromCloud()` on a fresh
    // install after local data loss could never recover it either).
    //
    // MEANING: `SYNC_UNPARSEABLE_FLOOR_KEY` in `meta`, when non-null, names the
    // earliest local timestamp that is not yet SAFE -- either (a) still an
    // application-typed row that fails to parse, or (b) parses now but has not
    // yet been confirmed (Firestore write acknowledged) as uploaded. Every
    // `syncToCloud()` call rewinds its scan floor to just below this marker
    // (see `scanFloor` below), so nothing at or after it is ever treated as
    // "already covered" by the cloud watermark alone -- it keeps getting
    // re-offered to `isApplicationApiEvent` every sync until it both parses
    // and uploads successfully.
    //
    // WHEN THE FLOOR MAY BE SET (null -> a value): immediately, the moment a
    // chunk reveals a *new* unparseable row while no floor is currently
    // persisted -- BEFORE that chunk's (or any later chunk's) upload can push
    // the cloud max past it (r3614064524: `syncToCloudBatch` is what advances
    // Firestore's own max, so a durable marker must land first or a SW death
    // right after the upload reopens the permanent-orphan window). Setting
    // from null only *narrows exposure* (protects a row that had none before),
    // so it is always safe to do eagerly, mid-pass, per chunk.
    //
    // WHEN THE FLOOR MAY ADVANCE (a value -> a LATER value) OR CLEAR (a value
    // -> null): only *after* every `syncToCloudBatch` call covering the range
    // being released has been awaited and did not throw (r3614189347: raising
    // the floor past a row that was recovered-but-not-yet-confirmed-uploaded
    // would let a later sync stop re-offering that row before it is actually
    // durable in Firestore -- silently losing it exactly like the original
    // bug this mechanism exists to fix). Concretely: this loop never raises an
    // *already-persisted* floor mid-pass -- only sets it from null. The
    // (possibly advanced or cleared) final value is committed once, after the
    // while-loop below, once every chunk in the pass has been uploaded and
    // confirmed. Note an already-persisted floor from an earlier pass is
    // always <= anything discovered THIS pass (scanning starts right at it,
    // ascending), so leaving it untouched mid-pass never under-protects a new,
    // later orphan -- a future rewind-scan from floor-1 still reaches it. If
    // the final commit itself is lost to a crash, the next pass harmlessly
    // re-derives and re-persists the same value (`syncToCloudBatch` upserts by
    // `${timestamp}_${ApiTypeId}`, so redundantly re-uploading already-synced
    // rows while re-deriving is just extra write cost, not a correctness bug).
    //
    // BACKFILL GUARANTEE (r3614189343): this floor did not always exist, so an
    // install that already had an unparseable row *below* the current cloud
    // max before this mechanism (or this fix) shipped would otherwise never
    // get it recorded -- `pendingUnparseableTimestamp` would read `null` and
    // `scanFloor` would fall back to trusting `cloudMaxTimestamp` outright,
    // permanently skipping that pre-existing orphan. `backfillUnparseableFloorIfNeeded()`
    // runs once (tracked by `SYNC_UNPARSEABLE_BACKFILL_DONE_KEY`) before this
    // trust decision, scanning local application-typed rows at/below the cloud
    // max for any that are still unparseable and seeding the floor from the
    // earliest one found.
    //
    // Alternatives considered and rejected:
    // - Never advance the cursor past ANY unparseable row: reintroduces the
    //   exact starvation this raw-chunk-boundary cursor design exists to avoid
    //   (see the "100% noise chunk" test) -- one stuck row would block all
    //   future uploads forever, not just its own.
    // - Upload the raw/unparsed row to Firestore as an opaque blob so it counts
    //   toward `getCloudMaxTimestamp()`: pollutes Firestore with non-`ApiEvent`
    //   documents that `syncFromCloud()`/`decodeFields()` and every downstream
    //   consumer would need to special-case.
    // - Only re-scan from the earliest unparseable timestamp right after an
    //   explicit rebuild: misses the case where the schema fix ships and the
    //   very next auto-sync fires before any rebuild runs.
    await this.backfillUnparseableFloorIfNeeded(cloudMaxTimestamp)

    const pendingUnparseableTimestamp = await this.getUnparseableSyncFloor()
    const scanFloor = pendingUnparseableTimestamp !== null && cloudMaxTimestamp !== null
      ? Math.min(cloudMaxTimestamp, pendingUnparseableTimestamp - 1)
      : cloudMaxTimestamp
    if (scanFloor !== cloudMaxTimestamp) {
      console.log(`[AutoSync] Rewinding upload scan to ${scanFloor} to re-offer a previously unparseable row at ${pendingUnparseableTimestamp}`)
    }

    // Count events newer than the (possibly rewound) scan floor
    const totalCount = scanFloor !== null
      ? await this.db.apiEvents.where('timestamp').above(scanFloor).count()
      : await this.db.apiEvents.count()

    if (totalCount === 0) {
      console.log('[AutoSync] No new events to sync')
      // Nothing at all above the floor -- if a marker was pending, its row no
      // longer exists locally (e.g. local data was cleared). Nothing left to
      // recover, so clear the stale marker rather than rewinding forever.
      // (No upload happened in this branch, so there's nothing for the floor
      // to have advanced past -- clearing here is always safe.)
      if (pendingUnparseableTimestamp !== null) await this.persistUnparseableSyncFloor(null)
      return
    }

    console.log(`[AutoSync] Found ${totalCount} new events to sync`)

    // Process in chunks to avoid memory issues
    const CHUNK_SIZE = DATABASE_CONSTANTS.SYNC_CHUNK_SIZE
    let processed = 0
    let synced = 0
    let lastProcessedTimestamp = scanFloor || 0
    // Earliest still-unparseable-application timestamp seen across this whole
    // pass (see invariant spec above). Only ever reflects rows that are
    // STILL unparseable as of this pass's scan -- a row that resolved (now
    // parses) simply stops contributing to it, which is how the floor
    // eventually clears.
    let earliestUnparseableThisPass: number | null = null
    // Tracks whether a floor is already persisted (from a prior pass, or set
    // fresh earlier in THIS pass) -- gates the "set from null" fast path so
    // it only ever SETS, never RAISES, a value mid-pass (see invariant spec).
    let floorAlreadyPersisted = pendingUnparseableTimestamp !== null

    while (processed < totalCount) {
      // Get chunk of raw events newer than lastProcessedTimestamp. apiEvents is the
      // raw Lake (see docs/architecture.md) — it may contain non-application noise
      // (202/205 keepalive/timer events) that we deliberately never sync to cloud
      // (cost decision: only application-type events go to Firestore).
      const rawChunk = await this.db.apiEvents
        .where('timestamp')
        .above(lastProcessedTimestamp)
        .limit(CHUNK_SIZE)
        .toArray()

      if (rawChunk.length === 0) break

      // Sort chunk by timestamp to ensure order
      rawChunk.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))

      // Application-type-only filter for cloud upload. Deliberately filtered AFTER
      // sorting/tracking the raw chunk's boundary, not before: lastProcessedTimestamp
      // must advance based on the raw chunk regardless of how many rows in it are
      // noise, otherwise a chunk containing only non-application events would never
      // advance the cursor and the loop would refetch it forever.
      const chunk = rawChunk.filter(isApplicationApiEvent)

      // Find any application-typed rows in THIS raw chunk that still can't
      // parse (see watermark guard above).
      let earliestUnparseableThisChunk: number | null = null
      for (const raw of rawChunk) {
        if (isUnparseableApplicationEvent(raw) && typeof raw.timestamp === 'number') {
          earliestUnparseableThisChunk = earliestUnparseableThisChunk === null
            ? raw.timestamp
            : Math.min(earliestUnparseableThisChunk, raw.timestamp)
        }
      }

      if (earliestUnparseableThisChunk !== null) {
        earliestUnparseableThisPass = earliestUnparseableThisPass === null
          ? earliestUnparseableThisChunk
          : Math.min(earliestUnparseableThisPass, earliestUnparseableThisChunk)

        if (!floorAlreadyPersisted) {
          // First orphan discovered THIS pass with nothing currently
          // persisted -- SET (not raise) the floor before the upload below,
          // closing the r3614064524 window. Safe unconditionally: there is
          // no pre-existing recovered-but-unconfirmed row this could be
          // prematurely releasing (r3614189347 does not apply to a null ->
          // value transition).
          await this.persistUnparseableSyncFloor(earliestUnparseableThisPass)
          floorAlreadyPersisted = true
        }
        // else: a floor is already durable and (per the invariant spec) is
        // guaranteed <= earliestUnparseableThisPass -- it already protects
        // this timestamp. Raising it further must wait until every upload up
        // to that point is confirmed, which happens once, after the loop.
      }

      // Sync this chunk (skip the Firestore round-trip entirely if it's all noise)
      if (chunk.length > 0) {
        const summary = await firestoreBackupService.syncToCloudBatch(
          chunk,
          // Pass the (possibly rewound) scan floor, not the raw Firestore max:
          // otherwise a just-recovered row whose timestamp sits below the real
          // cloud max would be filtered back out by syncToCloudBatch's own
          // dedup check, defeating the whole point of rewinding. Firestore
          // writes are idempotent upserts keyed by `${timestamp}_${ApiTypeId}`,
          // so redundantly re-sending already-uploaded rows in
          // [scanFloor, cloudMaxTimestamp] while a marker is pending is safe --
          // just extra write cost, bounded to however much happened since the
          // break, and it stops once the row resolves.
          scanFloor,
          (progress) => {
            this.updateSyncState({
              progress: {
                current: processed + progress.current,
                total: totalCount,
                direction: 'upload'
              }
            })
          }
        )
        // Reaching this line means the await above did not throw, i.e.
        // Firestore acknowledged every write in this chunk -- this chunk's
        // rows (including any recovered row the persisted floor was still
        // protecting) are now confirmed durable. This is what makes it safe
        // for the end-of-loop commit below to eventually advance/clear the
        // floor past them.
        synced += summary.syncedEvents
      }

      processed += rawChunk.length

      // Update timestamp for next chunk (based on the raw chunk, see comment above)
      const lastRawEvent = rawChunk[rawChunk.length - 1]
      if (lastRawEvent && lastRawEvent.timestamp) {
        lastProcessedTimestamp = lastRawEvent.timestamp
      }
    }

    // Full pass completed without throwing -- every chunk's upload above was
    // awaited and confirmed (see comment inside the loop), so it is now safe
    // to advance or clear the floor to its final value for this pass. If this
    // commit itself is lost to a crash, the next pass re-derives and
    // re-persists the same value (see invariant spec above) -- not a
    // correctness gap, just a redundant re-scan/re-upload.
    await this.persistUnparseableSyncFloor(earliestUnparseableThisPass)

    console.log(`[AutoSync] Uploaded ${synced} new events to cloud`)
  }

  /**
   * One-time backfill (see the UNPARSEABLE-ROW SYNC FLOOR invariant spec in
   * `syncToCloud()`, "BACKFILL GUARANTEE"): seeds `SYNC_UNPARSEABLE_FLOOR_KEY`
   * from any local application-typed-but-unparseable row at or below the
   * current cloud max, for installs where such a row already existed before
   * this floor mechanism (or this ordering fix) shipped and was therefore
   * never recorded. No-ops after the first successful run
   * (`SYNC_UNPARSEABLE_BACKFILL_DONE_KEY`).
   *
   * Bounded scan: restricts to the `ApiTypeId` index over `ApiTypeValues`
   * first (so non-application noise like 202/205 keepalives -- typically the
   * majority of rows in a long-lived Raw Event Lake -- is skipped by the
   * IndexedDB index itself and never Zod-validated), then filters to
   * `timestamp <= cloudMaxTimestamp` (rows above it are already covered by
   * every normal `syncToCloud()` pass's own per-chunk detection) and paginates
   * via `processInChunks` so a 300k-row install never loads more than one
   * chunk into memory at a time.
   */
  private async backfillUnparseableFloorIfNeeded(cloudMaxTimestamp: number | null): Promise<void> {
    const alreadyDone = await this.db.meta.get(this.SYNC_UNPARSEABLE_BACKFILL_DONE_KEY)
    if (alreadyDone) return

    if (cloudMaxTimestamp === null) {
      // Nothing uploaded yet -- there is no "already past the watermark"
      // region below which a pre-existing orphan could be hiding.
      await this.markUnparseableFloorBackfillDone()
      return
    }

    console.log('[AutoSync] Running one-time unparseable-floor backfill scan...')
    let earliestBackfilledOrphan: number | null = null

    for await (const chunk of processInChunks(
      this.db.apiEvents
        .where('ApiTypeId').anyOf(ApiTypeValues)
        .and(raw => typeof raw.timestamp === 'number' && raw.timestamp <= cloudMaxTimestamp),
      DATABASE_CONSTANTS.SYNC_CHUNK_SIZE
    )) {
      for (const raw of chunk) {
        if (isUnparseableApplicationEvent(raw) && typeof raw.timestamp === 'number') {
          earliestBackfilledOrphan = earliestBackfilledOrphan === null
            ? raw.timestamp
            : Math.min(earliestBackfilledOrphan, raw.timestamp)
        }
      }
    }

    if (earliestBackfilledOrphan !== null) {
      // Only ever SET (never raise past) an existing floor: if a marker is
      // somehow already pending (e.g. a fresh orphan surfaced in an earlier
      // sync before this backfill got a chance to run), it is already <=
      // anything a backfill of older history could find, so leave it alone
      // rather than risk moving it later (see invariant spec above).
      const existing = await this.getUnparseableSyncFloor()
      if (existing === null) {
        console.log(`[AutoSync] Backfill found a pre-existing unparseable row at ${earliestBackfilledOrphan}; seeding sync floor`)
        await this.persistUnparseableSyncFloor(earliestBackfilledOrphan)
      }
    }

    await this.markUnparseableFloorBackfillDone()
  }

  private async markUnparseableFloorBackfillDone(): Promise<void> {
    await this.db.meta.put({
      id: this.SYNC_UNPARSEABLE_BACKFILL_DONE_KEY,
      value: true,
      updatedAt: Date.now()
    })
  }

  /** Read the persisted unparseable-row sync floor (see `syncToCloud()`). */
  private async getUnparseableSyncFloor(): Promise<number | null> {
    const record = await this.db.meta.get(this.SYNC_UNPARSEABLE_FLOOR_KEY)
    const value = record?.value
    return typeof value === 'number' ? value : null
  }

  /** Persist (or clear, when `timestamp` is `null`) the unparseable-row sync floor. */
  private async persistUnparseableSyncFloor(timestamp: number | null): Promise<void> {
    if (timestamp === null) {
      await this.db.meta.delete(this.SYNC_UNPARSEABLE_FLOOR_KEY)
      return
    }
    await this.db.meta.put({
      id: this.SYNC_UNPARSEABLE_FLOOR_KEY,
      value: timestamp,
      updatedAt: Date.now()
    })
  }

  /**
   * Sync cloud events to local (cloud as source of truth)
   */
  private async syncFromCloud(): Promise<void> {
    console.log('[AutoSync] Starting complete download from cloud...')

    let downloadedEvents = 0

    try {
      await firestoreBackupService.syncFromCloud({
        onBatch: async (events) => {
          await this.db.apiEvents.bulkPut(events)
          downloadedEvents += events.length
        },
        onProgress: (progress) => {
          this.updateSyncState({
            progress: { ...progress, direction: 'download' }
          })
        }
      })
    } catch (error) {
      // A previous page may already be durable. Rebuild before surfacing the
      // error so partially downloaded raw events cannot leave entities stale.
      if (downloadedEvents > 0) await this.rebuildLocalEntities()
      throw error
    }

    if (downloadedEvents > 0) {
      console.log(`[AutoSync] Downloaded and updated ${downloadedEvents} events from cloud`)
      await this.rebuildLocalEntities()
    }
  }

  /** Rebuild derived tables without loading the entire event history into memory. */
  private async rebuildLocalEntities(): Promise<void> {
    try {
      console.log('[AutoSync] Triggering chunked data rebuild after download...')

      const defaultSession = {
        id: undefined,
        battleType: undefined,
        name: undefined,
        players: new Map(),
        reset: () => { }
      }
      const converter = new EntityConverter(defaultSession)
      const service = (self as any).service
      const totalEventCount = await this.db.apiEvents.count()
      let lastProcessedTimestamp = 0
      let latestDealEvent: ApiEvent | undefined

      if (service?.session) service.session.reset()

      for await (const events of processInChunks(
        this.db.apiEvents.orderBy('[timestamp+ApiTypeId]'),
        DATABASE_CONSTANTS.SYNC_CHUNK_SIZE
      )) {
        // events is a raw Lake chunk (see docs/architecture.md) — it may contain
        // non-application noise, unknown ApiTypeIds, or app-type payloads that
        // fail the current schema. EntityConverter reads required fields (e.g.
        // EVT_DEAL.Game.SmallBlind) without guards, so only hand it validated
        // application events; isApiEventType()/restoreSessionEvent() below
        // already re-validate internally so they're safe on the raw chunk as-is.
        const validEvents = await filterValidApplicationEvents(events)
        const entities = converter.convertEventChunk(validEvents)
        await this.saveRebuiltEntities(entities)

        for (const event of events) {
          lastProcessedTimestamp = Math.max(lastProcessedTimestamp, event.timestamp || 0)
          this.restoreSessionEvent(service, event)
          if (isApiEventType(event, ApiType.EVT_DEAL)) latestDealEvent = event
        }
      }

      await this.saveRebuiltEntities(converter.flush())
      await this.db.meta.put({
        id: 'importStatus',
        value: {
          lastProcessedTimestamp,
          lastProcessedEventCount: totalEventCount,
          lastImportDate: new Date().toISOString()
        },
        updatedAt: Date.now()
      })

      this.restoreLatestDeal(service, latestDealEvent)
      console.log(`[AutoSync] Chunked data rebuild completed (${totalEventCount} events)`)
    } catch (error) {
      console.error('[AutoSync] Data rebuild error:', error)
      // Preserve the existing behavior: raw event sync remains successful even
      // if rebuilding derived data fails.
    }
  }

  private async saveRebuiltEntities(entities: ReturnType<EntityConverter['flush']>): Promise<void> {
    await saveEntities(this.db, entities, {
      onProgress: (counts) => {
        if (counts.hands + counts.phases + counts.actions > 0) {
          console.log(`[AutoSync] Generated entities - Hands: ${counts.hands}, Phases: ${counts.phases}, Actions: ${counts.actions}`)
        }
      }
    })
  }

  private restoreSessionEvent(service: any, event: ApiEvent): void {
    if (!service?.session) return

    if (event.ApiTypeId === ApiType.EVT_SESSION_RESULTS) {
      service.session.reset()
    } else if (isApiEventType(event, ApiType.EVT_ENTRY_QUEUED)) {
      service.session.setId(event.Id)
      service.session.setBattleType(event.BattleType)
    } else if (isApiEventType(event, ApiType.EVT_SESSION_DETAILS)) {
      service.session.setName(event.Name)
    } else if (isApiEventType(event, ApiType.EVT_PLAYER_SEAT_ASSIGNED)) {
      event.TableUsers?.forEach(tableUser => {
        service.session.setPlayer(tableUser.UserId, {
          name: tableUser.UserName,
          rank: tableUser.Rank.RankId
        })
      })
    } else if (isApiEventType(event, ApiType.EVT_PLAYER_JOIN) && event.JoinUser) {
      service.session.setPlayer(event.JoinUser.UserId, {
        name: event.JoinUser.UserName,
        rank: event.JoinUser.Rank.RankId
      })
    }
  }

  private restoreLatestDeal(service: any, latestDealEvent?: ApiEvent): void {
    if (!service) return

    if (service.session?.id) {
      console.log(`[AutoSync] Restored session: ${service.session.id} - ${service.session.name || 'Unknown'}`)
    }

    if (latestDealEvent && isApiEventType(latestDealEvent, ApiType.EVT_DEAL)) {
      service.latestEvtDeal = latestDealEvent
      const playerSeatIndex = latestDealEvent.Player?.SeatIndex
      if (playerSeatIndex !== undefined && playerSeatIndex >= 0) {
        const playerId = latestDealEvent.SeatUserIds?.[playerSeatIndex]
        if (playerId && playerId !== -1) service.playerId = playerId
      }
    }

    if (service.latestEvtDeal?.SeatUserIds) {
      const playerIds = service.latestEvtDeal.SeatUserIds.filter((id: number) => id !== -1)
      if (playerIds.length > 0) service.statsOutputStream.write(playerIds)
    }
  }


  /**
   * Update sync state and notify
   */
  private updateSyncState(updates: Partial<SyncState>): void {
    this.syncState = { ...this.syncState, ...updates }
    
    // Send state update to popup if it's open
    chrome.runtime.sendMessage({
      type: 'SYNC_STATE_UPDATE',
      state: this.syncState
    }).catch(() => {
      // Popup might not be open, ignore error
    })
  }

  /**
   * Get current sync state
   */
  getSyncState(): SyncState {
    return { ...this.syncState }
  }

  /**
   * Handle authentication state changes
   */
  async onAuthStateChanged(user: any): Promise<void> {
    if (user) {
      // User logged in, start sync
      await this.initialize()
    } else {
      // User logged out, reset sync state
      this.updateSyncState({ status: 'idle', lastSyncTime: undefined })
    }
  }

  // Note on the raw `.count()`/`.where(...).count()` calls below (onGameSessionEnd,
  // getUnsyncedEventCount, getSyncInfo): apiEvents is the raw Lake and these counts
  // include non-application noise (202/205 keepalive/timer events) that syncToCloud()
  // never actually uploads (see its isApplicationApiEvent filter above). This was
  // already true before the Lake restoration — Dexie's `.count()` doesn't invoke the
  // `reading` hook that used to hide non-application rows, so these thresholds/UI
  // counts have always been raw-row counts, not "events that will actually sync"
  // counts. Left as-is here (not over-engineered into per-call `.and(isApplicationApiEvent)`
  // filters): they're a "is there enough new activity to justify a sync" threshold and a
  // rough "pending" UI number, not billing-accurate counts.

  /**
   * バックログが閾値を超えていればuploadを起動する共通ロジック。
   * `onGameSessionEnd`（309到着時）と`onNewSessionStart`（201/308到着時、
   * postmortem再発防止#3のフォールバックトリガー）の両方から呼ばれる。
   *
   * 二重発火ガード: `this.isSyncing`チェックと、成功した同期が
   * `syncState.lastSyncTime`を進める（＝以降のバックログ件数を減らす）ことの
   * 組み合わせで自然に防がれる。309が正常に動作していれば、その直後に
   * 201/308が来てもバックログは既に閾値未満になっているため再発火しない。
   */
  private async syncIfBacklogExceedsThreshold(trigger: string): Promise<void> {
    // Only sync if there are enough new events to justify the cost
    const user = firebaseAuthService.getCurrentUser()
    if (!user || this.isSyncing) return

    try {
      // Check how many events we have since last sync
      const lastSyncTime = this.syncState.lastSyncTime?.getTime() || 0
      const newEventsCount = await this.db.apiEvents
        .where('timestamp')
        .above(lastSyncTime)
        .count()

      if (newEventsCount >= this.EVENTS_THRESHOLD) {
        console.log(`[AutoSync] ${trigger} with ${newEventsCount} new events, performing upload sync...`)
        await this.performSync('upload')
      } else {
        console.log(`[AutoSync] ${trigger} with only ${newEventsCount} new events, skipping sync (threshold: ${this.EVENTS_THRESHOLD})`)
      }
    } catch (error) {
      console.error(`[AutoSync] Error checking event count (${trigger}):`, error)
    }
  }

  /**
   * Handle game session end (EVT_SESSION_RESULTS / 309). Primary auto-sync trigger.
   */
  async onGameSessionEnd(): Promise<void> {
    await this.syncIfBacklogExceedsThreshold('Game ended')
  }

  /**
   * Handle new session start (EVT_ENTRY_QUEUED / 201, EVT_SESSION_DETAILS / 308).
   *
   * postmortem再発防止#3（docs/postmortems/2026-07-session-results-drop.md）:
   * 309単一トリガーはSPOFだった（2026年シーズン3で実際にRP/セッション結果が
   * 半年間喪失した）。新セッション開始はまだ進行中ハンドが存在しない安全な
   * タイミングなので、ここでも同じ閾値判定でuploadを起動し、309が再び壊れても
   * 「最大1セッション遅れ」を保証するフォールバックにする。
   */
  async onNewSessionStart(): Promise<void> {
    await this.syncIfBacklogExceedsThreshold('New session started')
  }

  /**
   * Get unsync event count (for UI display)
   */
  async getUnsyncedEventCount(): Promise<number> {
    try {
      const lastSyncTime = this.syncState.lastSyncTime?.getTime() || 0
      return await this.db.apiEvents
        .where('timestamp')
        .above(lastSyncTime)
        .count()
    } catch (error) {
      console.error('[AutoSync] Error getting unsynced count:', error)
      return 0
    }
  }

  /**
   * Update local and cloud last timestamps
   */
  async updateTimestamps(): Promise<void> {
    try {
      // Get local last timestamp
      const localLastEvent = await this.db.apiEvents
        .orderBy('timestamp')
        .reverse()
        .limit(1)
        .first()
      
      if (localLastEvent) {
        this.syncState.localLastTimestamp = localLastEvent.timestamp
      }

      // Get cloud last timestamp if authenticated
      const user = firebaseAuthService.getCurrentUser()
      if (user) {
        const cloudMaxTimestamp = await firestoreBackupService.getCloudMaxTimestamp()
        this.syncState.cloudLastTimestamp = cloudMaxTimestamp || undefined
      }

      // Notify UI of updated state
      this.updateSyncState({
        localLastTimestamp: this.syncState.localLastTimestamp,
        cloudLastTimestamp: this.syncState.cloudLastTimestamp
      })
    } catch (error) {
      console.error('[AutoSync] Error updating timestamps:', error)
    }
  }

  /**
   * Get sync info for display
   */
  async getSyncInfo(): Promise<{
    localLastTimestamp?: number
    cloudLastTimestamp?: number
    uploadPendingCount: number
  }> {
    await this.updateTimestamps()
    
    // Calculate upload pending count based on cloud timestamp
    let uploadPendingCount = 0
    if (this.syncState.cloudLastTimestamp !== undefined) {
      uploadPendingCount = await this.db.apiEvents
        .where('timestamp')
        .above(this.syncState.cloudLastTimestamp)
        .count()
    } else {
      // If no cloud timestamp, all events are pending
      uploadPendingCount = await this.db.apiEvents.count()
    }
    
    return {
      localLastTimestamp: this.syncState.localLastTimestamp,
      cloudLastTimestamp: this.syncState.cloudLastTimestamp,
      uploadPendingCount
    }
  }

}

// Export singleton instance
export const autoSyncService = new AutoSyncService()
