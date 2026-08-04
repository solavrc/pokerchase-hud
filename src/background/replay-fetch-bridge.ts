/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
/**
 * 開発用の取得入口（既定OFFの実験機能）。
 *
 * ページ側（`web_accessible_resource.ts`）は HandId を渡されれば
 * `/replay/detail` を叩いて sanitize 済みの結果を返せるが、それを依頼する
 * 主体がこのPRには無い。セッション境界を見て自動で依頼する取り込み層は
 * 別PRなので、ここでは **DevToolsから手で叩くための最小の入口**だけを置く。
 *
 * 取り込み層が入ったらこのモジュールは役目を終える（あちらが自前の
 * キューとポート管理で依頼を出す）。それまでの間、取得層を単体で検証・
 * 実験できるようにするのが目的。
 *
 * 保存は一切しない。結果は呼び出し元へ返すだけで、IndexedDBにも
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
  REPLAY_PORT_FETCH,
  REPLAY_PORT_RESULT,
  REPLAY_PORT_STARTED,
  isPositiveHandId,
  replayFetchBatchTimeoutMs,
  type ReplayFetchItemResult,
  type ReplayFetchResult,
  type ReplayFetchStarted
} from '../replay/protocol'

interface PendingRequest {
  port: chrome.runtime.Port
  handIdCount: number
  resolve: (results: ReplayFetchItemResult[]) => void
  timer: ReturnType<typeof setTimeout>
  /** ページ側の開始通知を受けてタイマーを張り直したか（多重発火の抑止）。 */
  started: boolean
}

const pending = new Map<string, PendingRequest>()

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
 * `event-ingestion.ts` のポート受信から、通常のイベント処理より前に呼ぶ。
 *
 * 取り込みキューには載せない: 保存を行わないので耐久性バリアの対象になる
 * 副作用が無く、載せるとライブイベントの処理を待たせるだけになる。
 */
export const handleReplayPortMessage = (
  message: unknown,
  port: chrome.runtime.Port
): boolean => {
  if (typeof message !== 'object' || message === null) return false

  // ページ側がそのバッチの処理を実際に開始した ―― ここで期限を張り直す。
  // 開始前は「先行バッチが最大構成でも待ち切れる長さ」、開始後は「自分の
  // バッチの所要」。片方だけで計ると、自分の件数だけでは先行バッチの
  // 間隔待ちの最中に切れ、上限件数だけでは先行バッチを吸収した後に自分の
  // 所要が残らない。
  if ((message as { type?: unknown }).type === REPLAY_PORT_STARTED) {
    const started = message as Partial<ReplayFetchStarted>
    if (typeof started.requestId !== 'string') return true
    const request = pending.get(started.requestId)
    if (!request || request.port !== port || request.started) return true
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
  if (typeof result.requestId !== 'string' || !Array.isArray(result.results)) return true
  const request = pending.get(result.requestId)
  // 依頼を出したポートからの応答だけを受け取る（別タブの応答で解決しない）
  if (!request || request.port !== port) return true
  settle(result.requestId, result.results as ReplayFetchItemResult[])
  return true
}

/** ポート切断時に、そのポート宛の待ちを空結果で解放する。 */
export const releaseReplayRequestsForPort = (port: chrome.runtime.Port): void => {
  for (const [requestId, request] of pending) {
    if (request.port === port) settle(requestId, [])
  }
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
      pending.set(requestId, { port, handIdCount: handIds.length, resolve, timer, started: false })
      try {
        port.postMessage({ type: REPLAY_PORT_FETCH, requestId, handIds })
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
  dispatchQueue = Promise.resolve()
}
