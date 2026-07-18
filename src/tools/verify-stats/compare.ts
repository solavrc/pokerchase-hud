/**
 * verify-stats: comparison / agreement report.
 *
 * Compares pipeline-side stat fractions (pipeline.ts) against the
 * independent oracle's fractions (oracle.ts) per player, per stat, and
 * reports numerator/denominator agreement. Only players with at least
 * `minHands` hands are counted, to avoid noise from tiny samples where a
 * single off-by-one dominates the percentage.
 *
 * Eligibility is the UNION of both sides' eligible players (each side's own
 * `hands >= minHands`), not just the pipeline's: if EntityConverter drops a
 * player entirely, or undercounts their hand count below minHands, that
 * player must still show up as a mismatch rather than silently vanishing
 * from the comparison. Likewise, a stat that is missing or malformed
 * (non-fraction, e.g. a thrown StatDefinition.calculate reduced to scalar 0
 * by StatsRegistry's catch handler) on either side for an eligible player is
 * counted as a MISMATCH, not skipped -- silently skipping would let a
 * regression that makes a stat throw (and thus resolve to `0`, which can
 * spuriously equal a legitimate `0/0`) hide behind a 100% agreement report.
 */
import type { PipelineResult } from './pipeline'
import type { OracleFraction, OracleResult } from './oracle'

/** Stats compared -- must exist as a [num, denom] tuple on both sides. */
export const COMPARED_STATS = [
  'vpip', 'vpipF', 'pfr', '3bet', '3betfold', 'cbet', 'cbetFold', 'af', 'afq',
  'wtsd', 'wsd', 'wwsf', 'wtsdNoAi', 'wwsfNoAi', 'steal', 'foldToSteal', 'riverCallAccuracy',
] as const
export type ComparedStat = typeof COMPARED_STATS[number]

export interface Mismatch {
  playerId: number
  pipeline: OracleFraction | undefined
  oracle: OracleFraction | undefined
  dNum: number | undefined
  dDen: number | undefined
  /** True when this mismatch is due to one/both sides missing or non-fraction, not a value disagreement. */
  missing: boolean
}

export interface StatAgreement {
  stat: ComparedStat
  agree: number
  total: number
  /** agree/total as a percentage in [0, 100]; 100 when total is 0 (nothing to disagree on). */
  pct: number
  /** Count of mismatches caused by a missing/non-fraction stat on one or both sides (subset of mismatches.length). */
  missing: number
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
 * Compare pipeline vs oracle results for players eligible (>= minHands hands)
 * on EITHER side. A player present/eligible on only one side counts as a
 * mismatch (missing=true) on every compared stat, since the other side has
 * no fraction to compare against.
 */
export function compareResults(pipeline: PipelineResult, oracle: OracleResult, minHands = 50): ComparisonReport {
  const pipelineEligible = new Set(
    [...pipeline.values()].filter(p => p.hands >= minHands).map(p => p.playerId)
  )
  const oracleEligible = new Set(
    [...oracle.values()].filter(p => p.hands >= minHands).map(p => p.playerId)
  )
  const eligiblePlayerIds = new Set([...pipelineEligible, ...oracleEligible])

  const stats: StatAgreement[] = COMPARED_STATS.map(stat => {
    let agree = 0
    let total = 0
    let missing = 0
    const mismatches: Mismatch[] = []

    for (const playerId of eligiblePlayerIds) {
      const p = pipeline.get(playerId)?.stats[stat]
      const o = oracle.get(playerId)?.stats[stat]
      const pOk = isFraction(p)
      const oOk = isFraction(o)
      total++

      if (!pOk || !oOk) {
        missing++
        mismatches.push({
          playerId,
          pipeline: pOk ? p : undefined,
          oracle: oOk ? o : undefined,
          dNum: undefined,
          dDen: undefined,
          missing: true,
        })
        continue
      }

      const [pn, pd] = p
      const [on, od] = o
      if (pn === on && pd === od) {
        agree++
      } else {
        mismatches.push({ playerId, pipeline: p, oracle: o, dNum: pn - on, dDen: pd - od, missing: false })
      }
    }

    return {
      stat,
      agree,
      total,
      pct: total === 0 ? 100 : (100 * agree) / total,
      missing,
      mismatches,
    }
  })

  return { eligiblePlayers: eligiblePlayerIds.size, minHands, stats }
}

/** Render a human-readable agreement table, one line per stat. */
export function formatReport(report: ComparisonReport, sampleMismatches = 5): string {
  const lines: string[] = []
  lines.push(`Eligible players (>= ${report.minHands} hands, union of both sides): ${report.eligiblePlayers}`)
  lines.push('')
  lines.push('Stat          Agreement          Pct       Missing')
  lines.push('----          ---------          ---       -------')
  for (const s of report.stats) {
    const ratio = `${s.agree}/${s.total}`
    lines.push(`${s.stat.padEnd(13)} ${ratio.padEnd(18)} ${(s.pct.toFixed(2) + '%').padEnd(9)} ${s.missing}`)
  }
  for (const s of report.stats) {
    if (s.mismatches.length === 0) continue
    lines.push('')
    lines.push(`Mismatches for ${s.stat} (showing up to ${sampleMismatches} of ${s.mismatches.length}, missing=${s.missing}):`)
    for (const m of s.mismatches.slice(0, sampleMismatches)) {
      if (m.missing) {
        lines.push(`  player ${m.playerId}: MISSING pipeline=${m.pipeline ? `[${m.pipeline}]` : 'absent'} oracle=${m.oracle ? `[${m.oracle}]` : 'absent'}`)
      } else {
        lines.push(`  player ${m.playerId}: pipeline=[${m.pipeline}] oracle=[${m.oracle}] (dNum=${m.dNum}, dDen=${m.dDen})`)
      }
    }
  }
  return lines.join('\n')
}
