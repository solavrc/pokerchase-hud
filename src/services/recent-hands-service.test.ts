/**
 * RecentHandsService tests
 *
 * Builds a small synthetic dataset directly in a fake-indexeddb-backed
 * PokerChaseDB (bypassing the write-entity-stream ingestion pipeline, same
 * approach as positional-stats-service.test.ts) so the expected per-hand
 * fields can be pinned down exactly. Covers:
 *  - preflop-line taxonomy: open / 3bet / cold-call / call / limp / fold /
 *    "-F" suffix / BB-check / BB-walk / no-data
 *  - hole-card visibility: shown only for showdown RankTypes with actually
 *    valid HoleCards; NO_CALL/FOLD_OPEN never show, SHOWDOWN_MUCK without
 *    valid cards doesn't show either
 *  - newest-first ordering + limit
 *  - battleType/tableSize filter application (handLimitFilter NOT applied)
 *  - cache key differs by playerId/filters/limit
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { PokerChaseDB } from '../db/poker-chase-db'
import PokerChaseService from './poker-chase-service'
import {
  getRecentHands,
  clearRecentHandsCache,
  buildRecentHandsCacheKey,
  derivePreflopLine,
  DEFAULT_RECENT_HANDS_LIMIT,
} from './recent-hands-service'
import { ActionType, BattleType, PhaseType, Position, RankType } from '../types/game'
import type { Action, Hand } from '../types/entities'

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

describe('RecentHandsService', () => {
  let db: PokerChaseDB
  let service: PokerChaseService

  beforeEach(async () => {
    clearRecentHandsCache()
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = new PokerChaseService({ db })
    await service.ready
  })

  afterEach(async () => {
    db.close()
    await db.delete()
  })

  describe('getRecentHands: ordering, limit, filters', () => {
    beforeEach(async () => {
      const hands: Hand[] = [1, 2, 3, 4, 5].map(id =>
        makeHand({
          id,
          approxTimestamp: id * 1000,
          session: { battleType: id <= 3 ? BattleType.TOURNAMENT : BattleType.RING_GAME },
          results: [{ UserId: PLAYER_ID, HandRanking: 1, Ranking: -2, RewardChip: 0, RankType: RankType.NO_CALL, Hands: [], HoleCards: [] }]
        })
      )
      await db.hands.bulkAdd(hands)
    })

    test('returns hands newest-first (by hand id) and applies the limit', async () => {
      const result = await getRecentHands(db, service, PLAYER_ID, 3)
      expect(result.hands.map(h => h.handId)).toEqual([5, 4, 3])
      expect(typeof result.computedAt).toBe('number')
    })

    test('defaults to DEFAULT_RECENT_HANDS_LIMIT when limit is omitted', async () => {
      const result = await getRecentHands(db, service, PLAYER_ID)
      expect(result.hands).toHaveLength(Math.min(5, DEFAULT_RECENT_HANDS_LIMIT))
    })

    test('battleTypeFilter narrows hands, independent of handLimitFilter (which does not apply here)', async () => {
      service.battleTypeFilter = [BattleType.RING_GAME]
      service.handLimitFilter = 1 // must be ignored entirely by this feature
      const result = await getRecentHands(db, service, PLAYER_ID, 10)
      expect(result.hands.map(h => h.handId)).toEqual([5, 4])
    })

    test('brand-new player with zero hands returns an empty list, not an error', async () => {
      const result = await getRecentHands(db, service, 999)
      expect(result.hands).toEqual([])
    })
  })

  describe('preflop-line taxonomy', () => {
    async function lineFor(actions: Action[], handOverrides: Partial<Hand> = {}): Promise<string | null> {
      const hand = makeHand({ id: 1, bigBlindUserId: 2, seatUserIds: [1, 2, 3, 4, 5], ...handOverrides })
      await db.hands.add(hand)
      if (actions.length > 0) await db.actions.bulkAdd(actions)
      const result = await getRecentHands(db, service, PLAYER_ID, 10)
      return result.hands[0]!.preflopLine
    }

    test('open: first preflop action is a RAISE facing no prior bet/raise', async () => {
      const line = await lineFor([
        makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.BTN }),
      ])
      expect(line).toBe('Open')
    })

    test('3bet: RAISE facing exactly one prior raise (opponent open)', async () => {
      const line = await lineFor([
        // Opponent's open (phasePrevBetCount=1 at write time), then hero's 3bet.
        makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.UTG, playerId: 2 }),
        makeAction({ handId: 1, index: 1, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.BTN, playerId: PLAYER_ID }),
      ])
      expect(line).toBe('3Bet')
    })

    test('cold-call: player\'s first preflop action is a CALL facing a prior raise', async () => {
      const line = await lineFor([
        makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.UTG, playerId: 2 }),
        makeAction({ handId: 1, index: 1, phase: PhaseType.PREFLOP, actionType: ActionType.CALL, position: Position.BTN, playerId: PLAYER_ID }),
      ])
      expect(line).toBe('ColdCall')
    })

    test('call: CALL facing a raise, after the player already had a preflop line (limped then called a raise)', async () => {
      const line = await lineFor([
        makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.CALL, position: Position.UTG, playerId: PLAYER_ID }), // limp
        makeAction({ handId: 1, index: 1, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.BTN, playerId: 2 }),
        makeAction({ handId: 1, index: 2, phase: PhaseType.PREFLOP, actionType: ActionType.CALL, position: Position.UTG, playerId: PLAYER_ID }),
      ])
      expect(line).toBe('Call')
    })

    test('limp: first preflop action is a CALL with no prior raise (just the blind)', async () => {
      const line = await lineFor([
        makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.CALL, position: Position.UTG }),
      ])
      expect(line).toBe('Limp')
    })

    test('fold: only preflop action is a FOLD (no preceding line)', async () => {
      const line = await lineFor([
        makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.FOLD, position: Position.UTG }),
      ])
      expect(line).toBe('Fold')
    })

    test('-F suffix: opened, then folded to a re-raise -> Open-F', async () => {
      const line = await lineFor([
        makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.BTN, playerId: PLAYER_ID }),
        makeAction({ handId: 1, index: 1, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.SB, playerId: 2 }),
        makeAction({ handId: 1, index: 2, phase: PhaseType.PREFLOP, actionType: ActionType.FOLD, position: Position.BTN, playerId: PLAYER_ID }),
      ])
      expect(line).toBe('Open-F')
    })

    test('-F suffix: 3bet, then folded to a 4bet -> 3Bet-F', async () => {
      const line = await lineFor([
        makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.UTG, playerId: 2 }),
        makeAction({ handId: 1, index: 1, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.BTN, playerId: PLAYER_ID }), // 3bet
        makeAction({ handId: 1, index: 2, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.UTG, playerId: 2 }), // 4bet
        makeAction({ handId: 1, index: 3, phase: PhaseType.PREFLOP, actionType: ActionType.FOLD, position: Position.BTN, playerId: PLAYER_ID }),
      ])
      expect(line).toBe('3Bet-F')
    })

    test('BB-check-walk: no preflop action at all + player was BB -> Walk', async () => {
      const line = await lineFor([], { bigBlindUserId: PLAYER_ID })
      expect(line).toBe('Walk')
    })

    test('BB-check-walk: BB checks their option after being limped to -> Check', async () => {
      const line = await lineFor([
        makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.CHECK, position: Position.BB }),
      ], { bigBlindUserId: PLAYER_ID })
      expect(line).toBe('Check')
    })

    test('no data: no preflop action and player was not BB -> null', async () => {
      const line = await lineFor([], { bigBlindUserId: 2 })
      expect(line).toBeNull()
    })

    test('derivePreflopLine is directly unit-testable without going through getRecentHands', () => {
      const hand = makeHand({ id: 42, bigBlindUserId: 2 })
      const actionsByHandId = new Map([[42, [
        makeAction({ handId: 42, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.BTN }),
      ]]])
      expect(derivePreflopLine(hand, PLAYER_ID, actionsByHandId)).toBe('Open')
    })
  })

  describe('hole-card visibility', () => {
    let nextHandId = 1

    async function holeCardsFor(rankType: RankType, holeCards: number[]): Promise<string[] | null> {
      const hand = makeHand({
        id: nextHandId++,
        results: [{ UserId: PLAYER_ID, HandRanking: rankType <= 9 ? 1 : -1, Ranking: -2, RewardChip: 0, RankType: rankType, Hands: [], HoleCards: holeCards }]
      })
      await db.hands.add(hand)
      const result = await getRecentHands(db, service, PLAYER_ID, 1)
      return result.hands[0]!.holeCards
    }

    test('real showdown comparison with valid cards -> shown', async () => {
      expect(await holeCardsFor(RankType.ONE_PAIR, [48, 49])).toEqual(['As', 'Ah'])
    })

    test('SHOWDOWN_MUCK (11) with valid cards (shown then technically lost/mucked-but-sent) -> shown', async () => {
      expect(await holeCardsFor(RankType.SHOWDOWN_MUCK, [48, 49])).toEqual(['As', 'Ah'])
    })

    test('SHOWDOWN_MUCK (11) without valid cards (actually mucked, server sends nothing) -> hidden', async () => {
      expect(await holeCardsFor(RankType.SHOWDOWN_MUCK, [])).toBeNull()
      expect(await holeCardsFor(RankType.SHOWDOWN_MUCK, [-1, -1])).toBeNull()
    })

    test('NO_CALL (10) never shows, even if HoleCards happened to contain values', async () => {
      expect(await holeCardsFor(RankType.NO_CALL, [])).toBeNull()
      expect(await holeCardsFor(RankType.NO_CALL, [48, 49])).toBeNull()
    })

    test('FOLD_OPEN (12) never shows, even though the server sends real revealed cards for it', async () => {
      expect(await holeCardsFor(RankType.FOLD_OPEN, [48, 49])).toBeNull()
    })

    test('player absent from Results (e.g. disconnect) -> hidden, not an error', async () => {
      const hand = makeHand({ id: 1, results: [] })
      await db.hands.add(hand)
      const result = await getRecentHands(db, service, PLAYER_ID, 10)
      expect(result.hands[0]!.holeCards).toBeNull()
      expect(result.hands[0]!.wentToShowdown).toBe(false)
      expect(result.hands[0]!.won).toBe(false)
      expect(result.hands[0]!.netChips).toBeNull()
    })
  })

  describe('won / netChips / wentToShowdown / sawFlop', () => {
    test('won hand: RewardChip>0 -> won=true, netChips=RewardChip', async () => {
      const hand = makeHand({
        id: 1,
        results: [{ UserId: PLAYER_ID, HandRanking: 1, Ranking: -2, RewardChip: 1240, RankType: RankType.NO_CALL, Hands: [], HoleCards: [] }]
      })
      await db.hands.add(hand)
      const result = await getRecentHands(db, service, PLAYER_ID, 10)
      expect(result.hands[0]!.won).toBe(true)
      expect(result.hands[0]!.netChips).toBe(1240)
      expect(result.hands[0]!.wentToShowdown).toBe(false) // NO_CALL is not a showdown
    })

    test('lost hand: RewardChip=0 -> won=false, netChips=null', async () => {
      const hand = makeHand({
        id: 1,
        results: [{ UserId: PLAYER_ID, HandRanking: -1, Ranking: -2, RewardChip: 0, RankType: RankType.ONE_PAIR, Hands: [], HoleCards: [48, 49] }]
      })
      await db.hands.add(hand)
      const result = await getRecentHands(db, service, PLAYER_ID, 10)
      expect(result.hands[0]!.won).toBe(false)
      expect(result.hands[0]!.netChips).toBeNull()
      expect(result.hands[0]!.wentToShowdown).toBe(true) // real comparison RankType
    })

    test('sawFlop: true when the FLOP phase entry includes the player', async () => {
      const hand = makeHand({ id: 1, results: [] })
      await db.hands.add(hand)
      await db.phases.add({ handId: 1, phase: PhaseType.FLOP, seatUserIds: [PLAYER_ID, 2], communityCards: [0, 1, 2] })
      const result = await getRecentHands(db, service, PLAYER_ID, 10)
      expect(result.hands[0]!.sawFlop).toBe(true)
    })

    test('sawFlop: false when no FLOP phase exists and the hand never reached showdown', async () => {
      const hand = makeHand({
        id: 1,
        results: [{ UserId: PLAYER_ID, HandRanking: 1, Ranking: -2, RewardChip: 100, RankType: RankType.NO_CALL, Hands: [], HoleCards: [] }]
      })
      await db.hands.add(hand)
      const result = await getRecentHands(db, service, PLAYER_ID, 10)
      expect(result.hands[0]!.sawFlop).toBe(false)
    })

    test('sawFlop: true (fallback) when no FLOP phase was recorded (preflop-allin runout) but showdown was reached', async () => {
      const hand = makeHand({
        id: 1,
        results: [{ UserId: PLAYER_ID, HandRanking: 1, Ranking: -2, RewardChip: 500, RankType: RankType.ONE_PAIR, Hands: [], HoleCards: [48, 49] }]
      })
      await db.hands.add(hand)
      // Intentionally no phases rows at all (simulates the all-in-preflop-no-DEAL_ROUND edge case).
      const result = await getRecentHands(db, service, PLAYER_ID, 10)
      expect(result.hands[0]!.sawFlop).toBe(true)
    })
  })

  describe('position', () => {
    test('resolved from the player\'s own PREFLOP action row', async () => {
      const hand = makeHand({ id: 1, bigBlindUserId: 2 })
      await db.hands.add(hand)
      await db.actions.add(makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.CO }))
      const result = await getRecentHands(db, service, PLAYER_ID, 10)
      expect(result.hands[0]!.position).toBe(Position.CO)
    })

    test('falls back to BB when there is no preflop action and the player was bigBlindUserId', async () => {
      const hand = makeHand({ id: 1, bigBlindUserId: PLAYER_ID })
      await db.hands.add(hand)
      const result = await getRecentHands(db, service, PLAYER_ID, 10)
      expect(result.hands[0]!.position).toBe(Position.BB)
    })

    test('null for legacy position=-3 rows', async () => {
      const hand = makeHand({ id: 1, bigBlindUserId: 2 })
      await db.hands.add(hand)
      await db.actions.add(makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.CALL, position: -3 as Position }))
      const result = await getRecentHands(db, service, PLAYER_ID, 10)
      expect(result.hands[0]!.position).toBeNull()
    })
  })

  describe('cache key', () => {
    test('differs by playerId, battleTypeFilter, tableSizeFilter, and limit', () => {
      const key1 = buildRecentHandsCacheKey(PLAYER_ID, service, 10)
      const key2 = buildRecentHandsCacheKey(2, service, 10)
      expect(key1).not.toBe(key2)

      const keyLimit5 = buildRecentHandsCacheKey(PLAYER_ID, service, 5)
      expect(key1).not.toBe(keyLimit5)

      service.battleTypeFilter = [BattleType.RING_GAME]
      const keyBattle = buildRecentHandsCacheKey(PLAYER_ID, service, 10)
      expect(key1).not.toBe(keyBattle)
      service.battleTypeFilter = undefined

      service.tableSizeFilter = ['full']
      const keyTable = buildRecentHandsCacheKey(PLAYER_ID, service, 10)
      expect(key1).not.toBe(keyTable)
    })
  })
})
