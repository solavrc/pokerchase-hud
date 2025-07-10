/**
 * コンテンツスクリプト: DOM にアクセスできる
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts?hl=ja
 * @see https://developer.mozilla.org/ja/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { web_accessible_resources } from '../manifest.json'
import PokerChaseService, { ApiEvent, ApiType, PlayerStats } from './app'
import App from './components/App'
import type { ChromeMessage } from './types/messages'
import { MESSAGE_ACTIONS as EVENTS } from './types/messages'
/** !!! BACKGROUND、WEB_ACCESSIBLE_RESOURCES からインポートしないこと !!! */

const RECONNECT_DELAY_MS = 500

export interface StatsData {
  stats: PlayerStats[]
  evtDeal?: ApiEvent<ApiType.EVT_DEAL>  // 席のマッピング用のEVT_DEALイベント
}

declare global {
  interface WindowEventMap {
    [PokerChaseService.POKER_CHASE_SERVICE_EVENT]: CustomEvent<StatsData>
  }
}

const connectToBackgroundService = () => {
  const port = chrome.runtime.connect({ name: PokerChaseService.POKER_CHASE_SERVICE_EVENT })
  port.onMessage.addListener((message: { stats: PlayerStats[], evtDeal?: ApiEvent<ApiType.EVT_DEAL> } | string) => {
    if (typeof message === 'object' && message !== null && 'stats' in message) {
      window.dispatchEvent(new CustomEvent(PokerChaseService.POKER_CHASE_SERVICE_EVENT, { detail: message }))
    }
  })
  port.onDisconnect.addListener(() => {
    setTimeout(connectToBackgroundService, RECONNECT_DELAY_MS)
  })
  return port
}

const port = connectToBackgroundService()

window.addEventListener('message', (event: MessageEvent<ApiEvent>) => {
  // セキュリティチェック: ゲームのオリジンからのメッセージのみ受け付ける
  if (event.source !== window ||
    event.origin !== PokerChaseService.POKER_CHASE_ORIGIN ||
    !event.data.ApiTypeId) {
    return
  }
  try {
    port.postMessage(event.data)
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Extension context invalidated.') {
      window.location.reload()
    }
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
