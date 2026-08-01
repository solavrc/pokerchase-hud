export const EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY = 'experimentalReplayImportEnabled'
export const REPLAY_DETAIL_URL = 'https://production.api-poker-chase.com/replay/detail'
export const REPLAY_API_ORIGIN = 'https://production.api-poker-chase.com'

export const REPLAY_LIST_PATH = '/replay/list'

export const REPLAY_BRIDGE_CONFIG = 'pokerchase-hud:replay-config'
export const REPLAY_BRIDGE_FETCH = 'pokerchase-hud:replay-fetch'
export const REPLAY_BRIDGE_RESULT = 'pokerchase-hud:replay-result'
export const REPLAY_BRIDGE_LEDGER = 'pokerchase-hud:replay-ledger'
export const REPLAY_PORT_FETCH = 'experimental-replay-fetch'
export const REPLAY_PORT_RESULT = 'experimental-replay-result'
export const REPLAY_PORT_LEDGER = 'experimental-replay-ledger'

export const REPLAY_FETCH_BATCH_LIMIT = 100

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

/** Remove transport credentials before a replay response crosses into the extension. */
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
  /** 手札公開パスの期限（Unix秒）。`0`は未購入。 */
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
 * 台帳としては有効に返す。課金状態の観測はハンドの有無に依存しない。
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
