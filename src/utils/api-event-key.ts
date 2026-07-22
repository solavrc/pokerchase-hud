import type { PokerChaseDB } from '../db/poker-chase-db'
import { ApiTypeValues, type ApiEvent } from '../types/api'
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
  arrivalOrder?: number
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

export const getApiEventArrivalOrder = (event: { arrivalOrder?: unknown }): number | undefined =>
  typeof event.arrivalOrder === 'number' && Number.isSafeInteger(event.arrivalOrder) && event.arrivalOrder >= 0
    ? event.arrivalOrder
    : undefined

const isLegacyRoundBeforeAction = (round: RawApiEvent, action: RawApiEvent): boolean => {
  const roundProgress = round.Progress as Record<string, unknown> | undefined
  const actionProgress = action.Progress as Record<string, unknown> | undefined
  const players = [
    round.Player,
    ...Array.isArray(round.OtherPlayers) ? round.OtherPlayers : []
  ] as Array<Record<string, unknown> | undefined>
  const actorBeforeAction = players.find(player => player?.SeatIndex === action.SeatIndex)

  return round.ApiTypeId === 305 &&
    action.ApiTypeId === 304 &&
    typeof roundProgress?.Phase === 'number' &&
    roundProgress.Phase === actionProgress?.Phase &&
    roundProgress.NextActionSeat === action.SeatIndex &&
    typeof roundProgress.Pot === 'number' &&
    typeof action.BetChip === 'number' &&
    action.BetChip > 0 &&
    typeof action.Chip === 'number' &&
    typeof actionProgress.Pot === 'number' &&
    actionProgress.Pot === roundProgress.Pot + action.BetChip &&
    actorBeforeAction?.BetChip === 0 &&
    actorBeforeAction.Chip === action.Chip + action.BetChip
}

/**
 * Replay order for stateful consumers.
 *
 * Live rows carry the exact background-port arrival order. Legacy exports do
 * not, because raw export itself used primary-key order. For a legacy group,
 * repair only the observed equal-millisecond collision signature: one EVT_DEAL_ROUND and
 * one first action whose actor stack and pot both advance exactly by BetChip.
 * Everything else retains the historical primary-key order.
 *
 * This is deliberately a group operation instead of a pairwise comparator.
 * A comparator that moves 305 before one matching 304 but leaves another 304
 * before 305 can become non-transitive and produce engine-dependent results.
 */
export const orderApiEventsForReplay = <T extends RawApiEvent>(events: T[]): T[] => {
  const primaryOrder = [...events].sort(compareApiEventKeys)
  const ordered: T[] = []

  for (let start = 0; start < primaryOrder.length;) {
    let end = start + 1
    while (end < primaryOrder.length && primaryOrder[end]!.timestamp === primaryOrder[start]!.timestamp) end++
    const group = primaryOrder.slice(start, end)

    if (group.every(event => getApiEventArrivalOrder(event) !== undefined)) {
      group.sort((a, b) =>
        getApiEventArrivalOrder(a)! - getApiEventArrivalOrder(b)! || compareApiEventKeys(a, b)
      )
    } else {
      const rounds = group.filter(event => event.ApiTypeId === 305)
      if (rounds.length === 1) {
        const round = rounds[0]!
        const matchingActions = group.filter(event => isLegacyRoundBeforeAction(round, event))
        if (matchingActions.length === 1) {
          const actionIndex = group.indexOf(matchingActions[0]!)
          const roundIndex = group.indexOf(round)
          if (actionIndex < roundIndex) {
            group.splice(roundIndex, 1)
            group.splice(actionIndex, 0, round)
          }
        }
      }
    }

    ordered.push(...group)
    start = end
  }

  return ordered
}

/**
 * Stable content identity for reconnect/import/cloud deduplication.
 *
 * `sequence` and `arrivalOrder` are storage metadata, not part of the wire
 * payload. Two rows that differ only by them are therefore the same event.
 * Object keys are sorted recursively so a Firestore decode or legacy export
 * with a different property order still compares equal to the WebSocket object.
 */
export const getApiEventContentIdentity = (event: RawApiEvent): string => {
  const canonicalize = (value: unknown, omitSequence: boolean): unknown => {
    if (Array.isArray(value)) return value.map(item => canonicalize(item, false))
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>
      const result: Record<string, unknown> = {}
      for (const key of Object.keys(record).sort()) {
        if (omitSequence && (key === 'sequence' || key === 'arrivalOrder')) continue
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
