/**
 * Table-size layer classification and filtering (shared util).
 *
 * Extracted from src/stats/core/vpip-full.ts (A案, #130) so the same
 * table-type-relative "layer" rule can be reused by the C案 table-size
 * (players-dealt) HUD filter (see hand-over:
 * workspace/reports/pokerchase-hud-vpip-f-handover.md §C案) without
 * duplicating the classification logic. `vpip-full.ts` re-exports
 * `classifyTableSizeLayer` as `classifyVpipFLayer` for backward compatibility
 * with its own tests and callers -- there is exactly ONE implementation of
 * this rule, here.
 *
 * Layer definition (table-type relative):
 * - 6-max hand (`seatUserIds.length === 6`): 'full' when >= 5 seats dealt
 *   (non -1), '4p' when exactly 4 dealt, '3p' when exactly 3, 'hu' when 2.
 * - 4-max hand (`seatUserIds.length === 4`): 'full' when all 4 dealt, '3p'
 *   when 3, 'hu' when 2. ('4p' only exists on 6-max tables, since a 4-max
 *   table with all 4 seats dealt IS the full layer.)
 * - Anything else (degenerate seat counts, or table sizes other than 4/6)
 *   classifies as `null` -- excluded from both vpipF and an active
 *   table-size filter, but never excluded when the filter is inactive
 *   (default / all-layers-selected = no-op, see `selectedTableSizeLayers`).
 */

import type { Hand } from '../types/entities'

/** The four table-size layers used both by vpipF's tooltip breakdown and the table-size filter. */
export type TableSizeLayer = 'full' | '4p' | '3p' | 'hu'

export const ALL_TABLE_SIZE_LAYERS: readonly TableSizeLayer[] = ['full', '4p', '3p', 'hu']

/**
 * Classifies a hand into a table-size layer (table-type relative rule).
 * Returns `null` for seat counts that don't fit the known 6-max/4-max rules
 * (e.g. 1 seat dealt, or a table size other than 4/6).
 */
export function classifyTableSizeLayer(hand: Pick<Hand, 'seatUserIds'>): TableSizeLayer | null {
  const tableSize = hand.seatUserIds.length
  const dealtCount = hand.seatUserIds.filter(id => id !== -1).length

  if (tableSize === 6) {
    if (dealtCount >= 5) return 'full'
    if (dealtCount === 4) return '4p'
    if (dealtCount === 3) return '3p'
    if (dealtCount === 2) return 'hu'
    return null
  }
  if (tableSize === 4) {
    if (dealtCount === 4) return 'full'
    if (dealtCount === 3) return '3p'
    if (dealtCount === 2) return 'hu'
    return null
  }
  return null
}

/** Per-layer multiselect toggle, mirroring `GameTypeFilter`'s boolean-per-bucket shape. */
export interface TableSizeFilter {
  full: boolean
  '4p': boolean
  '3p': boolean
  hu: boolean
}

/** Default = every layer selected, i.e. no filtering (matches `battleTypeFilter`'s `undefined` = show-all convention). */
export const DEFAULT_TABLE_SIZE_FILTER: TableSizeFilter = { full: true, '4p': true, '3p': true, hu: true }

/**
 * Converts the UI's per-layer booleans into the service-internal predicate
 * input: `undefined` means "no filtering" (every hand matches, including
 * hands whose layer can't be classified), a populated array means "only
 * these layers match".
 *
 * Both "nothing selected" and "everything selected" collapse to `undefined`
 * -- the former mirrors `battleTypeFilter`'s existing convention (an
 * inadvertently all-unchecked filter shows everything rather than nothing),
 * the latter is the literal default/no-op case (#C案 requirement 4).
 */
export function selectedTableSizeLayers(filter: TableSizeFilter): TableSizeLayer[] | undefined {
  const selected = ALL_TABLE_SIZE_LAYERS.filter(layer => filter[layer])
  return selected.length > 0 && selected.length < ALL_TABLE_SIZE_LAYERS.length
    ? selected
    : undefined
}

/**
 * Hand predicate for the table-size filter. `layers === undefined` means
 * "no filtering active" -- every hand matches, including ones
 * `classifyTableSizeLayer` can't place into any of the 4 buckets. When a
 * concrete layer list is active, unclassifiable hands are excluded (they
 * can't belong to any selected bucket).
 */
export function matchesTableSizeFilter(hand: Pick<Hand, 'seatUserIds'>, layers: TableSizeLayer[] | undefined): boolean {
  if (!layers) return true
  const layer = classifyTableSizeLayer(hand)
  return layer !== null && layers.includes(layer)
}
