/**
 * Extracts a small, clean, anonymized fixture from a real captured NDJSON
 * (as produced by the extension's "download raw data" feature, one decoded
 * API event per line -- see docs/api-events.md). Reproducible: re-running
 * with the same source file and options produces byte-identical output.
 *
 * The source file is never touched/copied/committed -- only the small
 * anonymized slice this script writes is meant to be checked in.
 *
 * Usage:
 *   tsx e2e/tools/extract-fixture.ts <input.ndjson> [output.ndjson] [--hands N]
 *
 * Selection: starts at the first EVT_ENTRY_QUEUED (201) in the file (a
 * clean session start) and includes everything up to and including the
 * Nth EVT_HAND_RESULTS (306) after it (default N=3), so the fixture always
 * ends on a complete hand boundary.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { anonymizeEvents } from './anonymize.ts'
import { DEFAULT_FIXTURE } from '../config.ts'

const ApiType = {
  EVT_ENTRY_QUEUED: 201,
  EVT_HAND_RESULTS: 306,
} as const

interface Options {
  input: string
  output: string
  hands: number
}

const parseArgs = (argv: string[]): Options => {
  const positional = argv.filter((a) => !a.startsWith('--'))
  const handsFlagIndex = argv.indexOf('--hands')
  const hands = handsFlagIndex >= 0 ? Number(argv[handsFlagIndex + 1]) : 3
  const input = positional[0]
  if (!input) {
    throw new Error(
      'Usage: tsx e2e/tools/extract-fixture.ts <input.ndjson> [output.ndjson] [--hands N]'
    )
  }
  const output = positional[1] || DEFAULT_FIXTURE
  return { input: resolve(input), output: resolve(output), hands }
}

export const extractFixture = ({ input, output, hands }: Options): { lines: number; hands: number } => {
  const raw = readFileSync(input, 'utf-8')
  const allLines = raw.split('\n').filter((l) => l.trim().length > 0)

  const parsed: Array<{ ApiTypeId?: number; [key: string]: unknown }> = allLines.map((line) => JSON.parse(line))

  const startIdx = parsed.findIndex((e) => e.ApiTypeId === ApiType.EVT_ENTRY_QUEUED)
  if (startIdx === -1) {
    throw new Error(`No EVT_ENTRY_QUEUED (201) found in ${input} -- cannot find a clean session start`)
  }

  let handsSeen = 0
  let endIdx = -1
  for (let i = startIdx; i < parsed.length; i++) {
    if (parsed[i]!.ApiTypeId === ApiType.EVT_HAND_RESULTS) {
      handsSeen++
      if (handsSeen === hands) {
        endIdx = i
        break
      }
    }
  }
  if (endIdx === -1) {
    throw new Error(
      `Only found ${handsSeen} EVT_HAND_RESULTS (306) after the session start; requested ${hands}`
    )
  }

  const slice = parsed.slice(startIdx, endIdx + 1)
  const anonymized = anonymizeEvents(slice)
  const ndjson = anonymized.map((e) => JSON.stringify(e)).join('\n') + '\n'

  writeFileSync(output, ndjson)
  return { lines: anonymized.length, hands: handsSeen }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2))
  const result = extractFixture(options)
  console.log(
    `[extract-fixture] wrote ${result.lines} events (${result.hands} hands) from ${options.input} -> ${options.output}`
  )
}
