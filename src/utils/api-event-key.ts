import type { PokerChaseDB } from '../db/poker-chase-db'
import { ApiType, ApiTypeValues, type ApiEvent } from '../types/api'
import {
  isScopedSyncMetaKey,
  SYNC_RESCAN_BACKFILL_DONE_META_KEY,
  SYNC_RESCAN_FLOOR_META_KEY
} from '../constants/sync'

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

export interface MergeApiEventsOptions {
  /**
   * Imported history may sort below an account's Firestore max timestamp.
   * Lower every previously-reconciled account's scan floor in the same
   * transaction as the new raw rows so the watermark cannot hide them.
   */
  protectAddedApplicationEventsFromCloudWatermark?: boolean
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

const STATE_SNAPSHOT_API_TYPE_IDS = new Set([
  ApiType.EVT_DEAL,
  ApiType.EVT_DEAL_ROUND,
  ApiType.EVT_PLAYER_SEAT_ASSIGNED
])

const isProvenSnapshotBeforeAction = (snapshot: RawApiEvent, action: RawApiEvent): boolean => {
  if (!STATE_SNAPSHOT_API_TYPE_IDS.has(snapshot.ApiTypeId) || action.ApiTypeId !== ApiType.EVT_ACTION) return false

  const snapshotProgress = snapshot.Progress as Record<string, unknown> | undefined
  const actionProgress = action.Progress as Record<string, unknown> | undefined
  const players = [
    snapshot.Player,
    ...Array.isArray(snapshot.OtherPlayers) ? snapshot.OtherPlayers : []
  ] as Array<Record<string, unknown> | undefined>
  const actorBeforeAction = players.find(player => player?.SeatIndex === action.SeatIndex)
  const previousBet = actorBeforeAction?.BetChip
  const actionBet = action.BetChip
  if (typeof previousBet !== 'number' || typeof actionBet !== 'number') return false
  const additionalBet = actionBet - previousBet

  return additionalBet >= 0 &&
    typeof snapshotProgress?.Phase === 'number' &&
    snapshotProgress.Phase === actionProgress?.Phase &&
    snapshotProgress.NextActionSeat === action.SeatIndex &&
    typeof snapshotProgress.Pot === 'number' &&
    typeof action.Chip === 'number' &&
    typeof actionProgress.Pot === 'number' &&
    actionProgress.Pot === snapshotProgress.Pot + additionalBet &&
    actorBeforeAction?.Chip === action.Chip + additionalBet
}

const resolveStrictSnapshotActionPair = <T extends RawApiEvent>(group: T[]): T[] => {
  // The production inversions are isolated two-event groups. With a third row,
  // even a proven local edge could move an unrelated lifecycle event across the
  // pair, so compound groups stay entirely in canonical primary-key order.
  if (group.length !== 2) return group
  const [first, second] = group as [T, T]
  return isProvenSnapshotBeforeAction(second, first) ? [second, first] : group
}

/**
 * Replay order for stateful consumers.
 *
 * IndexedDB and raw export use `[timestamp+ApiTypeId+sequence]`, so cross-type
 * events sharing a millisecond are stored in ApiTypeId order rather than wire
 * order. Reverse only an isolated two-event snapshot/action pair proven by
 * exact phase, actor, stack and pot deltas. Compound groups and all other events
 * retain primary-key order as a stable, fail-closed representation; this
 * function does not infer lifecycle order from an isolated timestamp group.
 *
 * The 393,830-event production corpus contained 210 cross-type equal-ms
 * groups. The strict predicate changes only three proven inversions (two
 * 313→304 groups and one 305→304 group), all isolated two-event groups.
 */
export const orderApiEventsForReplay = <T extends RawApiEvent>(events: T[]): T[] => {
  const primaryOrder = [...events].sort(compareApiEventKeys)
  const ordered: T[] = []

  for (let start = 0; start < primaryOrder.length;) {
    let end = start + 1
    while (end < primaryOrder.length && primaryOrder[end]!.timestamp === primaryOrder[start]!.timestamp) end++
    const group = primaryOrder.slice(start, end)
    ordered.push(...resolveStrictSnapshotActionPair(group))
    start = end
  }

  return ordered
}

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
  inputEvents: RawApiEvent[],
  options: MergeApiEventsOptions = {}
): Promise<MergeApiEventsResult> {
  if (inputEvents.length === 0) return { added: [], duplicates: 0 }

  const transactionTables = options.protectAddedApplicationEventsFromCloudWatermark
    ? [db.apiEvents, db.meta]
    : [db.apiEvents]

  return await db.transaction('rw', transactionTables, async () => {
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

      if (options.protectAddedApplicationEventsFromCloudWatermark) {
        const importedApplicationTimestamps = added
          .filter(event => ApiTypeValues.includes(event.ApiTypeId as any))
          .map(event => event.timestamp)
        const earliestImportedTimestamp = importedApplicationTimestamps.length > 0
          ? Math.min(...importedApplicationTimestamps)
          : null

        if (earliestImportedTimestamp !== null) {
          const reconciledAccounts = await db.meta
            .filter(record => isScopedSyncMetaKey(record.id, SYNC_RESCAN_BACKFILL_DONE_META_KEY))
            .toArray()

          for (const marker of reconciledAccounts) {
            const accountSuffix = marker.id.slice(SYNC_RESCAN_BACKFILL_DONE_META_KEY.length)
            const floorKey = `${SYNC_RESCAN_FLOOR_META_KEY}${accountSuffix}`
            const existingFloor = await db.meta.get(floorKey)
            if (typeof existingFloor?.value !== 'number' || existingFloor.value > earliestImportedTimestamp) {
              await db.meta.put({
                id: floorKey,
                value: earliestImportedTimestamp,
                updatedAt: Date.now()
              })
            }
          }
        }
      }
    }

    return { added, duplicates }
  })
}
