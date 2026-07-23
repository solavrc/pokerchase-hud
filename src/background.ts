/**
 * service worker: ブラウザイベントを監視できる
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/background?hl=ja
 * @see https://developer.chrome.com/docs/extensions/reference/api/storage
 * @see https://zenn.dev/dotdotdot/articles/b123e67552fe3c
 */
import PokerChaseService, {
  BATTLE_TYPE_FILTERS,
  PokerChaseDB
} from './app'
import { defaultRegistry, defaultStatDisplayConfigs, mergeStatDisplayConfigs } from './stats'
import type { StatsRegistry } from './stats/registry'
import { firebaseAuthService } from './services/firebase-auth-service'
import { autoSyncService } from './services/auto-sync-service'
import { content_scripts } from '../manifest.json'
import { registerStreamSubscriptions } from './background/ports'
import { registerEventIngestion } from './background/event-ingestion'
import { registerMessageRouter } from './background/message-router'
import { checkOnUpdate } from './background/rebuild-advisory'
import { initUpdateManager } from './background/update-manager'
import { markWhatsNewOnUpdate, reassertWhatsNewBadgeOnStartup } from './background/whats-new-badge'
import { needsConfigPersist } from './background/hud-config-sync'
import { initializeAutoSyncOnReady, createSignInTransitionHandler } from './background/auto-sync-boot'
import { ExperimentalReplayImporter } from './background/experimental-replay-import'
import { loadOptions, saveOptions, type Options } from './utils/options-storage'
import { DEFAULT_TABLE_SIZE_FILTER, selectedTableSizeLayers } from './utils/table-size'
import { checkMinVersionGate } from './services/min-version-gate'
/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */

// Get game URL pattern from manifest
const gameUrlPattern = content_scripts[0]!.matches[0]!

declare global {
  interface Window {
    db: PokerChaseDB
    service: PokerChaseService
    statsRegistry: StatsRegistry
  }
}

const db = new PokerChaseDB(self.indexedDB, self.IDBKeyRange)
const service = new PokerChaseService({ db })
const experimentalReplayImporter = new ExperimentalReplayImporter(db, service)
self.db = db
self.service = service
self.statsRegistry = defaultRegistry

// Wait for service initialization
service.ready.then(async () => {
  console.log('[background] PokerChaseService is ready')

  // Initialize auto sync if user is authenticated.
  //
  // codex post-merge audit finding ("cold-start auth-restore race loses the
  // initial sync"): `firebaseAuthService`'s auth-state restore
  // (`restoreAuthState()`, kicked off from its constructor at import time)
  // is independent of `service.ready` (IndexedDB init) above -- there is no
  // ordering guarantee between the two. `initializeAutoSyncOnReady()`
  // (`src/background/auto-sync-boot.ts`) awaits `firebaseAuthService.ready()`
  // before checking `getCurrentUser()`, so an already-signed-in user's
  // initial sync is no longer skipped whenever IndexedDB init happens to
  // resolve first.
  try {
    await initializeAutoSyncOnReady(firebaseAuthService, autoSyncService)
  } catch (error) {
    console.error('[background] Auto sync initialization failed:', error)
  }
}).catch(err => {
  console.error('[background] PokerChaseService initialization failed:', err)
})

/** 拡張更新時の処理 */
chrome.runtime.onInstalled.addListener(async details => {
  console.log(`[onInstalled] Extension ${details.reason}: previousVersion=${details.previousVersion}`)

  if (details.reason === 'update') {
    try {
      await checkOnUpdate(db)
    } catch (error) {
      console.error('[onInstalled] Rebuild advisory check failed:', error)
    }

    // 更新情報（What's New）: 新規インストール（'install'）ではバッジ churn
    // 防止のため呼ばない（whats-new-badge.ts冒頭のコメント参照）
    try {
      await markWhatsNewOnUpdate(chrome.runtime.getManifest().version)
    } catch (error) {
      console.error('[onInstalled] What\'s New badge check failed:', error)
    }
  }
})

/** 拡張起動時: フィルター設定を復元（統計の再計算はしない）。
 * loadOptionsは旧@extend-chrome/storage bucketキーからのマイグレーションも行う
 * （Popupを開かないユーザーでもservice worker起動時に移行が完了する）
 *
 * service.beginFiltersRestore()でゲートを張ってから非同期のloadOptions()を呼ぶ。
 * これにより、MV3のService WorkerがrequestLatestStats（preGame:true、
 * background/import-export.tsのgetLatestSessionStats参照）でコールドスタートした
 * 場合でも、この.then()/.catch()ブロックがbattleTypeFilter/tableSizeFilter/
 * handLimitFilterを反映し終えるまでgetLatestSessionStatsの計算を待たせられる
 * （service.filtersRestoredをawait）。 */
service.beginFiltersRestore()
loadOptions().then((options) => {
  if (options?.filterOptions) {
    service.battleTypeFilter = options.filterOptions.gameTypes.sng ||
      options.filterOptions.gameTypes.mtt ||
      options.filterOptions.gameTypes.ring
      ? [...new Set([
        ...(options.filterOptions.gameTypes.sng ? BATTLE_TYPE_FILTERS.SNG : []),
        ...(options.filterOptions.gameTypes.mtt ? BATTLE_TYPE_FILTERS.MTT : []),
        ...(options.filterOptions.gameTypes.ring ? BATTLE_TYPE_FILTERS.RING : [])
      ])]
      : undefined
    // 卓人数フィルタ（C案）。旧storage値にtableSizeが無ければデフォルト
    // （全層選択=フィルタなし）として扱う（グレースフルなマイグレーション）。
    service.tableSizeFilter = selectedTableSizeLayers(options.filterOptions.tableSize ?? DEFAULT_TABLE_SIZE_FILTER)
    service.handLimitFilter = options.filterOptions.handLimit
    // 保存済みのstatDisplayConfigsをデフォルトとマージしてから設定する。
    // マージしないと、リリースで新しい統計（例: #86のSTL/FTS）が追加されても、
    // ユーザーがポップアップを開いて再保存するまでHUDに一切表示されない
    // （service-worker起動時にstorageの値をそのまま代入していたため）。
    const savedStatDisplayConfigs = options.filterOptions.statDisplayConfigs
    const mergedStatDisplayConfigs = mergeStatDisplayConfigs(
      savedStatDisplayConfigs,
      defaultStatDisplayConfigs
    )
    service.statDisplayConfigs = mergedStatDisplayConfigs

    // HUD（src/components/App.tsx）はservice worker経由ではなく、
    // chrome.storage.syncの`options.filterOptions.statDisplayConfigs`を直接読む。
    // Popupを一度も開かないユーザーだと、上記のマージ結果がインメモリの
    // service.statDisplayConfigsにしか反映されず、HUDには古い設定のまま
    // 表示され続けてしまう（#100）。差分がある場合のみ、マージ結果をstorageへ
    // 書き戻す（冪等: 差分が無くなれば以降の起動では書き込まれない）。
    if (needsConfigPersist(savedStatDisplayConfigs, mergedStatDisplayConfigs)) {
      const updatedOptions: Options = {
        ...options,
        filterOptions: {
          ...options.filterOptions,
          statDisplayConfigs: mergedStatDisplayConfigs
        }
      }
      saveOptions(updatedOptions)
    }
  } else {
    // デフォルトフィルターを設定（再計算をトリガーせずに）
    service.battleTypeFilter = undefined  // デフォルトではすべてのゲームタイプを表示
    service.tableSizeFilter = undefined  // デフォルトではすべての卓人数層を表示
    service.handLimitFilter = 500
  }

  // テスト用にハンドログをデフォルトで有効化
  service.handLogConfig = {
    enabled: true,
    maxHands: 5,
    opacity: 0.8,
    fontSize: 8,
    position: 'bottom-right',
    width: 400,
    height: 100,
    autoScroll: true,
    showTimestamps: false
  }

  service.markFiltersRestored()
}).catch(error => {
  console.error('[background] Failed to restore filter options:', error)
  // 失敗してもゲートを解放する -- filtersRestoredを待つ側（プリゲーム・
  // ヒーロースタッツのフォールバック等）を永久にハングさせないため。
  // フィルターはservice側のデフォルト（undefined=全件）のままになる。
  service.markFiltersRestored()
})

/**
 * データエクスポート機能
 */
registerMessageRouter(service, db, gameUrlPattern, experimentalReplayImporter)

registerStreamSubscriptions(service, gameUrlPattern)

registerEventIngestion(service, experimentalReplayImporter)

/**
 * Forced update（sola承認）: 安全な瞬間にダウンロード済み更新を自動適用する。
 * onUpdateAvailable購読・加速チェック（起動時1回 + 6時間ごとのalarm）・
 * SW起動時点での保留中アップデート再チェックをまとめて行う。
 * 詳細はsrc/background/update-manager.tsとCLAUDE.mdを参照。
 *
 * 更新情報（What's New）バッジのSW起動時再評価は、この`initUpdateManager()`が
 * 返すSW起動時`recheckPendingUpdate()`のpromiseに続けて実行する（codex
 * review, PR #172）。`recheckPendingUpdate()`は`pendingUpdate`のstorage状態を
 * 読んで（既に適用済みなら）クリーンアップすることがあるため、この完了を
 * 待たずに`reassertWhatsNewBadgeOnStartup()`を並行実行すると、そのクリーン
 * アップ途中の古い`pendingUpdate`状態を読んでしまい、whats-newバッジへの
 * 「昇格」判定を誤ることがある。onInstalled('update')時点でrebuild-advisory/
 * update-managerのバッジが先に使用中だった場合、whats-newバッジは抑制された
 * ままになるため、他の2つが解消済みならここで優先順位を再評価し、
 * whats-newバッジへ昇格させる（詳細はsrc/background/whats-new-badge.tsと
 * CLAUDE.md参照）。全体としては（`.then()`チェーンをawaitしないので）SW起動を
 * ブロックしない -- fire-and-forgetのまま、実行順序だけを保証する。
 */
initUpdateManager()
  .then(() => reassertWhatsNewBadgeOnStartup())
  .catch(error => {
    console.error('[background] What\'s New badge reassertion failed:', error)
  })

/**
 * Forced update: リモート最低バージョンゲート（キルスイッチ）。
 * SW起動時に一度チェックし、結果を12hキャッシュする（AutoSyncServiceの
 * 各同期エントリポイントはperformSync()経由でこのキャッシュを参照する）。
 * フェイルオープン: フェッチ失敗時は既定でsupportedとして扱われる
 * （src/services/min-version-gate.ts参照）。
 */
checkMinVersionGate(chrome.runtime.getManifest().version).catch(error => {
  console.error('[background] Min-version gate check failed:', error)
})

// Same audit finding as above: also trigger autoSyncService.initialize() on
// an observed sign-in TRANSITION, as a defensive backstop beyond the
// cold-start await in the service.ready.then() block -- e.g. if this
// Service Worker instance observes a sign-in that didn't arrive through
// background/message-router.ts's own explicit
// `autoSyncService.onAuthStateChanged(user)` call (that call site already
// invokes initialize() on the popup-driven sign-in flow). See
// createSignInTransitionHandler()'s doc comment
// (src/background/auto-sync-boot.ts) for why the very first callback
// invocation on Service Worker startup deliberately does NOT count as a
// transition (avoids double-invoking initialize() on top of the cold-start
// path above), AND why a `source === 'sign-in'` transition is ALSO excluded
// (codex post-merge review on this PR, P2, "Avoid double auto-sync
// initialization on popup sign-in" -- that path, driven by
// `firebaseAuthService.signInWithGoogle()`, already has its own explicit
// caller in message-router.ts, and this listener fires synchronously
// *before* that caller's own call, so triggering initialize() here too used
// to race it).
const handleAuthSignInTransition = createSignInTransitionHandler(autoSyncService, (error) => {
  console.error('[background] Auto sync initialization on sign-in transition failed:', error)
})

// Listen for auth state changes on startup
firebaseAuthService.onAuthStateChange((user, source) => {
  console.log('[Firebase] Auth state changed:', user ? user.email : 'signed out')

  // Cache auth state for instant popup rendering
  const authCache = user
    ? { isSignedIn: true, userInfo: { email: user.email, uid: user.uid } }
    : { isSignedIn: false, userInfo: null }
  chrome.storage.local.set({ firebaseAuthCache: authCache })

  handleAuthSignInTransition(user, source)
})
