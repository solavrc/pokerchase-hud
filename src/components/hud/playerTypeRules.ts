/**
 * HM-style player-type classification icon (sola-approved spec, HUD
 * header). Data-driven on purpose, mirroring statColorRules.ts -- thresholds
 * live in one table here rather than inline conditionals, so tuning a band
 * is a one-line edit.
 *
 * Quadrants (VPIP x AF), boundaries inclusive on the "loose"/"aggressive"
 * side (mirrors statColorRules.ts's <= convention, just flipped to >=):
 *   - tight  < 25% VPIP   <= loose
 *   - passive < 1.5 AF    <= aggressive
 *
 *   🦈 TAG   tight + aggressive
 *   💣 LAG   loose + aggressive
 *   🪨 ニット tight + passive
 *   🐟 フィッシュ loose + passive
 *
 * Whale override (🐳): full-table-layer VPIP (`vpipF`, see
 * src/stats/core/vpip-full.ts) >= 50% overrides the quadrant icon entirely,
 * whatever the AF. This MUST use vpipF rather than raw `vpip` -- VPIP is
 * structurally inflated at short-handed tables (see vpip-full.ts's
 * rationale: 5-6p 35.2% vs. HU 71.9% for the same hero), so a player mostly
 * sampled at HU/short tables would otherwise be mislabeled a whale off raw
 * VPIP alone.
 *
 * n-gates (a stat's own [numerator, denominator] StatValue denominator):
 *   - No icon at all until `vpip` denominator >= MIN_VPIP_N (30) -- this is
 *     the baseline "enough of a track record to say anything" gate.
 *   - Whale check additionally requires `vpipF` denominator >= MIN_VPIPF_N
 *     (30) of its own (vpipF is a different, usually smaller, hand subset
 *     than vpip). It fires on vpipF alone once that's met, even if the AF
 *     axis is under-sampled -- whale ignores AF by definition.
 *   - Quadrant classification additionally requires `af` denominator >=
 *     MIN_AF_N (20). If AF's sample is too small but VPIP's is fine, this
 *     returns null rather than guessing an axis it can't place.
 *
 * Robust to missing stats: any absent/malformed StatValue is treated as
 * denominator 0, which fails every gate above and yields `null`.
 */
import type { StatResult, StatValue } from '../../types/stats'

export type PlayerType = 'tag' | 'lag' | 'nit' | 'fish' | 'whale'

export interface PlayerTypeClassification {
  type: PlayerType
  icon: string
  label: string
  /** Native `title` tooltip text (Japanese), e.g. "プレイヤータイプ: ...\nVPIP ... / AF ...". */
  reason: string
}

/** Tunable thresholds -- see module doc for the boundary convention. */
export const PLAYER_TYPE_THRESHOLDS = {
  /** VPIP% boundary: tight < this <= loose. */
  vpipTightLoose: 25,
  /** AF boundary: passive < this <= aggressive. */
  afPassiveAggressive: 1.5,
  /** Full-table-layer VPIP% (vpipF) at/above which the whale override fires. */
  whaleVpipF: 50,
  /** Minimum `vpip` denominator before ANY icon shows. */
  minVpipN: 30,
  /** Minimum `vpipF` denominator before the whale check is attempted. */
  minVpipFN: 30,
  /** Minimum `af` denominator before quadrant classification is attempted. */
  minAfN: 20,
} as const

export const PLAYER_TYPE_META: Record<PlayerType, { icon: string, label: string }> = {
  tag: { icon: '🦈', label: 'TAG' },
  lag: { icon: '💣', label: 'LAG' },
  nit: { icon: '🪨', label: 'ニット' },
  fish: { icon: '🐟', label: 'フィッシュ' },
  whale: { icon: '🐳', label: 'ホエール' },
}

// Guards a boundary comparison (`ratio >= threshold`) against float noise,
// same rationale/magnitude as statColorRules.ts's EPSILON.
const EPSILON = 1e-9

const asFraction = (value: StatValue | undefined): [number, number] | undefined =>
  Array.isArray(value) && value.length === 2 ? (value as [number, number]) : undefined

const findFraction = (statResults: StatResult[] | undefined, id: string): [number, number] | undefined =>
  asFraction(statResults?.find(s => s.id === id)?.value)

/**
 * Classifies a player into an HM-style type from their computed
 * statResults, or returns `null` if the sample is too small to place them
 * (see module doc for the exact n-gates). Pure function -- no I/O, no
 * mutation of the input.
 */
export function classifyPlayerType(statResults: StatResult[] | undefined): PlayerTypeClassification | null {
  const vpip = findFraction(statResults, 'vpip')
  const vpipDenom = vpip?.[1] ?? 0
  if (vpipDenom < PLAYER_TYPE_THRESHOLDS.minVpipN) return null

  // Whale check first: overrides the quadrant entirely once it fires, and
  // uses its own (vpipF) n-gate independent of AF's sample size.
  const vpipF = findFraction(statResults, 'vpipF')
  const vpipFDenom = vpipF?.[1] ?? 0
  if (vpipFDenom >= PLAYER_TYPE_THRESHOLDS.minVpipFN) {
    const vpipFPct = (vpipF![0] / vpipFDenom) * 100
    if (vpipFPct >= PLAYER_TYPE_THRESHOLDS.whaleVpipF - EPSILON) {
      const meta = PLAYER_TYPE_META.whale
      return {
        type: 'whale',
        icon: meta.icon,
        label: meta.label,
        reason: `プレイヤータイプ: ${meta.label} (超ルース)\n` +
          `フルテーブルVPIP ${Math.round(vpipFPct)}% (n=${vpipFDenom}) ≥ ${PLAYER_TYPE_THRESHOLDS.whaleVpipF}%`,
      }
    }
  }

  // Quadrant classification: needs the AF axis to be placeable.
  const af = findFraction(statResults, 'af')
  const afDenom = af?.[1] ?? 0
  if (afDenom < PLAYER_TYPE_THRESHOLDS.minAfN) return null

  const vpipPct = (vpip![0] / vpipDenom) * 100
  const isLoose = vpipPct >= PLAYER_TYPE_THRESHOLDS.vpipTightLoose - EPSILON
  const afRatio = af![0] / afDenom
  const isAggressive = afRatio >= PLAYER_TYPE_THRESHOLDS.afPassiveAggressive - EPSILON

  const type: PlayerType = isLoose
    ? (isAggressive ? 'lag' : 'fish')
    : (isAggressive ? 'tag' : 'nit')

  const meta = PLAYER_TYPE_META[type]
  const style = `${isLoose ? 'ルース' : 'タイト'}・${isAggressive ? 'アグレッシブ' : 'パッシブ'}`
  const vpipCmp = isLoose ? '≥' : '<'
  const afCmp = isAggressive ? '≥' : '<'

  return {
    type,
    icon: meta.icon,
    label: meta.label,
    reason: `プレイヤータイプ: ${meta.label} (${style})\n` +
      `VPIP ${Math.round(vpipPct)}% (n=${vpipDenom}) ${vpipCmp} ${PLAYER_TYPE_THRESHOLDS.vpipTightLoose} / ` +
      `AF ${afRatio.toFixed(1)} (n=${afDenom}) ${afCmp} ${PLAYER_TYPE_THRESHOLDS.afPassiveAggressive}`,
  }
}
