import { readFileSync, writeFileSync } from 'node:fs'
import { anonymizeEvents } from './anonymize.ts'
import { orderApiEventsForReplay, type RawApiEvent } from '../../src/utils/api-event-key.ts'

const ApiType = {
  EVT_ENTRY_QUEUED: 201,
  EVT_HAND_RESULTS: 306,
} as const

export interface ExtractFixtureOptions {
  input: string
  output: string
  hands: number
}

export const extractFixture = ({ input, output, hands }: ExtractFixtureOptions): { lines: number; hands: number } => {
  const raw = readFileSync(input, 'utf-8')
  const allLines = raw.split('\n').filter((line) => line.trim().length > 0)

  // Legacy raw exports use canonical primary-key line order, not original wire
  // order. Apply the same strict replay resolver as production consumers before
  // selecting the fixture slice so proven equal-ms snapshot/action transitions
  // are not frozen into a fixture backwards.
  const parsed = orderApiEventsForReplay(
    allLines.map((line) => JSON.parse(line)) as RawApiEvent[]
  )

  const startIdx = parsed.findIndex((event) => event.ApiTypeId === ApiType.EVT_ENTRY_QUEUED)
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
  const ndjson = anonymized.map((event) => JSON.stringify(event)).join('\n') + '\n'

  writeFileSync(output, ndjson)
  return { lines: anonymized.length, hands: handsSeen }
}
