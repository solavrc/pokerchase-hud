/**
 * リプレイ取得ブリッジ: fetch / XMLHttpRequest を傍受して認証エンベロープを
 * 捕獲し、`/replay/detail` の取得と `/replay/list` 台帳の受動読み取りを行う。
 * main world（ページのJavaScriptコンテキスト）で動く。
 *
 * !!! BACKGROUND、CONTENT_SCRIPTSからインポートしないこと !!!
 *
 * ## なぜ web_accessible_resource.ts から分離したか（技術事実）
 *
 * WebSocket傍受（HUDの土台、`web_accessible_resource.ts`）は全ユーザーで常時
 * 注入されるが、こちらのリプレイ傍受は開発者フラグまたは公開オプトインを
 * 有効にしたユーザーだけが対象。両者を同居させると、どちらも有効でない
 * ユーザーにも fetch / XMLHttpRequest のパッチと、設定到達前の fail-open 窓
 * （下記）でのエンベロープ捕獲が走る。
 *
 * このモジュールを別ファイルにし、`content_script.ts` がフラグ有効時にだけ
 * WAR `<script>` として注入することで、無効ユーザーの実行環境には本モジュール
 * のコードが一切存在しなくなる ―― fetch / XHR は素のまま、傍受も捕獲も行われ
 * ない。中核の WebSocket hook は `web_accessible_resource.ts` のまま無変更。
 *
 * ## 設計上の限界（承知の上）
 *
 * - **注入は有効化の遷移より後**: `content_script.ts` は `storage.onChanged` を
 *   受けたその場で注入するので、ページ再読み込みは要らない。ただし有効化する
 *   前にページが出していた通信のエンベロープは捕獲できない。捕獲機会は1回きり
 *   ではなく、ロード後の任意の通常API通信（ホーム画面到達時の `/home/index` 等）
 *   で捕まる。`/replay/list`・`/replay/detail` はいずれもユーザー操作・
 *   セッション終了後に飛ぶので、間に合う。
 * - **`<script>` は取り消せない**: 一度注入したこのスクリプトは、フラグを無効に
 *   戻しても DOM から消せない。無効化は `REPLAY_BRIDGE_CONFIG` の
 *   `enabled: false` を受けて**ランタイムで no-op 化**する（`replayImportEnabled`
 *   を false にし、傍受を素通しに戻し、捕獲済みエンベロープを破棄する）。
 * - **ページ側からの偽装は残存**: main world と content script は同一オリジンの
 *   `window.postMessage` を共有するため、ページ側の任意のスクリプトがこのブリッジ
 *   へ設定と取得依頼を偽装できる。これは有効化したユーザーにのみ露出する残存
 *   リスクで、この分離では解消しない（`window.postMessage` では main world から
 *   content script を認証できないため）。
 */
import { decode, encode } from '@msgpack/msgpack'
import {
  POKER_CHASE_ORIGIN,
  REPLAY_PAGE_SESSION_ACTIVITY_EVENT,
  REPLAY_PAGE_SESSION_ACTIVITY_KEY
} from './constants/runtime'
import {
  REPLAY_API_ORIGIN,
  REPLAY_BRIDGE_CANCEL,
  REPLAY_BRIDGE_CONFIG,
  REPLAY_BRIDGE_FETCH,
  REPLAY_BRIDGE_AUTH_READY,
  REPLAY_BRIDGE_LEDGER,
  REPLAY_BRIDGE_RESULT,
  REPLAY_BRIDGE_STARTED,
  REPLAY_BRIDGE_VERIFY,
  REPLAY_BRIDGE_VERIFY_RESULT,
  REPLAY_DETAIL_URL,
  REPLAY_FETCH_BATCH_LIMIT,
  REPLAY_FETCH_INTERVAL_MS,
  REPLAY_FETCH_TIMEOUT_MS,
  REPLAY_LIST_PATH,
  REPLAY_LIST_URL,
  REPLAY_VERIFY_IN_SESSION,
  REPLAY_VERIFY_NO_AUTH,
  errorMessage,
  isPositiveHandId,
  readReplayLedger,
  sanitizeReplayDetail,
  type ReplayBridgeConfigMessage,
  type ReplayFetchItemResult,
  type ReplayFetchRequest,
  type ReplayVerificationRequest
} from './replay/protocol'

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
 * モジュールスコープで例外を投げるとブリッジ全体が死ぬ。
 */
const OriginalFetch: typeof window.fetch | undefined =
  typeof window.fetch === 'function' ? window.fetch.bind(window) : undefined
let replayImportEnabled = false
let replayConfigReceived = false
let replayAuth: ReplayAuthEnvelope | undefined
/**
 * 認証の**世代**。無効化で捕獲済みエンベロープを破棄するたびに増える。
 *
 * リクエストごとのエンベロープ（`replayAuth`の参照）とは別物であることが
 * 重要: 同一アカウントで通常API通信が並行すると、各リクエスト本文の捕獲で
 * `replayAuth`は毎回別オブジェクトへ差し替わる。参照の同一性だけで応答を
 * 判定すると、最後に送ったリクエスト以外の応答（＝正しい台帳を含みうる）を
 * 全て捨ててしまう。
 *
 * 捨てるべきなのは「無効化を挟んだ＝別アカウントでありうる」応答だけなので、
 * その境界を世代で表す。sessionの回転だけは、いま現役のエンベロープに対する
 * 応答のときにだけ書き戻す（古い応答のsessionで新しい版を上書きしない）。
 */
let replayAuthGeneration = 0
/** その世代で捕獲通知を1回だけ出すための印。 */
let replayAuthAnnounced = false

/**
 * 認証エンベロープを初めて捕獲したことだけを知らせる（**値は載せない**）。
 *
 * 取り込み層は、対局中に機能を有効化した場合その対局の終了直後には必ず
 * エンベロープを持っておらず、全件を繰り延べる。捕獲はホーム画面到達時の
 * 通常通信で起きるが、そのときポートは既に接続済みでセッション終了の
 * トリガーも消費済みなので、この通知が無いと次の対局まで再開しない。
 */
const announceAuthCaptured = (): void => {
  if (replayAuthAnnounced) return
  replayAuthAnnounced = true
  window.postMessage({ type: REPLAY_BRIDGE_AUTH_READY }, POKER_CHASE_ORIGIN)
}
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
 * エンベロープ側のフィールドも同じ応答に乗るので、そのために別の
 * リクエストを撃つ必要がない。
 */
const postReplayLedger = (url: URL, decoded: unknown): void => {
  // 設定未受信を有効扱いする下の観測ゲート（`!replayConfigReceived ||
  // replayImportEnabled`）には**乗らない**。あちらが緩いのは、認証エンベロープ
  // の捕獲機会が起動直後の1回しか無く、かつ捕獲した値はページのクロージャに
  // 留まって拡張側へ渡らない（設定が届いた時点で無効なら破棄される）ため。
  // 台帳は拡張側へ渡って永続化されるので、同じ緩さを適用すると両フラグを
  // 一度も有効化していないユーザーの監査が走ってしまう。
  // 実害も無い: `/replay/list` はユーザーの手動操作で飛ぶので、起動直後の
  // 設定未確定の窓に重なることは無い。
  if (!replayImportEnabled) return
  if (url.pathname !== REPLAY_LIST_PATH) return
  const ledger = readReplayLedger(decoded)
  if (!ledger) return
  window.postMessage({ type: REPLAY_BRIDGE_LEDGER, ...ledger }, POKER_CHASE_ORIGIN)
}

/**
 * `authAtRequest` はそのリクエストを出した時点のエンベロープ。応答が返る間に
 * 無効化→再有効化で新しいエンベロープを捕獲していると、旧応答の `session` を
 * 新しい版へ混ぜてしまう（アカウント切替を伴えば別アカウントの資格情報が
 * 混じる）。捕獲のたびに丸ごと差し替えるので、参照の同一性で判定できる。
 * `fetchReplayDetail` 側と同じガードを、受動傍受の経路にも置く。
 *
 * 世代が変わっていたら**台帳も破棄する**（MUST）。台帳は拡張側へ渡って
 * 永続化され、受信時点の `playerId` と突き合わされる。旧アカウントの
 * HandId/ChipDiff を新アカウントのローカル履歴と比べると、偽の未キャプチャ・
 * 偽のチップ不一致が `replayLedgerAudit` に残る。
 *
 * 判定は**世代**（無効化を挟んだか）で行い、リクエストごとのエンベロープの
 * 参照同一性は使わない ―― 同一アカウントで通信が並行すると参照は毎回変わる
 * ので、それで判定すると正常な応答まで捨てる。
 */
const observeApiResponse = (
  url: URL,
  decoded: unknown,
  authAtRequest: ReplayAuthEnvelope | undefined,
  generationAtRequest: number
): void => {
  if (generationAtRequest !== replayAuthGeneration) return
  // sessionの回転は「いま現役のエンベロープ」に対する応答のときだけ書き戻す。
  // 並行リクエストの古い応答で新しい版を上書きしないため。
  if (replayAuth !== undefined && replayAuth === authAtRequest &&
    typeof decoded === 'object' && decoded !== null &&
    'session' in decoded && typeof decoded.session === 'string') {
    replayAuth = { ...authAtRequest, session: decoded.session }
  }
  postReplayLedger(url, decoded)
}

const readApiResponse = async (
  url: URL,
  response: Response,
  authAtRequest: ReplayAuthEnvelope | undefined,
  generationAtRequest: number
): Promise<void> => {
  try {
    observeApiResponse(
      url,
      decode(new Uint8Array(await response.clone().arrayBuffer())),
      authAtRequest,
      generationAtRequest
    )
  } catch {
    // MessagePackでない応答は多い。ここでは無関係なので黙って捨てる。
  }
}

// PokerChase自身が送っている版数・sessionのエンベロープを、同じ通信から
// 捕獲する。捕獲した値は main world のクロージャに留め、拡張コンテキストへも
// IndexedDBへも渡してはならない（MUST NOT）。
if (OriginalFetch) {
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input)
    if (url?.origin !== REPLAY_API_ORIGIN || (replayConfigReceived && !replayImportEnabled)) {
      return OriginalFetch(input, init)
    }

    // 本文のデコードは非同期。待っている間に無効化→再有効化が起きると、
    // この代入が**旧世代の認証を新しい世代へ復活させてしまう**。デコードを
    // 始めた時点の世代を控え、一致するときだけ反映する（MUST）。
    const generationAtCapture = replayAuthGeneration
    try {
      const captured = readAuthEnvelope(await decodeRequestBody(input, init))
      if (captured && generationAtCapture === replayAuthGeneration) {
        replayAuth = captured
        announceAuthCaptured()
      }
    } catch {
      // MessagePackの本文を持たないリクエストはリプレイの認証と無関係。
    }
    const authAtRequest = replayAuth
    // 応答の判定にも**リクエストを出した時点**の世代を使う（デコード後に
    // 読み直すと、無効化を挟んだリクエストの応答を新世代として受理する）。
    const generationAtRequest = generationAtCapture
    const response = await OriginalFetch(input, init)
    readApiResponse(url, response, authAtRequest, generationAtRequest).catch(() => undefined)
    return response
  }) as typeof window.fetch
}

// Unity WebGL は同じAPI呼び出しに fetch ではなく XMLHttpRequest を使うことが
// ある。エンベロープの観測を同じようにこちらにも置く。リクエスト自体は素の
// ブラウザ実装をそのまま通す（傍受で書き換えない）。
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

const readApiXhrResponse = async (
  url: URL,
  xhr: XMLHttpRequest,
  authAtRequest: ReplayAuthEnvelope | undefined,
  generationAtRequest: number
): Promise<void> => {
  try {
    const response = xhr.response
    let decoded: unknown
    if (response instanceof ArrayBuffer) decoded = decode(new Uint8Array(response))
    else if (ArrayBuffer.isView(response)) decoded = decode(new Uint8Array(response.buffer, response.byteOffset, response.byteLength))
    else if (response instanceof Blob) decoded = decode(new Uint8Array(await response.arrayBuffer()))
    else return
    observeApiResponse(url, decoded, authAtRequest, generationAtRequest)
  } catch {
    // MessagePackでないXHR応答はリプレイの認証と無関係。
  }
}

XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null): void {
  const url = xhrUrls.get(this)
  if (url?.origin === REPLAY_API_ORIGIN && (!replayConfigReceived || replayImportEnabled)) {
    // このリクエスト自身のエンベロープは`send`の**後**に非同期で確定するので、
    // `send`時点の`replayAuth`（＝前のリクエストの版）を控えると、応答時には
    // 必ず不一致になってsessionの回転が止まる。捕獲の完了を待って、その時点の
    // 版を控える。
    let authAtRequest: ReplayAuthEnvelope | undefined = replayAuth
    const generationAtRequest = replayAuthGeneration
    // fetch経路と同じ理由で、デコード開始時点の世代を控えて照合する。
    const generationAtCapture = replayAuthGeneration
    const captured = body instanceof Document
      ? Promise.resolve()
      : decodeBody(body)
        .then(decoded => {
          const envelope = readAuthEnvelope(decoded)
          if (envelope && generationAtCapture === replayAuthGeneration) {
            replayAuth = envelope
            announceAuthCaptured()
          }
          authAtRequest = replayAuth
        })
        .catch(() => undefined)
    this.addEventListener('loadend', () => {
      captured
        .then(() => readApiXhrResponse(url, this, authAtRequest, generationAtRequest))
        .catch(() => undefined)
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

const pageState = window as unknown as Record<PropertyKey, unknown>
const isPageOutsideSession = (): boolean =>
  pageState[REPLAY_PAGE_SESSION_ACTIVITY_KEY] === 'inactive'

let activeReplayController: AbortController | undefined
let currentServiceWorkerEpoch: string | undefined
let auxiliaryCancelGeneration = 0

/** SWが消えてもpage worldに残るHTTPを、このページ自身で停止する。 */
const cancelAllReplayRequests = (): void => {
  activeReplayController?.abort()
}

/**
 * 新しいSWの依頼を受けた時点で旧SW世代を失効させる補助ガード。
 * 公平性の第一防衛線はpage activityであり、epochはSW再起動時の所有権分離と
 * 孤児HTTPの短縮だけを担う。
 * 旧世代のHTTPは中断し、遅れて完了しても結果を転送しない（MUST NOT）。
 */
const adoptServiceWorkerEpoch = (epoch: string): void => {
  if (currentServiceWorkerEpoch === epoch) return
  cancelAllReplayRequests()
  currentServiceWorkerEpoch = epoch
}

const fetchReplayDetail = async (
  handId: number
): Promise<ReplayFetchItemResult> => {
  if (!OriginalFetch) return { handId, ok: false, error: 'fetch-unavailable', retryable: false }
  const auth = replayAuth
  if (!auth) return { handId, ok: false, error: 'auth-envelope-unavailable', retryable: true }

  const controller = new AbortController()
  activeReplayController = controller
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
    // 応答が返る間に設定が変わっていれば書き戻さない。
    //
    // 「消えていないこと」だけでは足りない: 無効化→再有効化で新しいエンベロープ
    // を捕獲した後に旧リクエストが完了すると、旧応答の `session` を新しい
    // エンベロープへ混ぜてしまう（アカウント切替を伴えば別アカウントの
    // セッションが混じる）。エンベロープは捕獲のたびに丸ごと差し替えるので、
    // 参照が同一かどうかで「このリクエストを出したときのまま」を判定できる。
    if (replayAuth === auth && typeof decoded === 'object' && decoded !== null &&
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
    if (activeReplayController === controller) activeReplayController = undefined
  }
}

const postVerificationResult = (
  request: ReplayVerificationRequest,
  outcome:
    | { ok: true, entitlement: { cardOpenEndDate: number, isExpiredCardOpen: boolean } }
    | { ok: false, error: string, retryable: boolean }
): void => {
  window.postMessage({
    type: REPLAY_BRIDGE_VERIFY_RESULT,
    epoch: request.epoch,
    requestId: request.requestId,
    ...outcome
  }, POKER_CHASE_ORIGIN)
}

/**
 * 公開オプトインの資格確認。1回の呼び出しにつき`/replay/list`を1本だけ送る。
 * `BattleType`ごとにHandListは異なるが、プレミアムパスの期限は応答エンベロープ共通
 * なので、検証ではカテゴリ0を使う。
 *
 * この1本にも `/replay/detail` と**同じ公平性ゲートを掛ける**（MUST）:
 * epoch照合・補助CANCEL世代・page activityの三値ゲート（`unknown`もfail-closed）
 * を、HTTPの前と応答の後の両方で見る。AbortControllerも同じ
 * `activeReplayController` へ載せ、WSがACTIVEを観測した瞬間の自律abortが
 * 検証にもそのまま効くようにする。
 */
const verifyReplayAccess = async (
  request: ReplayVerificationRequest,
  queuedCancelGeneration: number
): Promise<void> => {
  const isStale = (): boolean =>
    currentServiceWorkerEpoch !== request.epoch ||
    queuedCancelGeneration !== auxiliaryCancelGeneration ||
    !replayImportEnabled
  if (isStale()) return
  // `unknown`もfail-closed。対局中・状態不明では検証も撃たない。依頼元は
  // これを`pending-session`として記録し、次の取得サイクルで撃ち直す。
  if (!isPageOutsideSession()) {
    postVerificationResult(request, {
      ok: false,
      error: REPLAY_VERIFY_IN_SESSION,
      retryable: true
    })
    return
  }
  const auth = replayAuth
  const generationAtRequest = replayAuthGeneration
  if (!OriginalFetch || !auth) {
    postVerificationResult(request, {
      ok: false,
      error: !OriginalFetch ? 'fetch-unavailable' : REPLAY_VERIFY_NO_AUTH,
      retryable: true
    })
    return
  }

  const controller = new AbortController()
  activeReplayController = controller
  const timer = setTimeout(() => controller.abort(), REPLAY_FETCH_TIMEOUT_MS)
  try {
    const response = await OriginalFetch(REPLAY_LIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/msgpack' },
      signal: controller.signal,
      body: encode({
        param: { BattleType: 0 },
        ...auth,
        requestKey: crypto.randomUUID()
      })
    })
    if (!response.ok) {
      const retryable = response.status === 401 || response.status === 408 ||
        response.status === 429 || response.status >= 500
      postVerificationResult(request, {
        ok: false,
        error: `HTTP ${response.status}`,
        retryable
      })
      return
    }
    const decoded = decode(new Uint8Array(await response.arrayBuffer()))
    if (generationAtRequest !== replayAuthGeneration) {
      postVerificationResult(request, {
        ok: false,
        error: 'stale-auth-generation',
        retryable: true
      })
      return
    }
    if (replayAuth === auth && typeof decoded === 'object' && decoded !== null &&
      'session' in decoded && typeof decoded.session === 'string') {
      replayAuth = { ...auth, session: decoded.session }
    }
    // 応答が返る間に対局が始まっていたら、資格の判定結果も返さない（MUST）。
    // 返すと依頼元が`verified`を書き、その周回の取得判定が対局中のまま真になる。
    if (isStale()) return
    if (!isPageOutsideSession()) {
      postVerificationResult(request, {
        ok: false,
        error: REPLAY_VERIFY_IN_SESSION,
        retryable: true
      })
      return
    }
    const rejection = readEnvelopeRejection(decoded)
    const ledger = readReplayLedger(decoded)
    if (rejection || !ledger) {
      postVerificationResult(request, {
        ok: false,
        error: rejection?.error ?? 'malformed-response',
        retryable: rejection?.retryable ?? false
      })
      return
    }
    postVerificationResult(request, {
      ok: true,
      entitlement: {
        cardOpenEndDate: ledger.cardOpenEndDate,
        isExpiredCardOpen: ledger.isExpiredCardOpen
      }
    })
  } catch (error) {
    if (isStale()) return
    postVerificationResult(request, {
      ok: false,
      error: isPageOutsideSession() ? errorMessage(error) : REPLAY_VERIFY_IN_SESSION,
      retryable: true
    })
  } finally {
    clearTimeout(timer)
    if (activeReplayController === controller) activeReplayController = undefined
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

const postEmptyReplayResult = (message: ReplayFetchRequest): void => {
  window.postMessage({
    type: REPLAY_BRIDGE_RESULT,
    epoch: message.epoch,
    requestId: message.requestId,
    results: []
  }, POKER_CHASE_ORIGIN)
}

const handleReplayFetch = async (
  message: ReplayFetchRequest,
  queuedCancelGeneration: number
): Promise<void> => {
  const epoch = message.epoch
  if (currentServiceWorkerEpoch !== epoch) return
  if (queuedCancelGeneration !== auxiliaryCancelGeneration) {
    postEmptyReplayResult(message)
    return
  }

  // `unknown`もfail-closed。WARがbridge注入前から残した状態を読むので、
  // content scriptに滞留した旧依頼が対局中にflushされてもHTTPは発行しない。
  if (!isPageOutsideSession()) {
    window.postMessage({
      type: REPLAY_BRIDGE_RESULT,
      epoch,
      requestId: message.requestId,
      results: []
    }, POKER_CHASE_ORIGIN)
    return
  }
  const handIds = message.handIds
    .filter(isPositiveHandId)
    .slice(0, REPLAY_FETCH_BATCH_LIMIT)
  // 依頼元のタイマーを「先行バッチの待ち」から「自分のバッチの所要」へ
  // 切り替えさせる。逐次キューで待たされていた時間を期限に含めないため。
  window.postMessage({
    type: REPLAY_BRIDGE_STARTED,
    epoch,
    requestId: message.requestId
  }, POKER_CHASE_ORIGIN)

  const results: ReplayFetchItemResult[] = []
  for (const handId of handIds) {
    // 各件の前に再確認する。無効化は次の1件から効く必要があり、バッチ完了まで
    // 最大99件を撃ち続けてはいけない。
    if (!replayImportEnabled || currentServiceWorkerEpoch !== epoch ||
      queuedCancelGeneration !== auxiliaryCancelGeneration ||
      !isPageOutsideSession()) break
    // 先頭は待たない。1件だけの取得は従来どおり即座に走る。
    if (results.length > 0) {
      await delay(REPLAY_FETCH_INTERVAL_MS)
      // 待機の**後**にも確認する（MUST）。間隔待ちの最中に無効化されると、
      // 上のチェックは通過済みなので `fetchReplayDetail` が呼ばれ、
      // 資格情報が消えている分だけ偽の `auth-envelope-unavailable`
      // （retryable）が結果に積まれる。
      if (!replayImportEnabled || currentServiceWorkerEpoch !== epoch ||
        queuedCancelGeneration !== auxiliaryCancelGeneration ||
        !isPageOutsideSession()) break
    }
    const result = await fetchReplayDetail(handId)
    if (currentServiceWorkerEpoch !== epoch ||
      queuedCancelGeneration !== auxiliaryCancelGeneration ||
      !isPageOutsideSession()) break
    results.push(result)
  }
  if (currentServiceWorkerEpoch !== epoch) return
  if (queuedCancelGeneration !== auxiliaryCancelGeneration) {
    postEmptyReplayResult(message)
    return
  }
  window.postMessage({
    type: REPLAY_BRIDGE_RESULT,
    epoch,
    requestId: message.requestId,
    // セッション開始がfetch完了と競合してもpage境界を越えてdetailを返さない。
    results: isPageOutsideSession() ? results : []
  }, POKER_CHASE_ORIGIN)
}

window.addEventListener(REPLAY_PAGE_SESSION_ACTIVITY_EVENT, () => {
  // 常時注入WARが同一pageのtrusted WSからactivityを先に更新する。
  // SWやcontent scriptの補助CANCELへ依存せず、ACTIVE化と同時に自律abortする。
  if (!isPageOutsideSession()) {
    // controllerだけでなく既にpage queueへ入った全旧依頼を無効化する。fetchが
    // AbortSignalを無視して遅延成功しても、次のinactive後に復活させない（MUST）。
    auxiliaryCancelGeneration += 1
    cancelAllReplayRequests()
  }
})

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window || event.origin !== POKER_CHASE_ORIGIN ||
    typeof event.data !== 'object' || event.data === null) return

  if (!('type' in event.data)) return

  if (event.data.type === REPLAY_BRIDGE_CANCEL) {
    // SW経由はクロスタブ等の補助線。既にpage queueへ入った全旧依頼を世代で
    // 無効化し、現在の1本を止める。request mapやepoch照合は持たない。
    auxiliaryCancelGeneration += 1
    cancelAllReplayRequests()
    return
  }

  if (event.data.type === REPLAY_BRIDGE_CONFIG) {
    const message = event.data as ReplayBridgeConfigMessage
    replayConfigReceived = true
    replayImportEnabled = message.enabled === true
    // 無効化は `<script>` を取り消せない代わりのランタイム縮退。傍受を素通しに
    // 戻し（`replayConfigReceived && !replayImportEnabled` で fetch/XHR が
    // OriginalFetch/OriginalXhr を素通しする）、捕獲済みエンベロープを破棄する。
    if (!replayImportEnabled) {
      // 無効化＝資格情報の破棄。ここで世代を進めることで、無効化を挟んで
      // 完了する古い応答（アカウント切替を伴いうる）を確実に切り離す。
      replayAuth = undefined
      replayAuthGeneration += 1
      replayAuthAnnounced = false
    }
    return
  }
  if (event.data.type === REPLAY_BRIDGE_VERIFY && replayImportEnabled) {
    const message = event.data as Partial<ReplayVerificationRequest>
    if (typeof message.epoch !== 'string' || typeof message.requestId !== 'string') return
    const request = message as ReplayVerificationRequest
    // 詳細取得と**同じ入口の形**にする。ACTIVE/unknown中の依頼はキューへ入れず
    // 即答し、SW側の待ちを`pending-session`として解放する。
    if (!isPageOutsideSession()) {
      cancelAllReplayRequests()
      postVerificationResult(request, {
        ok: false,
        error: REPLAY_VERIFY_IN_SESSION,
        retryable: true
      })
      return
    }
    adoptServiceWorkerEpoch(request.epoch)
    const queuedVerifyCancelGeneration = auxiliaryCancelGeneration
    // 検証を**同じ逐次キュー**へ載せる（MUST）。別経路にすると`/replay/list`と
    // `/replay/detail`が同時に飛び、`REPLAY_FETCH_INTERVAL_MS`の間隔制御が
    // 効かなくなる。依頼元も同じ`dispatchQueue`で直列化しているので、この
    // キューで待たされるのは高々1件。
    replayFetchQueue = replayFetchQueue
      .then(() => verifyReplayAccess(request, queuedVerifyCancelGeneration))
      .catch(error => console.warn('[experimental-replay] Replay verification failed:', error))
    return
  }
  if (event.data.type !== REPLAY_BRIDGE_FETCH || !replayImportEnabled) return
  const message = event.data as Partial<ReplayFetchRequest>
  if (typeof message.epoch !== 'string' || typeof message.requestId !== 'string' ||
    !Array.isArray(message.handIds)) return
  // ACTIVE/unknown中の依頼はキューへも入れず即時空応答し、SW側pendingを解放する。
  // 未送信だった旧epoch依頼が遅れて届いても、現epochの所有権は動かさない。
  if (!isPageOutsideSession()) {
    cancelAllReplayRequests()
    postEmptyReplayResult(message as ReplayFetchRequest)
    return
  }
  adoptServiceWorkerEpoch(message.epoch)
  const queuedCancelGeneration = auxiliaryCancelGeneration
  replayFetchQueue = replayFetchQueue
    .then(() => handleReplayFetch(
      message as ReplayFetchRequest,
      queuedCancelGeneration
    ))
    .catch(error => console.warn('[experimental-replay] Replay fetch batch failed:', error))
})
