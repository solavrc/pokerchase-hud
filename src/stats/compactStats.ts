/**
 * Stat ids the compact HUD line (#143) always needs, regardless of the
 * user's HUD statistics visibility settings (statDisplayConfigs).
 *
 * Compact mode renders a fixed-format classic line (`VPIP/PFR/3B (HAND)`)
 * plus a fixed secondary line (AF/CB/STL) -- see CompactStatDisplay.tsx.
 * That format has no per-stat visibility toggle of its own, so these ids
 * must be calculated even when the user has disabled the corresponding
 * row in the full 16-stat grid (PR #143 review: previously a disabled
 * stat was omitted from `statResults` entirely, and the compact line
 * would render it as a bogus '-'/`(0)` even though the player has real
 * data).
 *
 * Used by:
 *  - read-entity-stream.ts: forces these ids into the calculation
 *    (calculateWithConfig) regardless of their configured `enabled` flag.
 *  - Hud.tsx: keeps the enabled-only filtering for the full grid's
 *    `displayStats` while still passing the full/unfiltered `statResults`
 *    to CompactStatDisplay, so visibility config only governs the grid.
 */
export const COMPACT_REQUIRED_STAT_IDS: string[] = ['vpip', 'pfr', '3bet', 'hands', 'af', 'cbet', 'steal']
