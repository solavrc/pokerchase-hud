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

/**
 * Stat ids the HUD-header player-type classifier (HM-style auto-rate icon,
 * see playerTypeRules.ts) always needs, regardless of the user's HUD
 * statistics visibility settings -- same rationale and same forcing
 * mechanism as {@link COMPACT_REQUIRED_STAT_IDS} above, kept as a separate
 * list because the classifier's requirements are conceptually independent
 * of compact-mode's fixed classic line (they happen to overlap on
 * vpip/af, which every display mode already needs for other reasons).
 *
 * `vpipF` is the odd one out: it's `enabled: false` by default (opt-in,
 * see vpip-full.ts) since most users never turn it on in the popup, but
 * the classifier's whale-override check depends on it unconditionally --
 * quadrant VPIP is structurally inflated at short-handed tables (see
 * vpip-full.ts's rationale), so the whale check must use the full-table-
 * layer VPIP (vpipF) rather than raw vpip to avoid mislabeling players
 * who were mostly sampled at HU/short tables. Without this forcing,
 * vpipF would silently be missing from `statResults` for any user who
 * hasn't opted into the vpipF row, and the classifier would never be able
 * to fire the whale override for them.
 *
 * Used by read-entity-stream.ts, combined with COMPACT_REQUIRED_STAT_IDS
 * into a single set of ids forced into calculateWithConfig.
 */
export const CLASSIFIER_REQUIRED_STAT_IDS: string[] = ['vpip', 'af', 'vpipF']
