import type { ApiEvent } from '../types/api'
import { ApiType } from '../types/api'
import { BattleType, BetStatusType } from '../types/game'
import {
  deriveHandRakeAccounting,
  deriveHandSettlement,
  deriveMidHandChipInflow,
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

// ---------------------------------------------------------------------------
// #339: リング戦のハンド中リバイイン／アドオン
// ---------------------------------------------------------------------------

const RING_SEATS = [-1, -1, 2001, 2002, 2003, -1]

const ringDeal = {
  ApiTypeId: ApiType.EVT_DEAL,
  timestamp: 1733147500000,
  SeatUserIds: RING_SEATS,
  Game: { CurrentBlindLv: 1, NextBlindUnixSeconds: -1, Ante: 0, SmallBlind: 10, BigBlind: 20, ButtonSeat: 2, SmallBlindSeat: 3, BigBlindSeat: 4 },
  Player: { SeatIndex: 2, BetStatus: BetStatusType.BET_ABLE, Chip: 4000, BetChip: 0, HoleCards: [22, 28] },
  OtherPlayers: [
    { SeatIndex: 3, Status: 0, BetStatus: BetStatusType.BET_ABLE, Chip: 1990, BetChip: 10 },
    { SeatIndex: 4, Status: 0, BetStatus: BetStatusType.BET_ABLE, Chip: 3980, BetChip: 20 },
  ],
  Progress: { Phase: 0, NextActionSeat: 2, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 12, MinRaise: 40, Pot: 30, SidePot: [] },
} as unknown as ApiEvent<ApiType.EVT_DEAL>

const ringAction = (seatIndex: number, actionType: number, chip: number, betChip: number, phase: number, nextActionSeat: number) => ({
  ApiTypeId: ApiType.EVT_ACTION,
  timestamp: 1733147501000,
  SeatIndex: seatIndex,
  ActionType: actionType,
  Chip: chip,
  BetChip: betChip,
  Progress: { Phase: phase, NextActionSeat: nextActionSeat, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 0, SidePot: [] },
}) as unknown as ApiEvent<ApiType.EVT_ACTION>

/** seat3 は降りたあとハンド中に +2000 買い足している。 */
const ringFlop = (seat3Chip: number) => ({
  ApiTypeId: ApiType.EVT_DEAL_ROUND,
  timestamp: 1733147502000,
  CommunityCards: [35, 4, 23],
  Player: { SeatIndex: 2, BetStatus: BetStatusType.BET_ABLE, Chip: 3980, BetChip: 0, HoleCards: [22, 28] },
  OtherPlayers: [
    { SeatIndex: 3, Status: 0, BetStatus: BetStatusType.FOLDED, Chip: seat3Chip, BetChip: 0 },
    { SeatIndex: 4, Status: 0, BetStatus: BetStatusType.BET_ABLE, Chip: 3980, BetChip: 0 },
  ],
  Progress: { Phase: 1, NextActionSeat: 4, NextActionTypes: [0, 5, 1], NextExtraLimitSeconds: 3, MinRaise: 0, Pot: 50, SidePot: [] },
}) as unknown as ApiEvent<ApiType.EVT_DEAL_ROUND>

/** seat4 はハンド終了時にバイイン上限へ +20 自動買い足し（終了スタックにしか現れない）。 */
const ringResults = {
  ApiTypeId: ApiType.EVT_HAND_RESULTS,
  timestamp: 1733147503000,
  HandId: 900000002,
  CommunityCards: [],
  Pot: 145,
  SidePot: [],
  ResultType: 0,
  DefeatStatus: 0,
  Results: [
    { UserId: 2001, RankType: 10, HandRanking: 1, Hands: [], HoleCards: [], Ranking: -2, RewardChip: 145 },
  ],
  Player: { SeatIndex: 2, BetStatus: -1, Chip: 4025, BetChip: 0 },
  OtherPlayers: [
    { SeatIndex: 3, Status: 0, BetStatus: -1, Chip: 3990, BetChip: 0 },
    { SeatIndex: 4, Status: 0, BetStatus: -1, Chip: 4000, BetChip: 0 },
  ],
} as unknown as ApiEvent<ApiType.EVT_HAND_RESULTS>

const ringHandEvents = (seat3FlopChip = 3990) => [
  ringDeal,
  ringAction(2, 3, 3980, 20, 0, 3),
  ringAction(3, 2, 1990, 10, 0, 4),
  ringAction(4, 0, 3980, 20, 0, -1),
  ringFlop(seat3FlopChip),
  ringAction(4, 0, 3980, 0, 1, 2),
  ringAction(2, 1, 3880, 100, 1, 4),
  // ハンド終了行。Progress.Phase は3固定で届くが実際はフロップ。
  ringAction(4, 2, 3980, 0, 3, -2),
  ringResults,
]

describe('deriveMidHandChipInflow', () => {
  test('recovers both the mid-hand rebuy and the end-of-hand auto top-up', () => {
    const inflow = deriveMidHandChipInflow(ringDeal, ringResults, ringHandEvents(), BattleType.RING_GAME)
    expect(inflow && Object.fromEntries(inflow)).toEqual({ 2: 0, 3: 2000, 4: 20 })
  })

  test('is unknown for a tournament, where a mid-hand top-up cannot happen', () => {
    expect(deriveMidHandChipInflow(ringDeal, ringResults, ringHandEvents(), BattleType.SIT_AND_GO)).toBeNull()
    expect(deriveMidHandChipInflow(ringDeal, ringResults, ringHandEvents(), undefined)).toBeNull()
  })

  test('is unknown when the intra-hand snapshot chain loses chips it cannot account for', () => {
    // seat3 のスタックが説明できない形で減っている = 融合バッファ等のシグネチャ。
    expect(deriveMidHandChipInflow(ringDeal, ringResults, ringHandEvents(1500), BattleType.RING_GAME)).toBeNull()
  })

  test('is unknown without the hand event list, keeping conservation strict', () => {
    expect(deriveMidHandChipInflow(ringDeal, ringResults, undefined, BattleType.RING_GAME)).toBeNull()
  })
})

describe('deriveMidHandChipInflow with an out-of-order equal-millisecond group', () => {
  test('ignores a street-opening snapshot that lands after a later street\u0027s action', () => {
    // 同一ms群は主キー順（ApiTypeId昇順）で並ぶため、ターンのアクション（304）の
    // あとにフロップの開始スナップショット（305）が届く。これを時系列として
    // 会計すると、精算済みのターン投入が買い足しとして戻ってしまう。
    const lateFlopSnapshot = ringFlop(1990)
    const events = [
      ringDeal,
      ringAction(2, 3, 3980, 20, 0, 3),
      ringAction(3, 2, 1990, 10, 0, 4),
      ringAction(4, 0, 3980, 20, 0, -1),
      // フロップの305より前に届いたターンのベット。
      ringAction(2, 1, 3880, 100, 2, 4),
      lateFlopSnapshot,
      ringResults,
    ]
    const inflow = deriveMidHandChipInflow(ringDeal, ringResults, events, BattleType.RING_GAME)
    // seat2 のターン投入100は流入として戻らない（後退スナップショットを無視する）。
    expect(inflow?.get(2)).toBe(0)
  })
})

describe('deriveHandSettlement with a Ring mid-hand rebuy', () => {
  test('keeps the exact winner and per-seat net chips despite the table total growing', () => {
    const startingTotal = 4000 + 2000 + 4000
    const finalTotal = 4025 + 3990 + 4000
    expect(finalTotal - startingTotal).toBe(2015)

    const settlement = deriveHandSettlement(ringDeal, ringResults, BattleType.RING_GAME, ringHandEvents())
    expect(settlement.winningPlayerIds).toEqual([2001])
    expect(settlement.playerChipAccounting).toEqual({
      '2001': { grossPayout: 145, totalContribution: 120, netChips: 25 },
      '2002': { grossPayout: 0, totalContribution: 10, netChips: -10 },
      '2003': { grossPayout: 0, totalContribution: 20, netChips: -20 },
    })
  })

  test('still fails closed when the hand events are not available to explain the inflow', () => {
    const settlement = deriveHandSettlement(ringDeal, ringResults, BattleType.RING_GAME)
    expect(settlement.winningPlayerIds).toEqual([])
    expect(Object.values(settlement.playerChipAccounting).every(entry => entry === null)).toBe(true)
  })

  test('resolves a seat that commits the chips it bought mid-hand', () => {
    // 開始100、ハンド中に+1,000買い足し、500を投じて払い戻しなしで600残る席。
    // 「買い足しが無かったときのスタック」は 600 - 1,000 = -400 になるが、
    // 正しい会計は拠出500・netChips -500 である（codex review P2）。
    const deal = {
      ...ringDeal,
      SeatUserIds: [-1, -1, 2001, 2002, -1, -1],
      Game: { ...(ringDeal as any).Game, SmallBlind: 50, BigBlind: 100, SmallBlindSeat: 2, BigBlindSeat: 3, ButtonSeat: 2 },
      Player: { SeatIndex: 2, BetStatus: BetStatusType.BET_ABLE, Chip: 4400, BetChip: 100, HoleCards: [22, 28] },
      OtherPlayers: [{ SeatIndex: 3, Status: 0, BetStatus: BetStatusType.BET_ABLE, Chip: 0, BetChip: 100 }],
      Progress: { ...(ringDeal as any).Progress, Pot: 200 },
    } as unknown as ApiEvent<ApiType.EVT_DEAL>
    const flop = {
      ApiTypeId: ApiType.EVT_DEAL_ROUND,
      timestamp: 1733147502000,
      CommunityCards: [35, 4, 23],
      Player: { SeatIndex: 2, BetStatus: BetStatusType.BET_ABLE, Chip: 4400, BetChip: 0, HoleCards: [22, 28] },
      // seat3 は 0 から +1,000 買い足している。
      OtherPlayers: [{ SeatIndex: 3, Status: 0, BetStatus: BetStatusType.BET_ABLE, Chip: 1000, BetChip: 0 }],
      Progress: { Phase: 1, NextActionSeat: 3, NextActionTypes: [0, 5, 1], NextExtraLimitSeconds: 3, MinRaise: 0, Pot: 200, SidePot: [] },
    } as unknown as ApiEvent<ApiType.EVT_DEAL_ROUND>
    const results = {
      ...ringResults,
      Pot: 1000,
      Results: [{ UserId: 2001, RankType: 7, HandRanking: 1, Hands: [], HoleCards: [], Ranking: -2, RewardChip: 1000 }],
      Player: { SeatIndex: 2, BetStatus: -1, Chip: 4800, BetChip: 0 },
      OtherPlayers: [{ SeatIndex: 3, Status: 0, BetStatus: -1, Chip: 600, BetChip: 0 }],
    } as unknown as ApiEvent<ApiType.EVT_HAND_RESULTS>
    const events = [
      deal,
      ringAction(3, 0, 0, 100, 0, -1),
      flop,
      ringAction(3, 1, 600, 400, 1, 2),
      ringAction(2, 3, 4000, 400, 1, -2),
      results,
    ]

    const inflow = deriveMidHandChipInflow(deal, results, events, BattleType.RING_GAME)
    expect(inflow?.get(3)).toBe(1000)

    const settlement = deriveHandSettlement(deal, results, BattleType.RING_GAME, events)
    expect(settlement.playerChipAccounting['2002']).toEqual({
      grossPayout: 0,
      totalContribution: 500,
      netChips: -500,
    })
    expect(settlement.winningPlayerIds).toEqual([2001])
  })

  test('still fails closed when the snapshot chain is broken rather than topped up', () => {
    const settlement = deriveHandSettlement(ringDeal, ringResults, BattleType.RING_GAME, ringHandEvents(1500))
    expect(settlement.winningPlayerIds).toEqual([])
  })
})
