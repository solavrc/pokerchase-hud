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
import { needsConfigPersist } from './background/hud-config-sync'
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
self.db = db
self.service = service
self.statsRegistry = defaultRegistry

// Wait for service initialization
service.ready.then(async () => {
  console.log('[background] PokerChaseService is ready')

  // Initialize auto sync if user is authenticated
  try {
    const user = firebaseAuthService.getCurrentUser()
    if (user) {
      await autoSyncService.initialize()
    }
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
registerMessageRouter(service, db, gameUrlPattern)

registerStreamSubscriptions(service, gameUrlPattern)

registerEventIngestion(service)

/**
 * Forced update（sola承認）: 安全な瞬間にダウンロード済み更新を自動適用する。
 * onUpdateAvailable購読・加速チェック（起動時1回 + 6時間ごとのalarm）・
 * SW起動時点での保留中アップデート再チェックをまとめて行う。
 * 詳細はsrc/background/update-manager.tsとCLAUDE.mdを参照。
 */
initUpdateManager()

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

// Listen for auth state changes on startup
firebaseAuthService.onAuthStateChange((user) => {
  console.log('[Firebase] Auth state changed:', user ? user.email : 'signed out')

  // Cache auth state for instant popup rendering
  const authCache = user
    ? { isSignedIn: true, userInfo: { email: user.email, uid: user.uid } }
    : { isSignedIn: false, userInfo: null }
  chrome.storage.local.set({ firebaseAuthCache: authCache })
})
