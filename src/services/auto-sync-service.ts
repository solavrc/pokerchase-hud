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

/**
 * Thrown internally whenever a bookkeeping write is about to happen under a
 * uid that no longer matches the one signed in live -- i.e. the account
 * changed since this sync pass started. Never thrown for the actual
 * Firestore upload/download calls themselves (accepted risk, see the
 * ACCOUNT-SCOPING INVARIANTS spec below) -- only for this file's own
 * `meta`/`chrome.storage.local` bookkeeping writes. Caught by
 * `performSync()`'s existing catch block, which sets `syncState.status =
 * 'error'` -- the next `performSync()` call retries cleanly under whichever
 * account is signed in by then.
 */
export class SyncAccountChangedError extends Error {
  constructor(context: string) {
    super(`同期中にサインインアカウントが変更されたため、このアカウント宛の記録を中止しました (${context})`)
    this.name = 'SyncAccountChangedError'
  }
}

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

/**
 * ==============================================================================
 * ACCOUNT-SCOPING INVARIANTS (owner-decided scope, sola, 2026-07-20/21 --
 * post-merge diversity reviews on #182 and #192)
 * ==============================================================================
 *
 * A same-device account switch (sign-in mistake, shared device, etc.) is a
 * realistic case that must be handled -- but the owner-decided requirement
 * is narrower than "prevent cross-account uploads entirely":
 *
 * EXPLICITLY ACCEPTED: local storage (`apiEvents`/`hands`/... in Dexie) is a
 * single unpartitioned store per browser profile, and an in-flight sync pass
 * can legitimately end up reading from or writing to whichever Firebase
 * account is live at the moment `firestore-backup-service.ts` makes its own
 * internal `requireUser()`/`getIdToken()` calls -- this file does NOT try to
 * pin those network calls to a snapshotted identity (see ACCEPTED RESIDUAL
 * RISK below). The worst case is data ending up duplicated in the wrong
 * account's Firestore. Accepted, not fixed here (an earlier draft of this
 * fix added a `localDataOwnerUid` ownership guard blocking automatic
 * cross-account uploads entirely -- removed per this decision).
 *
 * WHAT MUST HOLD: bookkeeping integrity per account. After a user signs back
 * into the correct account (following a sign-in mistake), THAT account's own
 * sync state (watermark/floor/backfill markers, `lastSyncTime`) must be
 * intact and correct -- no permanent gap, no marker silently advanced or
 * cleared by a DIFFERENT account's session in between.
 *
 * (1) LEGACY VALUES MIGRATE ONCE, TO WHOEVER IS SIGNED IN, NEVER INHERITED BY
 *     A DIFFERENT UID: an upgraded profile can have an old unscoped
 *     `autoSyncLastTime` value with no account attribution at all. The first
 *     `initialize()` call after upgrade migrates it to that specific uid's
 *     scoped key AND DELETES the unscoped key in the same step -- so it is
 *     consumed exactly once, by whichever account happens to be signed in
 *     the first time this code runs, and can never be read by (or
 *     accidentally granted to) a later, different uid. A subsequent account
 *     that has never synced correctly sees no stored `lastSyncTime` at all,
 *     not a borrowed one.
 *
 * (2) EVERY BOOKKEEPING WRITE IS GATED ON THE PASS-START UID STILL BEING
 *     LIVE: `performSync()` captures `firebaseAuthService.getCurrentUser()?.uid`
 *     once at sync start and threads that same value through the rest of
 *     the pass. `persistUnparseableSyncFloor()` and
 *     `markUnparseableFloorBackfillDone()` -- the ONLY two methods that ever
 *     write floor/backfill-done `meta` bookkeeping -- each re-check the LIVE
 *     signed-in uid against the uid they were called with, immediately
 *     before their own `db.meta` write, and throw `SyncAccountChangedError`
 *     instead of writing if it no longer matches. `performSync()`'s own
 *     final `autoSyncLastTime` write and `initialize()`'s legacy-migration
 *     write get the same inline check. Every bookkeeping write in this file
 *     is gated at its own write site -- not by remembering to guard every
 *     caller.
 *
 *     Deliberately NOT gated: the Firestore upload/download calls themselves
 *     (`syncToCloudBatch`/`syncFromCloud`/`getCloudMaxTimestamp`) -- see
 *     ACCEPTED RESIDUAL RISK. This is what closes the scenario that a naive
 *     "assert before the network call" guard would still miss:
 *     `getCloudMaxTimestamp()` at the top of `syncToCloud()` can legitimately
 *     reflect a DIFFERENT account's cloud state if the user switched
 *     accounts between `performSync()`'s snapshot and that call, and
 *     `backfillUnparseableFloorIfNeeded()` downstream still runs against
 *     that (possibly stale-account) value -- but it can never actually
 *     COMMIT `syncUnparseableFloorBackfillDoneV2` or a floor value derived
 *     from it under the SNAPSHOTTED (now wrong) uid's key, because the write
 *     methods themselves refuse once the live uid has moved on. The pass
 *     aborts with `SyncAccountChangedError`, `performSync()`'s catch block
 *     sets `status: 'error'`, and the NEXT sync pass (by either account)
 *     re-derives cleanly from scratch.
 *
 * (3) AUTOMATIC SYNC IS NOT GATED ON WHO LAST SYNCED LOCAL DATA: there is
 *     deliberately no "local data owner" marker or any check blocking
 *     automatic sync when local data may belong to a different account --
 *     the owner confirmed cross-account uploads are acceptable.
 *     `initialize()`'s first-sync trigger and `syncIfBacklogExceedsThreshold()`
 *     (backing `onGameSessionEnd`/`onNewSessionStart`) behave exactly as
 *     they did before any account-scoping work in that respect; only the
 *     per-account BOOKKEEPING they read/write is scoped and write-gated per
 *     (1)/(2) above.
 *
 * ACCEPTED RESIDUAL RISK (`firestore-backup-service.ts`, deliberately
 * untouched by this fix): every public method there (`getCloudMaxTimestamp`,
 * `syncToCloudBatch`, `syncFromCloud`, ...) independently calls its own
 * `requireUser()`, re-resolving `firebaseAuthService.getCurrentUser()` live
 * at call time regardless of what this file snapshotted -- so the actual
 * Firestore document path a given network call targets is decided at the
 * last possible moment, not pinned to `performSync()`'s snapshot.
 * 簿記はpass開始時のuidの下でのみ、そのuidが依然liveである時のみ前進する。
 * アップロード先の誤りはデータ重複に留まり、復帰したアカウントの簿記は
 * 常に正しい。
 *
 * Sign-out/sign-in transitions do not touch any OTHER account's scoped keys
 * (`onAuthStateChanged(null)` only resets in-memory `syncState`, never
 * deletes `meta`/`chrome.storage.local` entries) -- each account's
 * bookkeeping survives a sign-out/sign-in cycle for a different account
 * untouched, satisfying the isolation half of these invariants together with
 * (1)/(2) above.
 */
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
   * 直前までスキャン開始点を巻き戻す。実際のキーは`scopedMetaKey()`でサインイン中の
   * uidにスコープされる（上記 ACCOUNT-SCOPING INVARIANTS 参照）。
   */
  private readonly SYNC_UNPARSEABLE_FLOOR_KEY = 'syncUnparseableFloor'
  /**
   * `meta`テーブルのキー。一度だけ実行するバックフィルスキャン
   * （`backfillUnparseableFloorIfNeeded`、下記の invariant spec 参照）が
   * 完了したかどうかを記録する。存在する限り、以降の`syncToCloud()`は
   * バックフィルスキャンを二度と実行しない。実際のキーは`scopedMetaKey()`で
   * uidスコープされる。定数の文字列自体も`V2`にリネームしてある: 旧ロジック
   * （現在パースできない行だけを探す、かつuidスコープなし）で既にdone=trueを
   * 記録済みのインストールに、修正後のロジック（P1 fix、下記
   * `backfillUnparseableFloorIfNeeded`参照）とuidスコープを確実に一度だけ
   * 適用させるため。
   */
  private readonly SYNC_UNPARSEABLE_BACKFILL_DONE_KEY = 'syncUnparseableFloorBackfillDoneV2'

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
   * Scopes a local sync-bookkeeping key to a specific Firebase account.
   * Returns `${baseKey}:${uid}` when `uid` is provided, else the bare
   * `baseKey` (signed-out fallback -- defensive only, see invariant (2)
   * above; every real call site passes the pass-start snapshot).
   */
  private scopedMetaKey(baseKey: string, uid: string | undefined): string {
    return uid ? `${baseKey}:${uid}` : baseKey
  }

  /**
   * Throws `SyncAccountChangedError` if the live signed-in uid no longer
   * matches `uid` (the value snapshotted at this sync pass's start). Called
   * ONLY from the bookkeeping write choke points (`persistUnparseableSyncFloor`,
   * `markUnparseableFloorBackfillDone`, `performSync()`'s final
   * `autoSyncLastTime` write, `initialize()`'s legacy-migration write) --
   * never around the Firestore network calls themselves. See invariant (2)
   * in the ACCOUNT-SCOPING INVARIANTS spec above.
   */
  private assertUidUnchanged(uid: string | undefined, context: string): void {
    const liveUid = firebaseAuthService.getCurrentUser()?.uid
    if (liveUid !== uid) {
      throw new SyncAccountChangedError(context)
    }
  }

  /**
   * Initialize auto sync service
   */
  async initialize(): Promise<void> {
    try {
      // Check who is signed in FIRST -- everything below needs a
      // snapshotted uid (invariant (2)).
      const user = firebaseAuthService.getCurrentUser()
      if (!user) {
        console.log('[AutoSync] User not authenticated, skipping initialization')
        return
      }
      const uid = user.uid

      // Load last sync time from storage, scoped to this account (invariant
      // (1)). If this account's scoped key doesn't exist yet but the LEGACY
      // unscoped key does, migrate it: this account is whoever happens to be
      // signed in the first time this runs post-upgrade, so it's the only
      // reasonable owner to attribute an unattributed legacy value to.
      // Migration deletes the legacy key in the same step, so it is consumed
      // exactly once and can never later be read by (or granted to) a
      // DIFFERENT uid.
      const scopedSyncKey = this.scopedMetaKey(this.SYNC_STORAGE_KEY, uid)
      const stored = await chrome.storage.local.get([scopedSyncKey, this.SYNC_STORAGE_KEY]) as Record<string, any>
      let storedLastSyncTime = stored[scopedSyncKey]
      if (storedLastSyncTime === undefined && stored[this.SYNC_STORAGE_KEY] !== undefined) {
        storedLastSyncTime = stored[this.SYNC_STORAGE_KEY]
        // COMMIT POINT (invariant (2)): re-check before this migration write.
        this.assertUidUnchanged(uid, 'before legacy autoSyncLastTime migration')
        console.log(`[AutoSync] Migrating legacy unscoped ${this.SYNC_STORAGE_KEY} to this account (${uid}) and clearing it`)
        await chrome.storage.local.set({ [scopedSyncKey]: storedLastSyncTime })
        await chrome.storage.local.remove(this.SYNC_STORAGE_KEY)
      }
      // Explicitly reset (not just "leave whatever was there") so a direct
      // account switch without an intervening sign-out can't leak the
      // previous account's in-memory lastSyncTime into this one.
      this.syncState.lastSyncTime = storedLastSyncTime ? new Date(storedLastSyncTime as string | number) : undefined

      // Update timestamps
      await this.updateTimestamps()

      // Perform initial sync only if never synced before (invariant (3):
      // no cross-account ownership check here -- automatic sync for a
      // never-synced account is allowed to proceed, by owner decision).
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

    // SNAPSHOT the uid ONCE for this entire pass (invariant (2) in the
    // ACCOUNT-SCOPING INVARIANTS spec above). `syncToCloud`/`syncFromCloud`
    // and their bookkeeping helpers all use THIS value, never a freshly
    // re-resolved `getCurrentUser()`. `undefined` when signed out.
    const uid = firebaseAuthService.getCurrentUser()?.uid

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
          await this.syncToCloud(uid)
        }

        if (direction === 'download' || direction === 'both') {
          await this.syncFromCloud()
        }

        // COMMIT POINT (invariant (2)): the live uid must still match the
        // snapshot before writing the final success bookkeeping below.
        this.assertUidUnchanged(uid, 'before final lastSyncTime commit')

        // Update success state
        this.syncState.lastSyncTime = new Date()
        await chrome.storage.local.set({
          [this.scopedMetaKey(this.SYNC_STORAGE_KEY, uid)]: this.syncState.lastSyncTime.toISOString()
        })

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
  private async syncToCloud(uid: string | undefined): Promise<void> {
    console.log('[AutoSync] Starting upload to cloud...')

    // Get the latest timestamp from cloud first
    const cloudMaxTimestamp = await firestoreBackupService.getCloudMaxTimestamp()
    console.log(`[AutoSync] Cloud max timestamp: ${cloudMaxTimestamp || 'none'}`)

    // ==========================================================================
    // UNPARSEABLE-ROW SYNC FLOOR -- invariant spec (PR #142 review r3611258695;
    // hardened by codex reviews r3614064524, r3614189343, r3614189347 on #182;
    // further hardened by codex post-merge diversity review on #182,
    // r3614469176 (P2, ordering) / r3614469177 (P1, backfill seeding),
    // 2026-07-20 -- the third finding from that review, uid-scoping, is a
    // separate multi-account concern tracked/paused on #192, not part of this
    // single-account-focused fix)
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
    // WHEN THE FLOOR MAY BE SET OR LOWERED (null -> a value, OR an existing
    // value -> an EARLIER value): immediately, the moment a chunk reveals an
    // unparseable row whose timestamp is lower than whatever is currently
    // durable -- BEFORE that chunk's (or any later chunk's) upload can push
    // the cloud max past it (r3614064524: `syncToCloudBatch` is what advances
    // Firestore's own max, so a durable marker must land first or a SW death
    // right after the upload reopens the permanent-orphan window). Lowering
    // (from null, or from an existing value) only *narrows exposure*
    // (protects a row that had less or no protection before), so it is
    // always safe to do eagerly, mid-pass, per chunk.
    //
    // r3614469176 (P2, "Persist earlier discovered floors before uploading"):
    // the original code only ever took this eager-persist path on a null ->
    // value transition, on the assumption that an already-persisted floor
    // from an earlier pass is always <= anything discovered THIS pass
    // (reasoning: scanning starts right at it, ascending). That assumption
    // breaks when a user IMPORTS older raw events between sync passes: the
    // scan floor for the CURRENT pass is derived from `cloudMaxTimestamp`,
    // which can sit well below an already-pending-but-later floor (e.g. the
    // floor was set to a row's timestamp before any upload advanced the real
    // cloud max that far yet) -- so a newly imported, EARLIER unparseable row
    // can land inside this pass's scanned range despite being earlier than
    // the persisted floor. Deferring its persistence to the end-of-loop
    // commit (as the old code did) reopens the exact r3614064524 crash
    // window: if a later chunk in the same pass uploads successfully (moving
    // Firestore's real max past the newly discovered earlier row) and the
    // process then dies before the final commit, the durable floor is stuck
    // at the later, now-insufficient value and the next pass's rewind never
    // reaches the earlier orphan again. Fix: persist eagerly whenever this
    // pass's running earliest-unparseable value is LOWER than whatever is
    // currently durable, not only when nothing was durable yet.
    //
    // WHEN THE FLOOR MAY ADVANCE (a value -> a LATER value) OR CLEAR (a value
    // -> null): only *after* every `syncToCloudBatch` call covering the range
    // being released has been awaited and did not throw (r3614189347: raising
    // the floor past a row that was recovered-but-not-yet-confirmed-uploaded
    // would let a later sync stop re-offering that row before it is actually
    // durable in Firestore -- silently losing it exactly like the original
    // bug this mechanism exists to fix). The (possibly advanced or cleared)
    // final value is committed once, after the while-loop below, once every
    // chunk in the pass has been uploaded and confirmed. If the final commit
    // itself is lost to a crash, the next pass harmlessly re-derives and
    // re-persists the same value (`syncToCloudBatch` upserts by
    // `${timestamp}_${ApiTypeId}`, so redundantly re-uploading already-synced
    // rows while re-deriving is just extra write cost, not a correctness bug).
    //
    // BACKFILL GUARANTEE (r3614189343; broadened by r3614469177, P1, "Seed
    // floors for rows that already parse after upgrade"): this floor did not
    // always exist, so an install that already had an unparseable row *below*
    // the current cloud max before this mechanism shipped would otherwise
    // never get it recorded -- `pendingUnparseableTimestamp` would read
    // `null` and `scanFloor` would fall back to trusting `cloudMaxTimestamp`
    // outright, permanently skipping that pre-existing orphan. The original
    // backfill only scanned for rows that were STILL unparseable at backfill
    // time -- which misses exactly the case where the schema fix ships in
    // the SAME release as the floor mechanism (or any later release a user
    // upgrades directly into, skipping intermediates): the old orphan row
    // already parses by the time the backfill runs, so it's invisible to
    // that scan, even though it was never actually uploaded (the pass that
    // pushed the cloud max past it happened while the row still failed to
    // parse). See `backfillUnparseableFloorIfNeeded()`'s doc comment for the
    // fixed design and cost reasoning (300k-row install).
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
    // - Per-row Firestore existence check for the backfill: sound in
    //   principle, but a long-lived install can have tens of thousands of
    //   application-typed rows below the watermark -- that's tens of
    //   thousands of extra reads (recurring cost risk, not a bounded
    //   one-time migration) versus the near-O(1) local lookup this fix uses.
    await this.backfillUnparseableFloorIfNeeded(cloudMaxTimestamp, uid)

    const pendingUnparseableTimestamp = await this.getUnparseableSyncFloor(uid)
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
      if (pendingUnparseableTimestamp !== null) await this.persistUnparseableSyncFloor(null, uid)
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
    // Mirrors whatever is CURRENTLY durable in `meta` for this floor --
    // updated every time this loop persists a new value below, so the
    // "should I write?" check is always comparing against the true on-disk
    // state (not just "did THIS pass write yet"). This is what lets the P2
    // fix (r3614469176) correctly persist a newly discovered EARLIER orphan
    // even when a LATER floor from a previous pass is already durable (see
    // invariant spec above).
    let persistedFloorValue = pendingUnparseableTimestamp

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

        // Persist EAGERLY whenever the running earliest-this-pass value is
        // LOWER than whatever is currently durable -- covers both the
        // original null -> value fast path AND the P2 fix (r3614469176):
        // value -> an EARLIER value discovered mid-pass (e.g. older raw
        // events imported while cloudMaxTimestamp still sits below an
        // already-pending, LATER floor -- see invariant spec above). Must
        // land before this chunk's upload below, closing the r3614064524
        // window for this newly discovered orphan too: a crash after the
        // upload (which can advance Firestore's real max past it) but
        // before this pass's final commit would otherwise leave the durable
        // floor stuck at the later, now-insufficient value, permanently
        // orphaning the earlier row. Safe unconditionally to write early --
        // lowering the floor only ever narrows exposure, never releases a
        // row that was previously protected (r3614189347's "only raise
        // after confirmed upload" rule applies to RAISING/clearing, not to
        // lowering).
        if (persistedFloorValue === null || earliestUnparseableThisPass < persistedFloorValue) {
          await this.persistUnparseableSyncFloor(earliestUnparseableThisPass, uid)
          persistedFloorValue = earliestUnparseableThisPass
        }
        // else: the durable floor is already <= earliestUnparseableThisPass
        // -- it already protects this timestamp. Raising it further must
        // wait until every upload up to that point is confirmed, which
        // happens once, after the loop.
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
    // correctness gap, just a redundant re-scan/re-upload. (No explicit
    // account-switch assert needed at this specific call site -- it's
    // built into `persistUnparseableSyncFloor()` itself, see the
    // ACCOUNT-SCOPING INVARIANTS spec's invariant (2).)
    await this.persistUnparseableSyncFloor(earliestUnparseableThisPass, uid)

    console.log(`[AutoSync] Uploaded ${synced} new events to cloud`)
  }

  /**
   * One-time backfill (see the UNPARSEABLE-ROW SYNC FLOOR invariant spec in
   * `syncToCloud()`, "BACKFILL GUARANTEE"): seeds `SYNC_UNPARSEABLE_FLOOR_KEY`
   * for installs that may already have an orphaned row *below* the current
   * cloud max from before this floor mechanism (or this fix) existed. No-ops
   * after the first successful run (`SYNC_UNPARSEABLE_BACKFILL_DONE_KEY`).
   *
   * P1 FIX (codex post-merge review r3614469177, "Seed floors for rows that
   * already parse after upgrade"): the original version of this method
   * scanned local application-typed rows at/below the cloud max for ones
   * that are STILL unparseable *right now*, and seeded the floor from the
   * earliest one found. That misses exactly the season-3 scenario this
   * mechanism exists to fix: when the schema repair ships in the SAME
   * release as the floor mechanism (or any later release a user upgrades
   * directly into, skipping intermediate releases), the old orphan row
   * already parses successfully by the time this backfill runs --
   * `isUnparseableApplicationEvent()` returns false for it -- so the old
   * scan found nothing, marked itself done, and the row (below the cloud
   * max, never actually uploaded, because it failed to parse at the time the
   * pass that pushed the cloud max past it ran) stayed permanently orphaned.
   *
   * There is no historical local record of which specific rows were
   * confirmed uploaded at any point in the past (only the derived Firestore
   * max itself, which says nothing about gaps below it), and no cheap way to
   * ask Firestore "does a document for this exact row exist" per row -- that
   * is an extra network round trip PER application-typed row below the
   * watermark, which for a long-lived install is tens of thousands of reads,
   * a recurring cost risk rather than a bounded one-time migration.
   *
   * Since we cannot cheaply distinguish "already uploaded, and now happens
   * to still parse" from "orphaned, and now happens to parse" for any
   * individual row, the only SOUND conservative approximation is to stop
   * trying to identify individual suspect rows and instead seed the floor
   * from the EARLIEST application-typed row anywhere in the local Lake that
   * sits at or below the cloud max -- regardless of whether it currently
   * parses. This forces exactly one full reconciliation re-offer of the
   * entire below-watermark history on the next `syncToCloud()` pass.
   * `syncToCloudBatch`'s Firestore writes are idempotent upserts keyed by
   * `${timestamp}_${ApiTypeId}`, so re-sending already-uploaded rows is not
   * a correctness bug, only extra write volume.
   *
   * COST (reasoned for a 300k-row install, ~50% application-typed per the
   * Raw Event Lake's documented noise ratio -- CLAUDE.md Design Principles
   * #16 "Storage growth"):
   * - READ side: near-O(1), not O(n). `apiEvents`'s primary key is
   *   `[timestamp+ApiTypeId]`, so cursoring in that order and taking the
   *   FIRST row whose `ApiTypeId` is an application type stops almost
   *   immediately -- it does not get more expensive as the Lake grows, and
   *   does not need `processInChunks` pagination (a single row is fetched).
   * - WRITE side (the actual one-time cost): the next sync pass re-uploads
   *   on the order of ~150k already-synced documents once. Firestore write
   *   pricing (~$0.18 per 100k document writes past the free tier) puts that
   *   well under $1 even for a heavy user, and the write volume is naturally
   *   paced by this service's existing chunked upload loop
   *   (`DATABASE_CONSTANTS.SYNC_CHUNK_SIZE` per Firestore batch) -- not a
   *   cost this backfill can repeat (see PROVEN-STATE REQUIREMENT below).
   *   Only installs with SOME existing cloud history pay it at all
   *   (`cloudMaxTimestamp !== null` below) -- a brand-new install has
   *   nothing below any watermark to reconcile.
   *
   * INVARIANT: once this backfill has completed (successfully), the sync
   * floor is guaranteed to be <= the timestamp of any local application-
   * typed row that predates the cloud watermark at the time the backfill
   * ran -- so no row below the watermark can be silently skipped by trusting
   * the watermark alone, independent of whether that row happened to already
   * be uploaded.
   *
   * Tracked by `SYNC_UNPARSEABLE_BACKFILL_DONE_KEY`, independently renamed
   * (see its doc comment) to force exactly one fresh run of this corrected
   * logic for every existing install, even one whose OLD backfill already
   * marked the OLD key name done.
   *
   * PROVEN-STATE REQUIREMENT (codex review round 4 on PR #182, unchanged by
   * the P1 fix): this method must only ever mark itself done when
   * `cloudMaxTimestamp` reflects a proven cloud state -- either a real
   * watermark, or a confirmed-empty cloud. `getCloudMaxTimestamp()` upholds
   * this by throwing on auth/network/REST failure instead of returning
   * `null` for "unknown" (see its doc comment) -- so by the time
   * `cloudMaxTimestamp` reaches this method (the call in `syncToCloud()`
   * above is unguarded and lets that throw abort the whole sync attempt
   * before this method is ever invoked), `null` here can ONLY mean "proven
   * empty". Do not add a try/catch around that call site that would
   * reintroduce the ambiguity.
   */
  private async backfillUnparseableFloorIfNeeded(cloudMaxTimestamp: number | null, uid: string | undefined): Promise<void> {
    const doneKey = this.scopedMetaKey(this.SYNC_UNPARSEABLE_BACKFILL_DONE_KEY, uid)
    const alreadyDone = await this.db.meta.get(doneKey)
    if (alreadyDone) return

    if (cloudMaxTimestamp === null) {
      // Proven empty (see PROVEN-STATE REQUIREMENT above) -- nothing has
      // ever been uploaded, so there is no "already past the watermark"
      // region below which a pre-existing orphan could be hiding.
      await this.markUnparseableFloorBackfillDone(uid)
      return
    }

    console.log('[AutoSync] Running one-time sync-floor backfill scan...')

    // Earliest application-typed row AT OR BELOW cloudMaxTimestamp, regardless
    // of whether it currently parses (see P1 fix doc comment above for why
    // this must NOT be restricted to currently-unparseable rows only).
    //
    // BOUNDED, INDEXED SCAN (codex review r3615140413, P2, "Avoid unbounded
    // scans in the V2 backfill"): the original version cursored the PRIMARY
    // key `[timestamp+ApiTypeId]` with a `.filter()` predicate. Since the
    // `ApiTypeId` check isn't part of that index's range, Dexie has to walk
    // the cursor row-by-row (can't skip via the index alone) -- and because
    // the query had no upper bound, it could keep cursoring past
    // `cloudMaxTimestamp` (the only region this backfill has any business
    // examining -- everything above it is already covered by every normal
    // `syncToCloud()` pass's own per-chunk detection) before finding a match,
    // e.g. if the Lake starts with a long run of non-application noise.
    // Fixed: query the `[ApiTypeId+timestamp]` index once PER application
    // type (`ApiTypeValues` -- currently 9 types, a small fixed constant,
    // not proportional to Lake size), each bounded to `[apiTypeId, 0]..
    // [apiTypeId, cloudMaxTimestamp]`. Every one of these is a true indexed
    // range seek (no filter callback, no cursoring through rows of other
    // types or noise) that can never look above the watermark, and
    // `.first()` within each bound gives that type's own earliest candidate.
    // Taking the min across all 9 gives the true global earliest -- O(number
    // of application types) indexed seeks, not O(rows scanned).
    const earliestAppRowCandidates = await Promise.all(
      ApiTypeValues.map(apiTypeId =>
        this.db.apiEvents
          .where('[ApiTypeId+timestamp]')
          .between([apiTypeId, 0], [apiTypeId, cloudMaxTimestamp], true, true)
          .first()
      )
    )
    let earliestAppRow: ApiEvent | undefined
    for (const candidate of earliestAppRowCandidates) {
      if (candidate && typeof candidate.timestamp === 'number' &&
        (earliestAppRow === undefined || candidate.timestamp < earliestAppRow.timestamp!)) {
        earliestAppRow = candidate
      }
    }

    // No separate `<= cloudMaxTimestamp` check needed here -- every
    // candidate above was already bounded to that range by its own query.
    if (earliestAppRow && typeof earliestAppRow.timestamp === 'number') {
      // Only ever LOWER (never raise past) an existing floor: if a marker is
      // somehow already pending at or below this row's timestamp (e.g. a
      // fresh orphan surfaced in an earlier sync before this backfill got a
      // chance to run), it already protects at least as much history, so
      // leave it alone rather than risk moving it later (see invariant spec
      // in syncToCloud() above).
      const existing = await this.getUnparseableSyncFloor(uid)
      if (existing === null || existing > earliestAppRow.timestamp) {
        console.log(`[AutoSync] Backfill: earliest local application row (${earliestAppRow.timestamp}) is at or below the cloud watermark (${cloudMaxTimestamp}); seeding sync floor to force a one-time full reconciliation re-offer`)
        await this.persistUnparseableSyncFloor(earliestAppRow.timestamp, uid)
      }
    }

    await this.markUnparseableFloorBackfillDone(uid)
  }

  /**
   * Marks the one-time backfill done for `uid`. One of the two bookkeeping
   * WRITE CHOKE POINTS for this floor mechanism (invariant (2) in the
   * ACCOUNT-SCOPING INVARIANTS spec above) -- asserts the live signed-in uid
   * still matches `uid` immediately before the `db.meta` write, so a mid-pass
   * account switch can never commit this marker under the wrong (stale,
   * snapshotted) account's key, regardless of which account's cloud state
   * `cloudMaxTimestamp` (read earlier in `syncToCloud()`) actually reflected.
   */
  private async markUnparseableFloorBackfillDone(uid: string | undefined): Promise<void> {
    this.assertUidUnchanged(uid, 'before backfill-done commit')
    await this.db.meta.put({
      id: this.scopedMetaKey(this.SYNC_UNPARSEABLE_BACKFILL_DONE_KEY, uid),
      value: true,
      updatedAt: Date.now()
    })
  }

  /** Read the persisted unparseable-row sync floor for `uid` (see `syncToCloud()`). */
  private async getUnparseableSyncFloor(uid: string | undefined): Promise<number | null> {
    const record = await this.db.meta.get(this.scopedMetaKey(this.SYNC_UNPARSEABLE_FLOOR_KEY, uid))
    const value = record?.value
    return typeof value === 'number' ? value : null
  }

  /**
   * Persist (or clear, when `timestamp` is `null`) the unparseable-row sync
   * floor for `uid`. The OTHER bookkeeping WRITE CHOKE POINT (invariant (2)
   * above, alongside `markUnparseableFloorBackfillDone()`) -- same
   * assert-before-write guarantee, for every floor set/lower/raise/clear in
   * this file (there is no other place that writes `SYNC_UNPARSEABLE_FLOOR_KEY`).
   */
  private async persistUnparseableSyncFloor(timestamp: number | null, uid: string | undefined): Promise<void> {
    this.assertUidUnchanged(uid, 'before sync-floor commit')
    const key = this.scopedMetaKey(this.SYNC_UNPARSEABLE_FLOOR_KEY, uid)
    if (timestamp === null) {
      await this.db.meta.delete(key)
      return
    }
    await this.db.meta.put({
      id: key,
      value: timestamp,
      updatedAt: Date.now()
    })
  }

  /**
   * Sync cloud events to local (cloud as source of truth). No `uid` parameter
   * -- unlike `syncToCloud()`, this method never writes account-scoped
   * bookkeeping (it only merges raw events into the shared local Lake and
   * rebuilds derived entities, both of which are already unpartitioned by
   * design). Which account's cloud data actually lands here is exactly the
   * ACCEPTED RESIDUAL RISK described in the ACCOUNT-SCOPING INVARIANTS spec
   * above -- deliberately not gated here.
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
          // 席着席時のみ latestDealEvent を更新する（findLatestPlayerDealEvent()
          // ／aggregate-events-stream.tsのEVT_DEALケースと同じ判別: event.Player?.
          // SeatIndex !== undefined）。ダウンロード履歴の末尾が観戦モードのdeal
          // （ヒーロー敗退後もクライアントが他プレイヤーのテーブルを受信し続ける
          // ケース）で終わっていた場合、ここで無条件に最後のEVT_DEALを採用すると、
          // 下のrestoreLatestDeal()がそれを`service.latestEvtDeal`（ヒーロー在籍の
          // 文脈・setterがliveEvtDealも同期する）に代入してしまい、クラウド復元
          // 直後にヒーローのplayerIdを再導出できないばかりか、#177が塞いだはずの
          // 「観戦テーブルの顔ぶれでヒーロー統計が上書きされる」混在状態を
          // 復元パス（新規インストールでのクラウドDL）自体が再現してしまう
          // （codex #177マージ後レビュー、2026-07-20指摘）。観戦モードのdealは
          // ここで単純に無視する（意図的な選択: リビルドはライブ表示の瞬間では
          // ないため、liveEvtDeal相当の非永続フィールドへ別途フィードする必要は
          // ない -- 次の本物のライブdealが来ればliveEvtDealは正しく更新される）。
          if (isApiEventType(event, ApiType.EVT_DEAL) && event.Player?.SeatIndex !== undefined) {
            latestDealEvent = event
          }
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
      // This setter also syncs service.liveEvtDeal (see poker-chase-service.ts),
      // so the statsOutputStream.write() below (and any earlier stale
      // spectator-mode liveEvtDeal from before this cloud-sync restore ran)
      // broadcasts paired with this restored hero-anchored deal's seat
      // context, not a leftover one (codex #177 3rd review round P2).
      // `latestEvtDeal`'s own contract (poker-chase-service.ts) requires
      // callers to only ever assign a deal with Player.SeatIndex present --
      // rebuildLocalEntities() above now upholds that (guards latestDealEvent
      // to seated deals only), so this is never a spectator-mode deal.
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
