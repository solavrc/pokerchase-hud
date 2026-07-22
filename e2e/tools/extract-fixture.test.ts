import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractFixture } from './extract-fixture-core'

describe('extractFixture', () => {
  let tempDirectory: string | undefined

  afterEach(() => {
    if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true })
    tempDirectory = undefined
  })

  it('normalizes a proven equal-ms snapshot/action transition before freezing the fixture', () => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'pokerchase-fixture-'))
    const input = join(tempDirectory, 'input.ndjson')
    const output = join(tempDirectory, 'output.ndjson')
    const events = [
      { timestamp: 100, ApiTypeId: 201, Id: 'session', BattleType: 0 },
      { timestamp: 110, ApiTypeId: 303 },
      {
        timestamp: 120,
        ApiTypeId: 304,
        SeatIndex: 0,
        BetChip: 1_379,
        Chip: 8_621,
        Progress: { Phase: 2, Pot: 5_558 }
      },
      {
        timestamp: 120,
        ApiTypeId: 305,
        Progress: { Phase: 2, Pot: 4_179, NextActionSeat: 0 },
        Player: { SeatIndex: 0, BetChip: 0, Chip: 10_000 }
      },
      { timestamp: 130, ApiTypeId: 306, HandId: 1 }
    ]
    writeFileSync(input, `${events.map(event => JSON.stringify(event)).join('\n')}\n`)

    expect(extractFixture({ input, output, hands: 1 })).toEqual({ lines: 5, hands: 1 })

    const extracted = readFileSync(output, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(extracted.map(event => event.ApiTypeId)).toEqual([201, 303, 305, 304, 306])
  })
})
