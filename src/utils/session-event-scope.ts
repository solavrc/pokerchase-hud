import type { ApiEvent } from '../types'
import type { BattleType } from '../types'

export type EventSessionScope = Readonly<{
  id: string
  battleType: BattleType
  startedAt: number
}>

/**
 * Parsed live events keep their originating tab's session boundary while
 * travelling through the asynchronous aggregate/write pipeline. A WeakMap
 * intentionally keeps this transport-only metadata out of Raw Event Lake
 * payloads, exports, logs, and schema validation.
 */
const eventSessionScopes = new WeakMap<ApiEvent, EventSessionScope>()

export const setEventSessionScope = (event: ApiEvent, scope: EventSessionScope | undefined): void => {
  if (scope) eventSessionScopes.set(event, { ...scope })
}

export const getEventSessionScope = (event: ApiEvent): EventSessionScope | undefined =>
  eventSessionScopes.get(event)
