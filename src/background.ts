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
import { needsConfigPersist } from './background/hud-config-sync'
import type { Options } from './components/Popup'
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

/** 拡張起動時: フィルター設定を復元（統計の再計算はしない） */
chrome.storage.sync.get('options', (result: Record<string, any>) => {
  const options = result.options || {}

  if (options.filterOptions) {
    service.battleTypeFilter = options.filterOptions.gameTypes.sng ||
      options.filterOptions.gameTypes.mtt ||
      options.filterOptions.gameTypes.ring
      ? [...new Set([
        ...(options.filterOptions.gameTypes.sng ? BATTLE_TYPE_FILTERS.SNG : []),
        ...(options.filterOptions.gameTypes.mtt ? BATTLE_TYPE_FILTERS.MTT : []),
        ...(options.filterOptions.gameTypes.ring ? BATTLE_TYPE_FILTERS.RING : [])
      ])]
      : undefined
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
      chrome.storage.sync.set({ options: updatedOptions })
    }
  } else {
    // デフォルトフィルターを設定（再計算をトリガーせずに）
    service.battleTypeFilter = undefined  // デフォルトではすべてのゲームタイプを表示
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
})

/**
 * データエクスポート機能
 */
registerMessageRouter(service, db, gameUrlPattern)

registerStreamSubscriptions(service, gameUrlPattern)

registerEventIngestion(service)

// Listen for auth state changes on startup
firebaseAuthService.onAuthStateChange((user) => {
  console.log('[Firebase] Auth state changed:', user ? user.email : 'signed out')

  // Cache auth state for instant popup rendering
  const authCache = user
    ? { isSignedIn: true, userInfo: { email: user.email, uid: user.uid } }
    : { isSignedIn: false, userInfo: null }
  chrome.storage.local.set({ firebaseAuthCache: authCache })
})
