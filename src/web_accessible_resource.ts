/**
 * web accessible resource: JavaScript Context にアクセスできる
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources?hl=ja
 * @see https://developer.mozilla.org/ja/docs/Mozilla/Add-ons/WebExtensions/manifest.json/web_accessible_resources
 */
import { decode } from '@msgpack/msgpack'
import { ApiEvent, PokerChaseService } from './app'
/** !!! DO NOT IMPORT FROM BACKGROUND, CONTENT_SCRIPTS !!! */

const OriginalWebSocket = window.WebSocket

function createWebSocket(...args: ConstructorParameters<typeof WebSocket>): WebSocket {
  const instance: WebSocket = new OriginalWebSocket(...args)
  instance.addEventListener('message', ({ data }) => {
    if (data instanceof ArrayBuffer) {
      const event = decode(data) as ApiEvent
      window.postMessage({ ...event, timestamp: Date.now() }, PokerChaseService.POKER_CHASE_ORIGIN) /** to `content_script` */
    }
  })
  return instance
}

window.WebSocket = createWebSocket as unknown as typeof WebSocket
