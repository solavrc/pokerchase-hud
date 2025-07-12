/**
 * Poker Hand Evaluator
 * 
 * Efficient 7-card hand evaluation using bit manipulation and lookup tables
 * Optimized for real-time HUD calculations
 */

import { RankType } from '../types/game'
import { getCardRank, getCardSuit } from './card-utils'

// Card representation: 0-51 where:
// 0-3: 2s-2c, 4-7: 3s-3c, ..., 48-51: As-Ac
// Rank = card / 4, Suit = card % 4 (s=0, h=1, d=2, c=3)

// Export RankType for external use
export { RankType }


export interface HandRank {
  rank: RankType
  value: number // For comparing hands of same rank
  cards: number[] // The 5 cards making the hand
}

/**
 * Evaluate the best 5-card hand from 5-7 cards
 * @param cards Array of 5-7 card numbers (0-51)
 * @returns HandRank with rank type and comparison value
 */
export function evaluateHand(cards: number[]): HandRank {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error('Must evaluate between 5 and 7 cards')
  }

  
  // Count ranks and suits
  const rankCounts = new Array(13).fill(0)
  const suitCounts = new Array(4).fill(0)
  const rankBits = new Array(4).fill(0) // Bit masks per suit
  let allRankBits = 0
  
  for (const card of cards) {
    const rank = getCardRank(card)
    const suit = getCardSuit(card)
    rankCounts[rank]++
    suitCounts[suit]++
    rankBits[suit] |= (1 << rank)
    allRankBits |= (1 << rank)
  }
  
  // Check for flush
  let flushSuit = -1
  for (let suit = 0; suit < 4; suit++) {
    if (suitCounts[suit] >= 5) {
      flushSuit = suit
      break
    }
  }
  
  // Check for straight (including wheel A-2-3-4-5)
  const checkStraight = (bits: number): number => {
    // Check A-2-3-4-5 (wheel)
    if ((bits & 0x100F) === 0x100F) return 3 // 5-high straight
    
    // Check other straights
    for (let high = 12; high >= 4; high--) {
      const mask = 0x1F << (high - 4)
      if ((bits & mask) === mask) return high
    }
    return -1
  }
  
  // Check for straight flush
  if (flushSuit >= 0) {
    const straightHigh = checkStraight(rankBits[flushSuit])
    if (straightHigh >= 0) {
      return {
        rank: straightHigh === 12 ? RankType.ROYAL_FLUSH : RankType.STRAIGHT_FLUSH,
        value: straightHigh,
        cards: [] // TODO: Extract actual cards
      }
    }
  }
  
  // Count pairs, trips, quads
  let pairs = []
  let trips = []
  let quads = []
  
  for (let rank = 12; rank >= 0; rank--) {
    if (rankCounts[rank] === 4) quads.push(rank)
    else if (rankCounts[rank] === 3) trips.push(rank)
    else if (rankCounts[rank] === 2) pairs.push(rank)
  }
  
  // Determine hand rank
  if (quads.length > 0) {
    const quadRank = quads[0]!
    const kickers = getKicker(rankCounts, [quadRank], 1)
    return {
      rank: RankType.FOUR_OF_A_KIND,
      value: (quadRank << 4) | (kickers[0] || 0),
      cards: []
    }
  }
  
  if (trips.length > 0 && (pairs.length > 0 || trips.length >= 2)) {
    const tripRank = trips[0]!
    const pairRank = pairs.length > 0 ? pairs[0]! : trips[1]!
    return {
      rank: RankType.FULL_HOUSE,
      value: (tripRank << 4) | pairRank,
      cards: []
    }
  }
  
  if (flushSuit >= 0) {
    const flushRanks = getFlushRanks(cards, flushSuit, 5)
    return {
      rank: RankType.FLUSH,
      value: flushRanks.reduce((v, r, i) => v | (r << (4 * (4 - i))), 0),
      cards: []
    }
  }
  
  const straightHigh = checkStraight(allRankBits)
  if (straightHigh >= 0) {
    return {
      rank: RankType.STRAIGHT,
      value: straightHigh,
      cards: []
    }
  }
  
  if (trips.length > 0) {
    const tripRank = trips[0]!
    const kickers = getKicker(rankCounts, [tripRank], 2)
    return {
      rank: RankType.THREE_OF_A_KIND,
      value: (tripRank << 8) | ((kickers[0] || 0) << 4) | (kickers[1] || 0),
      cards: []
    }
  }
  
  if (pairs.length >= 2) {
    const pair1 = pairs[0]!
    const pair2 = pairs[1]!
    const kicker = getKicker(rankCounts, [pair1, pair2], 1)
    return {
      rank: RankType.TWO_PAIR,
      value: (pair1 << 8) | (pair2 << 4) | (kicker[0] || 0),
      cards: []
    }
  }
  
  if (pairs.length === 1) {
    const pairRank = pairs[0]!
    const kickers = getKicker(rankCounts, [pairRank], 3)
    return {
      rank: RankType.ONE_PAIR,
      value: (pairRank << 12) | ((kickers[0] || 0) << 8) | ((kickers[1] || 0) << 4) | (kickers[2] || 0),
      cards: []
    }
  }
  
  // High card
  const kickers = getKicker(rankCounts, [], 5)
  return {
    rank: RankType.HIGH_CARD,
    value: kickers.reduce((v, k, i) => v | (k << (4 * (4 - i))), 0),
    cards: []
  }
}

function getKicker(rankCounts: number[], used: number[], count: number): number[] {
  const kickers: number[] = []
  for (let rank = 12; rank >= 0 && kickers.length < count; rank--) {
    if (rankCounts[rank]! > 0 && !used.includes(rank)) {
      kickers.push(rank)
    }
  }
  return kickers
}

function getFlushRanks(cards: number[], suit: number, count: number): number[] {
  const ranks: number[] = []
  for (const card of cards) {
    if (getCardSuit(card) === suit) {
      ranks.push(getCardRank(card))
    }
  }
  ranks.sort((a, b) => b - a)
  return ranks.slice(0, count)
}


