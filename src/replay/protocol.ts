export const EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY = 'experimentalReplayImportEnabled'
export const REPLAY_DETAIL_URL = 'https://production.api-poker-chase.com/replay/detail'
export const REPLAY_API_ORIGIN = 'https://production.api-poker-chase.com'

export const REPLAY_LIST_PATH = '/replay/list'

export const REPLAY_BRIDGE_CONFIG = 'pokerchase-hud:replay-config'
export const REPLAY_BRIDGE_FETCH = 'pokerchase-hud:replay-fetch'
export const REPLAY_BRIDGE_STARTED = 'pokerchase-hud:replay-started'
export const REPLAY_BRIDGE_RESULT = 'pokerchase-hud:replay-result'
export const REPLAY_BRIDGE_LEDGER = 'pokerchase-hud:replay-ledger'
export const REPLAY_PORT_FETCH = 'experimental-replay-fetch'
export const REPLAY_PORT_STARTED = 'experimental-replay-started'
export const REPLAY_PORT_RESULT = 'experimental-replay-result'
export const REPLAY_PORT_LEDGER = 'experimental-replay-ledger'

export const REPLAY_FETCH_BATCH_LIMIT = 100

/**
 * 1件あたりの応答待ちの上限。これが無いと、応答が返らない1件で逐次取得が
 * 止まり、依頼元にも有効期限が無いため取り込みが恒久停止する。
 */
export const REPLAY_FETCH_TIMEOUT_MS = 15_000

/**
 * 連続取得の間隔（前の応答が返ってから次を出すまで）。
 *
 * ゲーム本体のリプレイ閲覧は1件ずつ人間の操作速度で発生するので、上限の
 * 100件を無間隔で叩くのはサーバから見て明確に異質な流量になる。取得は
 * セッション終了後なのでユーザーの操作を妨げない。
 */
export const REPLAY_FETCH_INTERVAL_MS = 1_500

/**
 * バッチ全体の待ち時間の上限。
 *
 * ページ側は「1件あたり最大 `REPLAY_FETCH_TIMEOUT_MS`」＋「2件目以降は
 * 毎回 `REPLAY_FETCH_INTERVAL_MS` の待ち」で逐次処理するので、依頼元の
 * 上限をこの合計より短くすると**必ず**先に切れる。しかもページ側は
 * バッチ完了時に一括で結果を返す実装なので、切れた場合に得られるのは
 * 部分結果ではなく空配列で、残りのPOSTだけが依頼元不在のまま走り続ける。
 * そのため上限は件数から導出する（100件の最悪ケースで約28分。実際は
 * 応答が即返るので2分半程度）。
 */
export const replayFetchBatchTimeoutMs = (handIdCount: number): number =>
  handIdCount * (REPLAY_FETCH_TIMEOUT_MS + REPLAY_FETCH_INTERVAL_MS) + 5_000

/**
 * 台帳1回あたりの上限。サーバは実測でカテゴリごと最新100件を返すが、
 * 境界側で受け取る配列長は信用せず、余裕を見た値で頭打ちにする。
 */
export const REPLAY_LEDGER_MAX_ENTRIES = 200

export interface ReplayBridgeConfigMessage {
  type: typeof REPLAY_BRIDGE_CONFIG
  enabled: boolean
}

export interface ReplayFetchRequest {
  type: typeof REPLAY_BRIDGE_FETCH | typeof REPLAY_PORT_FETCH
  requestId: string
  handIds: number[]
}

/**
 * ページ側がそのバッチの処理を**実際に開始した**ことの通知。
 *
 * 依頼元はこれを受け取るまで「先行バッチの待ち」、受け取ってからは「自分の
 * バッチの所要」で計る。片方だけで計ると必ずどちらかが足りない ―― 自分の
 * 件数だけでは先行バッチの間隔待ちの最中に切れ、上限件数だけでは先行バッチを
 * 吸収した後の自分の所要が残らない。
 */
export interface ReplayFetchStarted {
  type: typeof REPLAY_BRIDGE_STARTED | typeof REPLAY_PORT_STARTED
  requestId: string
}

export type ReplayFetchItemResult =
  | { handId: number, ok: true, detail: unknown }
  | { handId: number, ok: false, error: string, retryable: boolean }

export interface ReplayFetchResult {
  type: typeof REPLAY_BRIDGE_RESULT | typeof REPLAY_PORT_RESULT
  requestId: string
  results: ReplayFetchItemResult[]
}

export const isPositiveHandId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * リプレイ応答が拡張コンテキストへ渡る前に、輸送用の資格情報を落とす。
 * `session`（回転するセッショントークン）と`requestKey`は境界を越えては
 * ならない（MUST NOT）。
 */
export const sanitizeReplayDetail = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitizeReplayDetail)
  if (!isPlainRecord(value)) return value

  const sanitized: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === 'session' || key === 'requestKey') continue
    sanitized[key] = sanitizeReplayDetail(child)
  }
  return sanitized
}

/** `/replay/list` の1行。サーバ自身が持つ「ヒーローが打ったハンド」の台帳。 */
export interface ReplayLedgerEntry {
  handId: number
  /** ハンド開始時刻（Unix秒）。 */
  startTime: number
  /** そのハンドのヒーローの純増減。ローカルの`netChips`と突き合わせる。 */
  chipDiff: number
}

export interface ReplayLedger {
  battleType: number
  /** サーバが返す期限値（Unix秒）。 */
  cardOpenEndDate: number
  isExpiredCardOpen: boolean
  hands: ReplayLedgerEntry[]
}

export interface ReplayLedgerMessage extends ReplayLedger {
  type: typeof REPLAY_BRIDGE_LEDGER | typeof REPLAY_PORT_LEDGER
}

/**
 * `/replay/list` 応答から台帳を抜き出す。
 *
 * `sanitizeReplayDetail` の除外リスト方式ではなく**許可リスト**で組み立てる。
 * この応答の全フィールドを列挙できていない以上「session と requestKey さえ
 * 落とせば安全」という前提を置けない。必要なものだけを明示的に取り出せば、
 * 未知のフィールドが拡張側へ渡ること自体が構造的に起こらない。
 *
 * 空の`HandList`は正常（窓の中に1ハンドも無いだけ）なので、`hands`が空でも
 * 台帳としては有効に返す。エンベロープ側のフィールドはハンドの有無に依存しない。
 */
export const readReplayLedger = (decoded: unknown): ReplayLedger | undefined => {
  if (!isPlainRecord(decoded)) return undefined
  const param = decoded.param
  if (!isPlainRecord(param) || !Array.isArray(param.HandList)) return undefined

  const hands: ReplayLedgerEntry[] = []
  for (const row of param.HandList.slice(0, REPLAY_LEDGER_MAX_ENTRIES)) {
    if (!isPlainRecord(row) || !isPlainRecord(row.Hand)) continue
    const { HandId, StartTime, ChipDiff } = row.Hand
    if (!isPositiveHandId(HandId)) continue
    if (typeof StartTime !== 'number' || typeof ChipDiff !== 'number') continue
    hands.push({ handId: HandId, startTime: StartTime, chipDiff: ChipDiff })
  }

  return {
    battleType: typeof param.BattleType === 'number' ? param.BattleType : -1,
    cardOpenEndDate: typeof param.CardOpenEndDate === 'number' ? param.CardOpenEndDate : 0,
    isExpiredCardOpen: param.IsExpiredCardOpen === true,
    hands
  }
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
