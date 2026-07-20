/**
 * One-off script (not part of the permanent e2e toolchain) to extract a
 * bust/elimination fixture slice for the busted-player-dim feature.
 *
 * Slices the raw capture from a known EVT_ENTRY_QUEUED (201, SNG session
 * start) at line 1381 through the matching EVT_SESSION_RESULTS (309) at
 * line 1924 (1-indexed, inclusive) of
 * pokerchase_raw_data_2026-07-04T18-31-12-252Z.ndjson -- the same raw
 * capture docs/api-events.md's "実データ（393,830イベント）" analysis is
 * drawn from. This slice is an SNG (BattleType=0) where a player at raw
 * seat 0 (UserId 109263980, Ranking=6) busts mid-session (EVT_HAND_RESULTS
 * at source line 1743) while the rest of the table continues playing, and
 * the session then ends normally (EVT_SESSION_RESULTS) 57 hands in.
 *
 * Reuses e2e/tools/anonymize.ts's anonymizeEvents directly (not
 * extract-fixture.ts, which always starts at the *first* EVT_ENTRY_QUEUED
 * in the given file and always stops exactly on a hand boundary -- neither
 * fits here, since the source file has many earlier sessions and this
 * scenario specifically needs the trailing EVT_SESSION_RESULTS included).
 *
 * The source capture is developer-local (never committed -- see
 * anonymize.ts's doc comment) so its path can't be hardcoded for every
 * checkout/CI; take it from argv like extract-fixture.ts does. The line
 * numbers stay fixed defaults since they're specific to the one known-good
 * 2026-07-04 capture this fixture was drawn from -- pass a different
 * source only if you have that same file (or one with a session at the
 * same lines); this script isn't a general-purpose slicer.
 *
 * Usage:
 *   tsx e2e/tools/extract-bust-fixture.ts <input.ndjson> [--start N] [--end N]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { anonymizeEvents } from './anonymize.ts'

const parseArgs = (argv: string[]) => {
  const positional: string[] = []
  let start = 1381 // EVT_ENTRY_QUEUED (201), SNG session start
  let end = 1924 // EVT_SESSION_RESULTS (309), session end
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--start' || arg === '--end') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`${arg} requires a value`)
      if (arg === '--start') start = Number(value)
      else end = Number(value)
      i++ // consume the value too, so it never falls through to positionals
      continue
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`)
    }
    positional.push(arg)
  }
  const input = positional[0]
  if (!input) {
    throw new Error(
      'Usage: tsx e2e/tools/extract-bust-fixture.ts <input.ndjson> [--start N] [--end N]'
    )
  }
  return { source: resolve(input), start, end }
}

const { source: SOURCE, start: START_LINE, end: END_LINE } = parseArgs(process.argv.slice(2))
const OUTPUT = new URL('../fixtures/session-bust.ndjson', import.meta.url).pathname

const raw = readFileSync(SOURCE, 'utf-8')
const allLines = raw.split('\n')
const slice = allLines.slice(START_LINE - 1, END_LINE) // 1-indexed inclusive -> 0-indexed slice
const parsed = slice.filter((l) => l.trim().length > 0).map((l) => JSON.parse(l))

console.log(`[extract-bust-fixture] sliced ${parsed.length} events (lines ${START_LINE}-${END_LINE})`)
console.log(`[extract-bust-fixture] first: ApiTypeId=${(parsed[0] as any).ApiTypeId}, last: ApiTypeId=${(parsed[parsed.length - 1] as any).ApiTypeId}`)

const anonymized = anonymizeEvents(parsed)
const ndjson = anonymized.map((e) => JSON.stringify(e)).join('\n') + '\n'
writeFileSync(OUTPUT, ndjson)
console.log(`[extract-bust-fixture] wrote ${anonymized.length} events -> ${OUTPUT}`)
