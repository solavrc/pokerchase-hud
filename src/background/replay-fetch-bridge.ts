/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
/**
 * 開発用の取得入口（既定OFFの実験機能）。
 *
 * ページ側ブリッジへの`/replay/list`検証と`/replay/detail`取得を仲介する。
 * 公開取り込み層とDevToolsの手動取得が同じポート・fairness gateを使う。
 *
 * このモジュール自体は保存しない。結果は呼び出し元へ返すだけで、IndexedDBにも
 * chrome.storageにも触れない。
 *
 * 起動口は `chrome.runtime.sendMessage` ではなくService Workerのグローバル。
 * sendMessageは**送信元自身のonMessageには配送されない**ため、SWのDevTools
 * コンソールから叩くと "Could not establish connection. Receiving end does
 * not exist." になる（このファイルの唯一の想定利用者はSWコンソール）。
 */
import { connectedPorts } from './ports'
import { getActivePort, isActivePortOutsideSession } from './active-port'
import {
  REPLAY_FETCH_BATCH_LIMIT,
  REPLAY_PORT_CANCEL,
  REPLAY_PORT_FETCH,
  REPLAY_PORT_RESULT,
  REPLAY_PORT_STARTED,
  REPLAY_PORT_VERIFY,
  REPLAY_PORT_VERIFY_RESULT,
  REPLAY_FETCH_TIMEOUT_MS,
  REPLAY_VERIFY_IN_SESSION,
  isPositiveHandId,
  replayFetchBatchTimeoutMs,
  type ReplayFetchItemResult,
  type ReplayFetchResult,
  type ReplayFetchStarted,
  type ReplayEntitlement,
  type ReplayVerificationResult
} from '../replay/protocol'

interface PendingRequest {
  port: chrome.runtime.Port
  epoch: string
  handIdCount: number
  resolve: (results: ReplayFetchItemResult[]) => void
  timer: ReturnType<typeof setTimeout>
  /** ページ側の開始通知を受けてタイマーを張り直したか（多重発火の抑止）。 */
  started: boolean
}

const pending = new Map<string, PendingRequest>()

/** MV3 Service Workerの起動世代。再起動すると必ず変わる。 */
const serviceWorkerEpoch = crypto.randomUUID()

interface PendingVerification {
  port: chrome.runtime.Port
  epoch: string
  resolve: (outcome: ReplayVerificationOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingVerifications = new Map<string, PendingVerification>()

/** ページ側のキューに合わせて依頼を直列化する。 */
let dispatchQueue: Promise<void> = Promise.resolve()

const settle = (requestId: string, results: ReplayFetchItemResult[]): void => {
  const request = pending.get(requestId)
  if (!request) return
  pending.delete(requestId)
  clearTimeout(request.timer)
  request.resolve(results)
}

/**
 * ポートに届いたメッセージがこのモジュール宛なら処理して`true`を返す。
 * `event-ingestion.ts`の共通取り込みキュー内で呼ぶ。RESULTのsettleは、それを
 * 待つ取り込み処理を90001の書き込みへ進めうるため、先行する201/303/308の
 * activity更新より前へ迂回させてはならない（MUST NOT）。
 */
export const handleReplayPortMessage = (
  message: unknown,
  port: chrome.runtime.Port
): boolean => {
  if (typeof message !== 'object' || message === null) return false

  if ((message as { type?: unknown }).type === REPLAY_PORT_VERIFY_RESULT) {
    const result = message as Partial<ReplayVerificationResult>
    if (typeof result.requestId !== 'string' || typeof result.epoch !== 'string' ||
      typeof result.ok !== 'boolean') return true
    const request = pendingVerifications.get(result.requestId)
    // 詳細取得のRESULTと同じ世代照合を掛ける（MUST）。旧SW世代の`/replay/list`
    // 応答が再接続後のポート経由で届いても、新SWの状態機械へは入れない。
    if (!request || request.port !== port || request.epoch !== result.epoch ||
      result.epoch !== serviceWorkerEpoch) return true
    pendingVerifications.delete(result.requestId)
    clearTimeout(request.timer)
    if (result.ok && result.entitlement) {
      request.resolve({ success: true, entitlement: result.entitlement as ReplayEntitlement })
    } else {
      request.resolve({
        success: false,
        error: 'error' in result && typeof result.error === 'string'
          ? result.error
          : 'malformed-response'
      })
    }
    return true
  }

  // ページ側がそのバッチの処理を実際に開始した ―― ここで期限を張り直す。
  // 開始前は「先行バッチが最大構成でも待ち切れる長さ」、開始後は「自分の
  // バッチの所要」。片方だけで計ると、自分の件数だけでは先行バッチの
  // 間隔待ちの最中に切れ、上限件数だけでは先行バッチを吸収した後に自分の
  // 所要が残らない。
  if ((message as { type?: unknown }).type === REPLAY_PORT_STARTED) {
    const started = message as Partial<ReplayFetchStarted>
    if (typeof started.requestId !== 'string' || typeof started.epoch !== 'string') return true
    const request = pending.get(started.requestId)
    if (!request || request.port !== port || request.epoch !== started.epoch ||
      started.epoch !== serviceWorkerEpoch || request.started) return true
    request.started = true
    clearTimeout(request.timer)
    request.timer = setTimeout(
      () => settle(started.requestId as string, []),
      replayFetchBatchTimeoutMs(request.handIdCount)
    )
    return true
  }

  if ((message as { type?: unknown }).type !== REPLAY_PORT_RESULT) return false

  const result = message as Partial<ReplayFetchResult>
  if (typeof result.requestId !== 'string' || typeof result.epoch !== 'string' ||
    !Array.isArray(result.results)) return true
  const request = pending.get(result.requestId)
  // 依頼を出したポートからの応答だけを受け取る（別タブの応答で解決しない）
  if (!request || request.port !== port || request.epoch !== result.epoch ||
    result.epoch !== serviceWorkerEpoch) return true
  settle(result.requestId, result.results as ReplayFetchItemResult[])
  return true
}

/** ポート切断時に、そのポート宛の待ちを空結果で解放する。 */
export const releaseReplayRequestsForPort = (port: chrome.runtime.Port): void => {
  for (const [requestId, request] of pending) {
    if (request.port === port) settle(requestId, [])
  }
  for (const [requestId, request] of pendingVerifications) {
    if (request.port !== port) continue
    pendingVerifications.delete(requestId)
    clearTimeout(request.timer)
    request.resolve({ success: false, error: 'game tab disconnected' })
  }
}

export type ReplayVerificationOutcome =
  | { success: true, entitlement: ReplayEntitlement }
  | { success: false, error: string }

/**
 * 公開オプトインの検証（`/replay/list` 1本）をACTIVEゲームタブへ依頼する。
 *
 * 検証も**詳細取得と同じ経路**を通す（MUST）。この1本は課金確認であって
 * サーバから見れば同じAPIの追加トラフィックであり、対局中に撃てば詳細取得と
 * 同じ公平性の問題になる。したがって:
 *
 * - `isActivePortOutsideSession()` の三値ゲートを、`dispatchQueue` を待った
 *   **後**（＝実際のpostMessage直前）にも取り直す。token未生成・unknown・
 *   reconnect猶予はすべて対局中扱いで撃たない
 * - 依頼先は現在のACTIVEポートだけ。「ACTIVE tokenが無いときは接続中の
 *   任意のポートを使う」という緩和は置けない ―― token未生成は上のゲートで
 *   既に不可であり、緩和を書くと到達しないうえに不変条件と矛盾する
 * - `epoch` を載せ、ページ側の逐次キュー・自律abortに詳細取得と同じ形で乗る
 * - 依頼の直列化も同じ `dispatchQueue`。並列に撃つと、ページ側の間隔制御を
 *   跨いで `/replay/list` と `/replay/detail` が同時に飛ぶ
 */
export const requestReplayVerification = async (
  targetPort: chrome.runtime.Port
): Promise<ReplayVerificationOutcome> => {
  const slot = dispatchQueue
  let releaseSlot!: () => void
  dispatchQueue = new Promise<void>(resolve => { releaseSlot = resolve })
  await slot
  try {
    if (!isActivePortOutsideSession()) {
      return { success: false, error: REPLAY_VERIFY_IN_SESSION }
    }
    const activePort = getActivePort()
    const port = activePort && connectedPorts.has(activePort) &&
      activePort === targetPort
      ? activePort
      : undefined
    if (!port) return { success: false, error: 'no active game tab' }

    const requestId = `replay-verify-${crypto.randomUUID()}`
    return await new Promise<ReplayVerificationOutcome>(resolve => {
      const timer = setTimeout(() => {
        pendingVerifications.delete(requestId)
        resolve({ success: false, error: 'verification timeout' })
      }, REPLAY_FETCH_TIMEOUT_MS + 5_000)
      pendingVerifications.set(requestId, {
        port,
        epoch: serviceWorkerEpoch,
        resolve,
        timer
      })
      try {
        port.postMessage({
          type: REPLAY_PORT_VERIFY,
          epoch: serviceWorkerEpoch,
          requestId
        })
      } catch {
        pendingVerifications.delete(requestId)
        clearTimeout(timer)
        resolve({ success: false, error: 'game tab disconnected' })
      }
    })
  } finally {
    releaseSlot()
  }
}

/**
 * 保存・dedup後に新規と確定したセッション開始、またはraw保存失敗時の
 * fail-closed開始を全game pageへ知らせる補助線。
 * 同一pageの公平性はWARのactivity gateが自律的に守る。この通知はクロスタブや
 * SW再起動境界の孤児HTTPを短縮し、content側に未送信の依頼も破棄するだけで、
 * 保存可否の根拠にはしない。
 */
export const cancelReplayRequestsForSessionStart = (): number => {
  for (const port of connectedPorts) {
    try {
      port.postMessage({ type: REPLAY_PORT_CANCEL })
    } catch {
      // 切断済みportは通常のdisconnect処理が回収する。
    }
  }
  const cancelled = pending.size + pendingVerifications.size
  for (const requestId of [...pending.keys()]) settle(requestId, [])
  // 進行中の`/replay/list`検証も同じ契機で畳む（MUST）。検証だけ残すと、
  // 対局が始まった後に返る応答で`verified`を書き、その周回の取得判定が
  // 対局中のまま真になる。
  for (const [requestId, request] of [...pendingVerifications]) {
    pendingVerifications.delete(requestId)
    clearTimeout(request.timer)
    request.resolve({ success: false, error: REPLAY_VERIFY_IN_SESSION })
  }
  return cancelled
}

export type ReplayFetchOutcome =
  | { success: true, results: ReplayFetchItemResult[] }
  | { success: false, error: string }

/**
 * ACTIVEゲームタブへ取得を依頼し、結果を返す。
 */
export const requestReplayDetails = async (
  handIds: unknown,
  targetPort?: chrome.runtime.Port
): Promise<ReplayFetchOutcome> => {
  if (!Array.isArray(handIds) || handIds.length === 0) {
    return { success: false, error: 'handIds must be a non-empty array' }
  }
  if (handIds.length > REPLAY_FETCH_BATCH_LIMIT) {
    return { success: false, error: `handIds exceeds ${REPLAY_FETCH_BATCH_LIMIT}` }
  }
  if (!handIds.every(isPositiveHandId)) {
    return { success: false, error: 'handIds must be positive safe integers' }
  }

  // ページ側は `replayFetchQueue` で依頼を直列化するので、こちらも直列化して
  // **自分の番が来てから**タイマーを開始する。送信時点で自分の件数だけを見て
  // 起動すると、先行バッチの間隔待ちで自分がまだ1件も送られていないうちに
  // 期限切れになり、空結果を返した後で依頼元不在のPOSTが走る。
  const slot = dispatchQueue
  let releaseSlot!: () => void
  dispatchQueue = new Promise<void>(resolve => { releaseSlot = resolve })
  await slot
  try {
    // ポートの選択は**待った後**。待っている間にタブが再読み込みされると、
    // 待つ前に掴んだポートは切断済みになる。しかもこの依頼はまだ`pending`に
    // 載っていないので切断時の解放対象にもならず、再接続済みのポートが
    // 在るのに空結果を返してしまう。
    // 取り込み層から指定された依頼先も、現在のACTIVEポートと一致するときだけ
    // 使う（MUST）。queue待ち中のhandover後に旧portへ投げると、account違いの
    // `2302`で再試行不能として永久に捨ててしまうため。
    // fairness gateも実際のpostMessage直前に再確認する（MUST）。取り込み層の
    // canFetchNowを通った後、dispatchQueue待ちの間に次sessionが始まりうる。
    if (!isActivePortOutsideSession()) {
      return { success: false, error: 'active game session' }
    }
    const activePort = getActivePort()
    const port = activePort && connectedPorts.has(activePort) &&
      (!targetPort || targetPort === activePort)
      ? activePort
      : undefined
    if (!port) return { success: false, error: 'no active game tab' }

  // 連番ではなくUUID。連番はService Workerの再起動ごとに0へ戻るが、ページ側の
  // 逐次キューと進行中のHTTP取得はページが生きている限り継続する。旧SWの
  // `devtools-1` が処理中にSWが落ち、新SWが同じ番号で依頼を出すと、旧バッチの
  // 応答が再接続後のポート経由で届いて新しい待ちを誤って解決し、別のHandIdの
  // 結果が返る。
    const requestId = `devtools-${crypto.randomUUID()}`
    const results = await new Promise<ReplayFetchItemResult[]>(resolve => {
        // 開始通知が来るまでの期限。`dispatchQueue` はSW再起動で空へ戻る一方、
      // タブ側の `replayFetchQueue` は旧バッチを処理し続けるので、先行バッチが
      // 最大構成でも待ち切れる長さを取る。開始通知を受けたら
      // `handleReplayPortMessage` が自分の件数で張り直す。
      const timer = setTimeout(
        () => settle(requestId, []),
        replayFetchBatchTimeoutMs(REPLAY_FETCH_BATCH_LIMIT)
      )
      pending.set(requestId, {
        port,
        epoch: serviceWorkerEpoch,
        handIdCount: handIds.length,
        resolve,
        timer,
        started: false
      })
      try {
        port.postMessage({
          type: REPLAY_PORT_FETCH,
          epoch: serviceWorkerEpoch,
          requestId,
          handIds
        })
      } catch (error) {
        settle(requestId, [])
      }
    })

    return { success: true, results }
  } finally {
    releaseSlot()
  }
}

/**
 * Service Workerのグローバルへ取得関数を生やす。
 * DevToolsコンソールから `await pokerChaseReplayFetch([258411144])` で叩く。
 */
export const exposeReplayFetchForDevtools = (): void => {
  ;(globalThis as unknown as Record<string, unknown>).pokerChaseReplayFetch =
    requestReplayDetails
}

/** テスト用。モジュールスコープの待ち行列を空にする。 */
export const __resetReplayFetchBridgeForTests = (): void => {
  for (const request of pending.values()) clearTimeout(request.timer)
  pending.clear()
  for (const request of pendingVerifications.values()) clearTimeout(request.timer)
  pendingVerifications.clear()
  dispatchQueue = Promise.resolve()
}
