import { RankType } from '../types/game'

const CHOOSE = [
  [1, 0, 0, 0, 0],
  [1, 1, 0, 0, 0],
  [1, 2, 1, 0, 0],
  [1, 3, 3, 1, 0],
  [1, 4, 6, 4, 1]
] as const
const TOTAL_BOARDS = 2_118_760 // C(50, 5)
const cache = new Map<string, Readonly<Record<string, number>>>()

const choose = (n: number, k: number): number => CHOOSE[n]?.[k] ?? 0

const straightHigh = (bits: number): number => {
  for (let high = 12; high >= 4; high--) {
    const mask = 0b11111 << (high - 4)
    if ((bits & mask) === mask) return high
  }
  return (bits & 0x100f) === 0x100f ? 3 : -1
}

/**
 * 既知カードがホールカード2枚だけの場合の、リバー時点の最終役の排他的分布。
 * ランクごとのボード枚数を列挙し、スートの選び方を組合せ数で重み付けする。
 * フラッシュだけは同じランク集合のスート部分集合を数えて分類し直す。
 * 7枚中に別々の2スートのフラッシュは成立しないため、補正は重複しない。
 * ランク・suited/offsuitごとの169種類をキャッシュし、毎アクションの再計算を避ける。
 */
export function calculatePreflopProbabilities(holeCards: number[]): Readonly<Record<string, number>> {
  const [first, second] = holeCards
  if (holeCards.length !== 2 || first === undefined || second === undefined ||
      first === second || !holeCards.every(card => Number.isInteger(card) && card >= 0 && card < 52)) {
    throw new Error('ホールカードには重複しない0〜51の整数を2枚指定してください')
  }
  const firstRank = Math.floor(first / 4)
  const secondRank = Math.floor(second / 4)
  const key = `${Math.max(firstRank, secondRank)}:${Math.min(firstRank, secondRank)}:${first % 4 === second % 4}`
  const cached = cache.get(key)
  if (cached) return cached

  const holeCounts = new Array<number>(13).fill(0)
  holeCounts[firstRank] = holeCounts[firstRank]! + 1
  holeCounts[secondRank] = holeCounts[secondRank]! + 1
  const holeSuitBits = new Array<number>(4).fill(0)
  const holeSuitCounts = new Array<number>(4).fill(0)
  for (const card of holeCards) {
    const suit = card % 4
    holeSuitBits[suit] = holeSuitBits[suit]! | (1 << Math.floor(card / 4))
    holeSuitCounts[suit] = holeSuitCounts[suit]! + 1
  }
  const boardCounts = new Array<number>(13).fill(0)
  const counts = new Array<number>(10).fill(0)

  const countBoardRanks = (ways: number): void => {
    let bits = 0
    let pairs = 0
    let trips = 0
    let quads = false
    const ranks: number[] = []
    for (let rank = 0; rank < 13; rank++) {
      const n = holeCounts[rank]! + boardCounts[rank]!
      if (n > 0) bits |= 1 << rank
      if (n === 2) pairs++
      if (n === 3) trips++
      if (n === 4) quads = true
      if (boardCounts[rank]! > 0) ranks.push(rank)
    }
    const baseRank = quads ? RankType.FOUR_OF_A_KIND
      : trips > 0 && (pairs > 0 || trips > 1) ? RankType.FULL_HOUSE
      : straightHigh(bits) >= 0 ? RankType.STRAIGHT
      : trips > 0 ? RankType.THREE_OF_A_KIND
      : pairs > 1 ? RankType.TWO_PAIR
      : pairs > 0 ? RankType.ONE_PAIR : RankType.HIGH_CARD
    counts[baseRank] = counts[baseRank]! + ways
    // フルハウス／クワッズと5枚同スートは7枚以内で共存できない。
    if (baseRank < RankType.FLUSH) return

    for (let suit = 0; suit < 4; suit++) {
      const required = 5 - holeSuitCounts[suit]!
      if (ranks.length < required) continue
      for (let mask = 0; mask < 1 << ranks.length; mask++) {
        let selected = 0
        for (let value = mask; value; value &= value - 1) selected++
        if (selected < required) continue
        let flushWays = 1
        let flushBits = holeSuitBits[suit]!
        for (let index = 0; index < ranks.length; index++) {
          const rank = ranks[index]!
          const available = 4 - holeCounts[rank]!
          const boardCount = boardCounts[rank]!
          const suitedAvailable = (holeSuitBits[suit]! & (1 << rank)) === 0
          if (mask & (1 << index)) {
            if (!suitedAvailable) { flushWays = 0; break }
            flushWays *= choose(available - 1, boardCount - 1)
            flushBits |= 1 << rank
          } else {
            flushWays *= choose(available - Number(suitedAvailable), boardCount)
          }
          if (flushWays === 0) break
        }
        if (flushWays === 0) continue
        const high = straightHigh(flushBits)
        const flushRank = high === 12 ? RankType.ROYAL_FLUSH
          : high >= 0 ? RankType.STRAIGHT_FLUSH : RankType.FLUSH
        counts[baseRank] = counts[baseRank]! - flushWays
        counts[flushRank] = counts[flushRank]! + flushWays
      }
    }
  }

  const visit = (rank: number, remaining: number, ways: number): void => {
    if (remaining === 0) { countBoardRanks(ways); return }
    if (rank === 13) return
    const available = 4 - holeCounts[rank]!
    for (let count = 0; count <= Math.min(remaining, available); count++) {
      boardCounts[rank] = count
      visit(rank + 1, remaining - count, ways * choose(available, count))
    }
    boardCounts[rank] = 0
  }
  visit(0, 5, 1)

  const percentage = (rank: RankType): number => counts[rank]! * 100 / TOTAL_BOARDS
  const result = Object.freeze({
    straightflush: percentage(RankType.ROYAL_FLUSH) + percentage(RankType.STRAIGHT_FLUSH),
    fourofakind: percentage(RankType.FOUR_OF_A_KIND),
    fullhouse: percentage(RankType.FULL_HOUSE),
    flush: percentage(RankType.FLUSH),
    straight: percentage(RankType.STRAIGHT),
    threeofakind: percentage(RankType.THREE_OF_A_KIND),
    twopair: percentage(RankType.TWO_PAIR),
    onepair: percentage(RankType.ONE_PAIR),
    highcard: percentage(RankType.HIGH_CARD)
  })
  cache.set(key, result)
  return result
}
