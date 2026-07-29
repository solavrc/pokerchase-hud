import type { ApiEvent } from '../types'
import type { BattleType } from '../types'
import {
  getRawEventSessionContext,
  type RawEventSessionContext,
} from './raw-event-session-context'

export type EventSessionScope = Readonly<{
  id: string
  battleType: BattleType
  startedAt: number
  name?: string
}>

/**
 * Parsed live events keep their originating tab's session boundary while
 * travelling through the asynchronous aggregate/write pipeline. A WeakMap
 * intentionally keeps this transport-only metadata out of Raw Event Lake
 * payloads, exports, logs, and schema validation.
 */
const eventSessionScopes = new WeakMap<ApiEvent, EventSessionScope>()
const lineupSessionScopes = new WeakMap<number[], EventSessionScope>()

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
    id: scope.id,
    battleType: scope.battleType,
    startedAt: scope.startedAt,
    name: scope.name,
  })
}

export const getLineupSessionScope = (seatUserIds: number[]): EventSessionScope | undefined =>
  lineupSessionScopes.get(seatUserIds)
