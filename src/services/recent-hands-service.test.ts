/**
 * RecentHandsService tests
 *
 * Builds a small synthetic dataset directly in a fake-indexeddb-backed
 * PokerChaseDB (bypassing the write-entity-stream ingestion pipeline, same
 * approach as positional-stats-service.test.ts) so the expected per-hand
 * fields can be pinned down exactly. Covers:
 *  - preflop-line taxonomy (compact shorthand, #356): OR / 3B / CC / 3CC /
 *    4CC / C / L / X / F / W, "-F" suffix, no-data
 *  - board (community cards) assembled from the batched phases rows (#356)
 *  - hole-card visibility: shown only for showdown RankTypes with actually
 *    valid HoleCards; NO_CALL/FOLD_OPEN never show, SHOWDOWN_MUCK without
 *    valid cards doesn't show either
 *  - newest-first ordering + limit (default / clamp / non-positive fallback)
 *  - battleType/tableSize filter application (handLimitFilter NOT applied)
 *  - cache key differs by playerId/filters (NOT by limit -- #341)
 *  - dealt-in exclusion: spectator hands and the -1 empty-seat sentinel (#341)
 *  - per-street postflop action notation incl. the ALL_IN suffix (#341)
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { PokerChaseDB } from '../db/poker-chase-db'
import PokerChaseService from './poker-chase-service'
import { trackServiceForTeardown } from '../utils/test-service-teardown'
import {
  getRecentHands,
  clearRecentHandsCache,
  buildRecentHandsCacheKey,
  derivePreflopLine,
  derivePostflopLines,
  deriveBoard,
  isDealtIn,
  isVoluntaryParticipation,
  resolveEffectiveActionType,
  DEFAULT_RECENT_HANDS_LIMIT,
  MAX_RECENT_HANDS_LIMIT,
  RECENT_HANDS_ASSEMBLY_LIMIT,
} from './recent-hands-service'
import { ActionDetail, ActionType, BattleType, PhaseType, Position, RankType } from '../types/game'
import { ApiType, validateApiEvent } from '../types'
import type { ApiHandEvent } from '../types'
import type { Action, Hand } from '../types/entities'
import type { RecentHandEntry } from '../types/stats'
import { EntityConverter } from '../entity-converter'

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
      Player: { SeatIndex: 0, BetStatus: -1, Chip: 5300, BetChip: 0 },
      OtherPlayers: [
        { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
        { SeatIndex: 2, Status: 0, BetStatus: -1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
      ],
      timestamp: handId * 1000 + 1,
    },
  ]
}

function makeTournamentChipLossEvents(handId: number): ApiHandEvent[] {
  return makeMinimalHandEvents(handId, [1, 2, 3]).map(event =>
    event.ApiTypeId === ApiType.EVT_HAND_RESULTS && event.Player
      ? { ...event, Player: { ...event.Player, Chip: event.Player.Chip - 10 } }
      : event
  )
}

describe('RecentHandsService', () => {
  let db: PokerChaseDB
  let service: PokerChaseService

  beforeEach(async () => {
    clearRecentHandsCache()
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = trackServiceForTeardown(new PokerChaseService({ db }))
    await service.ready
  })

  afterEach(async () => {
    db.close()
    await db.delete()
  })

  test('Raw Event Lake rebuild persists the same signed accounting as the live writer', () => {
    service.session.setBattleType(BattleType.TOURNAMENT)
    const rebuilt = new EntityConverter(service.session).convertEventsToEntities(
      makeMinimalHandEvents(99, [1, 2, 3])
    )

    expect(rebuilt.hands[0]!.playerChipAccounting).toEqual({
      '1': { grossPayout: 300, totalContribution: 0, netChips: 300 },
      '2': { grossPayout: 0, totalContribution: 100, netChips: -100 },
      '3': { grossPayout: 0, totalContribution: 200, netChips: -200 },
    })

    const corruptTournament = new EntityConverter(service.session).convertEventsToEntities(
      makeTournamentChipLossEvents(100)
    )
    expect(Object.values(corruptTournament.hands[0]!.playerChipAccounting!)).toEqual([
      null, null, null,
    ])
  })

  test('live writer propagates Tournament BattleType to the chip-conservation guard', async () => {
    service.session.setBattleType(BattleType.TOURNAMENT)
    await new Promise<void>(resolve => {
      service.writeEntityStream.once('data', () => resolve())
      service.writeEntityStream.write(makeTournamentChipLossEvents(101))
    })

    const hand = await db.hands.get(101)
    expect(Object.values(hand!.playerChipAccounting!)).toEqual([null, null, null])
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

    test('returns timestamped hands newest-first and applies the limit', async () => {
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

    test('clamps a limit above MAX_RECENT_HANDS_LIMIT instead of returning more', async () => {
      const result = await getRecentHands(db, service, PLAYER_ID, MAX_RECENT_HANDS_LIMIT + 500)
      // 母集合が5件なので件数自体は5だが、要求値がclampされずに素通りしていない
      // ことは「エラーにならず既定と同じ集合が返る」ことで確認する。
      expect(result.hands.map(h => h.handId)).toEqual([5, 4, 3, 2, 1])
    })

    test('a non-positive limit falls back to the default instead of returning nothing', async () => {
      const result = await getRecentHands(db, service, PLAYER_ID, 0)
      expect(result.hands).toHaveLength(5)
    })
  })

  // #341「参加しなかったハンドの除外」
  describe('dealt-in exclusion', () => {
    test('isDealtIn keys off the EVT_DEAL lineup', () => {
      const hand = makeHand({ id: 1, seatUserIds: [1, 2, -1] })
      expect(isDealtIn(hand, 1)).toBe(true)
      expect(isDealtIn(hand, 2)).toBe(true)
      expect(isDealtIn(hand, 3)).toBe(false)
    })

    test('isDealtIn rejects the -1 empty-seat sentinel even though the array contains it', () => {
      const hand = makeHand({ id: 1, seatUserIds: [1, 2, -1] })
      expect(hand.seatUserIds).toContain(-1)
      expect(isDealtIn(hand, -1)).toBe(false)
    })

    test('getRecentHands returns nothing for the -1 sentinel, not every hand with an empty seat', async () => {
      // バースト後・SNG終盤のテーブルは空席（-1）だらけになる。-1をそのまま
      // マルチエントリインデックスに流すと、その全ハンドが「直近ハンド」として
      // 出てしまう ―― まさに観戦ハンドの混入経路。
      await db.hands.bulkAdd([
        makeHand({ id: 11, approxTimestamp: 11_000, seatUserIds: [1, 2, -1] }),
        makeHand({ id: 12, approxTimestamp: 12_000, seatUserIds: [1, -1, -1] }),
      ])
      const sentinel = await getRecentHands(db, service, -1)
      expect(sentinel.hands).toEqual([])

      // 同じ母集合でも、実在するプレイヤーには通常どおり返る（除外が
      // 効きすぎていないことの対照）。
      const real = await getRecentHands(db, service, 1)
      expect(real.hands.map(h => h.handId)).toEqual([12, 11])
    })

    test('a hand the player was never dealt into is excluded even if it is the newest one', async () => {
      await db.hands.bulkAdd([
        makeHand({ id: 21, approxTimestamp: 21_000, seatUserIds: [1, 2, 3] }),
        // バースト後の観戦ハンド: ラインナップからPLAYER_IDが消えている。
        makeHand({ id: 22, approxTimestamp: 22_000, seatUserIds: [2, 3, -1] }),
      ])
      const result = await getRecentHands(db, service, PLAYER_ID)
      expect(result.hands.map(h => h.handId)).not.toContain(22)
      expect(result.hands.map(h => h.handId)).toContain(21)
    })
  })

  // #353 損益のBB単位表示（そのハンド自身のブラインドで割る）
  describe('per-hand big blind', () => {
    test('そのハンドのbigBlindをそのまま返す（ブラインドが上がっても行ごとに正しい）', async () => {
      await db.hands.bulkAdd([
        makeHand({ id: 1, approxTimestamp: 1000, bigBlind: 200 }),
        makeHand({ id: 2, approxTimestamp: 2000, bigBlind: 800 }),
      ])
      const result = await getRecentHands(db, service, PLAYER_ID)
      expect(result.hands.map(h => ({ handId: h.handId, bigBlind: h.bigBlind })))
        .toEqual([{ handId: 2, bigBlind: 800 }, { handId: 1, bigBlind: 200 }])
    })

    test('0や非有限のbigBlindはnullにする（UI側でチップ表記へフォールバックさせる）', async () => {
      await db.hands.bulkAdd([
        makeHand({ id: 1, approxTimestamp: 1000, bigBlind: 0 }),
        makeHand({ id: 2, approxTimestamp: 2000, bigBlind: Number.NaN }),
      ])
      const result = await getRecentHands(db, service, PLAYER_ID)
      expect(result.hands.map(h => h.bigBlind)).toEqual([null, null])
    })
  })

  // #356 ボード（コミュニティカード）
  describe('board', () => {
    async function boardFor(phases: { phase: PhaseType, communityCards: number[] }[]): Promise<string[]> {
      await db.hands.add(makeHand({ id: 1, approxTimestamp: 1000 }))
      if (phases.length > 0) {
        await db.phases.bulkAdd(phases.map(p => ({ handId: 1, seatUserIds: [PLAYER_ID], ...p })))
      }
      const result = await getRecentHands(db, service, PLAYER_ID)
      return result.hands[0]!.board
    }

    test('フロップだけ見たハンドは3枚', async () => {
      expect(await boardFor([
        { phase: PhaseType.PREFLOP, communityCards: [] },
        { phase: PhaseType.FLOP, communityCards: [29, 33, 21] },
      ])).toEqual(['9h', 'Th', '7h'])
    })

    test('リバーまで行ったハンドは5枚（累積の最長を採る）', async () => {
      expect(await boardFor([
        { phase: PhaseType.PREFLOP, communityCards: [] },
        { phase: PhaseType.FLOP, communityCards: [29, 33, 21] },
        { phase: PhaseType.TURN, communityCards: [29, 33, 21, 2] },
        { phase: PhaseType.RIVER, communityCards: [29, 33, 21, 2, 50] },
      ])).toEqual(['9h', 'Th', '7h', '2d', 'Ad'])
    })

    test('プリフロップで終わったハンドは空配列', async () => {
      expect(await boardFor([{ phase: PhaseType.PREFLOP, communityCards: [] }])).toEqual([])
    })

    test('フェーズ行が無い古いハンドでも落ちず空配列', async () => {
      expect(await boardFor([])).toEqual([])
    })

    test('オールイン・ランナウト（DEAL_ROUND無し）でも合成フェーズから拾える', async () => {
      // EVT_DEAL_ROUNDが来ないケースでは、合成FLOPとSHOWDOWNにだけボードが入る。
      expect(await boardFor([
        { phase: PhaseType.PREFLOP, communityCards: [] },
        { phase: PhaseType.FLOP, communityCards: [29, 33, 21] },
        { phase: PhaseType.SHOWDOWN, communityCards: [29, 33, 21, 2, 50] },
      ])).toEqual(['9h', 'Th', '7h', '2d', 'Ad'])
    })

    test('deriveBoard works directly on a phase map (unit)', () => {
      const phases = [
        { handId: 7, phase: PhaseType.FLOP, seatUserIds: [], communityCards: [29, 33, 21] },
        { handId: 7, phase: PhaseType.TURN, seatUserIds: [], communityCards: [29, 33, 21, 2] },
      ]
      expect(deriveBoard(7, new Map([[7, phases]]))).toEqual(['9h', 'Th', '7h', '2d'])
      expect(deriveBoard(999, new Map([[7, phases]]))).toEqual([])
    })
  })

  // #353「ヒーロー自身の配札カードが出ない」修正
  describe("hero's own dealt hole cards (Raw Event Lake)", () => {
    const HERO_ID = PLAYER_ID
    const LINEUP: [number, number, number] = [HERO_ID, 2, 3]

    /** そのハンドのEVT_DEAL行だけをLakeへ入れる（Hand entityは別途addする）。 */
    async function addDealEvent(
      timestamp: number,
      seatUserIds: number[],
      holeCards: number[] | undefined,
      /** 観測者の席。既定はヒーロー（席0）。 */
      seatIndex: number = 0
    ): Promise<void> {
      await db.apiEvents.add({
        ApiTypeId: ApiType.EVT_DEAL,
        SeatUserIds: seatUserIds,
        Game: { CurrentBlindLv: 1, NextBlindUnixSeconds: 0, Ante: 0, SmallBlind: 100, BigBlind: 200, ButtonSeat: 0, SmallBlindSeat: 1, BigBlindSeat: 2 },
        ...(holeCards ? { Player: { SeatIndex: seatIndex, BetStatus: 1, HoleCards: holeCards, Chip: 5000, BetChip: 0 } } : {}),
        OtherPlayers: [],
        Progress: { Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 400, Pot: 300, SidePot: [] },
        timestamp,
        sequence: 0,
      } as any)
    }

    beforeEach(() => {
      service.playerId = HERO_ID
    })

    test('ショーダウンへ行かなかった自分のハンドでもカードを表示する（回帰: コールドコール行でカード欄が空）', async () => {
      // hand.resultsは公開されたカードしか持たないので、この行だけでは空になる。
      await db.hands.add(makeHand({ id: 1, approxTimestamp: 1000, seatUserIds: LINEUP }))
      await db.actions.add(makeAction({
        handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.CALL, position: Position.BTN,
      }))
      await addDealEvent(1000, LINEUP, [37, 51])

      const result = await getRecentHands(db, service, HERO_ID)
      expect(result.hands[0]!.holeCards).toEqual(['Jh', 'Ac'])
      expect(result.hands[0]!.holeCardsSource).toBe('dealt')
    })

    test('公開由来のカードがあるハンドではsourceを"results"のまま維持する', async () => {
      await db.hands.add(makeHand({
        id: 1,
        approxTimestamp: 1000,
        seatUserIds: LINEUP,
        results: [{ UserId: HERO_ID, HandRanking: 1, Ranking: -2, RewardChip: 300, RankType: RankType.ONE_PAIR, Hands: [], HoleCards: [0, 1] }],
      }))
      await addDealEvent(1000, LINEUP, [0, 1])

      const result = await getRecentHands(db, service, HERO_ID)
      expect(result.hands[0]!.holeCardsSource).toBe('results')
    })

    test('他プレイヤーのパネルにはEVT_DEAL由来のカードを出さない（Playerは観測者自身の情報）', async () => {
      await db.hands.add(makeHand({ id: 1, approxTimestamp: 1000, seatUserIds: LINEUP }))
      await addDealEvent(1000, LINEUP, [37, 51])

      const result = await getRecentHands(db, service, 2)
      expect(result.hands[0]!.holeCards).toBeNull()
      expect(result.hands[0]!.holeCardsSource).toBeNull()
    })

    // codexレビュー指摘（P2）: アカウント切替後・別アカウントのLakeを
    // インポートした環境では、履歴上の観測者が現在のヒーローとは限らない。
    test('配札イベントの観測者が対象プレイヤー本人でなければ採用しない', async () => {
      await db.hands.add(makeHand({ id: 1, approxTimestamp: 1000, seatUserIds: LINEUP }))
      // 同じラインナップだが、観測者は席2（=UserId 2）の別アカウント。
      await addDealEvent(1000, LINEUP, [37, 51], 1)

      const result = await getRecentHands(db, service, HERO_ID)
      expect(result.hands[0]!.holeCards).toBeNull()
      expect(result.hands[0]!.holeCardsSource).toBeNull()
    })

    test('観測者席が解決できない配札（SeatIndexなし/空席）も採用しない', async () => {
      await db.hands.bulkAdd([
        makeHand({ id: 1, approxTimestamp: 1000, seatUserIds: LINEUP }),
        makeHand({ id: 2, approxTimestamp: 2000, seatUserIds: [HERO_ID, 2, -1] }),
      ])
      await db.apiEvents.add({
        ApiTypeId: ApiType.EVT_DEAL,
        SeatUserIds: LINEUP,
        Player: { BetStatus: 1, HoleCards: [37, 51], Chip: 5000, BetChip: 0 },
        timestamp: 1000,
        sequence: 0,
      } as any)
      await addDealEvent(2000, [HERO_ID, 2, -1], [37, 51], 2)

      const result = await getRecentHands(db, service, HERO_ID)
      expect(result.hands.map(h => h.holeCards)).toEqual([null, null])
    })

    test('同一msに別テーブルの配札があっても、席の並びが一致する行にだけ結び付ける', async () => {
      await db.hands.add(makeHand({ id: 1, approxTimestamp: 1000, seatUserIds: LINEUP }))
      // 同じtimestampだがラインナップが違う配札（別タブ／別テーブル）。
      await addDealEvent(1000, [9, 8, 7], [10, 11])

      const result = await getRecentHands(db, service, HERO_ID)
      expect(result.hands[0]!.holeCards).toBeNull()
    })

    test('テーブル移動直後のHoleCards:[]や観戦配札（Playerなし）は埋めない', async () => {
      await db.hands.bulkAdd([
        makeHand({ id: 1, approxTimestamp: 1000, seatUserIds: LINEUP }),
        makeHand({ id: 2, approxTimestamp: 2000, seatUserIds: LINEUP }),
      ])
      await addDealEvent(1000, LINEUP, [])
      await addDealEvent(2000, LINEUP, undefined)

      const result = await getRecentHands(db, service, HERO_ID)
      expect(result.hands.map(h => h.holeCards)).toEqual([null, null])
    })

    test('イベント全体がZod検証に落ちる形でも、必要な部分だけ読めれば表示する', async () => {
      // AGENTS.md「Raw Event Lake」: 検証はパイプライン入口の関門であって、
      // 表示のための読み取りの関門ではない。EVT_DEALの無関係な部分が
      // サーバー仕様変更でスキーマから外れた瞬間に自分の手札が全部消える、
      // という壊れ方をしてはならない。
      const nonConformingDeal = {
        ApiTypeId: ApiType.EVT_DEAL,
        SeatUserIds: LINEUP,          // 実スキーマは4席以上を要求する
        OtherPlayers: [],             // 実スキーマは1件以上を要求する
        Player: { SeatIndex: 0, BetStatus: 1, HoleCards: [37, 51], Chip: 5000, BetChip: 0 },
        timestamp: 1000,
        sequence: 0,
      }
      expect(validateApiEvent(nonConformingDeal).success).toBe(false)

      await db.hands.add(makeHand({ id: 1, approxTimestamp: 1000, seatUserIds: LINEUP }))
      await db.apiEvents.add(nonConformingDeal as any)

      const result = await getRecentHands(db, service, HERO_ID)
      expect(result.hands[0]!.holeCards).toEqual(['Jh', 'Ac'])
    })

    test('approxTimestampを持たない古いハンドでも落ちず、カードは空のまま', async () => {
      await db.hands.add(makeHand({ id: 1, seatUserIds: LINEUP }))
      const result = await getRecentHands(db, service, HERO_ID)
      expect(result.hands[0]!.holeCards).toBeNull()
      expect(result.hands[0]!.approxTimestamp).toBeNull()
    })
  })

  // #353「参加のみ」（自発的にチップを入れたハンドだけへ絞る）
  describe('participation-only filter', () => {
    /** PLAYER_IDのプリフロップ・アクションを1件だけ持つハンドを作る。 */
    async function addHandWithPreflop(
      id: number,
      actionType: Exclude<ActionType, ActionType.ALL_IN> | null,
      handOverrides: Partial<Hand> = {}
    ): Promise<void> {
      await db.hands.add(makeHand({ id, approxTimestamp: id * 1000, bigBlindUserId: 2, ...handOverrides }))
      if (actionType !== null) {
        await db.actions.add(makeAction({
          handId: id, index: 0, phase: PhaseType.PREFLOP, actionType, position: Position.BTN,
        }))
      }
    }

    test('isVoluntaryParticipation excludes exactly F(old) and W(alk)', () => {
      const base = { handId: 1, approxTimestamp: null, bigBlind: 200, position: null, holeCards: null, holeCardsSource: null, postflopLines: { flop: [], turn: [], river: [] }, board: [], preflopLineAmountBB: null, preflopLineAmountChips: null, sawFlop: false, wentToShowdown: false, won: false, netChips: null } satisfies Omit<RecentHandEntry, 'preflopLine'>
      expect(isVoluntaryParticipation({ ...base, preflopLine: 'F' })).toBe(false)
      expect(isVoluntaryParticipation({ ...base, preflopLine: 'W' })).toBe(false)
      // 自発的に入れてから降りた行は「参加」。
      expect(isVoluntaryParticipation({ ...base, preflopLine: 'OR-F' })).toBe(true)
      expect(isVoluntaryParticipation({ ...base, preflopLine: '3B-F' })).toBe(true)
      expect(isVoluntaryParticipation({ ...base, preflopLine: 'L' })).toBe(true)
      expect(isVoluntaryParticipation({ ...base, preflopLine: 'CC' })).toBe(true)
      // BBのオプションチェックは残す（フロップ以降を実際に打っている可能性がある）。
      expect(isVoluntaryParticipation({ ...base, preflopLine: 'X' })).toBe(true)
      // 判定不能（データ欠落）は消さない。
      expect(isVoluntaryParticipation({ ...base, preflopLine: null })).toBe(true)
    })

    // codexレビュー指摘（P2）: 'W'は「BBのプリフロップEVT_ACTIONが無い」
    // 以上のことを意味しない。サーバーはBBのcheckを省略する（実ハンドの31.9%）
    // ほか、BBが強制投稿でオールインした場合もアクションを送らない。
    test("ボードを見たBBの'W'は除外しない（省略checkと真の不戦勝を分ける）", () => {
      const base = { handId: 1, approxTimestamp: null, bigBlind: 200, position: null, holeCards: null, holeCardsSource: null, postflopLines: { flop: [], turn: [], river: [] }, board: [], preflopLineAmountBB: null, preflopLineAmountChips: null, won: false, netChips: null } satisfies Omit<RecentHandEntry, 'preflopLine' | 'sawFlop' | 'wentToShowdown'>
      // 真の不戦勝: ボードを見ていない。
      expect(isVoluntaryParticipation({ ...base, preflopLine: 'W', sawFlop: false, wentToShowdown: false })).toBe(false)
      // 省略check: フロップを見ている。
      expect(isVoluntaryParticipation({ ...base, preflopLine: 'W', sawFlop: true, wentToShowdown: false })).toBe(true)
      // 強制投稿オールイン: ショーダウンまで行っている。
      expect(isVoluntaryParticipation({ ...base, preflopLine: 'W', sawFlop: false, wentToShowdown: true })).toBe(true)
    })

    test('ONのときF/W行が消え、OFFなら全部出る', async () => {
      await addHandWithPreflop(1, ActionType.FOLD)                            // Fold
      await addHandWithPreflop(2, null, { bigBlindUserId: PLAYER_ID })        // Walk
      await addHandWithPreflop(3, ActionType.CALL)                            // Limp
      await addHandWithPreflop(4, ActionType.RAISE)                           // Open
      await addHandWithPreflop(5, ActionType.CHECK, { bigBlindUserId: PLAYER_ID }) // Check

      const off = await getRecentHands(db, service, PLAYER_ID, 10, false)
      expect(off.hands.map(h => h.handId)).toEqual([5, 4, 3, 2, 1])
      expect(off.hands.map(h => h.preflopLine)).toEqual(['X', 'OR', 'L', 'W', 'F'])

      const on = await getRecentHands(db, service, PLAYER_ID, 10, true)
      expect(on.hands.map(h => h.handId)).toEqual([5, 4, 3])
    })

    test('既定（引数省略）はOFF -- 既定ONはUI側の設定であってサービスの既定ではない', async () => {
      await addHandWithPreflop(1, ActionType.FOLD)
      const result = await getRecentHands(db, service, PLAYER_ID)
      expect(result.hands.map(h => h.handId)).toEqual([1])
    })

    test('絞り込みはlimitより先に掛かる（limit件へ切ってから絞らない）', async () => {
      // 新しい順に Fold, Fold, Open, Open。limit=2 で参加のみONなら、
      // 「先頭2件を絞る」= 0件ではなく「絞ってから2件」= Open 2件になるべき。
      await addHandWithPreflop(1, ActionType.RAISE)
      await addHandWithPreflop(2, ActionType.RAISE)
      await addHandWithPreflop(3, ActionType.FOLD)
      await addHandWithPreflop(4, ActionType.FOLD)

      const on = await getRecentHands(db, service, PLAYER_ID, 2, true)
      expect(on.hands.map(h => h.handId)).toEqual([2, 1])
    })

    // codexレビュー指摘（P2）: 表示上限ちょうどしか組み立てないと、
    // 「参加のみ」ONで最大件数を選んだとき必ず件数に届かない。
    test('表示上限を超える母集合から拾うので、フォールドが混ざっていても最大件数を満たせる', async () => {
      // 新しい順に Fold を100件、その手前に Open を100件。表示上限（100）ぶん
      // しか組み立てない実装では、100件を要求しても0件しか返らない。
      for (let id = 1; id <= 100; id++) await addHandWithPreflop(id, ActionType.RAISE)
      for (let id = 101; id <= 200; id++) await addHandWithPreflop(id, ActionType.FOLD)

      // 母集合は表示上限より広い（この前提が崩れると本テストの意味も消える）。
      expect(RECENT_HANDS_ASSEMBLY_LIMIT).toBeGreaterThan(MAX_RECENT_HANDS_LIMIT)

      const on = await getRecentHands(db, service, PLAYER_ID, MAX_RECENT_HANDS_LIMIT, true)
      expect(on.hands).toHaveLength(MAX_RECENT_HANDS_LIMIT)
      expect(on.hands.every(h => h.preflopLine === 'OR')).toBe(true)
      // 新しい順は維持される。
      expect(on.hands[0]!.handId).toBe(100)
    })

    test('観戦ハンドはON/OFFに関係なく除外されたまま（#341の除外は別軸）', async () => {
      await addHandWithPreflop(1, ActionType.RAISE)
      await db.hands.add(makeHand({ id: 2, approxTimestamp: 2000, seatUserIds: [2, 3, -1] }))

      for (const participationOnly of [true, false]) {
        const result = await getRecentHands(db, service, PLAYER_ID, 10, participationOnly)
        expect(result.hands.map(h => h.handId)).not.toContain(2)
      }
    })
  })

  // #341「各ストリートでのアクション表示」
  describe('postflop street actions', () => {
    const postflopAction = (
      overrides: Partial<Action> & { handId: number, index: number, phase: PhaseType, actionType: ActionType }
    ): Action => makeAction({ position: Position.BTN, ...overrides })

    /** 記号だけを取り出す（サイズ検証は下の describe で行う）。 */
    const letters = (street: readonly { letter: string, allIn: boolean }[]): string =>
      street.map(a => `${a.letter}${a.allIn ? '!' : ''}`).join('')
    const lettersOf = (lines: { flop: any[], turn: any[], river: any[] }) =>
      ({ flop: letters(lines.flop), turn: letters(lines.turn), river: letters(lines.river) })

    test('groups the player\'s own actions per street, in index order', async () => {
      await db.hands.add(makeHand({ id: 1, approxTimestamp: 1000 }))
      await db.actions.bulkAdd([
        postflopAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE }),
        postflopAction({ handId: 1, index: 1, phase: PhaseType.FLOP, actionType: ActionType.CHECK }),
        postflopAction({ handId: 1, index: 2, phase: PhaseType.FLOP, actionType: ActionType.CALL }),
        postflopAction({ handId: 1, index: 3, phase: PhaseType.TURN, actionType: ActionType.BET }),
        postflopAction({ handId: 1, index: 4, phase: PhaseType.RIVER, actionType: ActionType.FOLD }),
      ])
      const result = await getRecentHands(db, service, PLAYER_ID)
      expect(lettersOf(result.hands[0]!.postflopLines)).toEqual({ flop: 'XC', turn: 'B', river: 'F' })
    })

    test('other players\' actions on the same street are not mixed in', async () => {
      await db.hands.add(makeHand({ id: 1, approxTimestamp: 1000 }))
      await db.actions.bulkAdd([
        postflopAction({ handId: 1, index: 0, phase: PhaseType.FLOP, actionType: ActionType.CHECK }),
        postflopAction({ handId: 1, index: 1, phase: PhaseType.FLOP, actionType: ActionType.BET, playerId: 2 }),
        postflopAction({ handId: 1, index: 2, phase: PhaseType.FLOP, actionType: ActionType.CALL }),
      ])
      const result = await getRecentHands(db, service, PLAYER_ID)
      expect(lettersOf(result.hands[0]!.postflopLines)).toEqual({ flop: 'XC', turn: '', river: '' })
    })

    test('marks pipeline-normalized ALL_IN', async () => {
      // パイプラインは生のALL_INをBET/RAISE/CALLへ正規化し、事実はactionDetailsに残す。
      await db.hands.add(makeHand({ id: 1, approxTimestamp: 1000 }))
      await db.actions.bulkAdd([
        postflopAction({
          handId: 1, index: 0, phase: PhaseType.FLOP, actionType: ActionType.RAISE,
          actionDetails: [ActionDetail.ALL_IN],
        }),
      ])
      const result = await getRecentHands(db, service, PLAYER_ID)
      expect(result.hands[0]!.postflopLines.flop[0]!.allIn).toBe(true)
      expect(lettersOf(result.hands[0]!.postflopLines).flop).toBe('R!')
    })

    test('a hand that ended preflop has every street empty', async () => {
      await db.hands.add(makeHand({ id: 1, approxTimestamp: 1000 }))
      await db.actions.add(
        postflopAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.FOLD })
      )
      const result = await getRecentHands(db, service, PLAYER_ID)
      expect(result.hands[0]!.postflopLines).toEqual({ flop: [], turn: [], river: [] })
    })

    test('an all-in runout the player never acted on keeps the streets empty (sawFlop carries that instead)', async () => {
      await db.hands.add(makeHand({
        id: 1,
        approxTimestamp: 1000,
        results: [{ UserId: PLAYER_ID, HandRanking: 1, Ranking: -2, RewardChip: 0, RankType: RankType.ONE_PAIR, Hands: [], HoleCards: [1, 2] }],
      }))
      await db.actions.add(postflopAction({
        handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.CALL,
        actionDetails: [ActionDetail.ALL_IN],
      }))
      const result = await getRecentHands(db, service, PLAYER_ID)
      expect(result.hands[0]!.postflopLines).toEqual({ flop: [], turn: [], river: [] })
      expect(result.hands[0]!.sawFlop).toBe(true)
    })

    test('derivePostflopLines works directly on an action map (unit)', () => {
      const actions: Action[] = [
        makeAction({ handId: 7, index: 2, phase: PhaseType.RIVER, actionType: ActionType.BET, position: Position.BB }),
        makeAction({ handId: 7, index: 0, phase: PhaseType.FLOP, actionType: ActionType.CHECK, position: Position.BB }),
        makeAction({ handId: 7, index: 1, phase: PhaseType.TURN, actionType: ActionType.CHECK, position: Position.BB }),
      ]
      expect(lettersOf(derivePostflopLines(7, PLAYER_ID, new Map([[7, actions]])))).toEqual({
        flop: 'X', turn: 'X', river: 'B',
      })
      expect(derivePostflopLines(999, PLAYER_ID, new Map([[7, actions]]))).toEqual({
        flop: [], turn: [], river: [],
      })
    })
  })

  // #354 ポット比サイジング
  //
  // 前提の検証: `EVT_ACTION.Progress.Pot`(+SidePot)はアクション**後**の
  // スナップショット、`BetChip`はストリート内累計。実キャプチャ2本
  // （2026-07-04 / 2026-08-01、ポストフロップのアグレッシブアクション計80,758件）
  // に対し `potBefore = pot + ΣsidePot - increment` が99.995% / 99.998%で
  // 直前イベントのポット総額と一致することを確認済み（残差は
  // docs/api-events.md「クロージングコールの欠落」の既知キャプチャ異常）。
  describe('pot-relative bet sizing', () => {
    const act = (
      overrides: Partial<Action> & { handId: number, index: number, phase: PhaseType, actionType: ActionType }
    ): Action => makeAction({ position: Position.BTN, ...overrides })

    async function sizesFor(actions: Action[], handOverrides: Partial<Hand> = {}) {
      await db.hands.add(makeHand({ id: 1, approxTimestamp: 1000, ...handOverrides }))
      await db.actions.bulkAdd(actions)
      const result = await getRecentHands(db, service, PLAYER_ID)
      return result.hands[0]!.postflopLines
    }

    test('ハーフポットのベット: 増分/直前ポット', async () => {
      // 直前ポット300、ベット150 -> pot(post)=450 -> 150/300 = 50%
      const lines = await sizesFor([
        act({ handId: 1, index: 0, phase: PhaseType.FLOP, actionType: ActionType.BET, bet: 150, pot: 450, sidePot: [] }),
      ])
      expect(lines.flop[0]).toMatchObject({ letter: 'B', increment: 150, potBefore: 300, potPercent: 50 })
    })

    test('オーバーベットは100%を超える値になる', async () => {
      // 直前ポット500、ベット600 -> pot(post)=1100 -> 120%
      const lines = await sizesFor([
        act({ handId: 1, index: 0, phase: PhaseType.FLOP, actionType: ActionType.BET, bet: 600, pot: 1100, sidePot: [] }),
      ])
      expect(lines.flop[0]!.potPercent).toBe(120)
    })

    test('レイズは累計betではなく増分を分子にする', async () => {
      // 自分がフロップで100ベット、相手が300へレイズ、自分が900へリレイズ。
      // 3手目の増分は 900-100 = 800。pot(post)=2100 -> 直前ポット1300 -> 62%
      const lines = await sizesFor([
        act({ handId: 1, index: 0, phase: PhaseType.FLOP, actionType: ActionType.BET, bet: 100, pot: 400, sidePot: [] }),
        act({ handId: 1, index: 1, phase: PhaseType.FLOP, actionType: ActionType.RAISE, playerId: 2, bet: 300, pot: 700, sidePot: [] }),
        act({ handId: 1, index: 2, phase: PhaseType.FLOP, actionType: ActionType.RAISE, bet: 900, pot: 2100, sidePot: [] }),
      ])
      expect(lines.flop.map(a => a.letter)).toEqual(['B', 'R'])
      expect(lines.flop[1]).toMatchObject({ increment: 800, potBefore: 1300, potPercent: 62 })
    })

    test('サイドポットを分母に含める（オールインでポットがティア分割されても壊れない）', async () => {
      // pot=1000, sidePot=[500,300] -> 場の総額1800。増分600 -> 直前1200 -> 50%
      const lines = await sizesFor([
        act({
          handId: 1, index: 0, phase: PhaseType.FLOP, actionType: ActionType.BET,
          bet: 600, pot: 1000, sidePot: [500, 300], actionDetails: [ActionDetail.ALL_IN],
        }),
      ])
      expect(lines.flop[0]).toMatchObject({ increment: 600, potBefore: 1200, potPercent: 50, allIn: true })
    })

    test('チェック/コール/フォールドには比率を付けない', async () => {
      const lines = await sizesFor([
        act({ handId: 1, index: 0, phase: PhaseType.FLOP, actionType: ActionType.CHECK, bet: 0, pot: 300, sidePot: [] }),
        act({ handId: 1, index: 1, phase: PhaseType.TURN, actionType: ActionType.CALL, bet: 200, pot: 700, sidePot: [] }),
        act({ handId: 1, index: 2, phase: PhaseType.RIVER, actionType: ActionType.FOLD, bet: 0, pot: 700, sidePot: [] }),
      ])
      expect(lines.flop[0]!.potPercent).toBeNull()
      expect(lines.turn[0]!.potPercent).toBeNull()
      expect(lines.river[0]!.potPercent).toBeNull()
      // コールの増分自体は出す（ツールチップで実額を見せるため）。
      expect(lines.turn[0]!.increment).toBe(200)
    })

    test('チェックスルーのハンドはサイズを一切持たない', async () => {
      const lines = await sizesFor([
        act({ handId: 1, index: 0, phase: PhaseType.FLOP, actionType: ActionType.CHECK, bet: 0, pot: 300, sidePot: [] }),
        act({ handId: 1, index: 1, phase: PhaseType.TURN, actionType: ActionType.CHECK, bet: 0, pot: 300, sidePot: [] }),
        act({ handId: 1, index: 2, phase: PhaseType.RIVER, actionType: ActionType.CHECK, bet: 0, pot: 300, sidePot: [] }),
      ])
      expect([...lines.flop, ...lines.turn, ...lines.river].every(a => a.potPercent === null)).toBe(true)
    })

    test('ストリートをまたいでも累計はリセットされる（ターンのbetをフロップ分と混ぜない）', async () => {
      const lines = await sizesFor([
        act({ handId: 1, index: 0, phase: PhaseType.FLOP, actionType: ActionType.BET, bet: 200, pot: 600, sidePot: [] }),
        act({ handId: 1, index: 1, phase: PhaseType.TURN, actionType: ActionType.BET, bet: 300, pot: 1200, sidePot: [] }),
      ])
      expect(lines.flop[0]).toMatchObject({ increment: 200, potBefore: 400, potPercent: 50 })
      // ターンは累計がリセットされるので増分＝300（500ではない）。
      expect(lines.turn[0]).toMatchObject({ increment: 300, potBefore: 900, potPercent: 33 })
    })

    test('直前ポットが0以下になる壊れた行は比率を出さない（数字を捏造しない）', async () => {
      const lines = await sizesFor([
        act({ handId: 1, index: 0, phase: PhaseType.FLOP, actionType: ActionType.BET, bet: 500, pot: 500, sidePot: [] }),
      ])
      expect(lines.flop[0]).toMatchObject({ letter: 'B', potBefore: null, potPercent: null })
    })

    // codexレビュー指摘（P2）: 保存パイプラインは生のALL_INを
    // `Progress.NextActionTypes`だけで正規化し、`CALL`が選択肢にあれば**額を
    // 見ずに**RAISEへ倒す（write-entity-stream.ts / entity-converter.ts）。
    // そのため相手のベットをカバーできないショートオールインもRAISEで保存され、
    // そのまま出すと`C!`であるべき行に`Rxx!`とポット比が付いてしまう。
    // 境界は`hand-log-processor.ts`のALL_IN分岐と揃える（`BetChip > prevBet`
    // だけがレイズ、同額・下回りはどちらもオールインコール）。
    describe('short all-in normalized to RAISE is really a call', () => {
      test('ポストフロップ: 相手のベットをカバーできないオールインはC!（比率なし）', async () => {
        const lines = await sizesFor([
          act({ handId: 1, index: 0, phase: PhaseType.FLOP, actionType: ActionType.BET, playerId: 2, bet: 1000, pot: 1300, sidePot: [] }),
          act({
            handId: 1, index: 1, phase: PhaseType.FLOP, actionType: ActionType.RAISE,
            bet: 400, pot: 1700, sidePot: [], actionDetails: [ActionDetail.ALL_IN],
          }),
        ])
        expect(lines.flop[0]).toMatchObject({ letter: 'C', allIn: true, potPercent: null })
        // 実額そのものは残す（ツールチップで見せるため）。
        expect(lines.flop[0]!.increment).toBe(400)
      })

      test('ポストフロップ: ちょうどカバーする額（BetChip === 対峙額）もコール', async () => {
        const lines = await sizesFor([
          act({ handId: 1, index: 0, phase: PhaseType.FLOP, actionType: ActionType.BET, playerId: 2, bet: 1000, pot: 1300, sidePot: [] }),
          act({
            handId: 1, index: 1, phase: PhaseType.FLOP, actionType: ActionType.RAISE,
            bet: 1000, pot: 2300, sidePot: [], actionDetails: [ActionDetail.ALL_IN],
          }),
        ])
        expect(lines.flop[0]).toMatchObject({ letter: 'C', allIn: true, potPercent: null })
      })

      test('ポストフロップ: 上回るオールインは従来どおりレイズ（比率つき）', async () => {
        // 対峙1000、自分1600へ。増分1600、pot(post)=3900 -> 直前2300 -> 70%
        const lines = await sizesFor([
          act({ handId: 1, index: 0, phase: PhaseType.FLOP, actionType: ActionType.BET, playerId: 2, bet: 1000, pot: 1300, sidePot: [] }),
          act({
            handId: 1, index: 1, phase: PhaseType.FLOP, actionType: ActionType.RAISE,
            bet: 1600, pot: 3900, sidePot: [], actionDetails: [ActionDetail.ALL_IN],
          }),
        ])
        expect(lines.flop[0]).toMatchObject({ letter: 'R', allIn: true, increment: 1600, potBefore: 2300, potPercent: 70 })
      })

      test('ポストフロップ: 対峙するベットが無いオールインはベットのまま', async () => {
        const lines = await sizesFor([
          act({
            handId: 1, index: 0, phase: PhaseType.FLOP, actionType: ActionType.BET,
            bet: 300, pot: 900, sidePot: [], actionDetails: [ActionDetail.ALL_IN],
          }),
        ])
        expect(lines.flop[0]).toMatchObject({ letter: 'B', allIn: true, potPercent: 50 })
      })

      test('ALL_IN印の無いRAISEには触らない（サーバーが明示的に送った種別）', async () => {
        const lines = await sizesFor([
          act({ handId: 1, index: 0, phase: PhaseType.FLOP, actionType: ActionType.BET, playerId: 2, bet: 1000, pot: 1300, sidePot: [] }),
          act({ handId: 1, index: 1, phase: PhaseType.FLOP, actionType: ActionType.RAISE, bet: 400, pot: 1700, sidePot: [] }),
        ])
        expect(lines.flop[0]!.letter).toBe('R')
      })

      test('プリフロップ: BBをカバーできないショートオールインにレイズto表示を出さない', async () => {
        // BB=200、自分は150しか無くオールイン。先行するEVT_ACTIONは無いので、
        // 対峙額の下駄（BB）が効かないとレイズ扱いになってしまう。
        await db.hands.add(makeHand({ id: 1, approxTimestamp: 1000, bigBlind: 200 }))
        await db.actions.add(act({
          handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE,
          bet: 150, pot: 500, sidePot: [], actionDetails: [ActionDetail.ALL_IN],
        }))
        const result = await getRecentHands(db, service, PLAYER_ID)
        expect(result.hands[0]!.preflopLineAmountChips).toBeNull()
        expect(result.hands[0]!.preflopLineAmountBB).toBeNull()
      })

      test('プリフロップ: BBちょうどのオールインもコール扱い', async () => {
        await db.hands.add(makeHand({ id: 1, approxTimestamp: 1000, bigBlind: 200 }))
        await db.actions.add(act({
          handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE,
          bet: 200, pot: 500, sidePot: [], actionDetails: [ActionDetail.ALL_IN],
        }))
        const result = await getRecentHands(db, service, PLAYER_ID)
        expect(result.hands[0]!.preflopLineAmountChips).toBeNull()
      })

      test('プリフロップ: BBを上回るオールインは従来どおりレイズto', async () => {
        await db.hands.add(makeHand({ id: 1, approxTimestamp: 1000, bigBlind: 200 }))
        await db.actions.add(act({
          handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE,
          bet: 3000, pot: 3300, sidePot: [], actionDetails: [ActionDetail.ALL_IN],
        }))
        const result = await getRecentHands(db, service, PLAYER_ID)
        expect(result.hands[0]!.preflopLineAmountChips).toBe(3000)
        expect(result.hands[0]!.preflopLineAmountBB).toBeCloseTo(15)
      })

      test('プリフロップ: 相手の3betをカバーできないオールインもコール扱い', async () => {
        await db.hands.add(makeHand({ id: 1, approxTimestamp: 1000, bigBlind: 200 }))
        await db.actions.bulkAdd([
          act({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, bet: 440, pot: 740, sidePot: [] }),
          act({ handId: 1, index: 1, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, playerId: 2, bet: 1400, pot: 2140, sidePot: [] }),
          act({
            handId: 1, index: 2, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE,
            bet: 900, pot: 2600, sidePot: [], actionDetails: [ActionDetail.ALL_IN],
          }),
        ])
        const result = await getRecentHands(db, service, PLAYER_ID)
        // 数字はラベルへインライン表示される（ラベルは**最後のアクション**を
        // 反映する）ので、最後の生RAISEが実質コールなら数字は出さない。
        // ここで1つ前のOpen(440)を返すと、別アクションの額がそのラベルに付く。
        expect(result.hands[0]!.preflopLineAmountChips).toBeNull()
        expect(result.hands[0]!.preflopLineAmountBB).toBeNull()
      })

      test('resolveEffectiveActionType (unit)', () => {
        const facing = makeAction({ handId: 1, index: 0, phase: PhaseType.FLOP, actionType: ActionType.BET, position: Position.BTN, playerId: 2, bet: 1000 })
        const shortAllIn = makeAction({ handId: 1, index: 1, phase: PhaseType.FLOP, actionType: ActionType.RAISE, position: Position.BTN, bet: 400, actionDetails: [ActionDetail.ALL_IN] })
        const coverAllIn = makeAction({ handId: 1, index: 1, phase: PhaseType.FLOP, actionType: ActionType.RAISE, position: Position.BTN, bet: 1600, actionDetails: [ActionDetail.ALL_IN] })
        expect(resolveEffectiveActionType(shortAllIn, [facing, shortAllIn])).toBe(ActionType.CALL)
        expect(resolveEffectiveActionType(coverAllIn, [facing, coverAllIn])).toBe(ActionType.RAISE)
        // 対峙額の下駄（プリフロップのBB）だけでもコール判定になる。
        expect(resolveEffectiveActionType(shortAllIn, [shortAllIn], 1000)).toBe(ActionType.CALL)
        expect(resolveEffectiveActionType(shortAllIn, [shortAllIn], 0)).toBe(ActionType.RAISE)
      })
    })

    test('プリフロップのレイズto額をBBとチップの両方で返す', async () => {
      await db.hands.add(makeHand({ id: 1, approxTimestamp: 1000, bigBlind: 200 }))
      await db.actions.bulkAdd([
        act({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, bet: 440, pot: 740, sidePot: [] }),
      ])
      const result = await getRecentHands(db, service, PLAYER_ID)
      expect(result.hands[0]!.preflopLineAmountChips).toBe(440)
      expect(result.hands[0]!.preflopLineAmountBB).toBeCloseTo(2.2)
    })

    test('プリフロップの最後のアグレッシブアクション（4bet等）を採る', async () => {
      await db.hands.add(makeHand({ id: 1, approxTimestamp: 1000, bigBlind: 200 }))
      await db.actions.bulkAdd([
        act({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, bet: 440, pot: 740, sidePot: [] }),
        act({ handId: 1, index: 1, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, playerId: 2, bet: 1400, pot: 2140, sidePot: [] }),
        act({ handId: 1, index: 2, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, bet: 4400, pot: 6100, sidePot: [] }),
      ])
      const result = await getRecentHands(db, service, PLAYER_ID)
      expect(result.hands[0]!.preflopLineAmountChips).toBe(4400)
      expect(result.hands[0]!.preflopLineAmountBB).toBeCloseTo(22)
    })

    // #356: コールドコールの「いくらまでコールしたか」
    test('コールドコールはコールto額を返す（レイズと同じ累計bet）', async () => {
      await db.hands.add(makeHand({ id: 1, approxTimestamp: 1000, bigBlind: 200, seatUserIds: [1, 2, 3] }))
      await db.actions.bulkAdd([
        act({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, playerId: 2, bet: 440, pot: 740, sidePot: [] }),
        act({ handId: 1, index: 1, phase: PhaseType.PREFLOP, actionType: ActionType.CALL, bet: 440, pot: 1180, sidePot: [] }),
      ])
      const result = await getRecentHands(db, service, PLAYER_ID)
      expect(result.hands[0]!.preflopLine).toBe('CC')
      expect(result.hands[0]!.preflopLineAmountChips).toBe(440)
      expect(result.hands[0]!.preflopLineAmountBB).toBeCloseTo(2.2)
    })

    test('リンプと非コールドのコールには金額を出さない', async () => {
      await db.hands.add(makeHand({ id: 1, approxTimestamp: 1000, bigBlind: 200, seatUserIds: [1, 2, 3] }))
      await db.actions.add(act({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.CALL, bet: 200, pot: 500, sidePot: [] }))
      const result = await getRecentHands(db, service, PLAYER_ID)
      expect(result.hands[0]!.preflopLine).toBe('L')
      expect(result.hands[0]!.preflopLineAmountChips).toBeNull()
    })

    test('プリフロップでアグレッシブでなければサイズは出さない', async () => {
      await db.hands.add(makeHand({ id: 1, approxTimestamp: 1000, bigBlind: 200 }))
      await db.actions.add(act({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.CALL, bet: 200, pot: 500, sidePot: [] }))
      const result = await getRecentHands(db, service, PLAYER_ID)
      expect(result.hands[0]!.preflopLineAmountChips).toBeNull()
      expect(result.hands[0]!.preflopLineAmountBB).toBeNull()
    })

    test('bigBlindが使えないハンドはBB換算だけnullになり、チップは残る', async () => {
      await db.hands.add(makeHand({ id: 1, approxTimestamp: 1000, bigBlind: 0 }))
      await db.actions.add(act({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, bet: 440, pot: 740, sidePot: [] }))
      const result = await getRecentHands(db, service, PLAYER_ID)
      expect(result.hands[0]!.preflopLineAmountChips).toBe(440)
      expect(result.hands[0]!.preflopLineAmountBB).toBeNull()
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
      expect(line).toBe('OR')
    })

    test('3bet: RAISE facing exactly one prior raise (opponent open)', async () => {
      const line = await lineFor([
        // Opponent's open (phasePrevBetCount=1 at write time), then hero's 3bet.
        makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.UTG, playerId: 2 }),
        makeAction({ handId: 1, index: 1, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.BTN, playerId: PLAYER_ID }),
      ])
      expect(line).toBe('3B')
    })

    test('cold-call: player\'s first preflop action is a CALL facing a prior raise', async () => {
      const line = await lineFor([
        makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.UTG, playerId: 2 }),
        makeAction({ handId: 1, index: 1, phase: PhaseType.PREFLOP, actionType: ActionType.CALL, position: Position.BTN, playerId: PLAYER_ID }),
      ])
      expect(line).toBe('CC')
    })

    // #356: オープンへのCCと3betへのCCは意味合いが全く違うので分ける。
    test('3CC: cold-calling a 3BET (facing two prior raises)', async () => {
      const line = await lineFor([
        makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.UTG, playerId: 2 }),
        makeAction({ handId: 1, index: 1, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.CO, playerId: 3 }),
        makeAction({ handId: 1, index: 2, phase: PhaseType.PREFLOP, actionType: ActionType.CALL, position: Position.BTN, playerId: PLAYER_ID }),
      ])
      expect(line).toBe('3CC')
    })

    test('4CC: cold-calling a 4BET (facing three prior raises)', async () => {
      const line = await lineFor([
        makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.UTG, playerId: 2 }),
        makeAction({ handId: 1, index: 1, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.CO, playerId: 3 }),
        makeAction({ handId: 1, index: 2, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.SB, playerId: 4 }),
        makeAction({ handId: 1, index: 3, phase: PhaseType.PREFLOP, actionType: ActionType.CALL, position: Position.BTN, playerId: PLAYER_ID }),
      ])
      expect(line).toBe('4CC')
    })

    // codexレビュー指摘（#356）: カバーしないショートオールインは保存上RAISEでも
    // 実質コールなので、ベット数として数えてはならない。
    test('CC: 先行のショートオールイン（実質コール）はベット数に数えない', async () => {
      const line = await lineFor([
        // オープン200 → カバーしないショートオールイン150（RAISE+ALL_IN保存）→ ヒーローのコール。
        // 生種別で数えると「3ベットに直面」となり3CCに化けるが、実質はオープンへのCC。
        makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.UTG, playerId: 2, bet: 200 }),
        makeAction({ handId: 1, index: 1, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.CO, playerId: 3, bet: 150, actionDetails: [ActionDetail.ALL_IN] }),
        makeAction({ handId: 1, index: 2, phase: PhaseType.PREFLOP, actionType: ActionType.CALL, position: Position.BTN, playerId: PLAYER_ID, bet: 200 }),
      ], { bigBlind: 100 })
      expect(line).toBe('CC')
    })

    test('3B: 先行のショートオールイン（実質コール）があってもレイズラベルはずれない', async () => {
      const line = await lineFor([
        makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.UTG, playerId: 2, bet: 200 }),
        makeAction({ handId: 1, index: 1, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.CO, playerId: 3, bet: 150, actionDetails: [ActionDetail.ALL_IN] }),
        makeAction({ handId: 1, index: 2, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.BTN, playerId: PLAYER_ID, bet: 600 }),
      ], { bigBlind: 100 })
      expect(line).toBe('3B')
    })

    test('3CC: カバーするオールインの3betは従来どおりベット数に数える', async () => {
      const line = await lineFor([
        makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.UTG, playerId: 2, bet: 200 }),
        makeAction({ handId: 1, index: 1, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.CO, playerId: 3, bet: 500, actionDetails: [ActionDetail.ALL_IN] }),
        makeAction({ handId: 1, index: 2, phase: PhaseType.PREFLOP, actionType: ActionType.CALL, position: Position.BTN, playerId: PLAYER_ID, bet: 500 }),
      ], { bigBlind: 100 })
      expect(line).toBe('3CC')
    })

    test('CCファミリーの-Fサフィックス（3betへCC後、4betに降りる）', async () => {
      const line = await lineFor([
        makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.UTG, playerId: 2 }),
        makeAction({ handId: 1, index: 1, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.CO, playerId: 3 }),
        makeAction({ handId: 1, index: 2, phase: PhaseType.PREFLOP, actionType: ActionType.CALL, position: Position.BTN, playerId: PLAYER_ID }),
        makeAction({ handId: 1, index: 3, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.UTG, playerId: 2 }),
        makeAction({ handId: 1, index: 4, phase: PhaseType.PREFLOP, actionType: ActionType.FOLD, position: Position.BTN, playerId: PLAYER_ID }),
      ])
      expect(line).toBe('3CC-F')
    })

    test('call: CALL facing a raise, after the player already had a preflop line (limped then called a raise)', async () => {
      const line = await lineFor([
        makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.CALL, position: Position.UTG, playerId: PLAYER_ID }), // limp
        makeAction({ handId: 1, index: 1, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.BTN, playerId: 2 }),
        makeAction({ handId: 1, index: 2, phase: PhaseType.PREFLOP, actionType: ActionType.CALL, position: Position.UTG, playerId: PLAYER_ID }),
      ])
      expect(line).toBe('C')
    })

    test('limp: first preflop action is a CALL with no prior raise (just the blind)', async () => {
      const line = await lineFor([
        makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.CALL, position: Position.UTG }),
      ])
      expect(line).toBe('L')
    })

    test('fold: only preflop action is a FOLD (no preceding line)', async () => {
      const line = await lineFor([
        makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.FOLD, position: Position.UTG }),
      ])
      expect(line).toBe('F')
    })

    test('-F suffix: opened, then folded to a re-raise -> OR-F', async () => {
      const line = await lineFor([
        makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.BTN, playerId: PLAYER_ID }),
        makeAction({ handId: 1, index: 1, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.SB, playerId: 2 }),
        makeAction({ handId: 1, index: 2, phase: PhaseType.PREFLOP, actionType: ActionType.FOLD, position: Position.BTN, playerId: PLAYER_ID }),
      ])
      expect(line).toBe('OR-F')
    })

    test('-F suffix: 3bet, then folded to a 4bet -> 3B-F', async () => {
      const line = await lineFor([
        makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.UTG, playerId: 2 }),
        makeAction({ handId: 1, index: 1, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.BTN, playerId: PLAYER_ID }), // 3bet
        makeAction({ handId: 1, index: 2, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, position: Position.UTG, playerId: 2 }), // 4bet
        makeAction({ handId: 1, index: 3, phase: PhaseType.PREFLOP, actionType: ActionType.FOLD, position: Position.BTN, playerId: PLAYER_ID }),
      ])
      expect(line).toBe('3B-F')
    })

    test('BB-check-walk: no preflop action at all + player was BB -> W', async () => {
      const line = await lineFor([], { bigBlindUserId: PLAYER_ID })
      expect(line).toBe('W')
    })

    test('BB-check-walk: BB checks their option after being limped to -> X', async () => {
      const line = await lineFor([
        makeAction({ handId: 1, index: 0, phase: PhaseType.PREFLOP, actionType: ActionType.CHECK, position: Position.BB }),
      ], { bigBlindUserId: PLAYER_ID })
      expect(line).toBe('X')
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
      expect(derivePreflopLine(hand, PLAYER_ID, actionsByHandId)).toBe('OR')
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

    /**
     * リプレイ取り込み（既定OFF）で保存済みの詳細があれば、マックした
     * ショーダウン行だけを埋める。サーバ自身がリプレイ機能で開示している
     * 情報なので、ゲームのUIが表示するものと同じ範囲に収まる。
     */
    describe('マック行のリプレイ穴埋め（オプトイン）', () => {
      const replayPayloadFor = (playerId: number, cards: number[]) => ({
        Game: { PlayerNum: 6 },
        Player: { SeatIndex: 0, UserId: playerId, HoleCardList: cards }
      })

      afterEach(async () => {
        await chrome.storage.sync.remove('experimentalReplayImportEnabled')
        await db.replayDetails.clear()
      })

      test('オプトインが有効なら、マック行をリプレイの手札で埋める', async () => {
        await chrome.storage.sync.set({ experimentalReplayImportEnabled: true })
        const handId = nextHandId++
        await db.hands.add(makeHand({
          id: handId,
          results: [{ UserId: PLAYER_ID, HandRanking: -1, Ranking: -2, RewardChip: 0, RankType: RankType.SHOWDOWN_MUCK, Hands: [], HoleCards: [] }]
        }))
        await db.replayDetails.put({
          handId,
          payload: replayPayloadFor(PLAYER_ID, [48, 49]),
          fetchedAt: 1
        })

        const result = await getRecentHands(db, service, PLAYER_ID, 1)
        expect(result.hands[0]!.holeCards).toEqual(['As', 'Ah'])
        expect(result.hands[0]!.holeCardsSource).toBe('replay')
      })

      test('オプトインが無効なら埋めない（保存済みでも読まない）', async () => {
        const handId = nextHandId++
        await db.hands.add(makeHand({
          id: handId,
          results: [{ UserId: PLAYER_ID, HandRanking: -1, Ranking: -2, RewardChip: 0, RankType: RankType.SHOWDOWN_MUCK, Hands: [], HoleCards: [] }]
        }))
        await db.replayDetails.put({
          handId,
          payload: replayPayloadFor(PLAYER_ID, [48, 49]),
          fetchedAt: 1
        })

        const result = await getRecentHands(db, service, PLAYER_ID, 1)
        expect(result.hands[0]!.holeCards).toBeNull()
        expect(result.hands[0]!.holeCardsSource).toBeNull()
      })

      // ショーダウンに到達していない行は埋めない。サーバがリプレイで
      // 開示するのはショーダウンに到達した手であり、降りた相手の手札は
      // この経路の対象外。
      test('ショーダウンに到達していない行は埋めない', async () => {
        await chrome.storage.sync.set({ experimentalReplayImportEnabled: true })
        const handId = nextHandId++
        await db.hands.add(makeHand({
          id: handId,
          results: [{ UserId: PLAYER_ID, HandRanking: -1, Ranking: -2, RewardChip: 0, RankType: RankType.NO_CALL, Hands: [], HoleCards: [] }]
        }))
        await db.replayDetails.put({
          handId,
          payload: replayPayloadFor(PLAYER_ID, [48, 49]),
          fetchedAt: 1
        })

        const result = await getRecentHands(db, service, PLAYER_ID, 1)
        expect(result.hands[0]!.holeCards).toBeNull()
      })

      test('WebSocket側に実手札があればそちらを優先する', async () => {
        await chrome.storage.sync.set({ experimentalReplayImportEnabled: true })
        const handId = nextHandId++
        await db.hands.add(makeHand({
          id: handId,
          results: [{ UserId: PLAYER_ID, HandRanking: 1, Ranking: -2, RewardChip: 0, RankType: RankType.ONE_PAIR, Hands: [], HoleCards: [48, 49] }]
        }))
        await db.replayDetails.put({
          handId,
          payload: replayPayloadFor(PLAYER_ID, [0, 1]),
          fetchedAt: 1
        })

        const result = await getRecentHands(db, service, PLAYER_ID, 1)
        expect(result.hands[0]!.holeCards).toEqual(['As', 'Ah'])
        expect(result.hands[0]!.holeCardsSource).toBe('results')
      })
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
    test('profitable hand uses exact signed accounting rather than gross RewardChip', async () => {
      const hand = makeHand({
        id: 1,
        results: [{ UserId: PLAYER_ID, HandRanking: 1, Ranking: -2, RewardChip: 1240, RankType: RankType.NO_CALL, Hands: [], HoleCards: [] }],
        playerChipAccounting: {
          [String(PLAYER_ID)]: { grossPayout: 1240, totalContribution: 240, netChips: 1000 }
        }
      })
      await db.hands.add(hand)
      const result = await getRecentHands(db, service, PLAYER_ID, 10)
      expect(result.hands[0]!.won).toBe(true)
      expect(result.hands[0]!.netChips).toBe(1000)
      expect(result.hands[0]!.wentToShowdown).toBe(false) // NO_CALL is not a showdown
    })

    test('lost hand preserves a negative signed result', async () => {
      const hand = makeHand({
        id: 1,
        results: [{ UserId: PLAYER_ID, HandRanking: -1, Ranking: -2, RewardChip: 0, RankType: RankType.ONE_PAIR, Hands: [], HoleCards: [48, 49] }],
        playerChipAccounting: {
          [String(PLAYER_ID)]: { grossPayout: 0, totalContribution: 200, netChips: -200 }
        }
      })
      await db.hands.add(hand)
      const result = await getRecentHands(db, service, PLAYER_ID, 10)
      expect(result.hands[0]!.won).toBe(false)
      expect(result.hands[0]!.netChips).toBe(-200)
      expect(result.hands[0]!.wentToShowdown).toBe(true) // real comparison RankType
    })

    test('break-even hand preserves zero while an ambiguous accounting entry stays null', async () => {
      await db.hands.bulkAdd([
        makeHand({
          id: 2,
          playerChipAccounting: {
            [String(PLAYER_ID)]: { grossPayout: 200, totalContribution: 200, netChips: 0 }
          }
        }),
        makeHand({ id: 1, playerChipAccounting: { [String(PLAYER_ID)]: null } }),
      ])

      const result = await getRecentHands(db, service, PLAYER_ID, 10)
      expect(result.hands.map(hand => hand.netChips)).toEqual([0, null])
      expect(result.hands.map(hand => hand.won)).toEqual([false, false])
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
    test('differs by playerId, battleTypeFilter, tableSizeFilter, and hero-panel-ness', () => {
      const key1 = buildRecentHandsCacheKey(PLAYER_ID, service)
      const key2 = buildRecentHandsCacheKey(2, service)
      expect(key1).not.toBe(key2)

      // #353: ヒーロー本人のパネルは配札ホールカードを埋めるので、組み立て結果が
      // 変わる。ヒーローID未復元のうちにキャッシュした「カードなし」の結果が、
      // ID復元後もそのまま返り続けないようにキーへ含める。
      service.playerId = PLAYER_ID
      const keyHero = buildRecentHandsCacheKey(PLAYER_ID, service)
      expect(key1).not.toBe(keyHero)
      service.playerId = undefined

      // codexレビュー指摘（P2）: フェッチ開始時のスナップショットを明示的に
      // 渡せる。キー作成とLake読み取りが同じ値を使うための口。
      expect(buildRecentHandsCacheKey(PLAYER_ID, service, true)).toBe(keyHero)
      expect(buildRecentHandsCacheKey(PLAYER_ID, service, false)).toBe(key1)

      service.battleTypeFilter = [BattleType.RING_GAME]
      const keyBattle = buildRecentHandsCacheKey(PLAYER_ID, service)
      expect(key1).not.toBe(keyBattle)
      service.battleTypeFilter = undefined

      service.tableSizeFilter = ['full']
      const keyTable = buildRecentHandsCacheKey(PLAYER_ID, service)
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
      service.session.setBattleType(BattleType.TOURNAMENT)
      await new Promise<void>(resolve => {
        service.writeEntityStream.once('data', () => resolve())
        service.writeEntityStream.write(makeMinimalHandEvents(5, [1, 2, 3]))
      })

      const afterHandCompletion = await getRecentHands(db, service, PLAYER_ID, 10)
      expect(afterHandCompletion).not.toBe(first) // recomputed, not served from the now-stale cache
      // hand 4 (seeded directly above) AND hand 5 (persisted by writeEntityStream
      // itself, from makeMinimalHandEvents) are both now reflected.
      expect(afterHandCompletion.hands.map(h => h.handId)).toEqual([5, 4, 3, 2, 1])
      expect(afterHandCompletion.hands[0]!.netChips).toBe(300)
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
