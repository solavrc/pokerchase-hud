/**
 * Tests for calculatePlayerPotOdds function
 */

import { calculatePlayerPotOdds } from './pot-odds'
import { BetStatusType } from '../types/game'

describe('calculatePlayerPotOdds', () => {
  it('should calculate pot odds for any player when it is their turn', () => {
    const playerSeatIndex = 2
    const progress = {
      NextActionSeat: 2,  // Use NextActionSeat, not SeatIndex
      Pot: 50,
      SidePot: [],
      Phase: 1
    }
    const seatBetAmounts = [10, 10, 5, 0, 0, 0]
    const seatChips = [100, 150, 200, 300, 0, 0]

    const result = calculatePlayerPotOdds(playerSeatIndex, progress, seatBetAmounts, seatChips)

    expect(result?.pot).toBe(55)
    expect(result?.call).toBe(5)
    expect(result?.percentage).toBeCloseTo(9.1, 1)
    expect(result?.ratio).toBe('10:1')
    expect(result?.isPlayerTurn).toBe(true)
    expect(result?.spr).toBe(4.0)
  })

  it('should calculate pot odds when not player turn', () => {
    const playerSeatIndex = 1
    const progress = {
      NextActionSeat: 2,  // Different from playerSeatIndex
      Pot: 50,
      SidePot: [],
      Phase: 1
    }
    const seatBetAmounts = [10, 10, 5, 0, 0, 0]
    const seatChips = [100, 150, 200, 300, 0, 0]

    const result = calculatePlayerPotOdds(playerSeatIndex, progress, seatBetAmounts, seatChips)

    expect(result).toEqual({
      pot: 50,  // No call amount added
      call: 0,  // Already at max bet
      percentage: 0,
      ratio: '',
      isPlayerTurn: false,
      spr: 3.0  // 150 / 50
    })
  })

  it('should not offer a call to a player who is already all-in', () => {
    const playerSeatIndex = 4
    const progress = {
      NextActionSeat: 3,
      Pot: 50,
      SidePot: [],
      Phase: 1
    }
    const seatBetAmounts = [10, 10, 5, 0, 0, 0]
    const seatChips = [100, 150, 200, 300, 0, 0]

    const result = calculatePlayerPotOdds(playerSeatIndex, progress, seatBetAmounts, seatChips)

    expect(result?.pot).toBe(50)
    expect(result?.call).toBe(0)
    expect(result?.percentage).toBe(0)
    expect(result?.ratio).toBe('')
    expect(result?.isPlayerTurn).toBe(false)
    expect(result?.spr).toBe(0)
  })

  it('caps a short-stack call at the remaining stack', () => {
    const result = calculatePlayerPotOdds(
      0,
      {
        NextActionSeat: 0,
        Pot: 300,
        SidePot: [],
        Phase: 1
      },
      [0, 100],
      [50, 900],
      [BetStatusType.BET_ABLE, BetStatusType.BET_ABLE]
    )

    expect(result).toEqual({
      pot: 350,
      call: 50,
      percentage: 50 / 350 * 100,
      ratio: '6:1',
      isPlayerTurn: true,
      spr: 0.2
    })
  })

  it('keeps all existing pot tiers available to an active short stack', () => {
    const result = calculatePlayerPotOdds(
      0,
      {
        NextActionSeat: 0,
        Pot: 300,
        SidePot: [120, 80],
        Phase: 2
      },
      [0, 100],
      [50, 900],
      [BetStatusType.BET_ABLE, BetStatusType.BET_ABLE]
    )

    // A BET_ABLE player has already funded every existing tier. Only the new
    // call is capped; the main pot and both existing side pots stay playable.
    expect(result).toMatchObject({
      pot: 550,
      call: 50,
      percentage: 50 / 550 * 100,
      ratio: '10:1'
    })
  })

  it.each([
    BetStatusType.NOT_IN_PLAY,
    BetStatusType.FOLDED,
    BetStatusType.ALL_IN,
    BetStatusType.ELIMINATED
  ])('does not display pot odds for non-acting BetStatus %s', (betStatus) => {
    const result = calculatePlayerPotOdds(
      0,
      {
        NextActionSeat: 1,
        Pot: 300,
        SidePot: [],
        Phase: 1
      },
      [0, 100],
      [500, 900],
      [betStatus, BetStatusType.BET_ABLE]
    )

    expect(result).toMatchObject({
      pot: 300,
      call: 0,
      percentage: 0,
      ratio: '',
      isPlayerTurn: false
    })
  })

  it('does not offer odds to an ante all-in seat when forced posts already created side pots', () => {
    const result = calculatePlayerPotOdds(
      0,
      {
        NextActionSeat: 1,
        Pot: 250,
        SidePot: [50],
        Phase: 0
      },
      [0, 100],
      [0, 900],
      [BetStatusType.ALL_IN, BetStatusType.BET_ABLE]
    )

    expect(result).toMatchObject({
      pot: 300,
      call: 0,
      percentage: 0,
      ratio: '',
      isPlayerTurn: false,
      spr: 0
    })
  })

  it('preserves hypothetical odds for a BET_ABLE player waiting on another seat', () => {
    const result = calculatePlayerPotOdds(
      0,
      {
        NextActionSeat: 1,
        Pot: 300,
        SidePot: [],
        Phase: 1
      },
      [0, 100],
      [500, 900],
      [BetStatusType.BET_ABLE, BetStatusType.BET_ABLE]
    )

    expect(result).toMatchObject({
      pot: 400,
      call: 100,
      percentage: 25,
      ratio: '3:1',
      isPlayerTurn: false
    })
  })

  it('maintains 0 <= call <= remainingStack across stack and bet boundaries', () => {
    const stacks = [0, 1, 49, 50, 99, 100, 101, 500, 10_000]
    const playerBets = [0, 50, 100, 500]
    const opposingBets = [0, 25, 100, 1_000, 20_000]

    for (const remainingStack of stacks) {
      for (const playerBet of playerBets) {
        for (const opposingBet of opposingBets) {
          const result = calculatePlayerPotOdds(
            0,
            {
              NextActionSeat: 0,
              Pot: 300,
              SidePot: [100],
              Phase: 1
            },
            [playerBet, opposingBet],
            [remainingStack, 100_000],
            [BetStatusType.BET_ABLE, BetStatusType.BET_ABLE]
          )

          expect(result).not.toBeNull()
          expect(result!.call).toBeGreaterThanOrEqual(0)
          expect(result!.call).toBeLessThanOrEqual(remainingStack)
          expect(result!.pot).toBe(400 + result!.call)
        }
      }
    }
  })

  it('should handle when call amount is 0', () => {
    const playerSeatIndex = 1
    const progress = {
      NextActionSeat: 1,
      Pot: 100,
      SidePot: [],
      Phase: 1
    }
    const seatBetAmounts = [20, 20, 20, 20, 0, 0]
    const seatChips = [100, 150, 200, 300, 0, 0]

    const result = calculatePlayerPotOdds(playerSeatIndex, progress, seatBetAmounts, seatChips)

    expect(result).toEqual({
      pot: 100,
      call: 0,
      percentage: 0,
      ratio: '',  // Empty string when no call amount
      isPlayerTurn: true,
      spr: 1.5
    })
  })

  it('should include side pots in pot calculation', () => {
    const playerSeatIndex = 0
    const progress = {
      NextActionSeat: 0,
      Pot: 1000,
      SidePot: [500, 300],
      Phase: 2
    }
    const seatBetAmounts = [0, 200, 200, 0, 0, 0]
    const seatChips = [1500, 800, 300, 0, 0, 0]

    const result = calculatePlayerPotOdds(playerSeatIndex, progress, seatBetAmounts, seatChips)

    expect(result).toEqual({
      pot: 2000, // 1000 + 500 + 300 + 200 (call)
      call: 200,
      percentage: 10.0, // 200 / 2000
      ratio: '9:1',
      isPlayerTurn: true,
      spr: 0.8 // 1500 / 1800
    })
  })

  it('should handle maximum bet differences correctly', () => {
    const playerSeatIndex = 1
    const progress = {
      NextActionSeat: 1,
      Pot: 300,
      SidePot: [],
      Phase: 1
    }
    const seatBetAmounts = [200, 100, 150, 0, 0, 0] // Player 0 has highest bet
    const seatChips = [800, 900, 850, 0, 0, 0]

    const result = calculatePlayerPotOdds(playerSeatIndex, progress, seatBetAmounts, seatChips)

    expect(result).toEqual({
      pot: 400, // 300 + 100 (call)
      call: 100,
      percentage: 25.0, // 100 / 400
      ratio: '3:1',
      isPlayerTurn: true,
      spr: 3.0 // 900 / 300
    })
  })

  it('should not calculate SPR when pot is 0', () => {
    const playerSeatIndex = 0
    const progress = {
      NextActionSeat: 0,
      Pot: 0,
      SidePot: [],
      Phase: 0
    }
    const seatBetAmounts = [0, 0, 0, 0, 0, 0]
    const seatChips = [1000, 1000, 1000, 1000, 0, 0]

    const result = calculatePlayerPotOdds(playerSeatIndex, progress, seatBetAmounts, seatChips)

    expect(result).toEqual({
      pot: 0,
      call: 0,
      percentage: 0,
      ratio: '',
      isPlayerTurn: true,
      spr: undefined // No SPR when pot is 0
    })
  })

  it('should return null when progress is undefined', () => {
    const result = calculatePlayerPotOdds(0, undefined, [0, 0], [100, 100])
    expect(result).toBe(null)
  })

  it('should return null when seatBetAmounts is undefined', () => {
    const progress = { NextActionSeat: 0, Pot: 100 }
    const result = calculatePlayerPotOdds(0, progress, undefined as any, [100, 100])
    expect(result).toBe(null)
  })
})
