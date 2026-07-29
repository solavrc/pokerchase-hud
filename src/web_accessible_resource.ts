/**
 * web accessible resource: JavaScript Context にアクセスできる
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources?hl=ja
 * @see https://developer.mozilla.org/ja/docs/Mozilla/Add-ons/WebExtensions/manifest.json/web_accessible_resources
 */
import { decode } from '@msgpack/msgpack'
import {
  POKER_CHASE_INVALID_API_EVENT,
  POKER_CHASE_ORIGIN
} from './constants/runtime'
/** !!! BACKGROUND、CONTENT_SCRIPTSからインポートしないこと !!! */

const OriginalWebSocket = window.WebSocket
const MAX_PENDING_UNCLASSIFIED_PAYLOADS = 5

function createWebSocket(...args: ConstructorParameters<typeof WebSocket>): WebSocket {
  const instance: WebSocket = new OriginalWebSocket(...args)
  let isPokerChaseApiSocket = false
  const pendingUnclassifiedPayloads: Record<string, unknown>[] = []

  const forwardInvalidPayload = (payload: Record<string, unknown>): void => {
    window.postMessage({
      type: POKER_CHASE_INVALID_API_EVENT,
      payload
    }, POKER_CHASE_ORIGIN)
  }

  instance.addEventListener('message', ({ data }) => {
    if (data instanceof ArrayBuffer) {
      try {
        const decoded = decode(data)

        if (decoded && typeof decoded === 'object') {
          const payload = {
            ...decoded,
            timestamp: Date.now()
          }
          if (
            'ApiTypeId' in decoded &&
            Number.isSafeInteger(
              (decoded as { ApiTypeId: unknown }).ApiTypeId
            )
          ) {
            if (!isPokerChaseApiSocket) {
              isPokerChaseApiSocket = true
              for (const pendingPayload of pendingUnclassifiedPayloads) {
                forwardInvalidPayload(pendingPayload)
              }
              pendingUnclassifiedPayloads.length = 0
            }
            window.postMessage(payload, POKER_CHASE_ORIGIN)
          } else if (isPokerChaseApiSocket) {
            // Preserve a fundamental schema break long enough for the trusted
            // content-script bridge to forward it into the bounded sentinel
            // diagnostic path. Keep the normal flat event contract unchanged.
            forwardInvalidPayload(payload)
          } else if (
            pendingUnclassifiedPayloads.length <
              MAX_PENDING_UNCLASSIFIED_PAYLOADS
          ) {
            // The page can own unrelated MessagePack WebSockets. Do not
            // diagnose their payloads unless this same connection later proves
            // it is the PokerChase API by producing a numeric ApiTypeId.
            pendingUnclassifiedPayloads.push(payload)
          }
        }
      } catch (error) {
        // デコードエラーは静かに無視（ログも最小限に）
        console.warn('[WebSocket] Failed to decode message')
      }
    }
  })

  // 再接続はゲームクライアント自身に任せる。
  // 拡張側で new WebSocket() しても参照を保持できず、ゲームが関知しない接続が増えるだけのため行わない。

  return instance
}

window.WebSocket = createWebSocket as unknown as typeof WebSocket
