/**
 * River Probabilities Calculator
 * 
 * Calculates the probability of making each poker hand by the river
 * Supports both turn→river (1 card) and flop→river (2 cards) calculations
 */

import { evaluateHand, RankType } from './poker-evaluator'

export interface RiverProbabilities {
  // Basic draws
  highCard: number     // ハイカード
  onePair: number      // ワンペア
  twoPair: number      // ツーペア
  trips: number        // スリーオブアカインド
  straight: number     // ストレート
  flush: number        // フラッシュ
  fullHouse: number    // フルハウス
  quads: number        // フォーオブアカインド
  straightFlush: number // ストレートフラッシュ
  royalFlush: number   // ロイヤルフラッシュ
  
  // Current hand strength
  currentRank: RankType
  currentRankName: string
}

/**
 * Calculate probabilities of making each hand by the river
 * @param holeCards Player's hole cards
 * @param communityCards Current community cards (3-4 cards)
 * @returns Probability of each hand type
 */
export function calculateRiverProbabilities(
  holeCards: number[],
  communityCards: number[]
): RiverProbabilities {
  const allCurrentCards = [...holeCards, ...communityCards]
  const usedCards = new Set(allCurrentCards)
  const remainingCards: number[] = []
  
  // Get all remaining cards in deck
  for (let card = 0; card < 52; card++) {
    if (!usedCards.has(card)) {
      remainingCards.push(card)
    }
  }
  
  // Evaluate current hand
  let currentHand: any
  if (communityCards.length === 5) {
    // River - evaluate as is
    currentHand = evaluateHand(allCurrentCards)
  } else if (communityCards.length === 4) {
    // Turn - add a dummy card for 7-card evaluation
    currentHand = evaluateHand([...allCurrentCards, remainingCards[0]!])
  } else if (communityCards.length === 3) {
    // Flop - add two dummy cards
    currentHand = evaluateHand([...allCurrentCards, remainingCards[0]!, remainingCards[1]!])
  } else {
    throw new Error('Invalid community cards length')
  }
  
  // Count outcomes for each hand type
  const handCounts: Record<RankType, number> = {
    [RankType.ROYAL_FLUSH]: 0,
    [RankType.STRAIGHT_FLUSH]: 0,
    [RankType.FOUR_OF_A_KIND]: 0,
    [RankType.FULL_HOUSE]: 0,
    [RankType.FLUSH]: 0,
    [RankType.STRAIGHT]: 0,
    [RankType.THREE_OF_A_KIND]: 0,
    [RankType.TWO_PAIR]: 0,
    [RankType.ONE_PAIR]: 0,
    [RankType.HIGH_CARD]: 0,
    [RankType.NO_CALL]: 0,
    [RankType.SHOWDOWN_MUCK]: 0,
    [RankType.FOLD_OPEN]: 0
  }
  
  let totalOutcomes = 0
  
  if (communityCards.length === 5) {
    // River - hand is final
    const rank = currentHand.rank as RankType
    if (rank in handCounts) {
      handCounts[rank] = 1
    }
    totalOutcomes = 1
  } else if (communityCards.length === 4) {
    // Turn - check all possible river cards
    for (const riverCard of remainingCards) {
      const finalCards = [...allCurrentCards, riverCard]
      const result = evaluateHand(finalCards)
      handCounts[result.rank]++
      totalOutcomes++
    }
  } else if (communityCards.length === 3) {
    // Flop - check all possible turn+river combinations
    for (let i = 0; i < remainingCards.length; i++) {
      for (let j = i + 1; j < remainingCards.length; j++) {
        const card1 = remainingCards[i]
        const card2 = remainingCards[j]
        if (card1 !== undefined && card2 !== undefined) {
          const finalCards = [...allCurrentCards, card1, card2]
        const result = evaluateHand(finalCards)
          handCounts[result.rank]++
          totalOutcomes++
        }
      }
    }
  }
  
  // Calculate probabilities
  const probabilities: RiverProbabilities = {
    highCard: (handCounts[RankType.HIGH_CARD] / totalOutcomes) * 100,
    onePair: (handCounts[RankType.ONE_PAIR] / totalOutcomes) * 100,
    twoPair: (handCounts[RankType.TWO_PAIR] / totalOutcomes) * 100,
    trips: (handCounts[RankType.THREE_OF_A_KIND] / totalOutcomes) * 100,
    straight: (handCounts[RankType.STRAIGHT] / totalOutcomes) * 100,
    flush: (handCounts[RankType.FLUSH] / totalOutcomes) * 100,
    fullHouse: (handCounts[RankType.FULL_HOUSE] / totalOutcomes) * 100,
    quads: (handCounts[RankType.FOUR_OF_A_KIND] / totalOutcomes) * 100,
    straightFlush: (handCounts[RankType.STRAIGHT_FLUSH] / totalOutcomes) * 100,
    royalFlush: (handCounts[RankType.ROYAL_FLUSH] / totalOutcomes) * 100,
    currentRank: currentHand.rank,
    currentRankName: getRankName(currentHand.rank)
  }
  
  return probabilities
}

/**
 * Get human-readable name for rank type
 */
function getRankName(rank: RankType): string {
  const names: Record<RankType, string> = {
    [RankType.ROYAL_FLUSH]: 'Royal Flush',
    [RankType.STRAIGHT_FLUSH]: 'Straight Flush',
    [RankType.FOUR_OF_A_KIND]: 'Four of a Kind',
    [RankType.FULL_HOUSE]: 'Full House',
    [RankType.FLUSH]: 'Flush',
    [RankType.STRAIGHT]: 'Straight',
    [RankType.THREE_OF_A_KIND]: 'Three of a Kind',
    [RankType.TWO_PAIR]: 'Two Pair',
    [RankType.ONE_PAIR]: 'One Pair',
    [RankType.HIGH_CARD]: 'High Card',
    [RankType.NO_CALL]: 'No Call',
    [RankType.SHOWDOWN_MUCK]: 'Showdown Muck',
    [RankType.FOLD_OPEN]: 'Fold Open'
  }
  return names[rank] || 'Unknown'
}

// Cache for performance
const probabilityCache = new Map<string, RiverProbabilities>()
const CACHE_TTL = 5000 // 5 seconds

export function calculateRiverProbabilitiesWithCache(
  holeCards: number[],
  communityCards: number[]
): RiverProbabilities {
  const cacheKey = `${holeCards.join(',')}|${communityCards.join(',')}`
  
  // Check cache
  const cached = probabilityCache.get(cacheKey)
  if (cached) {
    return cached
  }
  
  // Calculate
  const result = calculateRiverProbabilities(holeCards, communityCards)
  
  // Cache result
  probabilityCache.set(cacheKey, result)
  setTimeout(() => probabilityCache.delete(cacheKey), CACHE_TTL)
  
  return result
}