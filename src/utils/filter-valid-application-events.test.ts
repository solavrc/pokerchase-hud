/**
 * filterValidApplicationEvents (src/utils/database-utils.ts)
 *
 * Uses the real Zod schemas (no jest.mock('../types/api')) — unlike
 * database-utils.test.ts, which mocks Dexie and '../types/api' wholesale for
 * its own unit tests. This function's entire job is re-running real
 * validation over raw apiEvents rows, so a real schema is the point.
 */
import { filterValidApplicationEvents } from './database-utils'

describe('filterValidApplicationEvents', () => {
  it('passes through a valid application event unchanged', async () => {
    const validEntryEvent = {
      ApiTypeId: 201, timestamp: 100, Code: 0, BattleType: 0, Id: 'stage000_003', IsRetire: false
    }

    const result = await filterValidApplicationEvents([validEntryEvent])

    expect(result).toEqual([validEntryEvent])
  })

  it('drops a known non-application event even though it parses fine (202 keepalive)', async () => {
    const nonAppEvent = { ApiTypeId: 202, timestamp: 200, Code: 0 }

    const result = await filterValidApplicationEvents([nonAppEvent])

    expect(result).toEqual([])
  })

  it('drops an application-type event whose payload fails the current schema', async () => {
    // EVT_DEAL (303) missing every required field
    const brokenAppEvent = { ApiTypeId: 303, timestamp: 300 }

    const result = await filterValidApplicationEvents([brokenAppEvent])

    expect(result).toEqual([])
  })

  it('drops an event with an ApiTypeId entirely unknown to apiEventSchemas', async () => {
    const unknownEvent = { ApiTypeId: 9999, timestamp: 400 }

    const result = await filterValidApplicationEvents([unknownEvent])

    expect(result).toEqual([])
  })

  it('handles a mixed batch, keeping only the valid application events and preserving order', async () => {
    const validEntry = { ApiTypeId: 201, timestamp: 1, Code: 0, BattleType: 0, Id: 'a', IsRetire: false }
    const nonApp = { ApiTypeId: 202, timestamp: 2, Code: 0 }
    const broken = { ApiTypeId: 303, timestamp: 3 }
    const unknown = { ApiTypeId: 9999, timestamp: 4 }
    const validEntry2 = { ApiTypeId: 201, timestamp: 5, Code: 0, BattleType: 1, Id: '6078', IsRetire: false }

    const result = await filterValidApplicationEvents([validEntry, nonApp, broken, unknown, validEntry2])

    expect(result).toEqual([validEntry, validEntry2])
  })

  it('returns an empty array for an empty input', async () => {
    expect(await filterValidApplicationEvents([])).toEqual([])
  })

  it('does not throw on completely non-object/malformed inputs mixed into the batch', async () => {
    const validEntry = { ApiTypeId: 201, timestamp: 1, Code: 0, BattleType: 0, Id: 'a', IsRetire: false }

    const result = await filterValidApplicationEvents([null, undefined, 'garbage', 42, validEntry])

    expect(result).toEqual([validEntry])
  })
})
