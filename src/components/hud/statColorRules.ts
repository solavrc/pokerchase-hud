/**
 * Threshold-based stat value coloring (#143, ported from the
 * proto/hud-design-mock design review prototype).
 *
 * Data-driven on purpose: thresholds live in one table here rather than as
 * inline conditionals scattered across StatDisplay/CompactStatDisplay JSX,
 * so tuning a band is a one-line edit and both the full and compact
 * renderers share identical logic.
 *
 * Gating: a stat is only colored once its own [numerator, denominator]
 * StatValue has denominator >= MIN_DENOMINATOR_FOR_COLOR -- below that the
 * sample is too small to mean anything, so the value keeps the existing
 * dimmed gray used for low-confidence stats.
 */
import type { StatValue } from '../../types/stats'

/** Minimum opportunities (StatValue denominator) before a stat gets colored instead of dimmed gray. */
export const MIN_DENOMINATOR_FOR_COLOR = 20

/** Dimmed color shown for stats below {@link MIN_DENOMINATOR_FOR_COLOR}, matching StatDisplay's existing low-confidence style. */
export const LOW_SAMPLE_COLOR = '#888888'

/** One color band: values at or below `upTo` (inclusive) get `color`; `null` means "leave the default text color". A boundary value belongs to the band whose `upTo` it matches, not the next band up. */
interface ColorBand {
  upTo: number
  color: string | null
}

interface StatColorRule {
  /** How to turn a [numerator, denominator] StatValue into the number compared against band thresholds. */
  scale: 'percent' | 'factor'
  /** Ascending by `upTo`; the last band should have `upTo: Infinity` to catch everything above the previous band. */
  bands: ColorBand[]
}

// Design brief thresholds (sola-approved, see PR #143). Upper bounds are
// inclusive -- a boundary value belongs to the lower band:
//  - VPIP/PFR: <=20 tight/blue, (20,28] default, (28,40] loose/orange, >40 very loose/red
//  - 3bet: <=6 blue, (6,10] default, >10 orange (no red band specified)
//  - AF: <=1.5 blue, (1.5,3] default, >3 red (no orange band specified)
const TIGHT_LOOSE_BANDS: ColorBand[] = [
  { upTo: 20, color: '#64b5f6' },
  { upTo: 28, color: null },
  { upTo: 40, color: '#ffb74d' },
  { upTo: Infinity, color: '#e57373' },
]

export const STAT_COLOR_RULES: Record<string, StatColorRule> = {
  vpip: { scale: 'percent', bands: TIGHT_LOOSE_BANDS },
  pfr: { scale: 'percent', bands: TIGHT_LOOSE_BANDS },
  '3bet': {
    scale: 'percent',
    bands: [
      { upTo: 6, color: '#64b5f6' },
      { upTo: 10, color: null },
      { upTo: Infinity, color: '#ffb74d' },
    ],
  },
  af: {
    scale: 'factor',
    bands: [
      { upTo: 1.5, color: '#64b5f6' },
      { upTo: 3, color: null },
      { upTo: Infinity, color: '#e57373' },
    ],
  },
}

/**
 * Returns the color to render a stat's value in, or `null` to leave the
 * caller's default text color untouched (no rule for this stat id, or the
 * value isn't a [numerator, denominator] pair).
 */
export const getStatValueColor = (statId: string, value: StatValue): string | null => {
  const rule = STAT_COLOR_RULES[statId]
  if (!rule || !Array.isArray(value) || value.length !== 2) return null
  const [numerator, denominator] = value
  if (denominator === 0) return null // formatted as '-' anyway; nothing to color
  if (denominator < MIN_DENOMINATOR_FOR_COLOR) return LOW_SAMPLE_COLOR

  const ratio = rule.scale === 'percent' ? (numerator / denominator) * 100 : numerator / denominator
  // Epsilon guards boundary values against float noise, e.g. (28/100)*100 ===
  // 28.000000000000004 in IEEE 754 -- without it, an exact 28.0% VPIP would
  // wrongly skip the `<=28` band and fall through to the next one (#143
  // review). 1e-9 is far below any real stat's precision, so it can't blur
  // two genuinely different values together.
  const EPSILON = 1e-9
  const band = rule.bands.find((b) => ratio <= b.upTo + EPSILON)
  return band?.color ?? null
}
