/**
 * web accessible resource: JavaScript Context にアクセスできる
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources?hl=ja
 * @see https://developer.mozilla.org/ja/docs/Mozilla/Add-ons/WebExtensions/manifest.json/web_accessible_resources
 */
import { decode, encode } from '@msgpack/msgpack'
import { POKER_CHASE_ORIGIN } from './constants/runtime'
import {
  REPLAY_API_ORIGIN,
  REPLAY_BRIDGE_CONFIG,
  REPLAY_BRIDGE_FETCH,
  REPLAY_BRIDGE_RESULT,
  REPLAY_DETAIL_URL,
  REPLAY_FETCH_BATCH_LIMIT,
  errorMessage,
  isPositiveHandId,
  sanitizeReplayDetail,
  type ReplayBridgeConfigMessage,
  type ReplayFetchItemResult,
  type ReplayFetchRequest
} from './replay/protocol'
/** !!! BACKGROUND、CONTENT_SCRIPTSからインポートしないこと !!! */

const OriginalWebSocket = window.WebSocket

function createWebSocket(...args: ConstructorParameters<typeof WebSocket>): WebSocket {
  const instance: WebSocket = new OriginalWebSocket(...args)

  instance.addEventListener('message', ({ data }) => {
    if (data instanceof ArrayBuffer) {
      try {
        const decoded = decode(data)

        // ApiTypeIdの存在と数値型であることを確認
        if (decoded &&
          typeof decoded === 'object' &&
          'ApiTypeId' in decoded &&
          typeof (decoded as { ApiTypeId: unknown }).ApiTypeId === 'number') {
          // timestampを付与してメッセージ送信
          window.postMessage({
            ...decoded,
            timestamp: Date.now()
          }, POKER_CHASE_ORIGIN)
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

interface ReplayAuthEnvelope {
  session: string
  platform: number
  appVer: string
  dataVer: string
  masterVer: string
}

const OriginalFetch = window.fetch.bind(window)
let replayImportEnabled = false
let replayAuth: ReplayAuthEnvelope | undefined
let replayFetchQueue: Promise<void> = Promise.resolve()

const requestUrl = (input: RequestInfo | URL): URL | undefined => {
  try {
    return new URL(input instanceof Request ? input.url : String(input), window.location.href)
  } catch {
    return undefined
  }
}

const decodeBody = async (body: BodyInit | null | undefined): Promise<unknown> => {
  if (body instanceof ArrayBuffer) return decode(new Uint8Array(body))
  if (ArrayBuffer.isView(body)) return decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
  if (body instanceof Blob) return decode(new Uint8Array(await body.arrayBuffer()))
  return undefined
}

const decodeRequestBody = async (input: RequestInfo | URL, init?: RequestInit): Promise<unknown> => {
  if (init?.body != null) return decodeBody(init.body)
  if (input instanceof Request) return decode(new Uint8Array(await input.clone().arrayBuffer()))
  return undefined
}

const readAuthEnvelope = (value: unknown): ReplayAuthEnvelope | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (
    typeof record.session !== 'string' ||
    typeof record.platform !== 'number' ||
    typeof record.appVer !== 'string' ||
    typeof record.dataVer !== 'string' ||
    typeof record.masterVer !== 'string'
  ) return undefined
  return {
    session: record.session,
    platform: record.platform,
    appVer: record.appVer,
    dataVer: record.dataVer,
    masterVer: record.masterVer
  }
}

const refreshSessionFromResponse = async (response: Response): Promise<void> => {
  try {
    const decoded = decode(new Uint8Array(await response.clone().arrayBuffer()))
    if (typeof decoded === 'object' && decoded !== null &&
      'session' in decoded && typeof decoded.session === 'string' && replayAuth) {
      replayAuth = { ...replayAuth, session: decoded.session }
    }
  } catch {
    // Many API responses are not MessagePack. They are irrelevant here.
  }
}

// Capture the same version/session envelope PokerChase itself supplies. The
// envelope remains inside the page's main-world closure and is never posted to
// the extension context or IndexedDB.
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = requestUrl(input)
  if (!replayImportEnabled || url?.origin !== REPLAY_API_ORIGIN) {
    return OriginalFetch(input, init)
  }

  try {
    replayAuth = readAuthEnvelope(await decodeRequestBody(input, init)) ?? replayAuth
  } catch {
    // A request without a MessagePack body is unrelated to replay auth.
  }
  const response = await OriginalFetch(input, init)
  refreshSessionFromResponse(response).catch(() => undefined)
  return response
}) as typeof window.fetch

// Unity WebGL may use XMLHttpRequest rather than fetch for the same API
// calls. Mirror the envelope observation there; requests themselves still go
// through the original browser implementation unchanged.
const xhrUrls = new WeakMap<XMLHttpRequest, URL>()
const OriginalXhrOpen = XMLHttpRequest.prototype.open
const OriginalXhrSend = XMLHttpRequest.prototype.send

XMLHttpRequest.prototype.open = function (
  method: string,
  url: string | URL,
  async: boolean = true,
  username?: string | null,
  password?: string | null
): void {
  try {
    xhrUrls.set(this, new URL(String(url), window.location.href))
  } catch {
    xhrUrls.delete(this)
  }
  OriginalXhrOpen.call(this, method, String(url), async, username ?? null, password ?? null)
}

const refreshSessionFromXhr = async (xhr: XMLHttpRequest): Promise<void> => {
  try {
    const response = xhr.response
    let decoded: unknown
    if (response instanceof ArrayBuffer) decoded = decode(new Uint8Array(response))
    else if (ArrayBuffer.isView(response)) decoded = decode(new Uint8Array(response.buffer, response.byteOffset, response.byteLength))
    else if (response instanceof Blob) decoded = decode(new Uint8Array(await response.arrayBuffer()))
    if (typeof decoded === 'object' && decoded !== null &&
      'session' in decoded && typeof decoded.session === 'string' && replayAuth) {
      replayAuth = { ...replayAuth, session: decoded.session }
    }
  } catch {
    // Non-MessagePack XHR responses are unrelated to replay auth.
  }
}

XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null): void {
  const url = xhrUrls.get(this)
  if (replayImportEnabled && url?.origin === REPLAY_API_ORIGIN) {
    if (!(body instanceof Document)) {
      decodeBody(body)
        .then(decoded => { replayAuth = readAuthEnvelope(decoded) ?? replayAuth })
        .catch(() => undefined)
    }
    this.addEventListener('loadend', () => {
      refreshSessionFromXhr(this).catch(() => undefined)
    }, { once: true })
  }
  OriginalXhrSend.call(this, body)
}

const fetchReplayDetail = async (handId: number): Promise<ReplayFetchItemResult> => {
  const auth = replayAuth
  if (!auth) return { handId, ok: false, error: 'auth-envelope-unavailable', retryable: true }

  try {
    const response = await OriginalFetch(REPLAY_DETAIL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/msgpack' },
      body: encode({
        param: { HandId: handId },
        ...auth,
        requestKey: crypto.randomUUID()
      })
    })
    const responseBytes = new Uint8Array(await response.arrayBuffer())
    if (!response.ok) {
      const retryable = response.status === 401 || response.status === 408 || response.status === 429 || response.status >= 500
      return { handId, ok: false, error: `HTTP ${response.status}`, retryable }
    }
    const decoded = decode(responseBytes)
    if (typeof decoded === 'object' && decoded !== null &&
      'session' in decoded && typeof decoded.session === 'string') {
      replayAuth = { ...auth, session: decoded.session }
    }
    if (typeof decoded === 'object' && decoded !== null &&
      'Code' in decoded && typeof decoded.Code === 'number' && decoded.Code !== 0) {
      return { handId, ok: false, error: `API Code ${decoded.Code}`, retryable: false }
    }
    return { handId, ok: true, detail: sanitizeReplayDetail(decoded) }
  } catch (error) {
    return { handId, ok: false, error: errorMessage(error), retryable: true }
  }
}

const handleReplayFetch = async (message: ReplayFetchRequest): Promise<void> => {
  const handIds = message.handIds
    .filter(isPositiveHandId)
    .slice(0, REPLAY_FETCH_BATCH_LIMIT)
  const results: ReplayFetchItemResult[] = []
  for (const handId of handIds) results.push(await fetchReplayDetail(handId))
  window.postMessage({
    type: REPLAY_BRIDGE_RESULT,
    requestId: message.requestId,
    results
  }, POKER_CHASE_ORIGIN)
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window || event.origin !== POKER_CHASE_ORIGIN ||
    typeof event.data !== 'object' || event.data === null || !('type' in event.data)) return

  if (event.data.type === REPLAY_BRIDGE_CONFIG) {
    const message = event.data as ReplayBridgeConfigMessage
    replayImportEnabled = message.enabled === true
    if (!replayImportEnabled) replayAuth = undefined
    return
  }
  if (event.data.type !== REPLAY_BRIDGE_FETCH || !replayImportEnabled) return
  const message = event.data as Partial<ReplayFetchRequest>
  if (typeof message.requestId !== 'string' || !Array.isArray(message.handIds)) return
  replayFetchQueue = replayFetchQueue
    .then(() => handleReplayFetch(message as ReplayFetchRequest))
    .catch(error => console.warn('[experimental-replay] Replay fetch batch failed:', error))
})
