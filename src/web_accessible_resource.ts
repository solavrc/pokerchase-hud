/**
 * web accessible resource: JavaScript Context にアクセスできる
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources?hl=ja
 * @see https://developer.mozilla.org/ja/docs/Mozilla/Add-ons/WebExtensions/manifest.json/web_accessible_resources
 */
import { decode, encode } from '@msgpack/msgpack'
import {
  POKER_CHASE_INVALID_API_EVENT,
  POKER_CHASE_ORIGIN
} from './constants/runtime'
import {
  REPLAY_API_ORIGIN,
  REPLAY_BRIDGE_CONFIG,
  REPLAY_BRIDGE_FETCH,
  REPLAY_BRIDGE_LEDGER,
  REPLAY_BRIDGE_RESULT,
  REPLAY_DETAIL_URL,
  REPLAY_FETCH_BATCH_LIMIT,
  REPLAY_FETCH_INTERVAL_MS,
  REPLAY_FETCH_TIMEOUT_MS,
  REPLAY_LIST_PATH,
  errorMessage,
  isPositiveHandId,
  readReplayLedger,
  sanitizeReplayDetail,
  type ReplayBridgeConfigMessage,
  type ReplayFetchItemResult,
  type ReplayFetchRequest
} from './replay/protocol'
/** !!! BACKGROUND、CONTENT_SCRIPTSからインポートしないこと !!! */

const OriginalWebSocket = window.WebSocket
const MAX_PENDING_UNCLASSIFIED_PAYLOADS = 5
const POKER_CHASE_API_DOMAIN = 'api-poker-chase.com'

interface PendingPayload {
  payload: Record<string, unknown>
  hasSafeApiTypeId: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isPokerChaseApiSocketUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url, window.location.href)
    return (
      (parsed.protocol === 'wss:' || parsed.protocol === 'ws:') &&
      (
        parsed.hostname === POKER_CHASE_API_DOMAIN ||
        parsed.hostname.endsWith(`.${POKER_CHASE_API_DOMAIN}`)
      )
    )
  } catch {
    return false
  }
}

const hasIntegerInRange = (
  payload: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number
): boolean =>
  Number.isSafeInteger(payload[key]) &&
  (payload[key] as number) >= minimum &&
  (payload[key] as number) <= maximum

const hasArrayLength = (
  payload: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number
): boolean =>
  Array.isArray(payload[key]) &&
  payload[key].length >= minimum &&
  payload[key].length <= maximum

const hasRecord = (
  payload: Record<string, unknown>,
  key: string
): boolean => isRecord(payload[key])

const hasNestedIntegerInRange = (
  payload: Record<string, unknown>,
  parentKey: string,
  key: string,
  minimum: number,
  maximum: number
): boolean => {
  const parent = payload[parentKey]
  return isRecord(parent) &&
    hasIntegerInRange(parent, key, minimum, maximum)
}

const hasChatMessage = (
  payload: Record<string, unknown>,
  key: string
): boolean => {
  const message = payload[key]
  if (
    !isRecord(message) ||
    !hasIntegerInRange(message, 'Id', 0, Number.MAX_SAFE_INTEGER) ||
    !hasIntegerInRange(message, 'Ti', 0, Number.MAX_SAFE_INTEGER) ||
    typeof message.Ms !== 'string' ||
    !isRecord(message.Us)
  ) {
    return false
  }
  const user = message.Us
  return hasIntegerInRange(user, 'Id', 0, Number.MAX_SAFE_INTEGER) &&
    typeof user.Na === 'string' &&
    isRecord(user.Ic) &&
    typeof user.Ic.Co === 'string' &&
    typeof user.Ic.Fr === 'string'
}

/**
 * Positive, page-world-safe proof that a socket speaks the PokerChase
 * protocol. Importing the full Zod union here would add roughly 140 KB of
 * minified schema code to the injected main-world hook, so use distinctive
 * required-field fingerprints from frequent known events. This predicate is
 * only for latching socket identity; background remains the schema authority.
 */
const isPokerChaseProtocolAnchor = (
  payload: Record<string, unknown>
): boolean => {
  switch (payload.ApiTypeId) {
    case 201:
      return hasIntegerInRange(payload, 'BattleType', 0, 6) &&
        payload.BattleType !== 3 &&
        hasIntegerInRange(payload, 'Code', 0, Number.MAX_SAFE_INTEGER) &&
        typeof payload.Id === 'string' &&
        typeof payload.IsRetire === 'boolean'
    case 303:
      return hasRecord(payload, 'Game') &&
        hasNestedIntegerInRange(
          payload,
          'Game',
          'BigBlind',
          0,
          Number.MAX_SAFE_INTEGER
        ) &&
        hasArrayLength(payload, 'OtherPlayers', 1, 6) &&
        hasRecord(payload, 'Progress') &&
        hasNestedIntegerInRange(payload, 'Progress', 'Phase', 0, 0) &&
        hasNestedIntegerInRange(
          payload,
          'Progress',
          'Pot',
          0,
          Number.MAX_SAFE_INTEGER
        ) &&
        hasArrayLength(payload, 'SeatUserIds', 4, 6)
    case 304:
      return hasIntegerInRange(payload, 'ActionType', 0, 5) &&
        hasIntegerInRange(payload, 'BetChip', 0, Number.MAX_SAFE_INTEGER) &&
        hasIntegerInRange(payload, 'Chip', 0, Number.MAX_SAFE_INTEGER) &&
        hasIntegerInRange(payload, 'SeatIndex', 0, 5) &&
        hasRecord(payload, 'Progress') &&
        hasNestedIntegerInRange(payload, 'Progress', 'Phase', 0, 3) &&
        hasNestedIntegerInRange(
          payload,
          'Progress',
          'Pot',
          0,
          Number.MAX_SAFE_INTEGER
        )
    case 305:
      return hasArrayLength(payload, 'CommunityCards', 1, 3) &&
        hasArrayLength(payload, 'OtherPlayers', 1, 6) &&
        hasRecord(payload, 'Progress') &&
        hasNestedIntegerInRange(payload, 'Progress', 'Phase', 1, 3) &&
        hasNestedIntegerInRange(
          payload,
          'Progress',
          'Pot',
          0,
          Number.MAX_SAFE_INTEGER
        ) &&
        hasNestedIntegerInRange(payload, 'Progress', 'NextActionSeat', 0, 5)
    case 306:
      return hasArrayLength(payload, 'CommunityCards', 0, 5) &&
        hasIntegerInRange(payload, 'DefeatStatus', 0, 1) &&
        hasIntegerInRange(payload, 'HandId', 0, Number.MAX_SAFE_INTEGER) &&
        hasIntegerInRange(payload, 'Pot', 0, Number.MAX_SAFE_INTEGER) &&
        hasArrayLength(payload, 'Results', 1, 6) &&
        hasIntegerInRange(payload, 'ResultType', 0, 4) &&
        hasArrayLength(payload, 'SidePot', 0, 4)
    case 308:
      return hasIntegerInRange(
        payload,
        'DefaultChip',
        Number.MIN_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER
      ) &&
        hasArrayLength(payload, 'BlindStructures', 1, 100) &&
        hasIntegerInRange(
          payload,
          'CoinNum',
          Number.MIN_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER
        ) &&
        typeof payload.IsReplay === 'boolean' &&
        typeof payload.Name === 'string' &&
        typeof payload.Name2 === 'string' &&
        hasIntegerInRange(payload, 'LimitSeconds', 0, Number.MAX_SAFE_INTEGER)
    case 309:
      return hasIntegerInRange(
        payload,
        'Ranking',
        Number.MIN_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER
      ) &&
        Array.isArray(payload.Items) &&
        Array.isArray(payload.Rewards) &&
        Array.isArray(payload.Charas) &&
        hasRecord(payload, 'Money')
    case 313:
      return hasIntegerInRange(payload, 'ProcessType', 0, 4) &&
        typeof payload.IsLeave === 'boolean' &&
        typeof payload.IsRetire === 'boolean' &&
        hasArrayLength(payload, 'SeatUserIds', 4, 6) &&
        hasArrayLength(payload, 'TableUsers', 1, 6)
    case 1201:
      return hasIntegerInRange(payload, 'chatType', 0, 3) &&
        payload.Code === 0 &&
        hasArrayLength(payload, 'OnlineStatus', 0, 2) &&
        hasArrayLength(payload, 'OnlineUserIds', 0, 2) &&
        hasArrayLength(payload, 'PrevMessage', 0, 50)
    case 1301:
      return hasChatMessage(payload, 'Message')
    case 1303:
      return hasIntegerInRange(payload, 'BattleType', 0, 6) &&
        payload.BattleType !== 3 &&
        hasIntegerInRange(payload, 'RoomId', 0, Number.MAX_SAFE_INTEGER) &&
        hasChatMessage(payload, 'Message')
    default:
      return false
  }
}

function createWebSocket(...args: ConstructorParameters<typeof WebSocket>): WebSocket {
  const instance: WebSocket = new OriginalWebSocket(...args)
  // The production client currently connects through the official
  // *.api-poker-chase.com family. Trusting that endpoint independently of the
  // decoded body is what keeps a global ApiTypeId removal/rename observable
  // from the very first event. Protocol fingerprints below remain a fallback
  // if PokerChase moves the WebSocket endpoint in a future client release.
  let isPokerChaseApiSocket = isPokerChaseApiSocketUrl(instance.url)
  const pendingUnclassifiedPayloads: PendingPayload[] = []

  const forwardInvalidPayload = (payload: Record<string, unknown>): void => {
    window.postMessage({
      type: POKER_CHASE_INVALID_API_EVENT,
      payload
    }, POKER_CHASE_ORIGIN)
  }

  const forwardPayload = ({
    payload,
    hasSafeApiTypeId
  }: PendingPayload): void => {
    if (hasSafeApiTypeId) {
      window.postMessage(payload, POKER_CHASE_ORIGIN)
    } else {
      forwardInvalidPayload(payload)
    }
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
          const hasSafeApiTypeId =
            'ApiTypeId' in decoded &&
            Number.isSafeInteger(
              (decoded as { ApiTypeId: unknown }).ApiTypeId
            )
          const pendingPayload = { payload, hasSafeApiTypeId }

          if (isPokerChaseApiSocket) {
            forwardPayload(pendingPayload)
            return
          }

          // A numeric field name is not socket identity. Establish trust only
          // after this connection produces a distinctive known PokerChase
          // fingerprint. Schema-drift and invalid-ID payloads received before
          // that proof stay bounded and are flushed in arrival order.
          if (isPokerChaseProtocolAnchor(decoded as Record<string, unknown>)) {
            isPokerChaseApiSocket = true
            for (const bufferedPayload of pendingUnclassifiedPayloads) {
              forwardPayload(bufferedPayload)
            }
            pendingUnclassifiedPayloads.length = 0
            forwardPayload(pendingPayload)
          } else if (
            pendingUnclassifiedPayloads.length <
              MAX_PENDING_UNCLASSIFIED_PAYLOADS
          ) {
            pendingUnclassifiedPayloads.push(pendingPayload)
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

interface ReplayAuthEnvelope {
  session: string
  platform: number
  appVer: string
  dataVer: string
  masterVer: string
}

/**
 * ページ側がfetchを差し替える前の実体。モジュール読み込み時に掴むのは、
 * 後からゲーム側が差し替えても素の実装を使い続けるため。
 *
 * ただしfetchが存在しない実行環境（jsdomなど）でも読み込み自体は成功させる。
 * このファイルの本業はWebSocketの傍受であって、replay取り込みはその上に
 * 乗った実験機能にすぎない。モジュールスコープで例外を投げると本業ごと
 * 巻き添えで死ぬ。
 */
const OriginalFetch: typeof window.fetch | undefined =
  typeof window.fetch === 'function' ? window.fetch.bind(window) : undefined
let replayImportEnabled = false
let replayConfigReceived = false
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

/**
 * `/replay/list` の応答から台帳を拡張側へ渡す（受動取得）。
 *
 * 拡張は自分でリクエストを出さない ―― ユーザーがゲーム内でリプレイ画面を
 * 開いたときにゲーム自身が出した通信を読むだけなので、追加のHTTPは1本も
 * 発生しない。台帳はサーバ自身が持つ「ヒーローが打ったハンド」の記録で、
 * ローカルの`hands`と突き合わせればキャプチャ欠損を直接検出できる。
 * `CardOpenEndDate`も同じ応答に乗るので、課金状態の確認に別の
 * リクエストを撃つ必要がない。
 */
const postReplayLedger = (url: URL, decoded: unknown): void => {
  // 設定未受信を有効扱いする上の観測ゲート（`!replayConfigReceived ||
  // replayImportEnabled`）には**乗らない**。あちらが緩いのは、認証エンベロープ
  // の捕獲機会が起動直後の1回しか無く、かつ捕獲した値はページのクロージャに
  // 留まって拡張側へ渡らない（設定が届いた時点で無効なら破棄される）ため。
  // 台帳は拡張側へ渡って永続化されるので、同じ緩さを適用すると実験フラグを
  // 一度も有効化していないユーザーの監査が走ってしまう。
  // 実害も無い: `/replay/list` はユーザーの手動操作で飛ぶので、起動直後の
  // 設定未確定の窓に重なることは無い。
  if (!replayImportEnabled) return
  if (url.pathname !== REPLAY_LIST_PATH) return
  const ledger = readReplayLedger(decoded)
  if (!ledger) return
  window.postMessage({ type: REPLAY_BRIDGE_LEDGER, ...ledger }, POKER_CHASE_ORIGIN)
}

const observeApiResponse = (url: URL, decoded: unknown): void => {
  if (typeof decoded === 'object' && decoded !== null &&
    'session' in decoded && typeof decoded.session === 'string' && replayAuth) {
    replayAuth = { ...replayAuth, session: decoded.session }
  }
  postReplayLedger(url, decoded)
}

const readApiResponse = async (url: URL, response: Response): Promise<void> => {
  try {
    observeApiResponse(url, decode(new Uint8Array(await response.clone().arrayBuffer())))
  } catch {
    // Many API responses are not MessagePack. They are irrelevant here.
  }
}

// Capture the same version/session envelope PokerChase itself supplies. The
// envelope remains inside the page's main-world closure and is never posted to
// the extension context or IndexedDB.
if (OriginalFetch) {
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input)
    if (url?.origin !== REPLAY_API_ORIGIN || (replayConfigReceived && !replayImportEnabled)) {
      return OriginalFetch(input, init)
    }

    try {
      replayAuth = readAuthEnvelope(await decodeRequestBody(input, init)) ?? replayAuth
    } catch {
      // A request without a MessagePack body is unrelated to replay auth.
    }
    const response = await OriginalFetch(input, init)
    readApiResponse(url, response).catch(() => undefined)
    return response
  }) as typeof window.fetch
}

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

const readApiXhrResponse = async (url: URL, xhr: XMLHttpRequest): Promise<void> => {
  try {
    const response = xhr.response
    let decoded: unknown
    if (response instanceof ArrayBuffer) decoded = decode(new Uint8Array(response))
    else if (ArrayBuffer.isView(response)) decoded = decode(new Uint8Array(response.buffer, response.byteOffset, response.byteLength))
    else if (response instanceof Blob) decoded = decode(new Uint8Array(await response.arrayBuffer()))
    else return
    observeApiResponse(url, decoded)
  } catch {
    // Non-MessagePack XHR responses are unrelated to replay auth.
  }
}

XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null): void {
  const url = xhrUrls.get(this)
  if (url?.origin === REPLAY_API_ORIGIN && (!replayConfigReceived || replayImportEnabled)) {
    if (!(body instanceof Document)) {
      decodeBody(body)
        .then(decoded => { replayAuth = readAuthEnvelope(decoded) ?? replayAuth })
        .catch(() => undefined)
    }
    this.addEventListener('loadend', () => {
      readApiXhrResponse(url, this).catch(() => undefined)
    }, { once: true })
  }
  OriginalXhrSend.call(this, body)
}

/**
 * REST応答エンベロープの拒否判定。
 *
 * このAPIは拒否も**HTTP 200**で返し、成否は本文の`result`(0=成功)と
 * `status`(エラーコード)で表す。WebSocket側の`Code`
 * (docs/api-events.md の 201/202) は**このAPIには存在しない**フィールドで、
 * それを見ると拒否を常に成功として取り違える。
 *
 * 実測(2026-08-01): 取得できないhandIdは
 * `{ result: 1, status: 2302, message: 'text_error_message_code_2302' }` を返し、
 * `param`自体を持たない。成功時は`result: 0, status: 0`と`param`が揃う。
 *
 * `param`欠落も拒否として扱う。未知のエンベロープ形でも、中身の無い応答を
 * 成功として保存経路へ流さないため。
 *
 * `retryable`は一律false。エラーコード空間が未知であり、同じエンベロープでの
 * 再送が状況を変える根拠がまだ無い。取り込み層は`error`文字列に載る
 * `status`を見て、コード別の扱いを後から足せる。
 */
const readEnvelopeRejection = (
  decoded: unknown
): { error: string, retryable: boolean } | undefined => {
  if (typeof decoded !== 'object' || decoded === null) {
    return { error: 'malformed-response', retryable: false }
  }
  const record = decoded as Record<string, unknown>
  if (typeof record.result === 'number' && record.result !== 0) {
    const status = typeof record.status === 'number' ? record.status : 'unknown'
    return { error: `API result ${record.result} status ${status}`, retryable: false }
  }
  if (record.param === undefined) return { error: 'missing-param', retryable: false }
  return undefined
}

const fetchReplayDetail = async (handId: number): Promise<ReplayFetchItemResult> => {
  if (!OriginalFetch) return { handId, ok: false, error: 'fetch-unavailable', retryable: false }
  const auth = replayAuth
  if (!auth) return { handId, ok: false, error: 'auth-envelope-unavailable', retryable: true }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REPLAY_FETCH_TIMEOUT_MS)
  try {
    const response = await OriginalFetch(REPLAY_DETAIL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/msgpack' },
      signal: controller.signal,
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
    const rejection = readEnvelopeRejection(decoded)
    if (rejection) return { handId, ok: false, ...rejection }
    return { handId, ok: true, detail: sanitizeReplayDetail(decoded) }
  } catch (error) {
    // AbortErrorは上限到達。再試行可能として返し、backoffに委ねる。
    return { handId, ok: false, error: errorMessage(error), retryable: true }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 間隔を空ける理由のもう一つ: 流量制限に掛かった応答を「取得不可」と
 * 取り違えないための予防。このAPIは拒否をHTTP 200 + status で返すため、
 * HTTP 429として現れる保証がなく、`readEnvelopeRejection` からは 2302 と
 * 区別が付かない。間隔そのものは `protocol.ts` が持つ ―― 依頼元
 * （`replay-fetch-bridge.ts`）のバッチ上限がこの値から導出されるため、
 * 両者が同じ定数を見ていないと必ず先にタイムアウトする。
 */
const delay = (ms: number): Promise<void> =>
  new Promise(resolve => { setTimeout(resolve, ms) })

const handleReplayFetch = async (message: ReplayFetchRequest): Promise<void> => {
  const handIds = message.handIds
    .filter(isPositiveHandId)
    .slice(0, REPLAY_FETCH_BATCH_LIMIT)
  const results: ReplayFetchItemResult[] = []
  for (const handId of handIds) {
    // 先頭は待たない。1件だけの取得は従来どおり即座に走る。
    if (results.length > 0) await delay(REPLAY_FETCH_INTERVAL_MS)
    results.push(await fetchReplayDetail(handId))
  }
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
    replayConfigReceived = true
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
