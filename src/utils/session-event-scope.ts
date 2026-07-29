import type { ApiEvent, Hand, PlayerStats } from '../types'
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
  if (scope.scopeKey !== undefined) {
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
const statsSessionFilterKeys = new WeakMap<PlayerStats[], string>()

export const setEventSessionScope = (event: ApiEvent, scope: EventSessionScope | undefined): void => {
  if (scope) eventSessionScopes.set(event, { ...scope })
}

export const getEventSessionScope = (event: ApiEvent): EventSessionScope | undefined =>
  eventSessionScopes.get(event) ?? getRawEventSessionContext(event)

export const setLineupSessionScope = (
  seatUserIds: number[],
  scope: EventSessionScope | RawEventSessionContext | undefined
): void => {
  if (scope) lineupSessionScopes.set(seatUserIds, {
    scopeKey: scope.scopeKey,
    id: scope.id,
    battleType: scope.battleType,
    startedAt: scope.startedAt,
    name: scope.name,
    originId: scope.originId,
  })
}

export const getLineupSessionScope = (seatUserIds: number[]): EventSessionScope | undefined =>
  lineupSessionScopes.get(seatUserIds)

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
