/**
 * Pot Odds Statistic
 * 
 * Calculates and displays pot odds when facing a bet
 * Shows both percentage and ratio format
 */

import type { StatDefinition, StatCalculationContext, StatValue } from '../types/stats'
import { BetStatusType } from '../types/game'

export interface PlayerPotOddsResult {
  pot: number
  call: number
  percentage: number
  ratio: string
  isPlayerTurn: boolean
  spr?: number
}

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

/**
 * Calculate pot odds and SPR for any player
 * @param playerSeatIndex The seat index of the player to calculate for
 * @param progress Current game progress
 * @param seatBetAmounts Bet amounts for each seat
 * @param seatChips Chip stacks for each seat
 * @param seatBetStatuses Current action eligibility for each seat
 * @returns Pot odds and SPR data for the specified player
 */
export function calculatePlayerPotOdds(
  playerSeatIndex: number,
  progress: any,
  seatBetAmounts: number[],
  seatChips: number[],
  seatBetStatuses?: Array<BetStatusType | undefined>
): PlayerPotOddsResult | null {
  if (!progress || !seatBetAmounts) {
    return null
  }
  
  // A BET_ABLE player has already funded every existing pot tier, so all
  // current side pots remain playable. Only the player's new call is capped.
  let totalPot = progress.Pot || 0
  if (progress.SidePot && Array.isArray(progress.SidePot)) {
    for (const sidePot of progress.SidePot) {
      totalPot += sidePot || 0
    }
  }
  
  // Calculate call amount
  let maxBet = 0
  for (let i = 0; i < seatBetAmounts.length; i++) {
    const betAmount = seatBetAmounts[i]
    if (betAmount !== undefined && betAmount > maxBet) {
      maxBet = betAmount
    }
  }
  
  // Player's current bet
  const playerBet = seatBetAmounts[playerSeatIndex] || 0
  
  // A player can call only while still eligible to act. EVT_DEAL and
  // EVT_DEAL_ROUND provide authoritative BetStatus snapshots; EVT_ACTION
  // updates folds/all-ins between those snapshots.
  const playerBetStatus = seatBetStatuses?.[playerSeatIndex]
  const canAct = playerBetStatus === undefined || playerBetStatus === BetStatusType.BET_ABLE

  // Pot odds use the amount the player can actually put in, not the full bet
  // difference. Chip is the post-action/post-forced-post remaining stack in
  // PokerChase events, so a short call is capped directly by this value.
  const fullCallAmount = Math.max(0, maxBet - playerBet)
  const remainingStack = seatChips?.[playerSeatIndex]
  const effectiveStack = typeof remainingStack === 'number' && Number.isFinite(remainingStack)
    ? Math.max(0, remainingStack)
    : undefined
  const callAmount = canAct
    ? Math.min(fullCallAmount, effectiveStack ?? fullCallAmount)
    : 0

  // Progress already contains every current-street contribution. When this
  // seat cannot cover the highest bet, chips above its reachable contribution
  // belong to a deeper side-pot tier (or become an uncalled return) and cannot
  // be won by this seat. Remove that excess from every contributor before
  // adding the effective call.
  const reachableBet = playerBet + callAmount
  const unmatchedExcess = canAct
    ? seatBetAmounts.reduce((sum, betAmount) => (
      sum + Math.max(0, (betAmount || 0) - reachableBet)
    ), 0)
    : 0
  const eligiblePot = Math.max(0, totalPot - unmatchedExcess)
  
  // Calculate the total pot that player would be playing for
  const playablePot = eligiblePot + callAmount
  
  const result: PlayerPotOddsResult = {
    pot: playablePot,
    call: callAmount,
    percentage: 0,
    ratio: '',
    isPlayerTurn: progress.NextActionSeat === playerSeatIndex,
    spr: undefined
  }
  
  // Calculate SPR if we have chip data
  if (effectiveStack !== undefined) {
    if (totalPot > 0) {
      result.spr = Math.round((effectiveStack / totalPot) * 10) / 10
    }
  }
  
  // Calculate pot odds if there's a call amount
  if (callAmount > 0) {
    const odds = calculatePotOdds(callAmount, eligiblePot)
    result.percentage = odds.percentage
    result.ratio = odds.ratio
  }
  
  return result
}

export const potOddsStat: StatDefinition = {
  id: 'potOdds',
  name: 'POT ODDS',
  description: 'Pot odds when facing a bet',
  
  calculate(context: StatCalculationContext & {
    progress?: any
    heroSeatIndex?: number
    seatBetAmounts?: number[]
    seatChips?: number[]
    seatBetStatuses?: Array<BetStatusType | undefined>
  }): StatValue {
    // Use real-time Progress data from WebSocket events
    const { progress, heroSeatIndex, seatBetAmounts, seatChips, seatBetStatuses } = context
    
    if (!progress || heroSeatIndex === undefined || !seatBetAmounts) {
      return '-'
    }

    const playerResult = calculatePlayerPotOdds(
      heroSeatIndex,
      progress,
      seatBetAmounts,
      seatChips ?? [],
      seatBetStatuses
    )
    if (!playerResult) return '-'

    const { isPlayerTurn, ...odds } = playerResult
    return {
      ...odds,
      isHeroTurn: isPlayerTurn
    }
  },
  
  format(value) {
    if (typeof value === 'object' && value !== null && 'ratio' in value) {
      return value.ratio as string
    }
    return '-'
  }
}
