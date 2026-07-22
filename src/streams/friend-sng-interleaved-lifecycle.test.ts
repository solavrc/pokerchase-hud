/**
 * Friend SNG interleaved lifecycle regression fixture.
 *
 * Evidence source: docs/battle-type-coverage-audit.md.
 * - audit_ref 6a9017d85260 observed BattleType=2 with one 201, no 308/313,
 *   and completed hands.
 * - a separate long BattleType=2 segment observed 201 x1, 306 x167, and
 *   309 x10, with a new hand continuing after 309 without another 201.
 *
 * This fixture condenses that lifecycle to two completed hands separated by
 * 309. The two HandIds are retained as safe correlation keys from the audit;
 * their exact boundary relationship is synthetic. Player ids, lineups,
 * timestamps, cards, stacks, and the private session id are synthetic. Names,
 * User/observer ids, and raw private-room payloads are omitted.
 *
 * A Friend SNG 201 Id is retained as hand metadata, not used to aggregate
 * hands into a match object: persisted hands remain independently keyed by
 * HandId. An interleaved 309 must therefore neither clear the BattleType=2
 * context nor prevent the next Player-present 303 from reaching the HUD.
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { PokerChaseDB } from '../db/poker-chase-db'
import { EntityConverter } from '../entity-converter'
import PokerChaseService from '../services/poker-chase-service'
import { clearRecentHandsCache, getRecentHands } from '../services/recent-hands-service'
import {
  ApiType,
  BattleType,
  BetStatusType,
  parseApiEvent,
  RankType,
} from '../types'
import type { ApiEvent, PlayerStats, Session, StatResult } from '../types'

const HERO_ID = 101
const FIRST_LINEUP = [HERO_ID, 102, 103, 104]
const SECOND_LINEUP = [HERO_ID, 202, 203, 204]
const REDACTED_SESSION_ID = 'friend_sng_fixture_redacted'
const FIRST_HAND_ID = 428812561
const SECOND_HAND_ID = 428812789
const T0 = 2_000_000

const progress = {
  Phase: 0 as const,
  NextActionSeat: 0 as const,
  NextActionTypes: [2, 3, 4, 5] as const,
  NextExtraLimitSeconds: 1,
  MinRaise: 400,
  Pot: 300,
  SidePot: [],
}

function dealEvent(timestamp: number, lineup: number[], holeCards: [number, number]): ApiEvent<ApiType.EVT_DEAL> {
  return {
    ApiTypeId: ApiType.EVT_DEAL,
    timestamp,
    SeatUserIds: lineup,
    Game: {
      CurrentBlindLv: 1,
      NextBlindUnixSeconds: -1,
      Ante: 50,
      SmallBlind: 100,
      BigBlind: 200,
      ButtonSeat: 3,
      SmallBlindSeat: 0,
      BigBlindSeat: 1,
    },
    Player: {
      SeatIndex: 0,
      BetStatus: BetStatusType.BET_ABLE,
      HoleCards: holeCards,
      Chip: 5_900,
      BetChip: 100,
    },
    OtherPlayers: [
      {
        SeatIndex: 1,
        Status: 0,
        BetStatus: BetStatusType.BET_ABLE,
        Chip: 5_800,
        BetChip: 200,
      },
      {
        SeatIndex: 2,
        Status: 0,
        BetStatus: BetStatusType.BET_ABLE,
        Chip: 6_000,
        BetChip: 0,
      },
      {
        SeatIndex: 3,
        Status: 0,
        BetStatus: BetStatusType.BET_ABLE,
        Chip: 6_000,
        BetChip: 0,
      },
    ],
    Progress: { ...progress, NextActionTypes: [...progress.NextActionTypes] },
  }
}

function handResultsEvent(
  timestamp: number,
  handId: number,
  lineup: number[],
): ApiEvent<ApiType.EVT_HAND_RESULTS> {
  return {
    ApiTypeId: ApiType.EVT_HAND_RESULTS,
    timestamp,
    HandId: handId,
    CommunityCards: [],
    Pot: 300,
    SidePot: [],
    ResultType: 0,
    DefeatStatus: 0,
    HandLog: '',
    Results: [{
      UserId: HERO_ID,
      RankType: RankType.NO_CALL,
      HandRanking: 1,
      Hands: [],
      HoleCards: [],
      Ranking: -2,
      RewardChip: 300,
    }],
    Player: {
      SeatIndex: 0,
      BetStatus: BetStatusType.HAND_ENDED,
      Chip: 6_200,
      BetChip: 0,
    },
    OtherPlayers: lineup.slice(1).map((_, index) => ({
      SeatIndex: (index + 1) as 1 | 2 | 3,
      Status: 0 as const,
      BetStatus: BetStatusType.HAND_ENDED,
      Chip: 5_800,
      BetChip: 0,
    })),
  }
}

function sessionResultsEvent(timestamp: number, ranking: number): ApiEvent<ApiType.EVT_SESSION_RESULTS> {
  return {
    ApiTypeId: ApiType.EVT_SESSION_RESULTS,
    timestamp,
    Charas: [],
    Costumes: [],
    Decos: [],
    Emblems: [],
    EventRewards: [],
    IsLeave: false,
    IsRebuy: false,
    Items: [],
    Money: { FreeMoney: -1, PaidMoney: -1 },
    Ranking: ranking,
    Rewards: [],
    TotalMatch: 1,
  }
}

const ENTRY: ApiEvent<ApiType.EVT_ENTRY_QUEUED> = {
  ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
  timestamp: T0,
  BattleType: BattleType.FRIEND_SIT_AND_GO,
  Code: 0,
  Id: REDACTED_SESSION_ID,
  IsRetire: false,
}

const FIRST_DEAL = dealEvent(T0 + 1_000, FIRST_LINEUP, [5, 21])
const FIRST_RESULTS = handResultsEvent(T0 + 20_000, FIRST_HAND_ID, FIRST_LINEUP)
const INTERLEAVED_END = sessionResultsEvent(T0 + 21_000, 1)
const SECOND_DEAL = dealEvent(T0 + 22_000, SECOND_LINEUP, [10, 26])
const SECOND_RESULTS = handResultsEvent(T0 + 40_000, SECOND_HAND_ID, SECOND_LINEUP)
const FINAL_END = sessionResultsEvent(T0 + 41_000, 2)

const FIXTURE_EVENTS: ApiEvent[] = [
  ENTRY,
  FIRST_DEAL,
  FIRST_RESULTS,
  INTERLEAVED_END,
  SECOND_DEAL,
  SECOND_RESULTS,
  FINAL_END,
]

function handsStat(stats: PlayerStats[], playerId: number): StatResult | undefined {
  const player = stats.find(stat => stat.playerId === playerId)
  if (!player || !('statResults' in player) || !player.statResults) return undefined
  return player.statResults.find(stat => stat.id === 'hands')
}

const EMPTY_SESSION: Session = {
  id: undefined,
  battleType: undefined,
  name: undefined,
  players: new Map(),
  reset: () => {},
}

describe('Friend SNG 309 -> next hand lifecycle (audit_ref 6a9017d85260)', () => {
  let db: PokerChaseDB

  beforeEach(async () => {
    clearRecentHandsCache()
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
  })

  afterEach(async () => {
    await db.delete()
    clearRecentHandsCache()
  })

  test('stores and rebuilds each hand independently without requiring another 201, 308, or 313', async () => {
    expect(FIXTURE_EVENTS.filter(event => parseApiEvent(event) === null).map(event => event.ApiTypeId)).toEqual([])
    expect(FIXTURE_EVENTS.filter(event => event.ApiTypeId === ApiType.EVT_ENTRY_QUEUED)).toHaveLength(1)
    expect(FIXTURE_EVENTS.filter(event => event.ApiTypeId === ApiType.EVT_SESSION_RESULTS)).toHaveLength(2)
    expect(FIXTURE_EVENTS.filter(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)).toHaveLength(2)
    expect(FIXTURE_EVENTS.some(event => event.ApiTypeId === ApiType.EVT_SESSION_DETAILS)).toBe(false)
    expect(FIXTURE_EVENTS.some(event => event.ApiTypeId === ApiType.EVT_PLAYER_SEAT_ASSIGNED)).toBe(false)

    const service = new PokerChaseService({ db })
    await service.ready

    const aggregatedHands: ApiEvent[][] = []
    const completedLineups: number[][] = []
    service.handAggregateStream.on('data', hand => aggregatedHands.push(hand))
    service.writeEntityStream.on('data', lineup => completedLineups.push(lineup))

    const write = async (event: ApiEvent) => {
      service.handAggregateStream.write(event)
      await service.handAggregateStream.whenIdle()
      await service.writeEntityStream.whenIdle()
    }

    for (const event of FIXTURE_EVENTS.slice(0, 4)) await write(event)

    // 309 is allowed to belong to another interleaved Friend SNG. It must not
    // erase the only observed BattleType/session metadata before the next hand.
    expect(service.session.id).toBe(REDACTED_SESSION_ID)
    expect(service.session.battleType).toBe(BattleType.FRIEND_SIT_AND_GO)
    expect(service.session.players.size).toBe(0)

    for (const event of FIXTURE_EVENTS.slice(4)) await write(event)

    expect(aggregatedHands).toHaveLength(2)
    expect(aggregatedHands.map(events => events.map(event => event.ApiTypeId))).toEqual([
      [ApiType.EVT_DEAL, ApiType.EVT_HAND_RESULTS],
      [ApiType.EVT_DEAL, ApiType.EVT_HAND_RESULTS],
    ])
    expect(completedLineups).toEqual([FIRST_LINEUP, SECOND_LINEUP])
    expect(service.latestEvtDeal).toEqual(SECOND_DEAL)
    expect(service.playerId).toBe(HERO_ID)

    const liveHands = await db.hands.orderBy('id').toArray()
    expect(liveHands.map(hand => hand.id)).toEqual([FIRST_HAND_ID, SECOND_HAND_ID])
    expect(liveHands.map(hand => hand.seatUserIds)).toEqual([FIRST_LINEUP, SECOND_LINEUP])
    expect(liveHands.every(hand => hand.session.id === REDACTED_SESSION_ID)).toBe(true)
    expect(liveHands.every(hand => hand.session.battleType === BattleType.FRIEND_SIT_AND_GO)).toBe(true)

    service.battleTypeFilter = [BattleType.FRIEND_SIT_AND_GO]
    expect(handsStat(await service.statsOutputStream.calcStats([HERO_ID]), HERO_ID)?.value).toBe(2)
    expect((await getRecentHands(db, service, HERO_ID)).hands.map(hand => hand.handId)).toEqual([
      SECOND_HAND_ID,
      FIRST_HAND_ID,
    ])

    // Batch rebuild/parser parity: 309 remains outside both hand windows and
    // the second 303 starts a fresh hand even without any new session event.
    const rebuilt = new EntityConverter(EMPTY_SESSION).convertEventsToEntities(FIXTURE_EVENTS)
    expect(rebuilt.hands.map(hand => hand.id)).toEqual([FIRST_HAND_ID, SECOND_HAND_ID])
    expect(rebuilt.hands.map(hand => hand.seatUserIds)).toEqual([FIRST_LINEUP, SECOND_LINEUP])
    expect(rebuilt.hands.every(hand => hand.session.id === REDACTED_SESSION_ID)).toBe(true)
    expect(rebuilt.hands.every(hand => hand.session.battleType === BattleType.FRIEND_SIT_AND_GO)).toBe(true)
  })
})
