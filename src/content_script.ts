/**
 * コンテンツスクリプト: DOM にアクセスできる
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts?hl=ja
 * @see https://developer.mozilla.org/ja/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { web_accessible_resources } from '../manifest.json'
import PokerChaseService, { ApiEventType, ApiType, PlayerStats } from './app'
import App from './components/App'
import type { ChromeMessage } from './types/messages'
import { MESSAGE_ACTIONS as EVENTS } from './types/messages'
import type { AllPlayersRealTimeStats } from './realtime-stats/realtime-stats-service'
/** !!! BACKGROUND、WEB_ACCESSIBLE_RESOURCES からインポートしないこと !!! */

const RECONNECT_DELAY_MS = 500
const KEEPALIVE_INTERVAL_MS = 25000 // 25秒（30秒タイムアウトより少し短く）

// ゲーム状態の管理
let isGameActive = false
let keepaliveTimer: ReturnType<typeof setInterval> | null = null

export interface StatsData {
  stats: PlayerStats[]
  evtDeal?: ApiEventType<ApiType.EVT_DEAL>  // 席のマッピング用のEVT_DEALイベント
  realTimeStats?: AllPlayersRealTimeStats  // リアルタイム統計（全プレイヤー）
}

declare global {
  interface WindowEventMap {
    [PokerChaseService.POKER_CHASE_SERVICE_EVENT]: CustomEvent<StatsData>
  }
}

const connectToBackgroundService = () => {
  try {
    const port = chrome.runtime.connect({ name: PokerChaseService.POKER_CHASE_SERVICE_EVENT })

    // 接続成功時、ゲーム中ならキープアライブを開始
    if (isGameActive) {
      startKeepalive(port)
    }

    port.onMessage.addListener((message: { stats: PlayerStats[], evtDeal?: ApiEventType<ApiType.EVT_DEAL>, realTimeStats?: AllPlayersRealTimeStats } | string) => {
      if (typeof message === 'object' && message !== null && 'stats' in message) {
        console.time('[content_script] Dispatching stats event')
        window.dispatchEvent(new CustomEvent(PokerChaseService.POKER_CHASE_SERVICE_EVENT, { detail: message }))
        console.timeEnd('[content_script] Dispatching stats event')
        if (message.realTimeStats) {
          console.log('[content_script] Real-time stats received:', Object.keys(message.realTimeStats))
        }
      }
    })
    port.onDisconnect.addListener(() => {
      // 切断時にキープアライブを停止
      stopKeepalive()
      // 再接続を試みる
      setTimeout(connectToBackgroundService, RECONNECT_DELAY_MS)
    })
    return port
  } catch (e) {
    // 拡張機能のコンテキストが無効な場合は、少し待ってから再試行
    setTimeout(connectToBackgroundService, RECONNECT_DELAY_MS)
    return null as any
  }
}

let port = connectToBackgroundService()

// キープアライブ管理
const startKeepalive = (port: chrome.runtime.Port | null) => {
  if (!port) return
  // 既存のタイマーをクリア
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer)
  }

  // ゲーム中のみキープアライブを送信
  if (isGameActive) {
    keepaliveTimer = setInterval(() => {
      try {
        port.postMessage({ type: 'keepalive' } as any)
      } catch (e) {
        // ポートが切断されている場合は静かに停止（エラー出力なし）
        stopKeepalive()
      }
    }, KEEPALIVE_INTERVAL_MS)
  }
}

const stopKeepalive = () => {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer)
    keepaliveTimer = null
  }
}

// window.postMessageはさまざまなソースからのメッセージを受信する可能性がある
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  // 全ての条件を統合してチェック
  if (
    // セキュリティチェック: ゲームのオリジンからのメッセージのみ受け付ける
    event.source !== window ||
    event.origin !== PokerChaseService.POKER_CHASE_ORIGIN ||
    // PokerChase APIメッセージの型ガード: ApiTypeIdを持つことを確認
    !event.data ||
    typeof event.data !== 'object' ||
    !('ApiTypeId' in event.data) ||
    typeof event.data.ApiTypeId !== 'number'
  ) {
    return
  }

  // ゲーム状態の追跡
  switch (event.data.ApiTypeId) {
    case ApiType.EVT_SESSION_DETAILS:
      // セッション開始
      if (!isGameActive) {
        isGameActive = true
        startKeepalive(port)
      }
      break

    case ApiType.EVT_SESSION_RESULTS:
      // セッション終了
      if (isGameActive) {
        isGameActive = false
        stopKeepalive()
      }
      break
  }

  if (!port) {
    // ポートが無効な場合は再接続を試みる
    port = connectToBackgroundService()
    return
  }

  try {
    port.postMessage(event.data)
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Extension context invalidated.') {
      // 拡張機能が更新または無効化された場合は静かにリロード
      window.location.reload()
    }
    // その他のエラーも静かに処理（コンソールに出力しない）
  }
})

// Cleanup on window unload
window.addEventListener('beforeunload', () => {
  stopKeepalive()
  // Disconnect port gracefully
  if (port) {
    try {
      port.disconnect()
    } catch (e) {
      // ポートが既に切断されている可能性があるため、エラーは静かに無視
    }
  }
})

// Handle tab visibility changes
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Tab is hidden, stop keepalive to save resources
    stopKeepalive()
  } else if (isGameActive && port) {
    // Tab is visible again and game is active, restart keepalive
    startKeepalive(port)
  }
})

const messageHandlers: Record<string, (message: ChromeMessage) => void> = {
  updateBattleTypeFilter: (message) => {
    if ('filterOptions' in message) {
      window.dispatchEvent(new CustomEvent(EVENTS.UPDATE_BATTLE_TYPE_FILTER, {
        detail: message.filterOptions
      }))
    }
  },
  latestStats: (message) => {
    if ('stats' in message) {
      window.dispatchEvent(new CustomEvent(PokerChaseService.POKER_CHASE_SERVICE_EVENT, {
        detail: { stats: message.stats }
      }))
    }
  },
  handLogEvent: (message) => {
    if ('event' in message) {
      window.dispatchEvent(new CustomEvent(EVENTS.HAND_LOG_EVENT, {
        detail: message.event
      }))
    }
  },
  updateHandLogConfig: (message) => {
    if ('config' in message) {
      window.dispatchEvent(new CustomEvent(EVENTS.UPDATE_HAND_LOG_CONFIG, {
        detail: message.config
      }))
    }
  },
  refreshStats: () => {
    // インポート後の統計更新をリクエスト
    // 最新の統計をバックグラウンドサービスから取得
    try {
      chrome.runtime.sendMessage({ action: 'requestLatestStats' })
    } catch (e) {
      // 拡張機能のコンテキストが無効な場合は静かに無視
    }
  }
}

chrome.runtime.onMessage.addListener((message: ChromeMessage) => {
  const handler = messageHandlers[message.action]
  if (handler) {
    handler(message)
  }
})

const injectWebSocketHook = () => {
  const firstResource = web_accessible_resources[0]
  if (!firstResource?.resources[0]) return

  const script = document.createElement('script')
  script.type = 'text/javascript'
  script.src = chrome.runtime.getURL(firstResource.resources[0])
  document.body?.appendChild(script)
}
injectWebSocketHook()

const mountApp = () => {
  const unityContainer = document.querySelector('#unity-container')
  if (!unityContainer) return

  const appRoot = document.createElement('div')
  unityContainer.appendChild(appRoot)
  createRoot(appRoot).render(createElement(App))
}
mountApp()
