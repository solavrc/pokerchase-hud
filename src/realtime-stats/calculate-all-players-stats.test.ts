/**
 * Tests for calculateAllPlayersStats function
 */

import { RealTimeStatsService } from './realtime-stats-service'
import type { RealTimeStats } from './realtime-stats-service'

describe('calculateAllPlayersStats', () => {
  const mockHeroStats: RealTimeStats = {
    potOdds: {
      id: 'potOdds',
      name: 'Pot Odds',
      value: {
        pot: 300,
        call: 100,
        percentage: 25.0,
        ratio: '3:1',
        isHeroTurn: true,
        spr: 5.0
      }
    },
    handImprovement: {
      id: 'handImprovement',
      name: 'Hand Improvement',
      value: {
        currentHand: { rank: 1, name: 'High Card' },
        improvements: []
      }
    }
  }

  it('should calculate stats for all players with hero at seat 0', () => {
    const seatUserIds = [101, 102, 103, 104, -1, -1]
    const progress = {
      NextActionSeat: 2,
      Pot: 200,
      SidePot: [],
      MinRaise: 100,
      Phase: 1
    }
    const seatBetAmounts = [20, 20, 10, 20, 0, 0]
    const seatChips = [1000, 800, 900, 700, 0, 0]

    const result = RealTimeStatsService.calculateAllPlayersStats(
      seatUserIds,
      progress,
      seatBetAmounts,
      seatChips,
      mockHeroStats
    )

    // Check hero stats are preserved
    expect(result.heroStats).toEqual(mockHeroStats)

    // Check player at seat 2 (current turn)
    expect(result.playerStats[2]?.spr).toBe(4.5)
    expect(result.playerStats[2]?.potOdds?.pot).toBe(210)
    expect(result.playerStats[2]?.potOdds?.call).toBe(10)
    expect(result.playerStats[2]?.potOdds?.percentage).toBeCloseTo(4.8, 1)
    expect(result.playerStats[2]?.potOdds?.ratio).toBe('20:1')
    expect(result.playerStats[2]?.potOdds?.isPlayerTurn).toBe(true)

    // Check player at seat 1 (not their turn, already at max bet)
    expect(result.playerStats[1]).toEqual({
      spr: 4.0, // 800 / 200
      potOdds: {
        pot: 200,
        call: 0,
        percentage: 0,
        ratio: '',
        isPlayerTurn: false
      }
    })

    // Check empty seats (should be undefined)
    expect(result.playerStats[4]).toBeUndefined()
  })

  it('should handle when no player has turn', () => {
    const seatUserIds = [101, 102, 103, -1, -1, -1]
    const progress = undefined
    const seatBetAmounts = [100, 100, 100, 0, 0, 0]
    const seatChips = [900, 900, 900, 0, 0, 0]

    const result = RealTimeStatsService.calculateAllPlayersStats(
      seatUserIds,
      progress,
      seatBetAmounts,
      seatChips,
      mockHeroStats
    )

    // When progress is undefined, no player stats are calculated
    expect(result.playerStats[0]).toBeUndefined()
    expect(result.playerStats[1]).toBeUndefined()
    expect(result.playerStats[2]).toBeUndefined()
  })

  it('should handle all-in situations', () => {
    const seatUserIds = [101, 102, 103, 104, -1, -1]
    const progress = {
      NextActionSeat: 1,
      Pot: 1000,
      SidePot: [500],
      MinRaise: 600,
      Phase: 2
    }
    const seatBetAmounts = [300, 0, 300, 0, 0, 0]
    const seatChips = [0, 200, 0, 500, 0, 0] // Seats 0 and 2 are all-in

    const result = RealTimeStatsService.calculateAllPlayersStats(
      seatUserIds,
      progress,
      seatBetAmounts,
      seatChips,
      mockHeroStats
    )

    // Player 1 (current turn, limited stack)
    expect(result.playerStats[1]?.spr).toBe(0.1)
    expect(result.playerStats[1]?.potOdds?.pot).toBe(1800)
    expect(result.playerStats[1]?.potOdds?.call).toBe(300)
    expect(result.playerStats[1]?.potOdds?.percentage).toBeCloseTo(16.7, 1)
    expect(result.playerStats[1]?.potOdds?.ratio).toBe('5:1')
    expect(result.playerStats[1]?.potOdds?.isPlayerTurn).toBe(true)

    // All-in players should have SPR 0
    expect(result.playerStats[0]?.spr).toBe(0)
    expect(result.playerStats[2]?.spr).toBe(0)
  })

  it('should handle empty seatUserIds array', () => {
    const seatUserIds: number[] = []
    const progress = {
      NextActionSeat: 0,
      Pot: 100,
      SidePot: [],
      MinRaise: 100,
      Phase: 1
    }
    const seatBetAmounts: number[] = []
    const seatChips: number[] = []

    const result = RealTimeStatsService.calculateAllPlayersStats(
      seatUserIds,
      progress,
      seatBetAmounts,
      seatChips,
      mockHeroStats
    )

    expect(result.heroStats).toEqual(mockHeroStats)
    expect(result.playerStats).toEqual({})
  })

  it('should handle missing hero stats gracefully', () => {
    const seatUserIds = [101, 102, -1, -1, -1, -1]
    const progress = {
      NextActionSeat: 1,
      Pot: 200,
      SidePot: [],
      MinRaise: 100,
      Phase: 1
    }
    const seatBetAmounts = [50, 0, 0, 0, 0, 0]
    const seatChips = [950, 1000, 0, 0, 0, 0]

    const result = RealTimeStatsService.calculateAllPlayersStats(
      seatUserIds,
      progress,
      seatBetAmounts,
      seatChips,
      {} as RealTimeStats // Empty hero stats
    )

    // Should still calculate player stats correctly
    expect(result.playerStats[1]).toEqual({
      spr: 5.0, // 1000 / 200
      potOdds: {
        pot: 250,
        call: 50,
        percentage: 20.0,
        ratio: '4:1',
        isPlayerTurn: true
      }
    })
  })

  it('should handle when pot is 0', () => {
    const seatUserIds = [101, 102, 103, -1, -1, -1]
    const progress = {
      NextActionSeat: 0,
      Pot: 0,
      SidePot: [],
      MinRaise: 200,
      Phase: 0
    }
    const seatBetAmounts = [0, 0, 0, 0, 0, 0]
    const seatChips = [1000, 1000, 1000, 0, 0, 0]

    const result = RealTimeStatsService.calculateAllPlayersStats(
      seatUserIds,
      progress,
      seatBetAmounts,
      seatChips,
      mockHeroStats
    )

    // Should not calculate SPR when pot is 0
    expect(result.playerStats[0]).toEqual({
      spr: undefined,
      potOdds: {
        pot: 0,
        call: 0,
        percentage: 0,
        ratio: '',
        isPlayerTurn: true
      }
    })
  })
})