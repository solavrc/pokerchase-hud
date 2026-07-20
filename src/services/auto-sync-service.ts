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
 * Shown in the popup (via `syncState.error`) when a cloud download stored its
 * raw events but the derived-table rebuild failed. The raw data is safe (Raw
 * Event Lake invariant) -- only hands/phases/actions are stale until a
 * rebuild succeeds, which the user can trigger manually from the popup.
 */
export const REBUILD_AFTER_DOWNLOAD_FAILED_MESSAGE =
  'クラウドデータの保存は完了しましたが、統計データの再構築に失敗しました。ポップアップの「データ再構築」を実行してください'

/**
 * Thrown internally whenever a bookkeeping write is about to happen under an
 * auth-state generation that no longer matches the one live when this sync
 * pass started -- i.e. the account changed (possibly more than once) since
 * the pass began. Never thrown for the actual Firestore upload/download
 * calls themselves (accepted risk, see the ACCOUNT-SCOPING INVARIANTS spec
 * below) -- only for this file's own `meta`/`chrome.storage.local`
 * bookkeeping writes. Caught by `performSync()`'s existing catch block,
 * which sets `syncState.status = 'error'` -- the next `performSync()` call
 * retries cleanly under whichever account is signed in by then.
 */
export class SyncAccountChangedError extends Error {
  constructor(context: string) {
    super(`同期中にサインインアカウントが変更されたため、このアカウント宛の記録を中止しました (${context})`)
    this.name = 'SyncAccountChangedError'
  }
}

/**
 * Snapshot of "who is signed in" taken once at the start of a sync pass (or
 * an `initialize()` call). `uid` is used for BOOKKEEPING KEY DERIVATION
 * (`scopedMetaKey()`); `generation` is the VALIDITY TOKEN checked at every
 * commit point (`assertGenerationUnchanged()`) -- see the ACCOUNT-SCOPING
 * INVARIANTS spec below for why a bare uid-string comparison is insufficient
 * (the A -> B -> A problem, codex review r3615389112).
 */
interface SyncPassIdentity {
  uid: string | undefined
  generation: number
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
 * (2) EVERY BOOKKEEPING WRITE IS GATED ON THE PASS-START AUTH GENERATION
 *     STILL BEING CURRENT (codex review r3615389112, P1, "Detect ABA account
 *     switches before committing bookkeeping" -- hardening an earlier
 *     version of this invariant that compared uid STRINGS instead): a bare
 *     `liveUid === snapshottedUid` check is blind to an A -> B -> A round
 *     trip -- by the time the check runs, the live uid is back to "A",
 *     string-equal to the snapshot, even though account B was live in
 *     between and may have driven whatever cloud read/write the check was
 *     meant to guard (e.g. `syncToCloudBatch()` resolving under B while the
 *     pass believes it's still operating for A). `firebase-auth-service.ts`
 *     exposes a monotonic `getAuthGeneration()` counter, incremented on
 *     EVERY auth-state transition (sign-in, sign-out, initial restore) --
 *     never fooled by a value cycling back, since A -> B -> A still advances
 *     it by at least 2. `performSync()` captures `{ uid, generation }`
 *     (`SyncPassIdentity`) once at sync start; `uid` is used for bookkeeping
 *     KEY DERIVATION (`scopedMetaKey()`) throughout the pass, while
 *     `generation` is the VALIDITY TOKEN every commit point re-checks.
 *     `persistUnparseableSyncFloor()` and `markUnparseableFloorBackfillDone()`
 *     -- the ONLY two methods that ever write floor/backfill-done `meta`
 *     bookkeeping -- each re-check the CURRENT generation against the one
 *     they were called with, immediately before their own `db.meta` write,
 *     and throw `SyncAccountChangedError` instead of writing if it no
 *     longer matches. `performSync()`'s own final `autoSyncLastTime` write,
 *     `initialize()`'s legacy-migration/legacy-clear write, and
 *     `initialize()`'s own result-application step (see invariant (2b)
 *     below) all get the same generation check. Every bookkeeping write in
 *     this file is gated at its own write site -- not by remembering to
 *     guard every caller.
 *
 *     Deliberately NOT gated: the Firestore upload/download calls themselves
 *     (`syncToCloudBatch`/`syncFromCloud`/`getCloudMaxTimestamp`) -- see
 *     ACCEPTED RESIDUAL RISK. This is what closes the scenario that a naive
 *     "assert before the network call" guard would still miss:
 *     `getCloudMaxTimestamp()` at the top of `syncToCloud()` can legitimately
 *     reflect a DIFFERENT account's cloud state if the user switched
 *     accounts between `performSync()`'s snapshot and that call (including
 *     switching BACK by the time any later check runs), and
 *     `backfillUnparseableFloorIfNeeded()` downstream still runs against
 *     that (possibly stale-account) value -- but it can never actually
 *     COMMIT `syncUnparseableFloorBackfillDoneV2` or a floor value derived
 *     from it, because the write methods themselves refuse once the
 *     generation has moved on, REGARDLESS of what the uid looks like by
 *     then. The pass aborts with `SyncAccountChangedError`,
 *     `performSync()`'s catch block sets `status: 'error'`, and the NEXT
 *     sync pass (by either account) re-derives cleanly from scratch under a
 *     fresh generation snapshot.
 *
 * (2b) `initialize()` APPLIES ITS OWN RESULT UNDER THE SAME GENERATION GUARD,
 *     AND RETRIES RATHER THAN SILENTLY ABANDONING ON STALENESS (codex
 *     reviews r3615389121/r3615389133/r3615389139, P2): `initialize()` also
 *     snapshots `{ uid, generation }` at its own start (independent of any
 *     `performSync()` pass it may go on to trigger). Before publishing
 *     anything it computed (the resolved `lastSyncTime` into the shared
 *     `syncState`, or the "have I synced before" decision that gates the
 *     automatic first sync), it re-checks the CURRENT generation against its
 *     own snapshot. If they differ -- an account switch happened while
 *     `initialize()` was awaiting `chrome.storage.local`/`updateTimestamps()`
 *     -- the computed result is discarded (never published into `syncState`,
 *     never used to decide whether to call `performSync()`) and
 *     `initialize()` RE-RUNS itself fresh under whatever is live now
 *     (bounded to `MAX_INITIALIZE_ATTEMPTS` retries), rather than either (a)
 *     silently publishing a stale result computed for a different account,
 *     or (b) just giving up and leaving a genuinely-new account stranded
 *     with no automatic sync ever triggered. The SAME retry also covers the
 *     narrower race where `performSync()` inside `initialize()` no-ops
 *     because a DIFFERENT account's pass is still holding the `_isSyncing`
 *     latch: if this account is still live (generation unchanged) but no
 *     `lastSyncTime` got recorded, `initialize()` retries rather than
 *     leaving that account permanently waiting on some later
 *     threshold/manual trigger.
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
  /**
   * Resolves when the CURRENT in-flight `performSync()` call's `finally`
   * block runs (`null` when nothing is in flight). Lets `initialize()`'s
   * retry (invariant (2b)) wait for a DIFFERENT pass holding `_isSyncing` to
   * settle instead of immediately re-recursing into a `performSync()` call
   * that would just short-circuit again (codex review r3615664890, P2,
   * "Wait for the in-flight sync before retrying initialization") --
   * without this, all `MAX_INITIALIZE_ATTEMPTS` retries could burn through
   * before the other pass ever releases the latch, permanently stranding
   * this account.
   */
  private inFlightSyncPromise: Promise<void> | null = null
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
    // codex review r3615952256, P2, "Clear stale sync state when exposing
    // the new user": firebaseAuthService.signInWithGoogle()/signOut() now
    // notify this listener SYNCHRONOUSLY, in the same step as their own
    // currentState/authGeneration mutation -- before their own
    // persistAuthState()/storage-removal await, and well before
    // message-router.ts's explicit `autoSyncService.onAuthStateChanged(user)`
    // call even runs. This closes the gap one layer earlier than
    // `initialize()`'s own window fix (r3615781411): during a direct A->B
    // sign-in, a session-end/start trigger firing between "B is live per
    // firebaseAuthService" and "onAuthStateChanged(B) has run" would
    // otherwise still read A's stale in-memory `syncState.lastSyncTime`
    // under B's now-live identity.
    firebaseAuthService.onAuthStateChange(() => {
      this.syncState.lastSyncTime = undefined
    })
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
   * Snapshots "who is signed in" right now -- `uid` for key derivation,
   * `generation` for the validity check. See `SyncPassIdentity`'s doc
   * comment and invariant (2) in the ACCOUNT-SCOPING INVARIANTS spec above.
   */
  private snapshotIdentity(): SyncPassIdentity {
    return {
      uid: firebaseAuthService.getCurrentUser()?.uid,
      generation: firebaseAuthService.getAuthGeneration()
    }
  }

  /**
   * Throws `SyncAccountChangedError` if the CURRENT auth-state generation no
   * longer matches `generation` (the value snapshotted at this sync pass's
   * start) -- deliberately a generation-counter comparison, NOT a uid-string
   * comparison, so an A -> B -> A round trip is still caught even though the
   * live uid is back to matching the snapshot by the time this runs (see
   * invariant (2)'s "ABA" rationale above). Called ONLY from the bookkeeping
   * write choke points (`persistUnparseableSyncFloor`,
   * `markUnparseableFloorBackfillDone`, `performSync()`'s final
   * `autoSyncLastTime` write, `initialize()`'s legacy-migration/legacy-clear
   * write and result-application step) -- never around the Firestore
   * network calls themselves.
   */
  private assertGenerationUnchanged(generation: number, context: string): void {
    if (firebaseAuthService.getAuthGeneration() !== generation) {
      throw new SyncAccountChangedError(context)
    }
  }

  /**
   * Initialize auto sync service
   */
  async initialize(attempt = 0): Promise<void> {
    // Bounded retry (invariant (2b) above) -- a genuine account-change storm
    // is implausible in practice (each attempt does real async work), but
    // this caps the recursion so a pathological case can't loop forever.
    const MAX_INITIALIZE_ATTEMPTS = 3
    try {
      // Wait for auth state to settle BEFORE reading it (codex review
      // r3615553034, P2, "Await auth restore before snapshotting identity"):
      // firebaseAuthService's constructor kicks off an async
      // restoreAuthState() that has not necessarily resolved yet on a fresh
      // Service Worker start. Reading getCurrentUser() before it resolves
      // could see "signed out" for an already-signed-in user, or -- once
      // snapshotIdentity() exists -- capture a stale generation right
      // before the restore bumps it. Reuses the SAME readiness barrier
      // `firestore-backup-service.ts` already awaits internally
      // (`requireUser()`'s `await firebaseAuthService.ready()`).
      await firebaseAuthService.ready()

      // Check who is signed in FIRST -- everything below needs a
      // snapshotted identity (invariant (2)).
      const user = firebaseAuthService.getCurrentUser()
      if (!user) {
        console.log('[AutoSync] User not authenticated, skipping initialization')
        return
      }
      const identity = this.snapshotIdentity()
      const uid = identity.uid! // definitely defined -- `user` above proves it

      // Clear the (possibly stale, possibly a DIFFERENT account's)
      // in-memory lastSyncTime IMMEDIATELY, before the awaits below (codex
      // review r3615781411, P2, "Clear the previous account's sync time
      // before awaits"): `syncIfBacklogExceedsThreshold()` reads
      // `this.syncState.lastSyncTime` directly and is not gated by any of
      // this method's own commit points, so during a direct A -> B sign-in,
      // a session-end/start trigger firing while the storage read /
      // `updateTimestamps()` awaits below are still pending would otherwise
      // see A's stale value under B's live identity. If A synced more
      // recently than B's real watermark, that undercounts B's backlog and
      // can skip an upload B actually needs -- and if B already has an
      // OLDER scoped value of its own, the "perform initial sync only if
      // never synced before" check further down won't fire to make up for
      // it either, since B correctly looks "already synced" once its own
      // value is restored. Clearing to `undefined` here is conservative in
      // the safe direction -- a trigger firing in this narrow window
      // computes the backlog as "everything", which can only ever
      // OVER-count (at worst one redundant sync attempt), never undercount
      // -- and gets corrected to this account's own real value once the
      // async work below completes and generation is reconfirmed (see the
      // COMMIT POINT before the real assignment further down).
      this.syncState.lastSyncTime = undefined

      // Load last sync time from storage, scoped to this account (invariant
      // (1)). If the LEGACY unscoped key is present, consume/delete it
      // unconditionally (codex review r3615389121, P2, "Clear stale legacy
      // sync times even after scoped writes"): if this account has no
      // scoped value of its own yet, genuinely migrate the legacy value to
      // it (this account is whoever happens to be signed in the first time
      // this runs post-upgrade, the only reasonable owner to attribute an
      // unattributed legacy value to); if this account ALREADY has its own
      // scoped value (e.g. a manual sync already wrote one, bypassing this
      // migration path entirely), don't overwrite it -- but STILL delete
      // the orphaned legacy key so it can never later be inherited by a
      // DIFFERENT account. Either way the legacy key is consumed exactly
      // once and never read again.
      const scopedSyncKey = this.scopedMetaKey(this.SYNC_STORAGE_KEY, uid)
      const stored = await chrome.storage.local.get([scopedSyncKey, this.SYNC_STORAGE_KEY]) as Record<string, any>
      let storedLastSyncTime = stored[scopedSyncKey]
      const legacyLastSyncTime = stored[this.SYNC_STORAGE_KEY]
      if (legacyLastSyncTime !== undefined) {
        // COMMIT POINT (invariant (2)): re-check before this migration/
        // clear write.
        this.assertGenerationUnchanged(identity.generation, 'before legacy autoSyncLastTime migration/clear')
        // Consume (delete) the legacy key BEFORE writing the scoped copy
        // (codex review r3615664896, P2, "Consume the legacy sync key
        // before writing the scoped copy"): if the MV3 worker/browser stops
        // in the gap between these two writes, this ordering guarantees the
        // legacy key is already gone -- worst case THIS account's own
        // scoped value fails to land and it simply re-derives "first sync"
        // on the next `initialize()` call (one extra sync attempt). The
        // opposite ordering (write-scoped-then-remove-legacy) risks worse:
        // if the crash lands AFTER the scoped write already durable but
        // BEFORE the legacy removal, the legacy key survives, remaining
        // available for a completely DIFFERENT account's later
        // `initialize()` call to wrongly inherit -- exactly the
        // cross-account leak this migration exists to prevent.
        await chrome.storage.local.remove(this.SYNC_STORAGE_KEY)
        if (storedLastSyncTime === undefined) {
          // COMMIT POINT (invariant (2), codex review r3616056817, P2,
          // "Recheck auth before writing the scoped legacy time"):
          // re-check AGAIN, immediately before this scoped write -- the
          // FIRST assert above only covers up to the `remove()` await
          // just completed. If the account changed while THAT await was
          // in flight, this scoped write would otherwise durably persist
          // the OLD (now-stale) uid's `autoSyncLastTime:<uid>` key from an
          // `initialize()` attempt whose in-memory result is already known
          // to be discarded by the later generation-moved check further
          // down -- but that discard only prevents the STALE attempt from
          // publishing to `syncState`; it does nothing to undo a durable
          // storage write that already landed. If that uid signs in again
          // later, it would wrongly look "already synced" off a value it
          // never actually earned. Failing closed here (not writing) only
          // costs that account one extra "first sync" later -- the legacy
          // key is already gone either way (removed above), so there's no
          // repeat-migration risk from skipping this write.
          this.assertGenerationUnchanged(identity.generation, 'before scoped legacy migration write')
          storedLastSyncTime = legacyLastSyncTime
          console.log(`[AutoSync] Migrating legacy unscoped ${this.SYNC_STORAGE_KEY} to this account (${uid})`)
          await chrome.storage.local.set({ [scopedSyncKey]: storedLastSyncTime })
        } else {
          console.log(`[AutoSync] Cleared orphaned legacy unscoped ${this.SYNC_STORAGE_KEY} (this account already has its own scoped value)`)
        }
      }

      // Update timestamps
      await this.updateTimestamps()

      // COMMIT POINT (invariant (2b)): don't publish anything computed above
      // (storedLastSyncTime, the migration decision) if the account changed
      // mid-computation -- discard and re-run fresh under whatever is live
      // now, rather than either publishing a stale result or silently
      // stranding a new account.
      if (firebaseAuthService.getAuthGeneration() !== identity.generation) {
        if (attempt + 1 >= MAX_INITIALIZE_ATTEMPTS) {
          console.error('[AutoSync] initialize(): giving up after repeated account changes mid-computation')
          return
        }
        console.warn('[AutoSync] initialize(): account changed mid-computation, discarding this result and re-running')
        return this.initialize(attempt + 1)
      }

      // Publish this account's REAL value now (already cleared to
      // `undefined` up front, before the awaits -- see r3615781411 above)
      // now that the async work is done and the generation is reconfirmed
      // current.
      this.syncState.lastSyncTime = storedLastSyncTime ? new Date(storedLastSyncTime as string | number) : undefined

      // Perform initial sync only if never synced before (invariant (3):
      // no cross-account ownership check here -- automatic sync for a
      // never-synced account is allowed to proceed, by owner decision).
      if (!this.syncState.lastSyncTime) {
        console.log('[AutoSync] First time sync, performing initial sync...')
        await this.performSync()
        // codex review r3615389133, P2, "Retry first sync after an in-flight
        // account switch": performSync() may have silently no-op'd (e.g.
        // `_isSyncing` was still held by a DIFFERENT account's in-flight
        // pass, or the min-version gate blocked it) -- if this account is
        // STILL live (generation unchanged) but still has no recorded
        // lastSyncTime, retry rather than leaving it permanently stranded
        // until some later threshold/manual trigger.
        if (!this.syncState.lastSyncTime &&
          firebaseAuthService.getAuthGeneration() === identity.generation &&
          attempt + 1 < MAX_INITIALIZE_ATTEMPTS) {
          // codex review r3615664890, P2, "Wait for the in-flight sync
          // before retrying initialization": if a DIFFERENT pass is still
          // holding `_isSyncing`, immediately recursing would just call
          // performSync() again, which short-circuits instantly on the same
          // latch -- all `MAX_INITIALIZE_ATTEMPTS` retries could burn
          // through before that other pass ever releases it, permanently
          // stranding this account. Wait for it to actually settle first.
          if (this.isSyncing && this.inFlightSyncPromise) {
            console.warn('[AutoSync] initialize(): first sync did not run because a different pass is still in flight, waiting for it to settle before retrying')
            await this.inFlightSyncPromise
          } else {
            console.warn('[AutoSync] initialize(): first sync did not complete, retrying')
          }
          return this.initialize(attempt + 1)
        }
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
    let resolveInFlightSyncPromise: (() => void) | undefined
    this.inFlightSyncPromise = new Promise<void>(resolve => { resolveInFlightSyncPromise = resolve })

    try {
      // Wait for auth state to settle BEFORE snapshotting it (codex review
      // r3615553034, P2, "Await auth restore before snapshotting identity"):
      // on a fresh Service Worker start, firebaseAuthService's constructor
      // kicks off an async restoreAuthState() that has not necessarily
      // resolved yet. Snapshotting before it resolves could capture
      // `{ uid: undefined, generation: 0 }` even for an already-signed-in
      // user -- the FIRST firestoreBackupService call downstream (via
      // `requireUser()`'s own `await ready()`) would then complete the
      // restore and bump the generation, making every later commit-point
      // assert see a false account switch and abort a sync that should
      // have succeeded. Placed INSIDE the try (after the `_isSyncing`
      // latch, matching the existing min-version-gate await below) so this
      // await can't reopen the double-sync race the latch exists to
      // prevent, and so `finally` still releases the latch if `ready()`
      // itself ever rejected.
      await firebaseAuthService.ready()

      // SNAPSHOT identity ONCE for this entire pass (invariant (2) in the
      // ACCOUNT-SCOPING INVARIANTS spec above). `syncToCloud()` and its
      // bookkeeping helpers all use THIS snapshot -- `uid` for key
      // derivation, `generation` for the ABA-proof validity check -- never a
      // freshly re-resolved `getCurrentUser()`/`getAuthGeneration()`.
      const identity = this.snapshotIdentity()

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
          await this.syncToCloud(identity)
        }

        if (direction === 'download' || direction === 'both') {
          await this.syncFromCloud()
        }

        // COMMIT POINT (invariant (2)): the auth generation must still match
        // the snapshot before writing the final success bookkeeping below.
        this.assertGenerationUnchanged(identity.generation, 'before final lastSyncTime commit')

        // Update success state -- computed as a LOCAL value here, not yet
        // assigned into the shared `this.syncState` (see the second
        // COMMIT POINT below for why that assignment is deferred).
        const syncCompletedAt = new Date()
        const scopedSyncKey = this.scopedMetaKey(this.SYNC_STORAGE_KEY, identity.uid)
        // Opportunistically clear an orphaned legacy key here too (codex
        // review r3615389121): `initialize()` is the primary migration
        // path, but a manual sync (bypassing `initialize()` entirely, e.g.
        // right after upgrade) can also be the first write for this
        // account, and without this the legacy key would linger forever,
        // available for a later different account to inherit. Only when
        // signed in -- if `identity.uid` is undefined, `scopedSyncKey`
        // already equals the bare legacy key itself (see `scopedMetaKey()`),
        // and removing it here would delete what's about to be written, so
        // skip it in that case. Removed BEFORE the scoped write lands (codex
        // review r3615664896, P2, same ordering rationale as
        // `initialize()`'s migration): a crash between the two writes then
        // leaves the legacy key already gone (worst case just an extra
        // sync attempt) rather than surviving for a different account to
        // inherit later.
        if (identity.uid) await chrome.storage.local.remove(this.SYNC_STORAGE_KEY)
        await chrome.storage.local.set({ [scopedSyncKey]: syncCompletedAt.toISOString() })

        // Update timestamps after sync
        await this.updateTimestamps()

        // COMMIT POINT (invariant (2), codex review r3615553045, P2,
        // "Recheck before publishing sync success"): re-check AGAIN,
        // immediately before publishing into the shared (unscoped,
        // cross-account-visible) in-memory `syncState` -- `updateTimestamps()`
        // above is itself an async gap (it makes its own
        // `getCloudMaxTimestamp()` call) during which the account could have
        // changed again, even though the scoped bookkeeping WRITES above
        // already landed safely under a validated generation. This is why
        // `syncState.lastSyncTime` is assigned HERE, at the very last
        // possible moment, rather than right after the first assert above:
        // `syncIfBacklogExceedsThreshold()` and other readers see this
        // in-memory value change the instant it's assigned (a direct field
        // read, not gated by `updateSyncState()`'s broadcast), so if it were
        // set earlier and the account changed during `updateTimestamps()`,
        // a newly-signed-in account could transiently compute its own
        // upload backlog against the PREVIOUS account's completion time.
        this.assertGenerationUnchanged(identity.generation, 'before publishing sync success')
        this.syncState.lastSyncTime = syncCompletedAt

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
      this.inFlightSyncPromise = null
      resolveInFlightSyncPromise?.()
    }
  }

  /**
   * Sync local events to cloud
   */
  private async syncToCloud(identity: SyncPassIdentity): Promise<void> {
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
    await this.backfillUnparseableFloorIfNeeded(cloudMaxTimestamp, identity)

    const pendingUnparseableTimestamp = await this.getUnparseableSyncFloor(identity.uid)
    const scanFloor = pendingUnparseableTimestamp !== null && cloudMaxTimestamp !== null
      ? Math.min(cloudMaxTimestamp, pendingUnparseableTimestamp - 1)
      : cloudMaxTimestamp
    if (scanFloor !== cloudMaxTimestamp) {
      console.log(`[AutoSync] Rewinding upload scan to ${scanFloor} to re-offer a previously unparseable row at ${pendingUnparseableTimestamp}`)
    }

    // ==========================================================================
    // P1 FIX (release blocker; independent audit, 2026-07-21) -- COMPOUND-KEY
    // UPLOAD PAGINATION
    // ==========================================================================
    //
    // apiEvents' PRIMARY KEY is the compound `[timestamp+ApiTypeId]`
    // (poker-chase-db.ts), not bare `timestamp` alone -- two raw rows CAN
    // legitimately share the exact same millisecond with different
    // ApiTypeId (a burst of near-simultaneous API responses). Every cursor
    // below (the count, the pass-start cursor, and the per-chunk cursor at
    // the end of the while-loop further down) used to key off bare
    // `timestamp` alone via `.where('timestamp').above(x)`. That is broken
    // in two equivalent ways:
    //
    // (a) MID-PASS CHUNK BOUNDARY: if a CHUNK_SIZE-row page boundary falls
    //     between two same-millisecond rows, the chunk that uploads first
    //     advances `lastProcessedTimestamp` to that shared millisecond, and
    //     the NEXT page's `.above(lastProcessedTimestamp)` is strictly
    //     greater-than -- it permanently excludes the second row. The loop
    //     still completes "successfully" (every OTHER row uploaded and
    //     confirmed), so the end-of-loop commit further down advances/clears
    //     the unparseable-floor protection right past the silently-skipped
    //     row exactly as if it had actually been uploaded.
    //
    // (b) PASS-START BOUNDARY (the same bug, one layer up): even with (a)
    //     fixed, the very first chunk of a pass still started its query
    //     strictly above `scanFloor` (== `cloudMaxTimestamp` in the common,
    //     no-pending-floor case). A local row sharing `cloudMaxTimestamp`'s
    //     exact millisecond with a DIFFERENT ApiTypeId than whatever cloud
    //     doc actually pushed the watermark there -- because a PRIOR pass
    //     hit exactly the (a) bug at what happened to be its own last chunk
    //     -- would never even be fetched, on this pass or any future one,
    //     since every future pass's `cloudMaxTimestamp` still reads back
    //     that same millisecond.
    //
    // FIX: cursor the primary key `[timestamp+ApiTypeId]` end-to-end,
    // tracking BOTH components between chunks (fixes (a)), and make the
    // PASS-START cursor's ApiTypeId component `ApiTypeIdFloorSentinel` (0) --
    // below every real ApiTypeId (all >= 100; see `ApiTypeValues` /
    // `z.number().int()` in types/api.ts, and the existing `[apiTypeId, 0]`
    // lower-bound convention already used in
    // `backfillUnparseableFloorIfNeeded` above) -- which makes the first
    // page's lower bound INCLUSIVE of `scanFloor`'s own millisecond instead
    // of strictly-after it (fixes (b)).
    //
    // COST: the pass-start inclusivity means the first page may re-examine,
    // and harmlessly re-upload, whatever OTHER row(s) already sit at cloud's
    // exact watermark millisecond -- Firestore writes are idempotent upserts
    // keyed by `${timestamp}_${ApiTypeId}` (firestore-backup-service.ts), so
    // this is a no-op write, not a correctness or growing-cost concern: it's
    // bounded to however many rows tie at that one instant, and the
    // watermark itself advances past it on the next pass that uploads
    // anything newer.
    //
    // `firestoreBackupService.syncToCloudBatch()`'s OWN internal dedup filter
    // (`event.timestamp > <threshold>`, see its doc comment) is bare-
    // timestamp-only -- it has no ApiTypeId to compare against, so it can't
    // be made compound-aware the way the cursor above just was. Shifting the
    // threshold VALUE passed to it one millisecond earlier than `scanFloor`
    // makes its `>` check inclusive of `scanFloor`'s own millisecond too,
    // consistent with the cursor above -- reusing the exact same "pass a
    // deliberately lowered threshold, rely on idempotent upserts" pattern
    // this file already established for the unparseable-floor rewind (see
    // the big comment block above this one). Pre-existing floor-rewind
    // tests' asserted `floor` values shift down by 1 accordingly (see
    // auto-sync-service.test.ts).
    const ApiTypeIdFloorSentinel = 0
    const uploadDedupThreshold = scanFloor !== null ? scanFloor - 1 : null

    // Count events at-or-newer than the (possibly rewound) scan floor,
    // inclusive of ties at `scanFloor`'s own millisecond (see fix (b) above).
    const totalCount = scanFloor !== null
      ? await this.db.apiEvents.where('[timestamp+ApiTypeId]').above([scanFloor, ApiTypeIdFloorSentinel]).count()
      : await this.db.apiEvents.count()

    if (totalCount === 0) {
      console.log('[AutoSync] No new events to sync')
      // Nothing at all above the floor -- if a marker was pending, its row no
      // longer exists locally (e.g. local data was cleared). Nothing left to
      // recover, so clear the stale marker rather than rewinding forever.
      // (No upload happened in this branch, so there's nothing for the floor
      // to have advanced past -- clearing here is always safe.)
      if (pendingUnparseableTimestamp !== null) await this.persistUnparseableSyncFloor(null, identity)
      return
    }

    console.log(`[AutoSync] Found ${totalCount} new events to sync`)

    // Process in chunks to avoid memory issues
    const CHUNK_SIZE = DATABASE_CONSTANTS.SYNC_CHUNK_SIZE
    let processed = 0
    let synced = 0
    // Compound cursor: BOTH components must track the actual last-processed
    // row between chunks (see fix (a) above). Starts at `scanFloor`'s own
    // millisecond with the sentinel ApiTypeId (see fix (b) above).
    let lastProcessedTimestamp = scanFloor ?? 0
    let lastProcessedApiTypeId = ApiTypeIdFloorSentinel
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
      // Get chunk of raw events newer than the compound (timestamp, ApiTypeId)
      // cursor. apiEvents is the raw Lake (see docs/architecture.md) — it may
      // contain non-application noise (202/205 keepalive/timer events) that
      // we deliberately never sync to cloud (cost decision: only
      // application-type events go to Firestore). Cursoring the PRIMARY key
      // `[timestamp+ApiTypeId]` (not bare `timestamp`) is the P1 fix above --
      // it is what lets same-millisecond rows survive a CHUNK_SIZE page
      // boundary instead of one of them being silently, permanently skipped.
      const rawChunk = await this.db.apiEvents
        .where('[timestamp+ApiTypeId]')
        .above([lastProcessedTimestamp, lastProcessedApiTypeId])
        .limit(CHUNK_SIZE)
        .toArray()

      if (rawChunk.length === 0) break

      // Sort chunk by the full compound key (timestamp, then ApiTypeId) --
      // matches primary-key order already, but sorting explicitly (rather
      // than relying on Dexie's cursor order) keeps same-millisecond ties
      // deterministically ordered regardless of index internals.
      rawChunk.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0) || (a.ApiTypeId || 0) - (b.ApiTypeId || 0))

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
          await this.persistUnparseableSyncFloor(earliestUnparseableThisPass, identity)
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
          // Pass the (possibly rewound, and now also millisecond-shifted)
          // scan floor, not the raw Firestore max: otherwise a just-recovered
          // row whose timestamp sits below the real cloud max would be
          // filtered back out by syncToCloudBatch's own dedup check,
          // defeating the whole point of rewinding. Firestore writes are
          // idempotent upserts keyed by `${timestamp}_${ApiTypeId}`, so
          // redundantly re-sending already-uploaded rows in
          // [scanFloor, cloudMaxTimestamp] while a marker is pending is safe --
          // just extra write cost, bounded to however much happened since the
          // break, and it stops once the row resolves.
          //
          // `uploadDedupThreshold` (== `scanFloor - 1` when a floor exists;
          // see P1 fix doc comment above) rather than `scanFloor` itself:
          // syncToCloudBatch's own filter is `event.timestamp > threshold`,
          // bare-timestamp-only. Passing `scanFloor` unchanged would make
          // that filter re-exclude the exact same-millisecond row the
          // compound-key cursor above was just fixed to include (its
          // timestamp equals `scanFloor`, not greater than it) -- silently
          // undoing the fix one layer downstream.
          uploadDedupThreshold,
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

      // Update the compound cursor for next chunk (based on the raw chunk's
      // actual last row's FULL [timestamp, ApiTypeId] key -- see P1 fix doc
      // comment above). Tracking ApiTypeId here too is what lets the NEXT
      // chunk's query correctly resume mid-millisecond instead of skipping
      // past every row sharing the boundary row's timestamp.
      const lastRawEvent = rawChunk[rawChunk.length - 1]
      if (lastRawEvent && typeof lastRawEvent.timestamp === 'number') {
        lastProcessedTimestamp = lastRawEvent.timestamp
        lastProcessedApiTypeId = typeof lastRawEvent.ApiTypeId === 'number' ? lastRawEvent.ApiTypeId : ApiTypeIdFloorSentinel
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
    await this.persistUnparseableSyncFloor(earliestUnparseableThisPass, identity)

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
  private async backfillUnparseableFloorIfNeeded(cloudMaxTimestamp: number | null, identity: SyncPassIdentity): Promise<void> {
    const doneKey = this.scopedMetaKey(this.SYNC_UNPARSEABLE_BACKFILL_DONE_KEY, identity.uid)
    const alreadyDone = await this.db.meta.get(doneKey)
    if (alreadyDone) return

    if (cloudMaxTimestamp === null) {
      // Proven empty (see PROVEN-STATE REQUIREMENT above) -- nothing has
      // ever been uploaded, so there is no "already past the watermark"
      // region below which a pre-existing orphan could be hiding.
      await this.markUnparseableFloorBackfillDone(identity)
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
      const existing = await this.getUnparseableSyncFloor(identity.uid)
      if (existing === null || existing > earliestAppRow.timestamp) {
        console.log(`[AutoSync] Backfill: earliest local application row (${earliestAppRow.timestamp}) is at or below the cloud watermark (${cloudMaxTimestamp}); seeding sync floor to force a one-time full reconciliation re-offer`)
        await this.persistUnparseableSyncFloor(earliestAppRow.timestamp, identity)
      }
    }

    await this.markUnparseableFloorBackfillDone(identity)
  }

  /**
   * Marks the one-time backfill done for `identity.uid`. One of the two
   * bookkeeping WRITE CHOKE POINTS for this floor mechanism (invariant (2)
   * in the ACCOUNT-SCOPING INVARIANTS spec above) -- asserts the CURRENT
   * auth generation still matches `identity.generation` immediately before
   * the `db.meta` write, so a mid-pass account switch (including an A -> B
   * -> A round trip, which a uid-string check alone would miss) can never
   * commit this marker under the wrong (stale, snapshotted) account's key,
   * regardless of which account's cloud state `cloudMaxTimestamp` (read
   * earlier in `syncToCloud()`) actually reflected.
   */
  private async markUnparseableFloorBackfillDone(identity: SyncPassIdentity): Promise<void> {
    this.assertGenerationUnchanged(identity.generation, 'before backfill-done commit')
    await this.db.meta.put({
      id: this.scopedMetaKey(this.SYNC_UNPARSEABLE_BACKFILL_DONE_KEY, identity.uid),
      value: true,
      updatedAt: Date.now()
    })
  }

  /** Read the persisted unparseable-row sync floor for `uid` (see `syncToCloud()`). Read-only -- no generation check needed. */
  private async getUnparseableSyncFloor(uid: string | undefined): Promise<number | null> {
    const record = await this.db.meta.get(this.scopedMetaKey(this.SYNC_UNPARSEABLE_FLOOR_KEY, uid))
    const value = record?.value
    return typeof value === 'number' ? value : null
  }

  /**
   * Persist (or clear, when `timestamp` is `null`) the unparseable-row sync
   * floor for `identity.uid`. The OTHER bookkeeping WRITE CHOKE POINT
   * (invariant (2) above, alongside `markUnparseableFloorBackfillDone()`) --
   * same assert-before-write guarantee, for every floor set/lower/raise/
   * clear in this file (there is no other place that writes
   * `SYNC_UNPARSEABLE_FLOOR_KEY`).
   */
  private async persistUnparseableSyncFloor(timestamp: number | null, identity: SyncPassIdentity): Promise<void> {
    this.assertGenerationUnchanged(identity.generation, 'before sync-floor commit')
    const key = this.scopedMetaKey(this.SYNC_UNPARSEABLE_FLOOR_KEY, identity.uid)
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
      // If the rebuild ALSO fails here, log it but keep the DOWNLOAD error as
      // the primary failure surfaced to performSync()'s catch -- both paths
      // end in `syncState.status = 'error'` either way, and the download
      // error is the root cause the user should see first.
      if (downloadedEvents > 0) {
        try {
          await this.rebuildLocalEntities()
        } catch (rebuildError) {
          console.error('[AutoSync] Rebuild after a partial download failed too:', rebuildError)
        }
      }
      throw error
    }

    if (downloadedEvents > 0) {
      console.log(`[AutoSync] Downloaded and updated ${downloadedEvents} events from cloud`)
      await this.rebuildLocalEntities()
    }
  }

  /**
   * Rebuild derived tables without loading the entire event history into memory.
   *
   * THROWS on failure (independent release audit 2026-07-21, finding 5,
   * "派生テーブル再構築失敗を同期成功として確定する"): this used to catch and
   * swallow every error, so a download pass whose raw `bulkPut` succeeded but
   * whose hands/phases/actions derivation failed (quota, malformed chunk,
   * transaction abort) still reported `status: 'success'` to the popup while
   * the HUD silently served stale/partial aggregates. Now the error
   * propagates to `performSync()`'s catch, which sets
   * `syncState.status = 'error'` and broadcasts it via the existing
   * `SYNC_STATE_UPDATE` chrome.runtime message the popup already renders.
   *
   * Failure-state invariants:
   * - Raw Event Lake is unaffected: the downloaded raw rows were durably
   *   `bulkPut` BEFORE this rebuild ran and are never rolled back -- only the
   *   DERIVED tables are stale, and a manual データ再構築 (or the next
   *   successful download's rebuild) re-derives everything from the Lake.
   * - A failed rebuild is never marked as done: the `importStatus` meta write
   *   below only runs after every chunk (and the final flush) succeeded, so
   *   an error always leaves the previous `importStatus` untouched.
   */
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
        this.db.apiEvents,
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
      // Surface the failure instead of confirming the sync as successful (see
      // doc comment above). The raw events are already durable; only the
      // derived statistics are stale until a rebuild succeeds.
      throw new Error(
        `${REBUILD_AFTER_DOWNLOAD_FAILED_MESSAGE} (${error instanceof Error ? error.message : 'Unknown error'})`
      )
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
      //
      // AUDITED (P1 fix bookkeeping review, 2026-07-21): `lastSyncTime` here
      // is a WALL-CLOCK `Date` (`syncCompletedAt = new Date()` at the moment
      // a sync pass finished, see `performSync()`), not an event-position
      // watermark like `cloudMaxTimestamp`/the unparseable-row floor. This
      // bare `.where('timestamp').above(lastSyncTime)` count is used ONLY as
      // a heuristic threshold gate ("is it worth triggering another sync
      // pass at all") -- it is NOT the actual upload cursor, so it cannot
      // cause the compound-key data-loss bug fixed in `syncToCloud()` above
      // (that logic owns the real cursor and is unaffected by whatever this
      // count returns). Worst case if a same-millisecond event coincides
      // with `lastSyncTime` and gets excluded here: one proactive sync is
      // skipped and its backlog is simply picked up by the next trigger --
      // not a permanent gap. Left as bare-timestamp intentionally.
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
    
    // Calculate upload pending count based on cloud timestamp.
    //
    // AUDITED (P1 fix bookkeeping review, 2026-07-21): display-only figure
    // (see the return type below) -- not the actual sync cursor, so a
    // same-millisecond boundary tie can at worst undercount this UI number
    // by the tied row(s); it never causes the tied row to be skipped by an
    // actual upload, which is driven entirely by `syncToCloud()`'s own
    // compound-key cursor above. Left as bare-timestamp intentionally.
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
