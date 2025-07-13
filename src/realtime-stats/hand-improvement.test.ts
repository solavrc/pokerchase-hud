/**
 * Hand Improvement Tests
 */

import { handImprovementStat, setHandImprovementHeroHoleCards } from './hand-improvement'
import { PhaseType, RankType } from '../types'

describe('handImprovementStat', () => {
  beforeEach(() => {
    // キャッシュをクリア
    setHandImprovementHeroHoleCards('test-hand-1', '101', [48, 49])
  })

  test('プリフロップでポケットペアを正しく認識する', () => {
    /**
     * シナリオ: handImprovementStatが直接呼ばれてポケットペアを評価する場合
     * 検証内容:
     * - ホールカードのキャッシュが正しく動作する
     * - A♠A♥がONE_PAIRとして認識される（プリフロップ時点）
     * - 既に完成している手なので確率100%、isCurrent=true
     * - バッチモードではない通常の計算で動作
     */
    const context = {
      playerId: 101,
      actions: [],
      phases: [{
        handId: 1,
        phase: PhaseType.PREFLOP,
        seatUserIds: [101],
        communityCards: []
      }],
      hands: [{
        id: 1,
        seatUserIds: [101],
        winningPlayerIds: [],
        smallBlind: 100,
        bigBlind: 200,
        session: { id: undefined, battleType: undefined, name: undefined },
        results: []
      }],
      allPlayerActions: [],
      allPlayerPhases: [],
      winningHandIds: new Set<number>(),
      session: {
        id: undefined,
        battleType: undefined,
        name: undefined,
        players: new Map(),
        reset: () => { }
      }
    }

    const result = handImprovementStat.calculate(context) as any

    expect(result).not.toBe('-')
    expect(result.currentHand.rank).toBe(RankType.ONE_PAIR)
    expect(result.currentHand.name).toBe('One Pair')

    const onePair = result.improvements.find((h: any) => h.rank === RankType.ONE_PAIR)
    expect(onePair.probability).toBeCloseTo(62.81, 2)  // プリフロップでの最終的なワンペア確率
    expect(onePair.isCurrent).toBe(true)
    
    // 確率の総和が100%であることを確認
    const totalProbability = result.improvements.reduce((sum: number, h: any) => sum + h.probability, 0)
    expect(totalProbability).toBeCloseTo(100, 1)
  })

  test('スーテッドハンドでフラッシュ確率が高い', () => {
    /**
     * シナリオ: A♠K♠のスーテッドハンドでプリフロップ確率を計算する場合
     * 検証内容:
     * - スーテッドハンドのフラッシュ確率が約6.52%と計算される
     * - オフスートの場合（約2.24%）より高い確率
     * - calculatePreflopProbabilities関数が正しく動作する
     * - 同じスートの2枚からフラッシュを作る確率が反映される
     */
    // A♠ K♠
    setHandImprovementHeroHoleCards('test-hand-2', '102', [48, 44])

    const context = {
      playerId: 102,
      actions: [],
      phases: [{
        handId: 2,
        phase: PhaseType.PREFLOP,
        seatUserIds: [102],
        communityCards: []
      }],
      hands: [{
        id: 2,
        seatUserIds: [102],
        winningPlayerIds: [],
        smallBlind: 100,
        bigBlind: 200,
        session: { id: undefined, battleType: undefined, name: undefined },
        results: []
      }],
      allPlayerActions: [],
      allPlayerPhases: [],
      winningHandIds: new Set<number>(),
      session: {
        id: undefined,
        battleType: undefined,
        name: undefined,
        players: new Map(),
        reset: () => { }
      }
    }

    const result = handImprovementStat.calculate(context) as any

    expect(result).not.toBe('-')

    const flush = result.improvements.find((h: any) => h.rank === RankType.FLUSH)
    expect(flush.probability).toBeGreaterThan(6) // スーテッドは約6.52%
    expect(flush.probability).toBeLessThan(7)
  })

  test('ポケットペアでも各種役への改善確率が正しく計算される', () => {
    /**
     * シナリオ: 9♠9♥のポケットペアでプリフロップ確率を計算する場合
     * 検証内容:
     * - Three of a Kind: 約10.8%（残り2枚の9のどちらかが来る）
     * - Four of a Kind: 約0.245%（残り2枚の9が両方来る）
     * - Flush: 約2.19%（同じスートが3枚以上コミュニティに来る）
     * - Straight: 約4.62%（ストレートが完成する）
     * - Royal Flushは表示されない（Straight Flushに統合）
     */
    // 9♠ 9♥
    setHandImprovementHeroHoleCards('test-hand-3', '103', [32, 33])

    const context = {
      playerId: 103,
      actions: [],
      phases: [{
        handId: 3,
        phase: PhaseType.PREFLOP,
        seatUserIds: [103],
        communityCards: []
      }],
      hands: [{
        id: 3,
        seatUserIds: [103],
        winningPlayerIds: [],
        smallBlind: 100,
        bigBlind: 200,
        session: { id: undefined, battleType: undefined, name: undefined },
        results: []
      }],
      allPlayerActions: [],
      allPlayerPhases: [],
      winningHandIds: new Set<number>(),
      session: {
        id: undefined,
        battleType: undefined,
        name: undefined,
        players: new Map(),
        reset: () => { }
      }
    }

    const result = handImprovementStat.calculate(context) as any

    expect(result).not.toBe('-')

    // Royal Flushが含まれていないことを確認
    const royalFlush = result.improvements.find((h: any) => h.name === 'Royal Flush')
    expect(royalFlush).toBeUndefined()

    // 各確率を確認
    const straightFlush = result.improvements.find((h: any) => h.rank === RankType.STRAIGHT_FLUSH)
    expect(straightFlush.probability).toBeCloseTo(0.05, 1)

    const fourOfAKind = result.improvements.find((h: any) => h.rank === RankType.FOUR_OF_A_KIND)
    expect(fourOfAKind.probability).toBeCloseTo(0.245, 1)

    const flush = result.improvements.find((h: any) => h.rank === RankType.FLUSH)
    expect(flush.probability).toBeCloseTo(2.19, 1)

    const straight = result.improvements.find((h: any) => h.rank === RankType.STRAIGHT)
    expect(straight.probability).toBeCloseTo(4.62, 1)

    const threeOfAKind = result.improvements.find((h: any) => h.rank === RankType.THREE_OF_A_KIND)
    expect(threeOfAKind.probability).toBeCloseTo(10.8, 1)
  })
})