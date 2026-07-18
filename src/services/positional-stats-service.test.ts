/**
 * PositionalStatsService tests
 *
 * Builds a small synthetic dataset directly in a fake-indexeddb-backed
 * PokerChaseDB (bypassing the write-entity-stream ingestion pipeline) so the
 * expected per-position [numerator, denominator] pairs can be pinned down
 * exactly. Covers:
 *  - a BB walk hand (excluded from BB vpip/pfr denominators, but counted in handsN)
 *  - a steal-position open (CO) and a fold-to-steal (SB)
 *  - a hand with position derived from the player's own PREFLOP action row
 *  - an unknown-position legacy row (`position === -3`) and a hand with no
 *    recorded action + non-matching bigBlindUserId
 *  - a BTN hand exercising 3bet + a second BTN hand exercising steal + cbet
 *  - battleTypeFilter and handLimitFilter parity with calcStats semantics
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { PokerChaseDB } from '../db/poker-chase-db'
import PokerChaseService from './poker-chase-service'
import { getPositionalStats, clearPositionalStatsCache, buildCacheKey } from './positional-stats-service'
import { ActionDetail, ActionType, BattleType, PhaseType, Position } from '../types/game'
import type { Action, Hand } from '../types/entities'
import type { PositionalStatsBucketId } from '../types/stats'

const PLAYER_ID = 1

function makeHand(overrides: Partial<Hand> & { id: number }): Hand {
  return {
    seatUserIds: [1, 2, 3],
    winningPlayerIds: [],
    smallBlind: 100,
    bigBlind: 200,
    session: { battleType: BattleType.TOURNAMENT },
    results: [],
    ...overrides
  }
}

function makeAction(overrides: Partial<Action> & { handId: number, index: number, phase: PhaseType, actionType: ActionType, position: Position }): Action {
  return {
    playerId: PLAYER_ID,
    bet: 0,
    pot: 0,
    sidePot: [],
    actionDetails: [],
    ...overrides
  }
}

async function seedDataset(db: PokerChaseDB): Promise<void> {
  const hands: Hand[] = [
    // Hand 1: BB walk - hero posts BB, everyone folds uncalled, hero never acts.
    makeHand({ id: 1, bigBlindUserId: PLAYER_ID }),
    // Hand 2: BB, hero actually gets a preflop decision (checks).
    makeHand({ id: 2, bigBlindUserId: PLAYER_ID }),
    // Hand 3: CO steal-position open.
    makeHand({ id: 3, bigBlindUserId: 2, seatUserIds: [1, 2, 3, 4, 5] }),
    // Hand 4: UTG fold - position comes from the player's own preflop action row.
    makeHand({ id: 4, bigBlindUserId: 2, seatUserIds: [1, 2, 3, 4, 5, 6, 7] }),
    // Hand 5: unknown - legacy position=-3 row.
    makeHand({ id: 5, bigBlindUserId: 2, seatUserIds: [1, 2] }),
    // Hand 6: unknown - no recorded action at all, bigBlindUserId belongs to someone else.
    makeHand({ id: 6, bigBlindUserId: 2 }),
    // Hand 7: SB folds to a steal raise.
    makeHand({ id: 7, bigBlindUserId: 2, seatUserIds: [1, 2, 3, 4] }),
    // Hand 8: HJ fold.
    makeHand({ id: 8, bigBlindUserId: 2, seatUserIds: [1, 2, 3, 4, 5, 6] }),
    // Hand 9: BTN 3-bet (RING_GAME, for battleTypeFilter test).
    makeHand({ id: 9, bigBlindUserId: 2, session: { battleType: BattleType.RING_GAME } }),
    // Hand 10: BTN steal-open that continues into a flop c-bet (RING_GAME).
    makeHand({ id: 10, bigBlindUserId: 2, session: { battleType: BattleType.RING_GAME } }),
  ]

  const actions: Action[] = [
    makeAction({ handId: 2, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.CHECK, position: Position.BB, actionDetails: [] }),
    makeAction({ handId: 3, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.CO, actionDetails: [ActionDetail.VPIP, ActionDetail.STEAL_CHANCE, ActionDetail.STEAL] }),
    makeAction({ handId: 4, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.FOLD, position: Position.UTG, actionDetails: [] }),
    makeAction({ handId: 5, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.CALL, position: -3 as Position, actionDetails: [ActionDetail.VPIP] }),
    makeAction({ handId: 7, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.FOLD, position: Position.SB, actionDetails: [ActionDetail.FOLD_TO_STEAL_CHANCE, ActionDetail.FOLD_TO_STEAL] }),
    makeAction({ handId: 8, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.FOLD, position: Position.HJ, actionDetails: [] }),
    makeAction({ handId: 9, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.BTN, actionDetails: [ActionDetail.VPIP, ActionDetail.$3BET_CHANCE, ActionDetail.$3BET] }),
    makeAction({ handId: 10, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.BTN, actionDetails: [ActionDetail.VPIP, ActionDetail.STEAL_CHANCE, ActionDetail.STEAL] }),
    makeAction({ handId: 10, index: 1, phase: PhaseType.FLOP, actionType: ActionType.BET, position: Position.BTN, actionDetails: [ActionDetail.CBET_CHANCE, ActionDetail.CBET] }),
    // Hand 1 and Hand 6 intentionally have NO action rows for the player.
  ]

  await db.hands.bulkAdd(hands)
  await db.actions.bulkAdd(actions)
}

function zeroStats() {
  return { vpip: [0, 0], pfr: [0, 0], '3bet': [0, 0], steal: [0, 0], foldToSteal: [0, 0], cbet: [0, 0] }
}

function bucketOf(result: Awaited<ReturnType<typeof getPositionalStats>>, position: PositionalStatsBucketId) {
  const bucket = result.positions.find(p => p.position === position)
  if (!bucket) throw new Error(`bucket not found: ${String(position)}`)
  return bucket
}

describe('PositionalStatsService', () => {
  let db: PokerChaseDB
  let service: PokerChaseService

  beforeEach(async () => {
    clearPositionalStatsCache()
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = new PokerChaseService({ db })
    await service.ready
    await seedDataset(db)
  })

  afterEach(async () => {
    db.close()
    await db.delete()
  })

  test('emits all 7 buckets (BTN/CO/HJ/UTG/SB/BB/unknown) with correct handsN', async () => {
    const result = await getPositionalStats(db, service, PLAYER_ID)

    expect(result.positions.map(p => p.position)).toEqual([
      Position.BTN, Position.CO, Position.HJ, Position.UTG, Position.SB, Position.BB, 'unknown'
    ])
    expect(bucketOf(result, Position.BTN).handsN).toBe(2)
    expect(bucketOf(result, Position.CO).handsN).toBe(1)
    expect(bucketOf(result, Position.HJ).handsN).toBe(1)
    expect(bucketOf(result, Position.UTG).handsN).toBe(1)
    expect(bucketOf(result, Position.SB).handsN).toBe(1)
    expect(bucketOf(result, Position.BB).handsN).toBe(2) // walk (hand 1) + real BB decision (hand 2)
    expect(bucketOf(result, 'unknown').handsN).toBe(2) // legacy position=-3 (hand 5) + no-action/foreign-BB (hand 6)
    expect(typeof result.computedAt).toBe('number')
  })

  test('BB walk hand is excluded from vpip/pfr denominators but counted in handsN', async () => {
    const result = await getPositionalStats(db, service, PLAYER_ID)
    const bb = bucketOf(result, Position.BB)

    expect(bb.handsN).toBe(2)
    // Only hand 2 (the real BB decision) is an "opportunity"; hand 1 (the walk) is excluded.
    expect(bb.stats.vpip).toEqual([0, 1])
    expect(bb.stats.pfr).toEqual([0, 1])
    expect(bb.stats.steal).toEqual([0, 0])
    expect(bb.stats.foldToSteal).toEqual([0, 0])
    expect(bb.stats['3bet']).toEqual([0, 0])
    expect(bb.stats.cbet).toEqual([0, 0])
  })

  test('CO steal-position open is bucketed by the preflop action position', async () => {
    const result = await getPositionalStats(db, service, PLAYER_ID)
    const co = bucketOf(result, Position.CO)

    expect(co.handsN).toBe(1)
    expect(co.stats.vpip).toEqual([1, 1])
    expect(co.stats.pfr).toEqual([1, 1])
    expect(co.stats.steal).toEqual([1, 1])
    expect(co.stats.foldToSteal).toEqual([0, 0])
    expect(co.stats['3bet']).toEqual([0, 0])
    expect(co.stats.cbet).toEqual([0, 0])
  })

  test('UTG fold counts as a vpip/pfr opportunity with no execution', async () => {
    const result = await getPositionalStats(db, service, PLAYER_ID)
    const utg = bucketOf(result, Position.UTG)

    expect(utg.handsN).toBe(1)
    expect(utg.stats.vpip).toEqual([0, 1])
    expect(utg.stats.pfr).toEqual([0, 1])
  })

  test('SB fold-to-steal is captured', async () => {
    const result = await getPositionalStats(db, service, PLAYER_ID)
    const sb = bucketOf(result, Position.SB)

    expect(sb.handsN).toBe(1)
    expect(sb.stats.foldToSteal).toEqual([1, 1])
    expect(sb.stats.vpip).toEqual([0, 1])
    expect(sb.stats.pfr).toEqual([0, 1])
  })

  test('BTN bucket aggregates a 3bet hand and a steal+cbet hand', async () => {
    const result = await getPositionalStats(db, service, PLAYER_ID)
    const btn = bucketOf(result, Position.BTN)

    expect(btn.handsN).toBe(2)
    expect(btn.stats.vpip).toEqual([2, 2])
    expect(btn.stats.pfr).toEqual([2, 2])
    expect(btn.stats['3bet']).toEqual([1, 1])
    expect(btn.stats.steal).toEqual([1, 1])
    expect(btn.stats.cbet).toEqual([1, 1])
    expect(btn.stats.foldToSteal).toEqual([0, 0])
  })

  test('unknown bucket collects legacy position=-3 rows and no-action/foreign-BB hands', async () => {
    const result = await getPositionalStats(db, service, PLAYER_ID)
    const unknown = bucketOf(result, 'unknown')

    expect(unknown.handsN).toBe(2)
    // Hand 5's CALL was tagged VPIP at write time (VPIP detection isn't position-aware);
    // hand 6 contributes an opportunity with no action.
    expect(unknown.stats.vpip).toEqual([1, 2])
    expect(unknown.stats.pfr).toEqual([0, 2])
  })

  test('battleTypeFilter narrows hands exactly like calcStats before bucketing', async () => {
    service.battleTypeFilter = [BattleType.RING_GAME]
    const result = await getPositionalStats(db, service, PLAYER_ID)

    const btn = bucketOf(result, Position.BTN)
    expect(btn.handsN).toBe(2)
    expect(btn.stats.vpip).toEqual([2, 2])
    expect(btn.stats['3bet']).toEqual([1, 1])
    expect(btn.stats.steal).toEqual([1, 1])
    expect(btn.stats.cbet).toEqual([1, 1])

    for (const position of [Position.CO, Position.HJ, Position.UTG, Position.SB, Position.BB, 'unknown' as const]) {
      const bucket = bucketOf(result, position)
      expect(bucket.handsN).toBe(0)
      expect(bucket.stats).toEqual(zeroStats())
    }
  })

  test('handLimitFilter keeps only the most recent N hands, sorted by id desc like calcStats', async () => {
    service.handLimitFilter = 3
    const result = await getPositionalStats(db, service, PLAYER_ID)

    // Top 3 hands by id: 10 (BTN), 9 (BTN), 8 (HJ)
    const btn = bucketOf(result, Position.BTN)
    expect(btn.handsN).toBe(2)
    expect(btn.stats.vpip).toEqual([2, 2])
    expect(btn.stats['3bet']).toEqual([1, 1])
    expect(btn.stats.steal).toEqual([1, 1])
    expect(btn.stats.cbet).toEqual([1, 1])

    const hj = bucketOf(result, Position.HJ)
    expect(hj.handsN).toBe(1)
    expect(hj.stats.vpip).toEqual([0, 1])
    expect(hj.stats.pfr).toEqual([0, 1])

    for (const position of [Position.CO, Position.UTG, Position.SB, Position.BB, 'unknown' as const]) {
      const bucket = bucketOf(result, position)
      expect(bucket.handsN).toBe(0)
    }
  })

  test('battleTypeFilter that matches nothing returns all-empty buckets, not an error', async () => {
    service.battleTypeFilter = [BattleType.FRIEND_RING_GAME]
    const result = await getPositionalStats(db, service, PLAYER_ID)

    expect(result.positions).toHaveLength(7)
    for (const bucket of result.positions) {
      expect(bucket.handsN).toBe(0)
      expect(bucket.stats).toEqual(zeroStats())
    }
  })

  test('brand-new player with zero hands returns all-empty buckets', async () => {
    const result = await getPositionalStats(db, service, 999)

    expect(result.positions).toHaveLength(7)
    for (const bucket of result.positions) {
      expect(bucket.handsN).toBe(0)
      expect(bucket.stats).toEqual(zeroStats())
    }
  })

  describe('tableSizeFilter (C案: table-size / players-dealt filter)', () => {
    // Of the 10 seeded hands, only hand 7 (seatUserIds [1,2,3,4], 4-max full) and
    // hand 8 (seatUserIds [1,2,3,4,5,6], 6-max full) classify into a known layer
    // at all -- every other hand's seatUserIds length (2, 3, 5 or 7) doesn't match
    // the 4-max/6-max rule and classifies as null (unclassifiable).

    test('narrows hands exactly like calcStats before bucketing', async () => {
      service.tableSizeFilter = ['full']
      const result = await getPositionalStats(db, service, PLAYER_ID)

      const sb = bucketOf(result, Position.SB) // hand 7
      expect(sb.handsN).toBe(1)
      expect(sb.stats.foldToSteal).toEqual([1, 1])
      expect(sb.stats.vpip).toEqual([0, 1])

      const hj = bucketOf(result, Position.HJ) // hand 8
      expect(hj.handsN).toBe(1)
      expect(hj.stats.vpip).toEqual([0, 1])
      expect(hj.stats.pfr).toEqual([0, 1])

      for (const position of [Position.BTN, Position.CO, Position.UTG, Position.BB, 'unknown' as const]) {
        const bucket = bucketOf(result, position)
        expect(bucket.handsN).toBe(0)
        expect(bucket.stats).toEqual(zeroStats())
      }
    })

    test('a table-size filter matching nothing returns all-empty buckets, not an error', async () => {
      // None of the 10 seeded hands classify as 'hu'.
      service.tableSizeFilter = ['hu']
      const result = await getPositionalStats(db, service, PLAYER_ID)

      expect(result.positions).toHaveLength(7)
      for (const bucket of result.positions) {
        expect(bucket.handsN).toBe(0)
        expect(bucket.stats).toEqual(zeroStats())
      }
    })

    test('ordering: table-size filter narrows the population BEFORE handLimit caps it', async () => {
      // ['full'] narrows to hands {7, 8}. handLimit=1 must then keep only the
      // more recent of *those two* (hand 8, HJ) -- not the most recent hand
      // overall (hand 10, BTN, which isn't in the 'full' layer at all).
      service.tableSizeFilter = ['full']
      service.handLimitFilter = 1
      const result = await getPositionalStats(db, service, PLAYER_ID)

      const hj = bucketOf(result, Position.HJ)
      expect(hj.handsN).toBe(1)

      for (const position of [Position.BTN, Position.CO, Position.UTG, Position.SB, Position.BB, 'unknown' as const]) {
        expect(bucketOf(result, position).handsN).toBe(0)
      }
    })

    test('default/undefined tableSizeFilter is a no-op -- total handsN across buckets matches the unfiltered baseline (10)', async () => {
      expect(service.tableSizeFilter).toBeUndefined()
      const result = await getPositionalStats(db, service, PLAYER_ID)
      const totalHandsN = result.positions.reduce((sum, p) => sum + p.handsN, 0)
      expect(totalHandsN).toBe(10) // all 10 seeded hands accounted for, matching the "emits all 7 buckets" test above
    })

    test('cache key differs when tableSizeFilter differs, and when it matches the same key stays stable', () => {
      const withoutFilter = { ...service, tableSizeFilter: undefined } as PokerChaseService
      const withFull = { ...service, tableSizeFilter: ['full'] } as PokerChaseService
      const withFullAgain = { ...service, tableSizeFilter: ['full'] } as PokerChaseService
      const withHu = { ...service, tableSizeFilter: ['hu'] } as PokerChaseService

      const keyNone = buildCacheKey(PLAYER_ID, withoutFilter)
      const keyFull = buildCacheKey(PLAYER_ID, withFull)
      const keyFullAgain = buildCacheKey(PLAYER_ID, withFullAgain)
      const keyHu = buildCacheKey(PLAYER_ID, withHu)

      expect(keyFull).not.toBe(keyNone)
      expect(keyFull).not.toBe(keyHu)
      expect(keyFull).toBe(keyFullAgain) // same filter state -> same key (stable, cache-hit-able)
    })
  })
})
