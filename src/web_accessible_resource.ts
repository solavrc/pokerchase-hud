/**
 * web accessible resource: JavaScript Context にアクセスできる
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources?hl=ja
 * @see https://developer.mozilla.org/ja/docs/Mozilla/Add-ons/WebExtensions/manifest.json/web_accessible_resources
 */
import { decode } from '@msgpack/msgpack'
import PokerChaseService, { ApiEvent } from './app'
/** !!! BACKGROUND、CONTENT_SCRIPTSからインポートしないこと !!! */

const OriginalWebSocket = window.WebSocket

function createWebSocket(...args: ConstructorParameters<typeof WebSocket>): WebSocket {
  const instance: WebSocket = new OriginalWebSocket(...args)

  const connectionUrl = args[0]
  const connectionProtocols = args.length > 1 ? args[1] : undefined

  let wasConnected = false

  instance.addEventListener('open', () => {
    wasConnected = true
  })

  instance.addEventListener('message', ({ data }) => {
    if (data instanceof ArrayBuffer) {
      const event = decode(data) as ApiEvent
      window.postMessage({ ...event, timestamp: Date.now() }, PokerChaseService.POKER_CHASE_ORIGIN)
    }
  })

  instance.addEventListener('close', (event) => {
    if (wasConnected && !event.wasClean) {
      // 予期せず接続が閉じられた、再接続を試しています...
      setTimeout(() => {
        new WebSocket(connectionUrl, connectionProtocols)
      }, 500)
    }
  })

  return instance
}

window.WebSocket = createWebSocket as unknown as typeof WebSocket
