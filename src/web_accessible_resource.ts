/**
 * web accessible resource: JavaScript Context にアクセスできる
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources?hl=ja
 * @see https://developer.mozilla.org/ja/docs/Mozilla/Add-ons/WebExtensions/manifest.json/web_accessible_resources
 */
import { decode } from '@msgpack/msgpack'
import { origin } from './background'
import { ApiResponse } from './app'

const OriginalWebSocket = window.WebSocket

function createWebSocket(...args: ConstructorParameters<typeof WebSocket>): WebSocket {
  const instance: WebSocket = new OriginalWebSocket(...args)
  instance.addEventListener('message', ({ data }) => {
    if (data instanceof ArrayBuffer) {
      const event = decode(data) as ApiResponse
      window.postMessage({ _ts: Date.now(), ...event }, origin) /** to `content_script` */
    }
  })
  return instance
}

window.WebSocket = createWebSocket as unknown as typeof WebSocket
