import {
  handImprovementStat, setHandImprovementHeroHoleCards,
  setHandImprovementBatchMode, type HandImprovementResult
} from './hand-improvement'
import { PhaseType, RankType } from '../types'
import type { StatCalculationContext } from '../types/stats'

const contextFor = (phase: PhaseType, communityCards: number[]): StatCalculationContext => ({
  playerId: 101,
  actions: [],
  phases: [{ handId: 1, phase, seatUserIds: [101], communityCards }],
  hands: [{
    id: 1, seatUserIds: [101], winningPlayerIds: [], smallBlind: 100, bigBlind: 200,
    session: { id: undefined, battleType: undefined, name: undefined }, results: []
  }],
  allPlayerActions: [], allPlayerPhases: [], winningHandIds: new Set<number>(),
  session: {
    id: undefined, battleType: undefined, name: undefined,
    players: new Map(), reset: () => {}
  }
})

const calculate = (holeCards: number[], phase = PhaseType.PREFLOP, board: number[] = []) => {
  setHandImprovementHeroHoleCards('test-hand', '101', holeCards)
  return handImprovementStat.calculate(contextFor(phase, board)) as HandImprovementResult
}

const probability = (result: HandImprovementResult, rank: RankType): number =>
  result.improvements.find(row => row.rank === rank)!.probability

describe('handImprovementStat', () => {
  beforeEach(() => {
    setHandImprovementBatchMode(true)
    setHandImprovementBatchMode(false)
  })

  test.each([
    [PhaseType.FLOP, [40, 36, 32]],
    [PhaseType.TURN, [40, 36, 32, 1]],
    [PhaseType.RIVER, [40, 36, 32, 1, 6]],
    [PhaseType.TURN, [40, 36, 32, 1, 6]]
  ])('完成したロイヤルフラッシュを統合行に表示する (phase=%s, board=%j)', (phase, board) => {
    const result = calculate([48, 44], phase as PhaseType, board as number[])
    expect(result.currentHand.rank).toBe(RankType.ROYAL_FLUSH)
    expect(result.improvements).toHaveLength(9)
    expect(result.improvements.filter(row => row.isCurrent)).toEqual([{
      rank: RankType.STRAIGHT_FLUSH, name: 'Straight Flush',
      probability: 100, isComplete: true, isCurrent: true
    }])
    expect(result.improvements.reduce((sum, row) => sum + row.probability, 0)).toBe(100)
    expect(result.improvements.filter(row => row.rank !== RankType.STRAIGHT_FLUSH)
      .every(row => row.probability === 0 && !row.isComplete)).toBe(true)
  })

  test('プリフロップの現在のペアとリバー時点の最終役分布を区別する', () => {
    const result = calculate([48, 49])
    expect(result.currentHand).toEqual({ rank: RankType.ONE_PAIR, name: 'One Pair' })
    const pair = result.improvements.find(row => row.rank === RankType.ONE_PAIR)!
    // 50枚から5枚の全列挙で、AAが最終ワンペアとなるボードは762,300通り。
    expect(pair.probability).toBeCloseTo(762_300 * 100 / 2_118_760, 10)
    expect(pair.isCurrent).toBe(true)
    expect(pair.isComplete).toBe(false)
    expect(result.improvements.reduce((sum, row) => sum + row.probability, 0)).toBeCloseTo(100, 10)
  })

  test('同ランクのsuitedハンドはoffsuitよりフラッシュ確率が高い', () => {
    const suited = calculate([48, 44])
    const offsuit = calculate([48, 45])
    expect(probability(suited, RankType.FLUSH)).toBeCloseTo(138_296 * 100 / 2_118_760, 10)
    expect(probability(suited, RankType.FLUSH)).toBeGreaterThan(probability(offsuit, RankType.FLUSH))
  })

  test('ポケットペアのクワッズを独立した組合せ数で検証する', () => {
    const result = calculate([32, 33])
    const ownQuads = 48 * 47 * 46 / 6
    const boardQuads = 12 * 46
    expect(probability(result, RankType.FOUR_OF_A_KIND))
      .toBeCloseTo((ownQuads + boardQuads) * 100 / 2_118_760, 10)
    expect(result.improvements.some(row => row.name === 'Royal Flush')).toBe(false)
    expect(probability(result, RankType.STRAIGHT_FLUSH)).toBeGreaterThan(0)
    expect(probability(result, RankType.STRAIGHT)).toBeGreaterThan(0)
    expect(probability(result, RankType.FLUSH)).toBeGreaterThan(0)
    expect(probability(result, RankType.THREE_OF_A_KIND)).toBeGreaterThan(0)
  })

  test.each([
    { phase: PhaseType.FLOP, board: [] },
    { phase: PhaseType.FLOP, board: [8] },
    { phase: PhaseType.TURN, board: [8, 13, 22] },
    { phase: PhaseType.RIVER, board: [8, 13, 22, 35] }
  ])('盤面が不足しているphase=$phaseでは古い役を表示しない', ({ phase, board }) => {
    setHandImprovementHeroHoleCards('test-hand', '101', [48, 49])
    expect(handImprovementStat.calculate(contextFor(phase, board))).toBe('-')
  })

  test('盤面が揃ったリバーは確定した最終役だけを100%にする', () => {
    const result = calculate([48, 49], PhaseType.RIVER, [8, 13, 22, 35, 44])
    expect(result.currentHand.rank).toBe(RankType.ONE_PAIR)
    expect(result.improvements.filter(row => row.probability > 0)).toEqual([{
      rank: RankType.ONE_PAIR, name: 'One Pair', probability: 100,
      isComplete: true, isCurrent: true
    }])
  })
})
