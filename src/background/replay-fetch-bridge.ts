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
 */
import { connectedPorts } from './ports'
import {
  REPLAY_FETCH_BATCH_LIMIT,
  REPLAY_PORT_FETCH,
  REPLAY_PORT_RESULT,
  isPositiveHandId,
  type ReplayFetchItemResult,
  type ReplayFetchResult
} from '../replay/protocol'

/**
 * 1リクエストの上限。ページ側は逐次POSTで1件15秒の上限を持つので、
 * 100件が全て最悪ケースを踏むと25分になる。手で叩く入口なので、
 * 待たされ続けるより打ち切って部分結果を返す方が使える。
 */
const REPLAY_REQUEST_TIMEOUT_MS = 120_000

interface PendingRequest {
  port: chrome.runtime.Port
  resolve: (results: ReplayFetchItemResult[]) => void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, PendingRequest>()

let requestSequence = 0

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
 * 接続中のゲームタブへ取得を依頼し、結果を返す。
 * 依頼先は最初に見つかった接続で、タブの選択はしない（開発用のため）。
 */
export const requestReplayDetails = async (
  handIds: unknown
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

  const port = connectedPorts.values().next().value
  if (!port) return { success: false, error: 'no connected game tab' }

  const requestId = `devtools-${++requestSequence}`
  const results = await new Promise<ReplayFetchItemResult[]>(resolve => {
    const timer = setTimeout(() => settle(requestId, []), REPLAY_REQUEST_TIMEOUT_MS)
    pending.set(requestId, { port, resolve, timer })
    try {
      port.postMessage({ type: REPLAY_PORT_FETCH, requestId, handIds })
    } catch (error) {
      settle(requestId, [])
    }
  })

  return { success: true, results }
}

/** テスト用。モジュールスコープの待ち行列を空にする。 */
export const __resetReplayFetchBridgeForTests = (): void => {
  for (const request of pending.values()) clearTimeout(request.timer)
  pending.clear()
  requestSequence = 0
}
