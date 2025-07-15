/**
 * Pot Odds Statistic
 * 
 * Calculates and displays pot odds when facing a bet
 * Shows both percentage and ratio format
 */

import type { StatDefinition, StatCalculationContext, StatValue } from '../types/stats'

/**
 * Calculate pot odds
 * @param callAmount Amount to call
 * @param potSize Current pot size
 * @returns Pot odds as percentage and ratio
 */
function calculatePotOdds(callAmount: number, potSize: number): {
  percentage: number
  ratio: string
} {
  if (callAmount <= 0) {
    return { percentage: 0, ratio: '0:0' }
  }
  
  const totalPot = potSize + callAmount
  const percentage = (callAmount / totalPot) * 100
  
  // Calculate ratio
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a
  const divisor = gcd(potSize, callAmount)
  const potPart = Math.round(potSize / divisor)
  const callPart = Math.round(callAmount / divisor)
  
  return {
    percentage,
    ratio: `${potPart}:${callPart}`
  }
}

export const potOddsStat: StatDefinition = {
  id: 'potOdds',
  name: 'POT ODDS',
  description: 'Pot odds when facing a bet',
  
  calculate(context: StatCalculationContext & { progress?: any; heroSeatIndex?: number; seatBetAmounts?: number[]; seatChips?: number[] }): StatValue {
    // Use real-time Progress data from WebSocket events
    const { progress, heroSeatIndex, seatBetAmounts, seatChips } = context
    
    if (!progress || heroSeatIndex === undefined || !seatBetAmounts) {
      return '-'
    }
    
    // Calculate total pot including all side pots
    let totalPot = progress.Pot || 0
    if (progress.SidePot && Array.isArray(progress.SidePot)) {
      for (const sidePot of progress.SidePot) {
        totalPot += sidePot || 0
      }
    }
    
    // Calculate call amount regardless of whose turn it is
    // Find the highest bet amount
    let maxBet = 0
    for (let i = 0; i < seatBetAmounts.length; i++) {
      const betAmount = seatBetAmounts[i]
      if (betAmount !== undefined && betAmount > maxBet) {
        maxBet = betAmount
      }
    }
    
    // Hero's current bet
    const heroBet = seatBetAmounts[heroSeatIndex] || 0
    
    // Call amount is the difference
    const callAmount = maxBet - heroBet
    
    // Calculate the total pot that hero would be playing for
    const playablePot = totalPot + callAmount
    
    const result: any = {
      pot: playablePot,  // Show the pot hero would be playing for
      call: callAmount,
      percentage: 0,
      ratio: '',
      isHeroTurn: progress.NextActionSeat === heroSeatIndex,
      spr: undefined  // Stack to Pot Ratio
    }
    
    // Calculate SPR if we have chip data
    if (seatChips && seatChips[heroSeatIndex] !== undefined) {
      const heroStack = seatChips[heroSeatIndex]
      if (totalPot > 0) {
        result.spr = Math.round((heroStack / totalPot) * 10) / 10  // Round to 1 decimal
      }
    }
    
    // Calculate pot odds if there's a call amount
    if (callAmount > 0) {
      const odds = calculatePotOdds(callAmount, totalPot)
      result.percentage = odds.percentage
      result.ratio = odds.ratio
    }
    
    return result
  },
  
  format(value) {
    if (typeof value === 'object' && value !== null && 'ratio' in value) {
      return value.ratio as string
    }
    return '-'
  }
}