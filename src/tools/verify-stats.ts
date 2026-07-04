/**
 * Stats Verification Harness
 *
 * Regression tool that checks the live stats pipeline (EntityConverter +
 * StatDefinition.calculate, see pipeline.ts) against an independently
 * re-implemented "oracle" (oracle.ts, no imports from src/stats or
 * src/entity-converter) computed from the same raw NDJSON.
 *
 * Run this after any change to entity-converter.ts, write-entity-stream.ts,
 * or src/stats/**: a real behavioral regression will show up as a drop in
 * per-stat agreement, whereas a bug shared between the pipeline and this
 * tool's own oracle would not -- which is why the oracle is kept independent
 * (see oracle.ts's header comment).
 *
 * Usage:
 *   npm run verify-stats -- <NDJSONファイルパス> [--min-hands=50] [--threshold=99]
 *
 * Exits non-zero if any stat's agreement (for players with >= min-hands
 * hands) falls below --threshold percent.
 *
 * Known benign gaps (do not indicate a pipeline bug):
 *  - WTSD/WWSF typically settle around 99.5-99.7% agreement, not 100%, on
 *    large real captures. This repo's audit traced the residual mismatches
 *    to 8 hands with a dual-board/run-it-twice-shaped anomaly in the raw
 *    event stream that a single flat community-card oracle model cannot
 *    represent; the live pipeline's phase-membership logic is correct.
 *  - CBet can show a single-hand discrepancy caused by one duplicate
 *    EVT_ACTION event recorded for the same seat/street in the source
 *    capture (an artifact of the capture, not of either implementation).
 * The default --threshold=99 is set below both pipeline stats' typical
 * ceiling so these two known gaps do not fail CI, while still catching any
 * new, larger divergence.
 */
import { existsSync, createReadStream } from 'fs'
import { resolve } from 'path'
import { createInterface } from 'readline'
import { runPipeline } from './verify-stats/pipeline'
import { runOracle } from './verify-stats/oracle'
import { compareResults, formatReport } from './verify-stats/compare'
import type { ApiEvent } from '../types'

interface CliOptions {
  filePath: string
  minHands: number
  threshold: number
}

function parseArgs(argv: string[]): CliOptions {
  const positional: string[] = []
  let minHands = 50
  let threshold = 99

  for (const arg of argv) {
    if (arg.startsWith('--min-hands=')) {
      minHands = Number(arg.slice('--min-hands='.length))
    } else if (arg.startsWith('--threshold=')) {
      threshold = Number(arg.slice('--threshold='.length))
    } else {
      positional.push(arg)
    }
  }

  const filePath = positional[0]
  if (!filePath) {
    console.log('使用方法: npm run verify-stats -- <NDJSONファイルパス> [--min-hands=50] [--threshold=99]')
    console.log('例: npm run verify-stats -- ./pokerchase_raw_data.ndjson')
    process.exit(1)
  }

  return { filePath: resolve(process.cwd(), filePath), minHands, threshold }
}

async function readNdjson(filePath: string): Promise<ApiEvent[]> {
  const events: ApiEvent[] = []
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    events.push(JSON.parse(line))
  }
  return events
}

async function main() {
  const { filePath, minHands, threshold } = parseArgs(process.argv.slice(2))

  if (!existsSync(filePath)) {
    console.error(`エラー: ファイルが見つかりません: ${filePath}`)
    process.exit(1)
  }

  console.log(`ファイル: ${filePath}`)
  console.log('Reading NDJSON...')
  const events = await readNdjson(filePath)
  console.log(`Loaded ${events.length} events`)

  console.log('Running pipeline (EntityConverter + StatDefinition.calculate)...')
  const pipeline = await runPipeline(events)
  console.log(`Pipeline: ${pipeline.size} distinct players`)

  console.log('Running independent oracle...')
  const oracle = runOracle(events)
  console.log(`Oracle: ${oracle.size} distinct players`)

  const report = compareResults(pipeline, oracle, minHands)
  console.log('')
  console.log(formatReport(report))

  const failing = report.stats.filter(s => s.total > 0 && s.pct < threshold)
  console.log('')
  if (failing.length > 0) {
    console.error(`FAIL: ${failing.length} stat(s) below ${threshold}% agreement threshold: ${failing.map(s => `${s.stat} (${s.pct.toFixed(2)}%)`).join(', ')}`)
    process.exit(1)
  }

  console.log(`PASS: all stats >= ${threshold}% agreement (min-hands=${minHands}).`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
