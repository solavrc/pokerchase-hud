import type { BattleType } from '../types/game'

export const EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY = 'experimentalReplayImportEnabled'
export const REPLAY_DETAIL_URL = 'https://production.api-poker-chase.com/replay/detail'
export const REPLAY_API_ORIGIN = 'https://production.api-poker-chase.com'

export const REPLAY_BRIDGE_CONFIG = 'pokerchase-hud:replay-config'
export const REPLAY_BRIDGE_FETCH = 'pokerchase-hud:replay-fetch'
export const REPLAY_BRIDGE_RESULT = 'pokerchase-hud:replay-result'
export const REPLAY_PORT_FETCH = 'experimental-replay-fetch'
export const REPLAY_PORT_RESULT = 'experimental-replay-result'

export const REPLAY_FETCH_BATCH_LIMIT = 100

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

export type ExperimentalReplayStatus = 'pending' | 'ready' | 'complete' | 'failed'

export interface ExperimentalReplayRecord {
  handId: number
  sessionKey: string
  sessionId?: string
  battleType?: BattleType
  sessionName?: string
  status: ExperimentalReplayStatus
  queuedAt: number
  updatedAt: number
  attempts: number
  lastAttemptAt?: number
  capturedAt?: number
  lastError?: string
  detail?: unknown
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

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
