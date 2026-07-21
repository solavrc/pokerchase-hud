import type { PokerChaseDB } from '../db/poker-chase-db'
import type { ApiEvent } from '../types/api'

export const API_EVENT_PRIMARY_KEY = '[timestamp+ApiTypeId+sequence]'
export const API_EVENT_TIMESTAMP_TYPE_INDEX = '[timestamp+ApiTypeId]'

export type ApiEventKey = [timestamp: number, apiTypeId: number, sequence: number]

export type RawApiEvent = Record<string, unknown> & {
  timestamp: number
  ApiTypeId: number
  sequence?: number
}

export interface MergeApiEventsResult {
  added: RawApiEvent[]
  duplicates: number
}

export const getApiEventSequence = (event: { sequence?: unknown }): number =>
  typeof event.sequence === 'number' && Number.isSafeInteger(event.sequence) && event.sequence >= 0
    ? event.sequence
    : 0

export const getApiEventKey = (event: RawApiEvent): ApiEventKey => [
  event.timestamp,
  event.ApiTypeId,
  getApiEventSequence(event)
]

export const compareApiEventKeys = (a: RawApiEvent, b: RawApiEvent): number =>
  a.timestamp - b.timestamp ||
  a.ApiTypeId - b.ApiTypeId ||
  getApiEventSequence(a) - getApiEventSequence(b)

/**
 * Stable content identity for reconnect/import/cloud deduplication.
 *
 * `sequence` is storage metadata, not part of the wire payload. Two rows that
 * differ only by sequence are therefore the same event. Object keys are sorted
 * recursively so a Firestore decode or legacy export with a different property
 * order still compares equal to the original WebSocket object.
 */
export const getApiEventContentIdentity = (event: RawApiEvent): string => {
  const canonicalize = (value: unknown, omitSequence: boolean): unknown => {
    if (Array.isArray(value)) return value.map(item => canonicalize(item, false))
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>
      const result: Record<string, unknown> = {}
      for (const key of Object.keys(record).sort()) {
        if (omitSequence && key === 'sequence') continue
        result[key] = canonicalize(record[key], false)
      }
      return result
    }
    return value
  }

  return JSON.stringify(canonicalize(event, true))
}

/**
 * Merge raw events into the Lake without conflating key collisions with true
 * duplicates.
 *
 * Sequence allocation is scoped to one `(timestamp, ApiTypeId)` group. A
 * valid sequence supplied by a new-format export/cloud document is preserved
 * when that slot is free; legacy rows without one receive the next free value
 * (0 for the first row). Identical payloads are skipped before allocation.
 * The indexed lookup and writes share one transaction, so live ingestion,
 * import and cloud restore cannot race each other into the same sequence.
 */
export async function mergeApiEvents(
  db: PokerChaseDB,
  inputEvents: RawApiEvent[]
): Promise<MergeApiEventsResult> {
  if (inputEvents.length === 0) return { added: [], duplicates: 0 }

  return await db.transaction('rw', db.apiEvents, async () => {
    const groupKeys = [...new Map(
      inputEvents.map(event => [`${event.timestamp}\u0000${event.ApiTypeId}`, [event.timestamp, event.ApiTypeId] as [number, number]])
    ).values()]

    const existing = await db.apiEvents
      .where(API_EVENT_TIMESTAMP_TYPE_INDEX)
      .anyOf(groupKeys)
      .toArray() as unknown as RawApiEvent[]

    const groups = new Map<string, RawApiEvent[]>()
    for (const event of existing) {
      const groupKey = `${event.timestamp}\u0000${event.ApiTypeId}`
      const group = groups.get(groupKey) ?? []
      group.push(event)
      groups.set(groupKey, group)
    }

    const added: RawApiEvent[] = []
    let duplicates = 0

    for (const input of inputEvents) {
      const groupKey = `${input.timestamp}\u0000${input.ApiTypeId}`
      const group = groups.get(groupKey) ?? []
      const identity = getApiEventContentIdentity(input)

      if (group.some(event => getApiEventContentIdentity(event) === identity)) {
        duplicates++
        continue
      }

      const occupied = new Set(group.map(getApiEventSequence))
      const requested = typeof input.sequence === 'number' && Number.isSafeInteger(input.sequence) && input.sequence >= 0
        ? input.sequence
        : undefined
      let sequence = requested !== undefined && !occupied.has(requested)
        ? requested
        : (occupied.size === 0 ? 0 : Math.max(...occupied) + 1)
      while (occupied.has(sequence)) sequence++

      const stored: RawApiEvent = { ...input, sequence }
      group.push(stored)
      groups.set(groupKey, group)
      added.push(stored)
    }

    if (added.length > 0) {
      await db.apiEvents.bulkAdd(added as unknown as ApiEvent[])
    }

    return { added, duplicates }
  })
}
