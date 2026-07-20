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
import { ApiType } from '../types'
import type { ApiHandEvent } from '../types'
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

/** Minimal valid EVT_DEAL + EVT_HAND_RESULTS pair for one hand -- enough for
 * WriteEntityStream.toHandState() to accept it and persist a real hand (not
 * rejected as a chimera), so `service.writeEntityStream`'s 'data' fires for real.
 * Used only to drive the genuine hand-completion signal in the "real backend
 * cache" tests below -- not part of the fixtures above (which intentionally
 * bypass this pipeline, per the file header). Mirrors
 * positional-stats-service.test.ts's identical helper. */
function makeMinimalHandEvents(handId: number, seatUserIds: [number, number, number]): ApiHandEvent[] {
  return [
    {
      ApiTypeId: ApiType.EVT_DEAL,
      SeatUserIds: seatUserIds,
      Game: { CurrentBlindLv: 1, NextBlindUnixSeconds: 0, Ante: 0, SmallBlind: 100, BigBlind: 200, ButtonSeat: 0, SmallBlindSeat: 1, BigBlindSeat: 2 },
      Player: { SeatIndex: 0, BetStatus: 1, HoleCards: [0, 1], Chip: 5000, BetChip: 0 },
      OtherPlayers: [
        { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 100, IsSafeLeave: false },
        { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 200, IsSafeLeave: false },
      ],
      Progress: { Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 400, Pot: 300, SidePot: [] },
      timestamp: handId * 1000,
    },
    {
      ApiTypeId: ApiType.EVT_HAND_RESULTS,
      CommunityCards: [],
      Pot: 300,
      SidePot: [],
      ResultType: 0,
      DefeatStatus: 0,
      HandId: handId,
      HandLog: '',
      Results: [{ UserId: seatUserIds[0], HoleCards: [], RankType: 10, Hands: [], HandRanking: 1, Ranking: -2, RewardChip: 300 }],
      Player: { SeatIndex: 0, BetStatus: -1, Chip: 5000, BetChip: 0 },
      OtherPlayers: [
        { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
        { SeatIndex: 2, Status: 0, BetStatus: -1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
      ],
      timestamp: handId * 1000 + 1,
    },
  ]
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

  // 監査指摘11（P2）「開いたドリルダウンパネルが無期限に古くなる」対応: 上の全テストは
  // NODE_ENV=test下でこの関数の30秒キャッシュ自体を無効化してもらっているため
  // （`useCache`参照）、実際にキャッシュが効いている状態での「新しいハンドが
  // 終わったら古いキャッシュを返さない」という不変条件はどのテストも検証していない
  // （監査で指摘された「テストが実キャッシュの陳腐化を一度も検証していない」点）。
  // positional-stats-service.test.tsの同名describeと全く同じ理由・同じ実装。
  describe('real backend cache (audit finding 11, P2): hand completion rotates the 30s cache', () => {
    const originalNodeEnv = process.env.NODE_ENV

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv
    })

    test('a same-key call is served from cache until a live hand completes, then recomputes', async () => {
      process.env.NODE_ENV = 'production' // enable the real 30s cache path (disabled under 'test')

      await db.hands.bulkAdd([1, 2, 3].map(id => makeHand({ id, approxTimestamp: id * 1000 })))

      const first = await getRecentHands(db, service, PLAYER_ID, 10)
      expect(first.hands.map(h => h.handId)).toEqual([3, 2, 1])

      // Seed a 4th (newer) hand -- with the cache alone (no invalidation), a
      // same-key call within the 30s window would still return `first` unchanged.
      await db.hands.add(makeHand({ id: 4, approxTimestamp: 4000 }))

      const stillCached = await getRecentHands(db, service, PLAYER_ID, 10)
      expect(stillCached).toBe(first) // same cached object reference -- proves caching is actually live here
      expect(stillCached.hands.map(h => h.handId)).toEqual([3, 2, 1]) // hand 4 not yet reflected

      // A hand-start-warmup/filter-change/import-shaped rebroadcast (direct
      // statsOutputStream.write(), the same call aggregate-events-stream.ts's EVT_DEAL
      // warmup branch and message-router.ts's updateBattleTypeFilter/
      // recalculateStats() make) must NOT invalidate the cache -- audit finding 11
      // follow-up (P2, codex review): a first pass subscribed to statsOutputStream,
      // which also fires for these non-completion broadcasts.
      await new Promise<void>(resolve => {
        service.statsOutputStream.once('data', () => resolve())
        service.statsOutputStream.write([1, 2, 3])
      })
      const stillCachedAfterNonCompletionBroadcast = await getRecentHands(db, service, PLAYER_ID, 10)
      expect(stillCachedAfterNonCompletionBroadcast).toBe(first) // still the same stale cached object

      // A real live hand completion, through the actual live pipeline
      // (writeEntityStream is the direct pipe target and the one true completion
      // signal -- see its doc comment on PokerChaseService and ports.ts's
      // handCompletionEpoch). getRecentHands() self-subscribes to this stream
      // (subscribeToHandCompletion, module-level above) the first time it's called
      // for a given service instance, independent of the front-end hand-epoch
      // plumbing (App.tsx/Hud.tsx/ports.ts).
      await new Promise<void>(resolve => {
        service.writeEntityStream.once('data', () => resolve())
        service.writeEntityStream.write(makeMinimalHandEvents(5, [1, 2, 3]))
      })

      const afterHandCompletion = await getRecentHands(db, service, PLAYER_ID, 10)
      expect(afterHandCompletion).not.toBe(first) // recomputed, not served from the now-stale cache
      // hand 4 (seeded directly above) AND hand 5 (persisted by writeEntityStream
      // itself, from makeMinimalHandEvents) are both now reflected.
      expect(afterHandCompletion.hands.map(h => h.handId)).toEqual([5, 4, 3, 2, 1])
    })

    // 監査finding 11フォローアップ・pass-3（P2、codexレビュー指摘）: 進行中フェッチが
    // ハンド完了後にキャッシュへ古い結果を書き込んでしまうレース。
    // positional-stats-service.test.tsの同名テストと全く同じゲート手法（実データは
    // 即座に読むが、Promiseの解決だけをテストが手動で制御するまで遅らせる）で、
    // 「DB読み取り中にハンドが完了する」という進行中フェッチの状態を確定的に再現する。
    test('an in-flight fetch resolving after a hand completes does NOT fill the cache with a stale result', async () => {
      process.env.NODE_ENV = 'production' // enable the real 30s cache path (disabled under 'test')

      await db.hands.bulkAdd([1, 2, 3].map(id => makeHand({ id, approxTimestamp: id * 1000 })))

      let releaseGate!: () => void
      const gate = new Promise<void>(resolve => { releaseGate = resolve })
      const realWhere = db.hands.where.bind(db.hands)
      jest.spyOn(db.hands, 'where').mockImplementationOnce((indexName: any) => {
        const whereClause: any = realWhere(indexName)
        const realEquals = whereClause.equals.bind(whereClause)
        whereClause.equals = (value: any) => {
          const collection: any = realEquals(value)
          const realToArray = collection.toArray.bind(collection)
          collection.toArray = async () => {
            const data = await realToArray() // captures the real (pre-completion) snapshot immediately
            await gate // ...but withholds it from the caller until the test releases it
            return data
          }
          return collection
        }
        return whereClause
      })

      // Starts the fetch; its `db.hands...toArray()` call is now blocked on `gate`
      // (cache miss, since nothing has been cached in this test yet -- fetchGeneration
      // is captured before this call, per getRecentHands()'s own doc comment).
      const inFlightFetch = getRecentHands(db, service, PLAYER_ID, 10)

      // A genuine hand completes WHILE the fetch above is still blocked mid-read.
      await new Promise<void>(resolve => {
        service.writeEntityStream.once('data', () => resolve())
        service.writeEntityStream.write(makeMinimalHandEvents(4, [1, 2, 3]))
      })

      // Now let the blocked fetch resolve -- with the snapshot it captured BEFORE
      // hand 4 completed (hands 1-3 only).
      releaseGate()
      const staleResult = await inFlightFetch
      expect(staleResult.hands.map(h => h.handId)).toEqual([3, 2, 1])

      // The bug this guards against: cache.set(cacheKey, { result: staleResult, ... })
      // would have run here unconditionally, planting a stale fill that a subsequent
      // same-key call (the handEpoch-triggered refetch for an open panel) would then
      // serve for the rest of the 30s window. Assert it recomputes instead and
      // reflects hand 4.
      const afterRace = await getRecentHands(db, service, PLAYER_ID, 10)
      expect(afterRace).not.toBe(staleResult)
      expect(afterRace.hands.map(h => h.handId)).toEqual([4, 3, 2, 1])
    })
  })
})
