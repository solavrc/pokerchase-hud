import type { ApiEvent } from '../types/api'
import { ApiType } from '../types/api'
import { BattleType, BetStatusType } from '../types/game'
import {
  deriveHandRakeAccounting,
  deriveHandSettlement,
  derivePlayerHandChipAccounting,
  deriveStartingStack,
} from './hand-chip-accounting'

const uncalledReturnDeal = {
  ApiTypeId: ApiType.EVT_DEAL,
  timestamp: 1782011480000,
  SeatUserIds: [156012369, 561384657, -1, -1, 578444683, 805494763],
  Game: {
    CurrentBlindLv: 7,
    NextBlindUnixSeconds: 1782011516,
    Ante: 410,
    SmallBlind: 820,
    BigBlind: 1640,
    ButtonSeat: 4,
    SmallBlindSeat: 5,
    BigBlindSeat: 0,
  },
  Player: { SeatIndex: 1, BetStatus: 1, Chip: 45482, BetChip: 0, HoleCards: [2, 49] },
  OtherPlayers: [
    { SeatIndex: 0, Status: 0, BetStatus: 3, Chip: 0, BetChip: 1148, IsSafeLeave: false },
    { SeatIndex: 4, Status: 0, BetStatus: 1, Chip: 17194, BetChip: 0, IsSafeLeave: false },
    { SeatIndex: 5, Status: 0, BetStatus: 1, Chip: 23716, BetChip: 820, IsSafeLeave: false },
  ],
  Progress: {
    Phase: 0,
    NextActionSeat: 1,
    NextActionTypes: [2, 3, 4, 5],
    NextExtraLimitSeconds: 1,
    MinRaise: 3280,
    Pot: 4108,
    SidePot: [],
  },
} as unknown as ApiEvent<ApiType.EVT_DEAL>

const uncalledReturnResult = {
  ApiTypeId: ApiType.EVT_HAND_RESULTS,
  timestamp: 1782011488899,
  HandId: 517982965,
  CommunityCards: [10, 19, 21, 9, 40],
  Pot: 4756,
  SidePot: [2132],
  ResultType: 0,
  DefeatStatus: 0,
  Results: [
    { UserId: 156012369, RankType: 7, HandRanking: 1, Hands: [42, 40, 23, 21, 19], HoleCards: [42, 23], Ranking: -2, RewardChip: 4756 },
    // The hero lost the contested pot. RewardChip is only the uncalled excess.
    { UserId: 561384657, RankType: 8, HandRanking: 2, Hands: [10, 9, 49, 40, 21], HoleCards: [2, 49], Ranking: -2, RewardChip: 2132 },
  ],
  Player: { SeatIndex: 1, BetStatus: -1, Chip: 44334, BetChip: 0 },
  OtherPlayers: [
    { SeatIndex: 0, Status: 0, BetStatus: -1, Chip: 4756, BetChip: 0 },
    { SeatIndex: 4, Status: 0, BetStatus: -1, Chip: 17194, BetChip: 0 },
    { SeatIndex: 5, Status: 0, BetStatus: -1, Chip: 23716, BetChip: 0 },
  ],
} as unknown as ApiEvent<ApiType.EVT_HAND_RESULTS>

describe('derivePlayerHandChipAccounting', () => {
  test('real Hand #517982965: an uncalled return remains a signed loss for hero and all seats reconcile', () => {
    const result = derivePlayerHandChipAccounting(uncalledReturnDeal, uncalledReturnResult, BattleType.SIT_AND_GO)

    expect(result['561384657']).toEqual({
      grossPayout: 2132,
      totalContribution: 3690,
      netChips: -1558,
    })
    expect(result['156012369']).toEqual({
      grossPayout: 4756,
      totalContribution: 1558,
      netChips: 3198,
    })
    expect(result['578444683']).toEqual({ grossPayout: 0, totalContribution: 410, netChips: -410 })
    expect(result['805494763']).toEqual({ grossPayout: 0, totalContribution: 1230, netChips: -1230 })
    expect(Object.values(result).reduce((sum, entry) => sum + (entry?.netChips ?? 0), 0)).toBe(0)
  })

  test('split return produces an exact zero instead of null', () => {
    const deal = {
      ...uncalledReturnDeal,
      SeatUserIds: [1, 2],
      Game: { ...uncalledReturnDeal.Game, Ante: 0, SmallBlind: 100, BigBlind: 100, SmallBlindSeat: 0, BigBlindSeat: 1 },
      Player: { SeatIndex: 0, BetStatus: 1, Chip: 900, BetChip: 100, HoleCards: [0, 1] },
      OtherPlayers: [{ SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 900, BetChip: 100 }],
      Progress: { ...uncalledReturnDeal.Progress, Pot: 200, SidePot: [] },
    } as unknown as ApiEvent<ApiType.EVT_DEAL>
    const handResult = {
      ...uncalledReturnResult,
      Pot: 200,
      SidePot: [],
      Results: [
        { ...uncalledReturnResult.Results[0], UserId: 1, RewardChip: 100 },
        { ...uncalledReturnResult.Results[1], UserId: 2, RewardChip: 100 },
      ],
      Player: { SeatIndex: 0, BetStatus: -1, Chip: 1000, BetChip: 0 },
      OtherPlayers: [{ SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 1000, BetChip: 0 }],
    } as unknown as ApiEvent<ApiType.EVT_HAND_RESULTS>

    expect(derivePlayerHandChipAccounting(deal, handResult, BattleType.SIT_AND_GO)).toEqual({
      '1': { grossPayout: 100, totalContribution: 100, netChips: 0 },
      '2': { grossPayout: 100, totalContribution: 100, netChips: 0 },
    })
  })

  test('Ring rake may make table net negative without invalidating exact per-seat results', () => {
    const deal = {
      ...uncalledReturnDeal,
      SeatUserIds: [1, 2],
      Game: { ...uncalledReturnDeal.Game, Ante: 0, SmallBlind: 100, BigBlind: 100, SmallBlindSeat: 0, BigBlindSeat: 1 },
      Player: { SeatIndex: 0, BetStatus: 1, Chip: 900, BetChip: 100, HoleCards: [0, 1] },
      OtherPlayers: [{ SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 900, BetChip: 100 }],
      Progress: { ...uncalledReturnDeal.Progress, Pot: 200, SidePot: [] },
    } as unknown as ApiEvent<ApiType.EVT_DEAL>
    const handResult = {
      ...uncalledReturnResult,
      Pot: 190,
      SidePot: [],
      Results: [{ ...uncalledReturnResult.Results[0], UserId: 1, RewardChip: 190 }],
      Player: { SeatIndex: 0, BetStatus: -1, Chip: 1090, BetChip: 0 },
      OtherPlayers: [{ SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 900, BetChip: 0 }],
    } as unknown as ApiEvent<ApiType.EVT_HAND_RESULTS>

    const result = derivePlayerHandChipAccounting(deal, handResult, BattleType.RING_GAME)
    expect(result).toEqual({
      '1': { grossPayout: 190, totalContribution: 100, netChips: 90 },
      '2': { grossPayout: 0, totalContribution: 100, netChips: -100 },
    })
    expect(Object.values(result).reduce((sum, entry) => sum + (entry?.netChips ?? 0), 0)).toBe(-10)
    expect(deriveHandRakeAccounting(deal, handResult, BattleType.RING_GAME)).toEqual({
      totalContribution: 200,
      totalPayout: 190,
      rake: 10,
    })
    expect(
      Object.values(result).reduce((sum, entry) => sum + entry!.netChips, 0) +
      deriveHandRakeAccounting(deal, handResult, BattleType.RING_GAME)!.rake
    ).toBe(0)
  })

  test('Ring rake stays unknown when any endpoint seat snapshot is missing', () => {
    const incompleteResult = {
      ...uncalledReturnResult,
      OtherPlayers: uncalledReturnResult.OtherPlayers.slice(0, -1),
    } as ApiEvent<ApiType.EVT_HAND_RESULTS>

    expect(deriveHandRakeAccounting(
      uncalledReturnDeal,
      incompleteResult,
      BattleType.RING_GAME
    )).toBeNull()
  })

  test('malformed legacy Ring snapshot stays unknown instead of throwing', () => {
    const malformedResult = {
      ...uncalledReturnResult,
      OtherPlayers: undefined,
    } as unknown as ApiEvent<ApiType.EVT_HAND_RESULTS>

    expect(() => deriveHandRakeAccounting(
      uncalledReturnDeal,
      malformedResult,
      BattleType.RING_GAME
    )).not.toThrow()
    expect(deriveHandRakeAccounting(
      uncalledReturnDeal,
      malformedResult,
      BattleType.RING_GAME
    )).toBeNull()
  })

  test('Ring side-pot settlement preserves rake across uncalled return, split, and odd chip payouts', () => {
    // Real-equivalent endpoint shape:
    // contributions 101 + 301 + 501 = 903
    // uncalled return 200, contested gross pot 703
    // contested payouts 151 + 150 + 367 = 668 (odd chip included)
    // rake 703 - 668 = 35
    const deal = {
      ...uncalledReturnDeal,
      SeatUserIds: [1, 2, 3],
      Game: {
        ...uncalledReturnDeal.Game,
        Ante: 0,
        SmallBlind: 50,
        BigBlind: 100,
        SmallBlindSeat: 0,
        BigBlindSeat: 1,
      },
      Player: { SeatIndex: 0, BetStatus: 1, Chip: 899, BetChip: 101, HoleCards: [0, 1] },
      OtherPlayers: [
        { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 899, BetChip: 101 },
        { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 699, BetChip: 301 },
      ],
      Progress: { ...uncalledReturnDeal.Progress, Pot: 303, SidePot: [400] },
    } as unknown as ApiEvent<ApiType.EVT_DEAL>
    const handResult = {
      ...uncalledReturnResult,
      Pot: 301,
      SidePot: [367, 200],
      Results: [
        { ...uncalledReturnResult.Results[0], UserId: 1, RewardChip: 151 },
        { ...uncalledReturnResult.Results[1], UserId: 2, RewardChip: 150 },
        { ...uncalledReturnResult.Results[1], UserId: 3, RewardChip: 567 },
      ],
      Player: { SeatIndex: 0, BetStatus: -1, Chip: 1050, BetChip: 0 },
      OtherPlayers: [
        { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 849, BetChip: 0 },
        { SeatIndex: 2, Status: 0, BetStatus: -1, Chip: 1066, BetChip: 0 },
      ],
    } as unknown as ApiEvent<ApiType.EVT_HAND_RESULTS>

    const players = derivePlayerHandChipAccounting(deal, handResult, BattleType.RING_GAME)
    const rake = deriveHandRakeAccounting(deal, handResult, BattleType.RING_GAME)

    expect(players).toEqual({
      '1': { grossPayout: 151, totalContribution: 101, netChips: 50 },
      '2': { grossPayout: 150, totalContribution: 301, netChips: -151 },
      '3': { grossPayout: 567, totalContribution: 501, netChips: 66 },
    })
    expect(rake).toEqual({ totalContribution: 903, totalPayout: 868, rake: 35 })
    expect(Object.values(players).reduce((sum, entry) => sum + entry!.netChips, 0) + rake!.rake).toBe(0)
    expect(rake!.totalContribution - 200).toBe((rake!.totalPayout - 200) + rake!.rake)
  })

  test.each([
    ['SIT_AND_GO', BattleType.SIT_AND_GO],
    ['TOURNAMENT', BattleType.TOURNAMENT],
    ['FRIEND_SIT_AND_GO', BattleType.FRIEND_SIT_AND_GO],
    ['CLUB_MATCH', BattleType.CLUB_MATCH],
  ] as const)('%s settlement with table chip loss or creation fails closed', (_name, battleType) => {
    const deal = {
      ...uncalledReturnDeal,
      SeatUserIds: [1, 2],
      Game: { ...uncalledReturnDeal.Game, Ante: 0, SmallBlind: 100, BigBlind: 100, SmallBlindSeat: 0, BigBlindSeat: 1 },
      Player: { SeatIndex: 0, BetStatus: 1, Chip: 900, BetChip: 100, HoleCards: [0, 1] },
      OtherPlayers: [{ SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 900, BetChip: 100 }],
      Progress: { ...uncalledReturnDeal.Progress, Pot: 200, SidePot: [] },
    } as unknown as ApiEvent<ApiType.EVT_DEAL>
    const settlement = (winnerFinal: number, loserFinal: number) => ({
      ...uncalledReturnResult,
      Pot: 200,
      SidePot: [],
      Results: [{ ...uncalledReturnResult.Results[0], UserId: 1, RewardChip: 200 }],
      Player: { SeatIndex: 0, BetStatus: -1, Chip: winnerFinal, BetChip: 0 },
      OtherPlayers: [{ SeatIndex: 1, Status: 0, BetStatus: -1, Chip: loserFinal, BetChip: 0 }],
    }) as unknown as ApiEvent<ApiType.EVT_HAND_RESULTS>

    expect(Object.values(derivePlayerHandChipAccounting(deal, settlement(1090, 900), battleType)))
      .toEqual([null, null])
    expect(Object.values(derivePlayerHandChipAccounting(deal, settlement(1100, 910), battleType)))
      .toEqual([null, null])
  })

  test.each([
    ['RING_GAME', BattleType.RING_GAME],
    ['FRIEND_RING_GAME', BattleType.FRIEND_RING_GAME],
  ] as const)('%s settlement may lose rake but rejects table chip creation', (_name, battleType) => {
    const deal = {
      ...uncalledReturnDeal,
      SeatUserIds: [1, 2],
      Game: { ...uncalledReturnDeal.Game, Ante: 0, SmallBlind: 100, BigBlind: 100, SmallBlindSeat: 0, BigBlindSeat: 1 },
      Player: { SeatIndex: 0, BetStatus: 1, Chip: 900, BetChip: 100, HoleCards: [0, 1] },
      OtherPlayers: [{ SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 900, BetChip: 100 }],
      Progress: { ...uncalledReturnDeal.Progress, Pot: 200, SidePot: [] },
    } as unknown as ApiEvent<ApiType.EVT_DEAL>
    const corruptResult = {
      ...uncalledReturnResult,
      Pot: 200,
      SidePot: [],
      Results: [{ ...uncalledReturnResult.Results[0], UserId: 1, RewardChip: 200 }],
      Player: { SeatIndex: 0, BetStatus: -1, Chip: 1100, BetChip: 0 },
      OtherPlayers: [{ SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 910, BetChip: 0 }],
    } as unknown as ApiEvent<ApiType.EVT_HAND_RESULTS>

    expect(Object.values(derivePlayerHandChipAccounting(deal, corruptResult, battleType)))
      .toEqual([null, null])
  })

  test('unknown BattleType accepts a complete zero-sum settlement valid under either game rule', () => {
    expect(derivePlayerHandChipAccounting(
      uncalledReturnDeal,
      uncalledReturnResult,
      undefined
    )).toEqual({
      '156012369': { grossPayout: 4756, totalContribution: 1558, netChips: 3198 },
      '561384657': { grossPayout: 2132, totalContribution: 3690, netChips: -1558 },
      '578444683': { grossPayout: 0, totalContribution: 410, netChips: -410 },
      '805494763': { grossPayout: 0, totalContribution: 1230, netChips: -1230 },
    })
  })

  test('multiple short ante all-ins with side-pot tiers stay unknown when the seat-to-tier assignment is ambiguous', () => {
    const deal = {
      ...uncalledReturnDeal,
      SeatUserIds: [1, 2, 3],
      Game: { ...uncalledReturnDeal.Game, Ante: 100, SmallBlind: 50, BigBlind: 100, SmallBlindSeat: 2, BigBlindSeat: 2 },
      Player: { SeatIndex: 0, BetStatus: BetStatusType.ALL_IN, Chip: 0, BetChip: 0, HoleCards: [0, 1] },
      OtherPlayers: [
        { SeatIndex: 1, Status: 0, BetStatus: BetStatusType.ALL_IN, Chip: 0, BetChip: 0 },
        { SeatIndex: 2, Status: 0, BetStatus: BetStatusType.BET_ABLE, Chip: 800, BetChip: 100 },
      ],
      Progress: { ...uncalledReturnDeal.Progress, Pot: 150, SidePot: [250] },
    } as unknown as ApiEvent<ApiType.EVT_DEAL>

    expect(deriveStartingStack(deal, 0)).toBeNull()
    expect(deriveStartingStack(deal, 1)).toBeNull()
  })

  test('lineup mismatch or payout/pot inconsistency fails closed for every player', () => {
    const foreignResult = {
      ...uncalledReturnResult,
      Results: [{ ...uncalledReturnResult.Results[0], UserId: 999 }],
      Pot: 4756,
      SidePot: [],
    } as unknown as ApiEvent<ApiType.EVT_HAND_RESULTS>
    expect(Object.values(derivePlayerHandChipAccounting(uncalledReturnDeal, foreignResult, BattleType.SIT_AND_GO))).toEqual([
      null, null, null, null,
    ])

    const badPot = {
      ...uncalledReturnResult,
      Pot: uncalledReturnResult.Pot + 1,
    } as ApiEvent<ApiType.EVT_HAND_RESULTS>
    expect(Object.values(derivePlayerHandChipAccounting(uncalledReturnDeal, badPot, BattleType.SIT_AND_GO))).toEqual([
      null, null, null, null,
    ])
  })

  test('a missing final seat snapshot is null only for that player', () => {
    const incomplete = {
      ...uncalledReturnResult,
      OtherPlayers: uncalledReturnResult.OtherPlayers.filter(player => player.SeatIndex !== 4),
    } as ApiEvent<ApiType.EVT_HAND_RESULTS>
    const result = derivePlayerHandChipAccounting(uncalledReturnDeal, incomplete, BattleType.SIT_AND_GO)

    expect(result['578444683']).toBeNull()
    expect(result['561384657']?.netChips).toBe(-1558)
  })
})

describe('deriveHandSettlement', () => {
  const buildSettlementEvents = ({
    contributions,
    rewards,
    handRankings,
    battleType = BattleType.SIT_AND_GO,
  }: {
    contributions: number[]
    rewards: number[]
    handRankings: number[]
    battleType?: BattleType
  }) => {
    const userIds = contributions.map((_, index) => index + 1)
    const startingStack = 100
    const deal = {
      ApiTypeId: ApiType.EVT_DEAL,
      timestamp: 1,
      SeatUserIds: userIds,
      Game: {
        CurrentBlindLv: 1,
        NextBlindUnixSeconds: 0,
        Ante: 0,
        SmallBlind: 1,
        BigBlind: 2,
        ButtonSeat: 0,
        SmallBlindSeat: 0,
        BigBlindSeat: 1,
      },
      Player: {
        SeatIndex: 0,
        BetStatus: BetStatusType.BET_ABLE,
        Chip: startingStack,
        BetChip: 0,
        HoleCards: [0, 1],
      },
      OtherPlayers: userIds.slice(1).map((_, index) => ({
        SeatIndex: index + 1,
        Status: 0,
        BetStatus: BetStatusType.BET_ABLE,
        Chip: startingStack,
        BetChip: 0,
      })),
      Progress: {
        Phase: 0,
        NextActionSeat: 0,
        NextActionTypes: [],
        NextExtraLimitSeconds: 0,
        MinRaise: 0,
        Pot: 0,
        SidePot: [],
      },
    } as unknown as ApiEvent<ApiType.EVT_DEAL>
    const results = {
      ApiTypeId: ApiType.EVT_HAND_RESULTS,
      timestamp: 2,
      HandId: 1,
      CommunityCards: [0, 4, 8, 12, 16],
      Pot: rewards.reduce((sum, reward) => sum + reward, 0),
      SidePot: [],
      ResultType: 0,
      DefeatStatus: 0,
      Results: userIds.map((userId, index) => ({
        UserId: userId,
        HoleCards: [index * 2, index * 2 + 1],
        RankType: 1,
        Hands: [0, 4, 8, 12, 16],
        HandRanking: handRankings[index]!,
        Ranking: -2,
        RewardChip: rewards[index]!,
      })),
      Player: {
        SeatIndex: 0,
        BetStatus: -1,
        Chip: startingStack - contributions[0]! + rewards[0]!,
        BetChip: 0,
      },
      OtherPlayers: userIds.slice(1).map((_, index) => ({
        SeatIndex: index + 1,
        Status: 0,
        BetStatus: -1,
        Chip: startingStack - contributions[index + 1]! + rewards[index + 1]!,
        BetChip: 0,
      })),
    } as unknown as ApiEvent<ApiType.EVT_HAND_RESULTS>

    return { deal, results, battleType }
  }

  test('excludes a loser whose only payout is an uncalled excess return', () => {
    const fixture = buildSettlementEvents({
      contributions: [30, 50],
      rewards: [60, 20],
      handRankings: [1, 2],
    })

    const settlement = deriveHandSettlement(fixture.deal, fixture.results, fixture.battleType)

    expect(settlement.playerChipAccounting).toEqual({
      '1': { grossPayout: 60, totalContribution: 30, netChips: 30 },
      '2': { grossPayout: 20, totalContribution: 50, netChips: -30 },
    })
    expect(settlement.playerSettlements).toEqual({
      '1': { contestedAward: 60, uncalledReturn: 0 },
      '2': { contestedAward: 0, uncalledReturn: 20 },
    })
    expect(settlement.winningPlayerIds).toEqual([1])
  })

  test('keeps a side-pot winner even when the hand is a net loss', () => {
    const fixture = buildSettlementEvents({
      contributions: [90, 100, 100],
      rewards: [270, 20, 0],
      handRankings: [1, 2, -1],
    })

    const settlement = deriveHandSettlement(fixture.deal, fixture.results, fixture.battleType)

    expect(settlement.playerChipAccounting['2']?.netChips).toBe(-80)
    expect(settlement.playerSettlements['2']).toEqual({ contestedAward: 20, uncalledReturn: 0 })
    expect(settlement.winningPlayerIds).toEqual([1, 2])
  })

  test('preserves tied split-pot winners when an odd chip makes payouts unequal', () => {
    const fixture = buildSettlementEvents({
      contributions: [5, 5, 5],
      rewards: [8, 7, 0],
      handRankings: [1, 1, -1],
    })

    const settlement = deriveHandSettlement(fixture.deal, fixture.results, fixture.battleType)

    expect(settlement.playerSettlements['1']).toEqual({ contestedAward: 8, uncalledReturn: 0 })
    expect(settlement.playerSettlements['2']).toEqual({ contestedAward: 7, uncalledReturn: 0 })
    expect(settlement.winningPlayerIds).toEqual([1, 2])
  })

  test('allows Ring rake while retaining the contested winner', () => {
    const fixture = buildSettlementEvents({
      contributions: [50, 50],
      rewards: [95, 0],
      handRankings: [1, -1],
      battleType: BattleType.RING_GAME,
    })

    const settlement = deriveHandSettlement(fixture.deal, fixture.results, fixture.battleType)

    expect(settlement.playerChipAccounting['1']?.netChips).toBe(45)
    expect(settlement.playerChipAccounting['2']?.netChips).toBe(-50)
    expect(settlement.playerSettlements['1']).toEqual({ contestedAward: 95, uncalledReturn: 0 })
    expect(settlement.winningPlayerIds).toEqual([1])

    const beforeSessionMetadata = deriveHandSettlement(fixture.deal, fixture.results, undefined)
    expect(beforeSessionMetadata.playerSettlements['1']).toEqual({
      contestedAward: 95,
      uncalledReturn: 0,
    })
    expect(beforeSessionMetadata.playerChipAccounting).toEqual({
      '1': { grossPayout: 95, totalContribution: 50, netChips: 45 },
      '2': { grossPayout: 0, totalContribution: 50, netChips: -50 },
    })
    expect(beforeSessionMetadata.winningPlayerIds).toEqual([1])
  })

  test('real ante all-in settlement separates the returned top tier from the contested main pot', () => {
    const settlement = deriveHandSettlement(
      uncalledReturnDeal,
      uncalledReturnResult,
      BattleType.SIT_AND_GO
    )

    expect(settlement.playerSettlements['156012369']).toEqual({
      contestedAward: 4756,
      uncalledReturn: 0,
    })
    expect(settlement.playerSettlements['561384657']).toEqual({
      contestedAward: 0,
      uncalledReturn: 2132,
    })
    expect(settlement.winningPlayerIds).toEqual([156012369])
    expect(
      Object.values(settlement.playerSettlements)
        .reduce((sum, entry) => sum + (entry?.contestedAward ?? 0) + (entry?.uncalledReturn ?? 0), 0)
    ).toBe(uncalledReturnResult.Pot + uncalledReturnResult.SidePot.reduce((sum, pot) => sum + pot, 0))
  })

  test('fails winner resolution closed when settlement conservation is invalid', () => {
    const fixture = buildSettlementEvents({
      contributions: [30, 30],
      rewards: [60, 0],
      handRankings: [1, -1],
    })
    const corrupt = {
      ...fixture.results,
      Player: { ...fixture.results.Player!, Chip: fixture.results.Player!.Chip + 1 },
    } as ApiEvent<ApiType.EVT_HAND_RESULTS>

    const settlement = deriveHandSettlement(fixture.deal, corrupt, fixture.battleType)

    expect(settlement.winningPlayerIds).toEqual([])
    expect(Object.values(settlement.playerSettlements)).toEqual([null, null])
  })
})
