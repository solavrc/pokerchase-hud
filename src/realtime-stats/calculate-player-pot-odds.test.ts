/**
 * Tests for calculatePlayerPotOdds function
 */

import { calculatePlayerPotOdds } from './pot-odds'

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

  it('should calculate pot odds even when player has no chips', () => {
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

    expect(result?.pot).toBe(60)
    expect(result?.call).toBe(10)
    expect(result?.percentage).toBeCloseTo(16.7, 1)
    expect(result?.ratio).toBe('5:1')
    expect(result?.isPlayerTurn).toBe(false)
    expect(result?.spr).toBe(0)
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