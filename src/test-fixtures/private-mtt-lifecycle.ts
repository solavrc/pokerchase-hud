import type { ApiEvent } from '../types/api'
import { ApiType } from '../types/api'
import { BattleType, BetStatusType, PhaseType, RankType } from '../types/game'

/**
 * Sanitized private-MTT lifecycle derived from audit_ref=b1feff03635a.
 *
 * Retained production facts:
 * - the same private tournament identity is announced by 201/308 three times;
 * - two 309 events have IsRebuy=true and are followed by another entry/hand;
 * - two 313 table moves re-anchor the hero to a different seat/lineup;
 * - the four HandIds bracketing those moves and one late HandId are real;
 * - the final 309 is Ranking=3, IsRebuy=false.
 *
 * The 220-hand production capture is condensed to five representative hands.
 * Timestamps, cards, stacks, tournament name, and all user/display/private ids
 * are synthetic or redacted. Entry Codes and private ticket markers are not
 * retained.
 */

const HERO_ID = 100
const FIRST_LINEUP = [HERO_ID, 101, 102, 103, 104, 105] as const
const SECOND_LINEUP = [201, 202, 203, 204, 205, HERO_ID] as const
// The long capture contained intervening hands/tables. Keep the same players
// but rotate their observed seats to preserve the audited pre-move hero seat.
const SECOND_PRE_MOVE_LINEUP = [202, HERO_ID, 203, 204, 205, 201] as const
const FINAL_LINEUP = [301, 302, HERO_ID, 303, 304, 305] as const

const TOURNAMENT_ID = 'private-mtt-redacted'
const TOURNAMENT_NAME = 'Private MTT [redacted]'
const BASE_TIMESTAMP = 1_720_000_000_000

const rank = {
  RankId: 'redacted',
  RankName: '',
  RankLvId: 'redacted',
  RankLvName: ''
}

const tableUser = (userId: number) => ({
  UserId: userId,
  UserName: '',
  FavoriteCharaId: '',
  CostumeId: '',
  EmblemId: '',
  IsCpu: false,
  IsOfficial: false,
  SettingDecoIds: ['', '', '', '', '', '', ''],
  Rank: rank
})

const entry = (timestamp: number): ApiEvent<ApiType.EVT_ENTRY_QUEUED> => ({
  ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
  timestamp,
  BattleType: BattleType.TOURNAMENT,
  Code: 0,
  Id: TOURNAMENT_ID,
  IsRetire: false
})

const details = (timestamp: number): ApiEvent<ApiType.EVT_SESSION_DETAILS> => ({
  ApiTypeId: ApiType.EVT_SESSION_DETAILS,
  timestamp,
  BlindStructures: [{ ActiveMinutes: 5, Ante: 50, BigBlind: 200, Lv: 1 }],
  CoinNum: -1,
  DefaultChip: 20_000,
  IsReplay: false,
  Items: [],
  LimitSeconds: 10,
  MoneyList: [],
  Name: TOURNAMENT_NAME,
  Name2: ''
})

const seatAssigned = (
  timestamp: number,
  lineup: readonly number[]
): ApiEvent<ApiType.EVT_PLAYER_SEAT_ASSIGNED> => ({
  ApiTypeId: ApiType.EVT_PLAYER_SEAT_ASSIGNED,
  timestamp,
  IsLeave: false,
  IsRetire: false,
  ProcessType: 1,
  SeatUserIds: [...lineup],
  TableUsers: lineup.map(tableUser)
})

const deal = (
  timestamp: number,
  lineup: readonly number[],
  heroSeat: 0 | 1 | 2 | 5
): ApiEvent<ApiType.EVT_DEAL> => ({
  ApiTypeId: ApiType.EVT_DEAL,
  timestamp,
  SeatUserIds: [...lineup],
  Game: {
    CurrentBlindLv: 1,
    NextBlindUnixSeconds: Math.floor(timestamp / 1000) + 300,
    Ante: 50,
    SmallBlind: 100,
    BigBlind: 200,
    ButtonSeat: 3,
    SmallBlindSeat: 4,
    BigBlindSeat: 5
  },
  Player: {
    SeatIndex: heroSeat,
    BetStatus: BetStatusType.BET_ABLE,
    HoleCards: [0, 5],
    Chip: 19_950,
    BetChip: heroSeat === 5 ? 200 : 0
  },
  OtherPlayers: lineup
    .map((_, SeatIndex) => SeatIndex)
    .filter(SeatIndex => SeatIndex !== heroSeat)
    .map(SeatIndex => ({
      SeatIndex: SeatIndex as 0 | 1 | 2 | 3 | 4 | 5,
      Status: 0 as const,
      BetStatus: BetStatusType.BET_ABLE,
      Chip: 19_950,
      BetChip: SeatIndex === 4 ? 100 : SeatIndex === 5 ? 200 : 0,
      IsSafeLeave: false
    })),
  Progress: {
    Phase: PhaseType.PREFLOP,
    NextActionSeat: heroSeat,
    NextActionTypes: [2, 3, 4, 5],
    NextExtraLimitSeconds: 1,
    MinRaise: 400,
    Pot: 350,
    SidePot: []
  }
})

const results = (
  timestamp: number,
  handId: number,
  lineup: readonly number[],
  heroSeat: 0 | 1 | 2 | 5,
  finalPlacement = false
): ApiEvent<ApiType.EVT_HAND_RESULTS> => {
  const winnerId = lineup.find(userId => userId !== HERO_ID)!
  return {
    ApiTypeId: ApiType.EVT_HAND_RESULTS,
    timestamp,
    CommunityCards: [],
    Pot: 350,
    SidePot: [],
    ResultType: finalPlacement ? 1 : 0,
    DefeatStatus: 0,
    HandId: handId,
    HandLog: '',
    Results: [
      {
        UserId: winnerId,
        HoleCards: [],
        RankType: RankType.NO_CALL,
        Hands: [],
        HandRanking: 1,
        Ranking: -2,
        RewardChip: 350
      },
      ...(finalPlacement
        ? [{
            UserId: HERO_ID,
            HoleCards: [] as number[],
            RankType: RankType.NO_CALL,
            Hands: [] as number[],
            HandRanking: -1 as const,
            Ranking: 3 as const,
            RewardChip: 0
          }]
        : [])
    ],
    Player: {
      SeatIndex: heroSeat,
      BetStatus: finalPlacement ? BetStatusType.ELIMINATED : BetStatusType.HAND_ENDED,
      Chip: finalPlacement ? 0 : 19_950,
      BetChip: 0
    },
    OtherPlayers: lineup
      .map((_, SeatIndex) => SeatIndex)
      .filter(SeatIndex => SeatIndex !== heroSeat)
      .map(SeatIndex => ({
        SeatIndex: SeatIndex as 0 | 1 | 2 | 3 | 4 | 5,
        Status: 0 as const,
        BetStatus: BetStatusType.HAND_ENDED as const,
        Chip: 19_950,
        BetChip: 0,
        IsSafeLeave: false
      }))
  }
}

const sessionResults = (
  timestamp: number,
  isRebuy: boolean,
  ranking: number
): ApiEvent<ApiType.EVT_SESSION_RESULTS> => ({
  ApiTypeId: ApiType.EVT_SESSION_RESULTS,
  timestamp,
  Charas: [],
  Costumes: [],
  Decos: [],
  Emblems: [],
  EventRewards: [],
  IsLeave: false,
  IsRebuy: isRebuy,
  Items: [],
  Money: { FreeMoney: -1, PaidMoney: -1 },
  Ranking: ranking,
  Rewards: [],
  TotalMatch: 1
})

const FIRST_DEAL = deal(BASE_TIMESTAMP + 2, FIRST_LINEUP, 0)
const FIRST_RESULT = results(BASE_TIMESTAMP + 3, 284_723_970, FIRST_LINEUP, 0)
const FIRST_REBUY = sessionResults(BASE_TIMESTAMP + 4, true, -1)

const SECOND_DEAL = deal(BASE_TIMESTAMP + 8, SECOND_LINEUP, 5)
const SECOND_RESULT = results(BASE_TIMESTAMP + 9, 284_724_598, SECOND_LINEUP, 5)
const SECOND_PRE_MOVE_DEAL = deal(BASE_TIMESTAMP + 10, SECOND_PRE_MOVE_LINEUP, 1)
const SECOND_PRE_MOVE_RESULT = results(BASE_TIMESTAMP + 11, 284_728_288, SECOND_PRE_MOVE_LINEUP, 1)
const SECOND_REBUY = sessionResults(BASE_TIMESTAMP + 12, true, -1)

const FINAL_DEAL = deal(BASE_TIMESTAMP + 16, FINAL_LINEUP, 2)
const FINAL_MOVE_RESULT = results(BASE_TIMESTAMP + 17, 284_728_560, FINAL_LINEUP, 2)
const FINAL_PLACEMENT_DEAL = deal(BASE_TIMESTAMP + 18, FINAL_LINEUP, 2)
const FINAL_PLACEMENT_RESULT = results(BASE_TIMESTAMP + 19, 284_772_026, FINAL_LINEUP, 2, true)
const FINAL_SESSION_RESULT = sessionResults(BASE_TIMESTAMP + 20, false, 3)

export const PRIVATE_MTT_LIFECYCLE_FIXTURE = {
  heroId: HERO_ID,
  tournamentId: TOURNAMENT_ID,
  tournamentName: TOURNAMENT_NAME,
  lineups: {
    first: [...FIRST_LINEUP],
    second: [...SECOND_LINEUP],
    secondPreMove: [...SECOND_PRE_MOVE_LINEUP],
    final: [...FINAL_LINEUP]
  },
  heroSeats: [0, 5, 1, 2, 2],
  handIds: [284_723_970, 284_724_598, 284_728_288, 284_728_560, 284_772_026],
  intermediateResults: [FIRST_REBUY, SECOND_REBUY],
  finalResult: FINAL_SESSION_RESULT,
  finalDeal: FINAL_PLACEMENT_DEAL,
  events: [
    entry(BASE_TIMESTAMP),
    details(BASE_TIMESTAMP + 1),
    FIRST_DEAL,
    FIRST_RESULT,
    FIRST_REBUY,

    entry(BASE_TIMESTAMP + 5),
    details(BASE_TIMESTAMP + 6),
    seatAssigned(BASE_TIMESTAMP + 7, SECOND_LINEUP),
    SECOND_DEAL,
    SECOND_RESULT,
    SECOND_PRE_MOVE_DEAL,
    SECOND_PRE_MOVE_RESULT,
    SECOND_REBUY,

    entry(BASE_TIMESTAMP + 13),
    details(BASE_TIMESTAMP + 14),
    seatAssigned(BASE_TIMESTAMP + 15, FINAL_LINEUP),
    FINAL_DEAL,
    FINAL_MOVE_RESULT,
    FINAL_PLACEMENT_DEAL,
    FINAL_PLACEMENT_RESULT,
    FINAL_SESSION_RESULT
  ] as ApiEvent[]
} as const
