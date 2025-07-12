/**
 * Starting Hand Rankings
 *
 * Ranks all 169 unique starting hands in Texas Hold'em
 * Optimized for 6-max games where aggression and position are key
 */

import { getCardRank, getCardSuit, RANKS } from './card-utils'

// Types
export interface StartingHandInfo {
  notation: string
  ranking: number
}

// Starting hand rankings for 6-max games (1 = best, 169 = worst)
// 6-max rankings emphasize suited connectors and broadway cards more than full ring
const HAND_RANKINGS: Record<string, number> = {
  'AA': 1,
  'KK': 2,
  'QQ': 3,
  'JJ': 4,
  'AKs': 5,
  'TT': 6,
  'AQs': 7,
  'KQs': 8,
  'AKo': 9,
  'AJs': 10,
  'KJs': 11,
  'ATs': 12,
  '99': 13,
  'QJs': 14,
  'AQo': 15,
  'KTs': 16,
  'QTs': 17,
  'KQo': 18,
  'JTs': 19,
  'AJo': 20,
  'A9s': 21,
  '88': 22,
  'KJo': 23,
  'A8s': 24,
  'K9s': 25,
  'ATo': 26,
  'QJo': 27,
  'A7s': 28,
  'Q9s': 29,
  'T9s': 30,
  'J9s': 31,
  'KTo': 32,
  'A5s': 33,
  '77': 34,
  'A6s': 35,
  'A4s': 36,
  'QTo': 37,
  'JTo': 38,
  'K8s': 39,
  'A3s': 40,
  'K7s': 41,
  'Q8s': 42,
  'T8s': 43,
  'J8s': 44,
  'A2s': 45,
  'A9o': 46,
  '98s': 47,
  '66': 48,
  'K6s': 49,
  'K9o': 50,
  'K5s': 51,
  'A8o': 52,
  'Q7s': 53,
  'Q9o': 54,
  'K4s': 55,
  'T7s': 56,
  'J7s': 57,
  'T9o': 58,
  '97s': 59,
  '87s': 60,
  'J9o': 61,
  '55': 62,
  'Q6s': 63,
  'A7o': 64,
  'K3s': 65,
  'K2s': 66,
  'Q5s': 67,
  'A5o': 68,
  '76s': 69,
  'Q4s': 70,
  '86s': 71,
  'A6o': 72,
  'K8o': 73,
  'J6s': 74,
  'T6s': 75,
  '96s': 76,
  '44': 77,
  'A4o': 78,
  'Q3s': 79,
  'J5s': 80,
  '65s': 81,
  'Q8o': 82,
  'T8o': 83,
  'J8o': 84,
  'A3o': 85,
  'K7o': 86,
  '75s': 87,
  'Q2s': 88,
  '98o': 89,
  '54s': 90,
  'J4s': 91,
  '85s': 92,
  '33': 93,
  'A2o': 94,
  'K6o': 95,
  'J3s': 96,
  'T5s': 97,
  '95s': 98,
  '64s': 99,
  'J2s': 100,
  'T4s': 101,
  '22': 102,
  'K5o': 103,
  '87o': 104,
  '74s': 105,
  '53s': 106,
  'Q7o': 107,
  'T7o': 108,
  '97o': 109,
  'T3s': 110,
  'J7o': 111,
  'T2s': 112,
  '84s': 113,
  'K4o': 114,
  '43s': 115,
  '94s': 116,
  '63s': 117,
  'Q6o': 118,
  '93s': 119,
  'K3o': 120,
  '76o': 121,
  '73s': 122,
  '52s': 123,
  'Q5o': 124,
  '86o': 125,
  '92s': 126,
  'K2o': 127,
  '42s': 128,
  '83s': 129,
  '96o': 130,
  'T6o': 131,
  'Q4o': 132,
  '82s': 133,
  '65o': 134,
  '62s': 135,
  'J6o': 136,
  '32s': 137,
  'Q3o': 138,
  'J5o': 139,
  '75o': 140,
  '72s': 141,
  '54o': 142,
  '85o': 143,
  'Q2o': 144,
  'J4o': 145,
  '95o': 146,
  '64o': 147,
  'T5o': 148,
  'J3o': 149,
  'T4o': 150,
  '74o': 151,
  '53o': 152,
  'J2o': 153,
  'T3o': 154,
  '84o': 155,
  '43o': 156,
  'T2o': 157,
  '63o': 158,
  '94o': 159,
  '93o': 160,
  '52o': 161,
  '73o': 162,
  '92o': 163,
  '83o': 164,
  '42o': 165,
  '82o': 166,
  '62o': 167,
  '32o': 168,
  '72o': 169
}

/**
 * Validate that cards array has exactly 2 cards
 */
function validateHoleCards(cards: number[]): cards is [number, number] {
  return cards.length === 2 && 
         cards[0] !== undefined && 
         cards[1] !== undefined &&
         cards[0] >= 0 && cards[0] <= 51 &&
         cards[1] >= 0 && cards[1] <= 51
}

/**
 * Get hand notation for a pair of cards
 */
function getHandNotation(rank1: number, rank2: number, suited: boolean): string {
  const char1 = RANKS[rank1]
  const char2 = RANKS[rank2]
  
  if (!char1 || !char2) {
    throw new Error(`Invalid rank indices: ${rank1}, ${rank2}`)
  }
  
  if (rank1 === rank2) {
    // Pocket pair
    return `${char1}${char2}`
  }
  
  // Non-pair: ensure higher rank first
  const [highRank, lowRank] = rank1 > rank2 ? [rank1, rank2] : [rank2, rank1]
  const highChar = RANKS[highRank]!
  const lowChar = RANKS[lowRank]!
  
  return `${highChar}${lowChar}${suited ? 's' : 'o'}`
}

/**
 * Get the starting hand notation and ranking
 * @param cards Array of 2 hole cards (0-51)
 * @returns Starting hand info with notation and ranking, or null if invalid
 */
export function getStartingHandRanking(cards: number[]): StartingHandInfo | null {
  if (!validateHoleCards(cards)) {
    return null
  }

  const rank1 = getCardRank(cards[0])
  const rank2 = getCardRank(cards[1])
  const suited = getCardSuit(cards[0]) === getCardSuit(cards[1])

  try {
    const notation = getHandNotation(rank1, rank2, suited)
    const ranking = HAND_RANKINGS[notation]
    
    return ranking ? { notation, ranking } : null
  } catch {
    return null
  }
}
