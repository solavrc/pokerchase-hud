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
import { resolve } from 'node:path'
import { DEFAULT_FIXTURE } from '../config.ts'
import { extractFixture, type ExtractFixtureOptions } from './extract-fixture-core.ts'

export { extractFixture } from './extract-fixture-core.ts'

const parseArgs = (argv: string[]): ExtractFixtureOptions => {
  const positional: string[] = []
  let hands = 3
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--hands') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('--hands requires a value')
      hands = Number(value)
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
      'Usage: tsx e2e/tools/extract-fixture.ts <input.ndjson> [output.ndjson] [--hands N]'
    )
  }
  const output = positional[1] || DEFAULT_FIXTURE
  return { input: resolve(input), output: resolve(output), hands }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2))
  const result = extractFixture(options)
  console.log(
    `[extract-fixture] wrote ${result.lines} events (${result.hands} hands) from ${options.input} -> ${options.output}`
  )
}
