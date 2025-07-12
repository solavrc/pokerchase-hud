/**
 * Hand Improvement Statistics
 * 
 * Calculates the probability of making each hand type by the river
 * Shows outs and completion probability for all possible hands
 */

import type { StatDefinition, StatCalculationContext, StatValue } from '../types/stats'
import { PhaseType, RankType } from '../types/game'
import { evaluateHand } from '../utils/poker-evaluator'
import { calculateRiverProbabilities } from '../utils/river-probabilities'

// Cache hero's hole cards per hand
const holeCardsCache = new Map<string, number[]>()

// Track if we're in batch mode (import/rebuild)
let isBatchMode = false

export function setHandImprovementBatchMode(enabled: boolean) {
  isBatchMode = enabled
  if (enabled) {
    holeCardsCache.clear()
  }
}

export function setHandImprovementHeroHoleCards(handId: string, playerId: string, holeCards: number[]) {
  const cacheKey = `${handId}-${playerId}`
  holeCardsCache.set(cacheKey, holeCards)
  
  // Clean old entries (keep last 10)
  if (holeCardsCache.size > 10) {
    const entries = Array.from(holeCardsCache.entries())
    const toDelete = entries.slice(0, entries.length - 10)
    toDelete.forEach(([key]) => holeCardsCache.delete(key))
  }
}

export interface HandImprovementResult {
  currentHand: {
    rank: RankType
    name: string
  }
  improvements: {
    rank: RankType
    name: string
    probability: number
    isComplete: boolean
    isCurrent: boolean
  }[]
}

export const handImprovementStat: StatDefinition = {
  id: 'handImprovement',
  name: 'Hand Improvement',
  description: 'Probability of making each hand type by the river',
  
  calculate(context: StatCalculationContext): StatValue {
    // Skip during batch operations
    if (isBatchMode) {
      return '-'
    }
    
    const { hands, phases, playerId } = context
    
    // Get the most recent hand
    const recentHand = hands[hands.length - 1]
    if (!recentHand) {
      return '-'
    }
    
    // Check if hero is in this hand
    const heroSeatIndex = recentHand.seatUserIds.findIndex(id => id === playerId)
    if (heroSeatIndex === -1) {
      return '-'
    }
    
    // Get hero's hole cards from cache
    let heroCards: number[] | undefined
    
    // Look for any cached hole cards for this player (most recent)
    for (const [key, cards] of Array.from(holeCardsCache.entries()).reverse()) {
      if (key.includes(`-${playerId.toString()}`)) {
        heroCards = cards
        break
      }
    }
    
    if (!heroCards || heroCards.length !== 2) {
      return '-'
    }
    
    // Get current phase and community cards
    const currentPhases = phases.filter(p => p.handId === recentHand.id)
    const latestPhase = currentPhases[currentPhases.length - 1]
    
    if (!latestPhase) {
      return '-'
    }
    
    const communityCards = latestPhase.communityCards || []
    const allCards = [...heroCards, ...communityCards]
    
    // Evaluate current hand
    let currentRank = RankType.HIGH_CARD
    if (allCards.length >= 5) {
      // Only evaluate with actual cards (don't fill with dummy cards)
      const currentHand = evaluateHand(allCards)
      currentRank = currentHand.rank
    } else if (allCards.length === 2 && heroCards.length === 2) {
      // Preflop - check for pocket pair
      const card1 = heroCards[0]
      const card2 = heroCards[1]
      if (card1 !== undefined && card2 !== undefined) {
        const rank1 = Math.floor(card1 / 4)
        const rank2 = Math.floor(card2 / 4)
        if (rank1 === rank2) {
          currentRank = RankType.ONE_PAIR
        }
      }
    }
    
    
    // Calculate probabilities for all hand types
    const result: HandImprovementResult = {
      currentHand: {
        rank: currentRank,
        name: getRankName(currentRank)
      },
      improvements: []
    }
    
    // For each possible hand rank from best to worst
    const allRanks = [
      RankType.STRAIGHT_FLUSH,  // Royal Flush is included here
      RankType.FOUR_OF_A_KIND,
      RankType.FULL_HOUSE,
      RankType.FLUSH,
      RankType.STRAIGHT,
      RankType.THREE_OF_A_KIND,
      RankType.TWO_PAIR,
      RankType.ONE_PAIR,
      RankType.HIGH_CARD
    ]
    
    if (latestPhase.phase === PhaseType.RIVER || allCards.length === 7) {
      // River - just show current hand
      for (const rank of allRanks) {
        result.improvements.push({
          rank,
          name: getRankName(rank),
          probability: rank === currentRank ? 100 : 0,
          isComplete: rank === currentRank,
          isCurrent: rank === currentRank
        })
      }
    } else {
      // Calculate probabilities for improvement
      let probabilities: Record<string, number>
      
      if (communityCards.length < 3) {
        // Preflop - calculate for all 5 community cards to come
        probabilities = calculatePreflopProbabilities(heroCards)
      } else {
        // Postflop - use existing river probability calculation
        const riverProbs = calculateRiverProbabilities(heroCards, communityCards)
        // Extract probabilities with correct property names
        probabilities = {
          straightflush: riverProbs.straightFlush + riverProbs.royalFlush,  // Combine royal and straight flush
          fourofakind: riverProbs.quads,
          fullhouse: riverProbs.fullHouse,
          flush: riverProbs.flush,
          straight: riverProbs.straight,
          threeofakind: riverProbs.trips,
          twopair: riverProbs.twoPair,
          onepair: riverProbs.onePair,
          highcard: riverProbs.highCard
        }
      }
      
      
      for (const rank of allRanks) {
        const rankName = getRankName(rank).toLowerCase().replace(/ /g, '')  // Replace ALL spaces
        const probability = probabilities[rankName] || 0
        
        
        result.improvements.push({
          rank,
          name: getRankName(rank),
          probability: probability,
          isComplete: rank === currentRank && probability === 100,
          isCurrent: rank === currentRank
        })
      }
    }
    
    return result
  },
  
  format(value: StatValue): string {
    if (typeof value === 'object' && value && !Array.isArray(value) && 'currentHand' in value) {
      const result = value as HandImprovementResult
      return `Current: ${result.currentHand.name}`
    }
    return '-'
  }
}

function getRankName(rank: RankType): string {
  switch (rank) {
    case RankType.STRAIGHT_FLUSH: return 'Straight Flush'
    case RankType.ROYAL_FLUSH: return 'Straight Flush'  // Treat royal as straight flush
    case RankType.FOUR_OF_A_KIND: return 'Four of a Kind'
    case RankType.FULL_HOUSE: return 'Full House'
    case RankType.FLUSH: return 'Flush'
    case RankType.STRAIGHT: return 'Straight'
    case RankType.THREE_OF_A_KIND: return 'Three of a Kind'
    case RankType.TWO_PAIR: return 'Two Pair'
    case RankType.ONE_PAIR: return 'One Pair'
    case RankType.HIGH_CARD: return 'High Card'
    default: return 'Unknown'
  }
}

function calculatePreflopProbabilities(holeCards: number[]): Record<string, number> {
  // Simplified preflop probabilities based on hole cards
  if (holeCards.length !== 2) {
    return {
      royalflush: 0,
      straightflush: 0,
      fourofakind: 0,
      fullhouse: 0,
      flush: 0,
      straight: 0,
      threeofakind: 0,
      twopair: 0,
      onepair: 0,
      highcard: 100
    }
  }
  
  const card1 = holeCards[0]
  const card2 = holeCards[1]
  if (card1 === undefined || card2 === undefined) {
    return {
      royalflush: 0,
      straightflush: 0,
      fourofakind: 0,
      fullhouse: 0,
      flush: 0,
      straight: 0,
      threeofakind: 0,
      twopair: 0,
      onepair: 0,
      highcard: 100
    }
  }
  
  const isPocketPair = Math.floor(card1 / 4) === Math.floor(card2 / 4)
  const isSuited = card1 % 4 === card2 % 4
  
  if (isPocketPair) {
    return {
      straightflush: 0.05,  // Includes royal flush
      fourofakind: 0.245,   // Correct probability for pocket pair
      fullhouse: 2.6,
      flush: 2.19,          // Can make flush with 3+ suited community cards
      straight: 4.62,       // Can make straight with proper board
      threeofakind: 10.8,
      twopair: 16.7,
      onepair: 62.81,       // Remaining probability (100% - sum of others)
      highcard: 0
    }
  } else if (isSuited) {
    return {
      straightflush: 0.11,  // Includes royal flush
      fourofakind: 0.01,
      fullhouse: 0.73,
      flush: 6.52,
      straight: 4.62,
      threeofakind: 1.35,
      twopair: 4.75,
      onepair: 32.43,
      highcard: 49.48     // Adjusted to make total 100%
    }
  } else {
    // Offsuit
    return {
      straightflush: 0.02,  // Includes royal flush
      fourofakind: 0.01,
      fullhouse: 0.73,
      flush: 2.24,
      straight: 4.62,
      threeofakind: 1.35,
      twopair: 4.75,
      onepair: 32.43,
      highcard: 53.85     // Adjusted to make total 100%
    }
  }
}