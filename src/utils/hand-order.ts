import type { Hand } from '../types/entities'

type OrderableHand = Pick<Hand, 'id' | 'approxTimestamp'>

/**
 * Compare persisted hands by receive chronology, newest first.
 *
 * HandId is assigned by the table that completed the hand. In an MTT, a
 * player can move between independently progressing tables, so the receive
 * sequence can legitimately contain a local inversion such as
 * 288331102 -> 288331101. `approxTimestamp` comes from the EVT_DEAL receive
 * timestamp and is therefore the ordering signal for current records.
 *
 * Legacy records may predate `approxTimestamp`. Keep their previous HandId
 * ordering as a deterministic fallback, and put timestamped records ahead of
 * legacy records because newly written hands always have a timestamp.
 */
export function compareHandsNewestFirst(a: OrderableHand, b: OrderableHand): number {
  const aHasTimestamp = Number.isFinite(a.approxTimestamp)
  const bHasTimestamp = Number.isFinite(b.approxTimestamp)

  if (aHasTimestamp && bHasTimestamp && a.approxTimestamp !== b.approxTimestamp) {
    return b.approxTimestamp! - a.approxTimestamp!
  }
  if (aHasTimestamp !== bHasTimestamp) return aHasTimestamp ? -1 : 1

  return b.id - a.id
}
