import type { ApiEvent } from '../types/api'
import { ApiType } from '../types/api'
import { ActionType, BattleType, BetStatusType, PhaseType, RankType } from '../types/game'

/**
 * Sanitized lifecycle derived from BattleType audit_ref=952005e4927c.
 *
 * The structural facts retained from the capture are:
 * - repeated 201 -> 308 -> 313 table-move announcements;
 * - hero seat changes from 5 to 2 with a completely different lineup;
 * - an old-table 303 buffer receives a new-table 306 and must be rejected;
 * - accepted HandIds arrive as 288331102 -> 288331101 -> 288331638;
 * - a later old-table 303/new-table 306 boundary is rejected as a chimera.
 *
 * The rejected boundary HandId is synthetic because the audit published only
 * the rejected count, not those identifiers. All user IDs below are synthetic
 * small integers. Display names, observer, tournament, room, and other private
 * identifiers are omitted or redacted.
 */

const HERO_ID = 1006
const OLD_LINEUP = [1001, 1002, 1003, 1004, 1005, HERO_ID] as const
const MIDDLE_LINEUP = [2001, 2002, HERO_ID, 2004, 2005, 2006] as const
const NEW_LINEUP = [3001, 3002, HERO_ID, 3004, 3005, 3006] as const

const BASE_TIMESTAMP = 1_700_000_000_000

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
  Id: 'redacted',
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
  Name: '',
  Name2: ''
})

const seatAssigned = (
  timestamp: number,
  processType: 1 | 2 | 4,
  lineup: readonly number[]
): ApiEvent<ApiType.EVT_PLAYER_SEAT_ASSIGNED> => ({
  ApiTypeId: ApiType.EVT_PLAYER_SEAT_ASSIGNED,
  timestamp,
  IsLeave: false,
  IsRetire: false,
  ProcessType: processType,
  SeatUserIds: [...lineup],
  TableUsers: lineup.map(tableUser)
})

const deal = (
  timestamp: number,
  lineup: readonly number[],
  heroSeat: 2 | 5
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
    ButtonSeat: 0,
    SmallBlindSeat: 1,
    BigBlindSeat: 2
  },
  Player: {
    SeatIndex: heroSeat,
    BetStatus: BetStatusType.BET_ABLE,
    HoleCards: [0, 5],
    Chip: 19_750,
    BetChip: heroSeat === 2 ? 200 : 0
  },
  OtherPlayers: lineup
    .map((_, SeatIndex) => SeatIndex)
    .filter(SeatIndex => SeatIndex !== heroSeat)
    .map(SeatIndex => ({
      SeatIndex: SeatIndex as 0 | 1 | 2 | 3 | 4 | 5,
      Status: 0 as const,
      BetStatus: BetStatusType.BET_ABLE,
      Chip: 19_950,
      BetChip: SeatIndex === 1 ? 100 : 0,
      IsSafeLeave: false
    })),
  Progress: {
    Phase: PhaseType.PREFLOP,
    NextActionSeat: heroSeat,
    NextActionTypes: [ActionType.FOLD, ActionType.CALL, ActionType.RAISE, ActionType.ALL_IN],
    NextExtraLimitSeconds: 1,
    MinRaise: 400,
    Pot: 600,
    SidePot: []
  }
})

const results = (
  timestamp: number,
  handId: number,
  lineup: readonly number[],
  heroSeat: 2 | 5
): ApiEvent<ApiType.EVT_HAND_RESULTS> => ({
  ApiTypeId: ApiType.EVT_HAND_RESULTS,
  timestamp,
  CommunityCards: [],
  Pot: 600,
  SidePot: [],
  ResultType: 0,
  DefeatStatus: 0,
  HandId: handId,
  HandLog: '',
  Results: [{
    UserId: lineup[0]!,
    HoleCards: [],
    RankType: RankType.NO_CALL,
    Hands: [],
    HandRanking: 1,
    Ranking: -2,
    RewardChip: 600
  }],
  Player: {
    SeatIndex: heroSeat,
    BetStatus: BetStatusType.HAND_ENDED,
    Chip: 19_750,
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
      BetChip: 0 as const,
      IsSafeLeave: false
    }))
})

const action = (
  timestamp: number,
  heroSeat: 2 | 5,
  actionType: ActionType.CALL | ActionType.FOLD
): ApiEvent<ApiType.EVT_ACTION> => ({
  ApiTypeId: ApiType.EVT_ACTION,
  timestamp,
  SeatIndex: heroSeat,
  ActionType: actionType,
  Chip: actionType === ActionType.CALL ? 19_600 : 19_750,
  BetChip: actionType === ActionType.CALL ? 400 : 0,
  Progress: {
    Phase: PhaseType.PREFLOP,
    NextActionSeat: -2,
    NextActionTypes: [],
    NextExtraLimitSeconds: 0,
    MinRaise: 0,
    Pot: 600,
    SidePot: []
  }
})

export const MTT_TABLE_MOVE_FIXTURE = {
  heroId: HERO_ID,
  oldHeroSeat: 5,
  newHeroSeat: 2,
  oldLineup: [...OLD_LINEUP],
  middleLineup: [...MIDDLE_LINEUP],
  newLineup: [...NEW_LINEUP],
  handIds: {
    oldAccepted: 288331102,
    invertedAccepted: 288331101,
    rejectedChimera: 288331500,
    newAccepted: 288331638
  },
  timestamps: {
    oldAcceptedDeal: BASE_TIMESTAMP + 3,
    invertedAcceptedDeal: BASE_TIMESTAMP + 9,
    oldTailDeal: BASE_TIMESTAMP + 12,
    rejectedChimeraResult: BASE_TIMESTAMP + 16,
    newAcceptedDeal: BASE_TIMESTAMP + 17
  },
  events: [
    entry(BASE_TIMESTAMP),
    details(BASE_TIMESTAMP + 1),
    seatAssigned(BASE_TIMESTAMP + 2, 1, OLD_LINEUP),
    deal(BASE_TIMESTAMP + 3, OLD_LINEUP, 5),
    action(BASE_TIMESTAMP + 4, 5, ActionType.CALL),
    results(BASE_TIMESTAMP + 5, 288331102, OLD_LINEUP, 5),

    // First move: the next accepted hand arrives with a lower HandId.
    entry(BASE_TIMESTAMP + 6),
    details(BASE_TIMESTAMP + 7),
    seatAssigned(BASE_TIMESTAMP + 8, 2, MIDDLE_LINEUP),
    deal(BASE_TIMESTAMP + 9, MIDDLE_LINEUP, 2),
    action(BASE_TIMESTAMP + 10, 2, ActionType.FOLD),
    results(BASE_TIMESTAMP + 11, 288331101, MIDDLE_LINEUP, 2),

    // Second move: a tail from the previous table is buffered before the
    // destination-table result arrives. The mixed buffer must be rejected.
    deal(BASE_TIMESTAMP + 12, MIDDLE_LINEUP, 2),
    entry(BASE_TIMESTAMP + 13),
    details(BASE_TIMESTAMP + 14),
    seatAssigned(BASE_TIMESTAMP + 15, 4, NEW_LINEUP),
    results(BASE_TIMESTAMP + 16, 288331500, NEW_LINEUP, 2),

    // The first complete destination-table hand must be accepted and replace
    // every old lineup/hero-seat display context.
    deal(BASE_TIMESTAMP + 17, NEW_LINEUP, 2),
    action(BASE_TIMESTAMP + 18, 2, ActionType.FOLD),
    results(BASE_TIMESTAMP + 19, 288331638, NEW_LINEUP, 2)
  ] as ApiEvent[]
} as const
