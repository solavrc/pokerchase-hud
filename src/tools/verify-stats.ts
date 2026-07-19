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
 * Known benign gaps: none, as of the fused-buffer (duplicate-phase) hand
 * rejection. Earlier documented gaps are resolved:
 *  - WTSD/WWSF residuals were fixed by mirroring Dexie's [handId+phase]
 *    de-duplication in pipeline.ts (#108).
 *  - The former "dual-board" WTSD/WWSF/CBet residuals turned out to be
 *    fused table-move buffers (two hands merged around a mid-hand
 *    EVT_ENTRY_QUEUED/EVT_PLAYER_SEAT_ASSIGNED — see docs/api-events.md
 *    「デュアルボード観測」); such hands are now rejected identically by
 *    write-entity-stream.ts, entity-converter.ts, and the oracle, so the
 *    reference capture reaches 100% agreement on every compared stat.
 * The default --threshold=99 provides headroom for as-yet-unknown anomalies
 * in future captures while still catching real divergences.
 */
import { existsSync, createReadStream } from 'fs'
import { resolve } from 'path'
import { createInterface } from 'readline'
import { runPipeline } from './verify-stats/pipeline'
import { runOracle } from './verify-stats/oracle'
import { compareResults, formatReport } from './verify-stats/compare'
import { filterValidApplicationEvents } from '../utils/database-utils'
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
  const rawEvents: unknown[] = []
  // 実際のインポート経路（src/background/import-export.ts）は apiEvents の主キー
  // [timestamp+ApiTypeId] に基づき `${timestamp}-${ApiTypeId}` キーの先勝ちで
  // 重複イベントを除外してから EntityConverter に渡す。ハーネスも同じ前処理を
  // 行わないと、キャプチャ内の重複イベント（例: 同一 EVT_ACTION の二重記録）が
  // 製品では起こらない統計差分を生む（実データで cbet 1 件の偽性不一致を確認）。
  const seenKeys = new Set<string>()
  let duplicateCount = 0
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    const event = JSON.parse(line)
    const key = `${event.timestamp}-${event.ApiTypeId}`
    if (seenKeys.has(key)) {
      duplicateCount++
      continue
    }
    seenKeys.add(key)
    rawEvents.push(event)
  }
  if (duplicateCount > 0) {
    console.log(`Skipped ${duplicateCount} duplicate event(s) ([timestamp+ApiTypeId] first-wins, mirroring the import path)`)
  }
  // ファイルは Raw Event Lake の生ダンプたり得る（docs/architecture.md）: 202/205
  // keepalive、未知の ApiTypeId、スキーマ検証に失敗したアプリケーションイベントを
  // 含み得る。EntityConverter は EVT_DEAL.Game 等を無防備に参照するため、rebuild
  // 経路（import-export.ts, auto-sync-service.ts, hand-log-exporter.ts）と同じく
  // filterValidApplicationEvents() で再検証してから渡す。
  const validEvents = await filterValidApplicationEvents(rawEvents)
  const skippedCount = rawEvents.length - validEvents.length
  if (skippedCount > 0) {
    console.log(`Filtered out ${skippedCount} non-application/invalid event(s) (raw Lake noise — see filterValidApplicationEvents)`)
  }
  return validEvents
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
