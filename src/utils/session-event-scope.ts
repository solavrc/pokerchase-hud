import type { ApiEvent, ApiType, Hand, PlayerStats } from '../types'
import type { BattleType } from '../types'
import {
  getRawEventSessionContext,
  type RawEventSessionContext,
} from './raw-event-session-context'

export type EventSessionScope = Readonly<{
  scopeKey?: string
  id: string
  battleType: BattleType
  startedAt: number
  name?: string
  originId?: string
  authorityGeneration?: number
}>

export type ActiveSessionScope = Readonly<{
  scopeKey?: string
  id: string
  startedAt: number
}>

export const isHandInSessionScope = (
  hand: Pick<Hand, 'session' | 'approxTimestamp'>,
  scope: ActiveSessionScope | undefined
): boolean => {
  if (!scope) return false
  // Durable keys are authoritative whenever the Hand has one. Historical
  // Hands created before scope metadata existed have no key, so they retain
  // the legacy session-id/time boundary even when canonical replay restores
  // an active legacy-run/legacy-mtt key for the current session.
  if (hand.session.scopeKey !== undefined) {
    return hand.session.scopeKey === scope.scopeKey
  }
  return hand.session.id === scope.id &&
    Number.isFinite(hand.approxTimestamp) &&
    hand.approxTimestamp! >= scope.startedAt
}

/**
 * Parsed live events keep their originating tab's session boundary while
 * travelling through the asynchronous aggregate/write pipeline. A WeakMap
 * intentionally keeps this transport-only metadata out of Raw Event Lake
 * payloads, exports, logs, and schema validation.
 */
const eventSessionScopes = new WeakMap<ApiEvent, EventSessionScope>()
const lineupSessionScopes = new WeakMap<number[], EventSessionScope>()
const lineupOriginatingDeals = new WeakMap<number[], ApiEvent<ApiType.EVT_DEAL>>()
const statsSessionFilterKeys = new WeakMap<PlayerStats[], string>()
const statsOriginatingDeals = new WeakMap<PlayerStats[], ApiEvent<ApiType.EVT_DEAL>>()

export const setEventSessionScope = (event: ApiEvent, scope: EventSessionScope | undefined): void => {
  if (scope) eventSessionScopes.set(event, { ...scope })
}

export const getEventSessionScope = (event: ApiEvent): EventSessionScope | undefined =>
  eventSessionScopes.get(event) ?? getRawEventSessionContext(event)

export const setLineupSessionScope = (
  seatUserIds: number[],
  scope: EventSessionScope | RawEventSessionContext | undefined,
  originatingDeal?: ApiEvent<ApiType.EVT_DEAL>
): void => {
  if (scope) lineupSessionScopes.set(seatUserIds, {
    scopeKey: scope.scopeKey,
    id: scope.id,
    battleType: scope.battleType,
    startedAt: scope.startedAt,
    name: scope.name,
    originId: scope.originId,
    authorityGeneration: scope.authorityGeneration,
  })
  if (originatingDeal) {
    lineupOriginatingDeals.set(seatUserIds, originatingDeal)
  } else {
    lineupOriginatingDeals.delete(seatUserIds)
  }
}

export const getLineupSessionScope = (seatUserIds: number[]): EventSessionScope | undefined =>
  lineupSessionScopes.get(seatUserIds)

export const getLineupOriginatingDeal = (
  seatUserIds: number[]
): ApiEvent<ApiType.EVT_DEAL> | undefined =>
  lineupOriginatingDeals.get(seatUserIds)

/**
 * A calculated stats array must keep the session boundary that was captured
 * before its asynchronous DB reads started. The service's globally selected
 * scope may change before ports.ts broadcasts the result.
 */
export const setStatsSessionFilterKey = (
  stats: PlayerStats[],
  sessionFilterKey: string | undefined
): void => {
  if (sessionFilterKey !== undefined) statsSessionFilterKeys.set(stats, sessionFilterKey)
}

export const getStatsSessionFilterKey = (stats: PlayerStats[]): string | undefined =>
  statsSessionFilterKeys.get(stats)

export const setStatsOriginatingDeal = (
  stats: PlayerStats[],
  originatingDeal: ApiEvent<ApiType.EVT_DEAL> | undefined
): void => {
  if (originatingDeal) {
    statsOriginatingDeals.set(stats, originatingDeal)
  } else {
    statsOriginatingDeals.delete(stats)
  }
}

export const getStatsOriginatingDeal = (
  stats: PlayerStats[]
): ApiEvent<ApiType.EVT_DEAL> | undefined =>
  statsOriginatingDeals.get(stats)
