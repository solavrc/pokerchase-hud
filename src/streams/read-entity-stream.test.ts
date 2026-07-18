/**
 * ReadEntityStream.calcStats tests (C案: table-size / players-dealt filter)
 *
 * Builds a small synthetic dataset directly in a fake-indexeddb-backed
 * PokerChaseDB (bypassing the write-entity-stream ingestion pipeline,
 * following the same approach as positional-stats-service.test.ts) and
 * drives `service.statsOutputStream` end-to-end via `.write()` / the 'data'
 * event, since `calcStats` itself is private.
 *
 * Focus: the new `tableSizeFilter` predicate is applied at the SAME point
 * as `battleTypeFilter` (before `handLimitFilter`), with the same
 * filter-then-limit ordering, and defaults to a no-op when unset.
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { PokerChaseDB } from '../db/poker-chase-db'
import PokerChaseService from '../services/poker-chase-service'
import { BattleType } from '../types/game'
import type { Hand } from '../types/entities'
import type { PlayerStats, StatResult } from '../types'

const PLAYER_ID = 1
const SEAT_USER_IDS = [PLAYER_ID, 2, 3, 4, 5, 6]

function makeHand(overrides: Partial<Hand> & { id: number, seatUserIds: number[] }): Hand {
  return {
    winningPlayerIds: [],
    smallBlind: 100,
    bigBlind: 200,
    session: { battleType: BattleType.TOURNAMENT },
    results: [],
    ...overrides
  }
}

/** Drives the stream and resolves with the stats emitted for this single write(). */
function runCalcStats(service: PokerChaseService, seatUserIds: number[]): Promise<PlayerStats[]> {
  return new Promise((resolve, reject) => {
    const onData = (stats: PlayerStats[]) => {
      service.statsOutputStream.off('data', onData)
      resolve(stats)
    }
    service.statsOutputStream.on('data', onData)
    service.statsOutputStream.on('error', reject)
    service.statsOutputStream.write(seatUserIds)
  })
}

function handsStatOf(stats: PlayerStats[], playerId: number): StatResult | undefined {
  const player = stats.find(s => s.playerId === playerId)
  if (!player || !('statResults' in player) || !player.statResults) return undefined
  return player.statResults.find(r => r.id === 'hands')
}

describe('ReadEntityStream.calcStats -- table-size filter (C案)', () => {
  let db: PokerChaseDB
  let service: PokerChaseService

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = new PokerChaseService({ db })
    await service.ready

    const hands: Hand[] = [
      makeHand({ id: 1, seatUserIds: [1, 2, 3, 4, 5, 6] }),      // full (6-max, 6 dealt)
      makeHand({ id: 2, seatUserIds: [1, 2, 3, 4, 5, -1] }),     // full (6-max, 5 dealt)
      makeHand({ id: 3, seatUserIds: [1, 2, 3, 4, -1, -1] }),    // 4p
      makeHand({ id: 4, seatUserIds: [1, 2, 3, -1, -1, -1] }),   // 3p
      makeHand({ id: 5, seatUserIds: [1, 2, -1, -1, -1, -1] }),  // hu
      makeHand({ id: 6, seatUserIds: [1, 2, -1, -1, -1, -1] }),  // hu
    ]
    await db.hands.bulkAdd(hands)
  })

  afterEach(async () => {
    db.close()
    await db.delete()
  })

  test('default (tableSizeFilter unset) is a no-op -- all 6 hands counted', async () => {
    const stats = await runCalcStats(service, SEAT_USER_IDS)
    expect(handsStatOf(stats, PLAYER_ID)?.value).toBe(6)
  })

  test('filtering to HU only narrows the hand population for a plain stat (hands)', async () => {
    service.tableSizeFilter = ['hu']
    const stats = await runCalcStats(service, SEAT_USER_IDS)
    expect(handsStatOf(stats, PLAYER_ID)?.value).toBe(2) // hands 5 and 6
  })

  test('filtering to full+4p narrows to the matching hands', async () => {
    service.tableSizeFilter = ['full', '4p']
    const stats = await runCalcStats(service, SEAT_USER_IDS)
    expect(handsStatOf(stats, PLAYER_ID)?.value).toBe(3) // hands 1, 2, 3
  })

  test('a table-size filter matching nothing returns empty statResults, not an error', async () => {
    // Player 6 only ever appears in hand 1 (the 6-dealt 'full' hand). Filtering
    // to 'hu' leaves them with zero matching hands, even though they had hands
    // before the filter (originalHandsCount > 0) -- same early-return shape as
    // an unmatched battleTypeFilter.
    service.tableSizeFilter = ['hu']
    const stats = await runCalcStats(service, [6, 1, 2, 3, 4, 5])
    const player6 = stats.find(s => s.playerId === 6)
    expect(player6 && 'statResults' in player6 ? player6.statResults : undefined).toEqual([])
  })

  test('ordering: table-size filter applies BEFORE handLimit (filter narrows population first, then limit caps it)', async () => {
    // Only hands 1, 2, 3 match full+4p (3 hands). handLimit=2 should keep the
    // most recent 2 *within that filtered set* (ids 3, 2), not the most
    // recent 2 of the unfiltered 6 hands (which would be ids 6, 5 -- both hu).
    service.tableSizeFilter = ['full', '4p']
    service.handLimitFilter = 2
    const stats = await runCalcStats(service, SEAT_USER_IDS)
    expect(handsStatOf(stats, PLAYER_ID)?.value).toBe(2)
  })

  test('handLimit alone (no table-size filter) still behaves as before -- most recent N of all hands', async () => {
    service.handLimitFilter = 2
    const stats = await runCalcStats(service, SEAT_USER_IDS)
    expect(handsStatOf(stats, PLAYER_ID)?.value).toBe(2) // hands 6, 5 (most recent ids)
  })

  test('table-size filter composes with battleTypeFilter at the same application point', async () => {
    // Re-tag hand 1 and 2 (full layer) as RING_GAME; battleTypeFilter narrows to TOURNAMENT only.
    await db.hands.update(1, { session: { battleType: BattleType.RING_GAME } })
    service.battleTypeFilter = [BattleType.TOURNAMENT]
    service.tableSizeFilter = ['full', '4p']
    const stats = await runCalcStats(service, SEAT_USER_IDS)
    // full+4p = hands {1,2,3}; battleType=TOURNAMENT excludes hand 1 -> hands {2,3} remain.
    expect(handsStatOf(stats, PLAYER_ID)?.value).toBe(2)
  })
})
