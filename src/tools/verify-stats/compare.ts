/**
 * verify-stats: comparison / agreement report.
 *
 * Compares pipeline-side stat fractions (pipeline.ts) against the
 * independent oracle's fractions (oracle.ts) per player, per stat, and
 * reports numerator/denominator agreement. Only players with at least
 * `minHands` hands are counted, to avoid noise from tiny samples where a
 * single off-by-one dominates the percentage.
 */
import type { PipelineResult } from './pipeline'
import type { OracleFraction, OracleResult } from './oracle'

/** Stats compared -- must exist as a [num, denom] tuple on both sides. */
export const COMPARED_STATS = [
  'vpip', 'pfr', '3bet', '3betfold', 'cbet', 'cbetFold', 'af', 'afq',
  'wtsd', 'wsd', 'wwsf', 'steal', 'foldToSteal',
] as const
export type ComparedStat = typeof COMPARED_STATS[number]

export interface Mismatch {
  playerId: number
  pipeline: OracleFraction
  oracle: OracleFraction
  dNum: number
  dDen: number
}

export interface StatAgreement {
  stat: ComparedStat
  agree: number
  total: number
  /** agree/total as a percentage in [0, 100]; 100 when total is 0 (nothing to disagree on). */
  pct: number
  mismatches: Mismatch[]
}

export interface ComparisonReport {
  eligiblePlayers: number
  minHands: number
  stats: StatAgreement[]
}

function isFraction(value: unknown): value is OracleFraction {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'number'
}

/**
 * Compare pipeline vs oracle results for players with >= minHands hands.
 * Both maps are keyed by playerId; a player missing from either side for a
 * given stat is simply skipped for that stat (not counted as a mismatch).
 */
export function compareResults(pipeline: PipelineResult, oracle: OracleResult, minHands = 50): ComparisonReport {
  const eligiblePlayerIds = [...pipeline.values()]
    .filter(p => p.hands >= minHands)
    .map(p => p.playerId)

  const stats: StatAgreement[] = COMPARED_STATS.map(stat => {
    let agree = 0
    let total = 0
    const mismatches: Mismatch[] = []

    for (const playerId of eligiblePlayerIds) {
      const p = pipeline.get(playerId)?.stats[stat]
      const o = oracle.get(playerId)?.stats[stat]
      if (!isFraction(p) || !isFraction(o)) continue
      total++
      const [pn, pd] = p
      const [on, od] = o
      if (pn === on && pd === od) {
        agree++
      } else {
        mismatches.push({ playerId, pipeline: p, oracle: o, dNum: pn - on, dDen: pd - od })
      }
    }

    return {
      stat,
      agree,
      total,
      pct: total === 0 ? 100 : (100 * agree) / total,
      mismatches,
    }
  })

  return { eligiblePlayers: eligiblePlayerIds.length, minHands, stats }
}

/** Render a human-readable agreement table, one line per stat. */
export function formatReport(report: ComparisonReport, sampleMismatches = 5): string {
  const lines: string[] = []
  lines.push(`Eligible players (>= ${report.minHands} hands): ${report.eligiblePlayers}`)
  lines.push('')
  lines.push('Stat          Agreement          Pct')
  lines.push('----          ---------          ---')
  for (const s of report.stats) {
    const ratio = `${s.agree}/${s.total}`
    lines.push(`${s.stat.padEnd(13)} ${ratio.padEnd(18)} ${s.pct.toFixed(2)}%`)
  }
  for (const s of report.stats) {
    if (s.mismatches.length === 0) continue
    lines.push('')
    lines.push(`Mismatches for ${s.stat} (showing up to ${sampleMismatches} of ${s.mismatches.length}):`)
    for (const m of s.mismatches.slice(0, sampleMismatches)) {
      lines.push(`  player ${m.playerId}: pipeline=[${m.pipeline}] oracle=[${m.oracle}] (dNum=${m.dNum}, dDen=${m.dDen})`)
    }
  }
  return lines.join('\n')
}
