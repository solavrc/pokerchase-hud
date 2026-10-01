import { PhaseType } from '../types/game'
import { RealtimeCommunityCards, hasBoardForPhase } from './realtime-community-cards'

describe('RealtimeCommunityCards', () => {
  test('ACTION側のフェーズに依存せず、各ROUNDのstreetへカードを配置する', () => {
    const board = new RealtimeCommunityCards()
    expect(board.apply(PhaseType.FLOP, [0, 5, 10])).toEqual([0, 5, 10])
    expect(board.apply(PhaseType.TURN, [15])).toEqual([0, 5, 10, 15])
    expect(board.apply(PhaseType.RIVER, [20])).toEqual([0, 5, 10, 15, 20])
  })

  test('先に来たリバーをターンに繰り上げず、欠落箇所の到着後に復元する', () => {
    const board = new RealtimeCommunityCards()
    board.apply(PhaseType.FLOP, [0, 5, 10])
    expect(board.apply(PhaseType.RIVER, [20])).toEqual([0, 5, 10])
    expect(board.apply(PhaseType.TURN, [15])).toEqual([0, 5, 10, 15, 20])
  })

  test('フロップが最後に来ても、既知のターン・リバーを保持する', () => {
    const board = new RealtimeCommunityCards()
    expect(board.apply(PhaseType.TURN, [15])).toEqual([])
    expect(board.apply(PhaseType.RIVER, [20])).toEqual([])
    expect(board.apply(PhaseType.FLOP, [0, 5, 10])).toEqual([0, 5, 10, 15, 20])
  })

  test('累積形式と同内容の再送でカードを重複追加しない', () => {
    const board = new RealtimeCommunityCards()
    expect(board.apply(PhaseType.TURN, [0, 5, 10, 15])).toEqual([0, 5, 10, 15])
    expect(board.apply(PhaseType.TURN, [15])).toEqual([0, 5, 10, 15])
    expect(board.apply(PhaseType.RIVER, [0, 5, 10, 15, 20])).toEqual([0, 5, 10, 15, 20])
    expect(board.apply(PhaseType.FLOP, [0, 5, 10])).toEqual([0, 5, 10, 15, 20])
  })

  test('リセットで前ハンドの未連結カードも捨てる', () => {
    const board = new RealtimeCommunityCards()
    board.apply(PhaseType.RIVER, [20])
    board.reset()
    expect(board.apply(PhaseType.FLOP, [1, 6, 11])).toEqual([1, 6, 11])
    expect(board.apply(PhaseType.TURN, [16])).toEqual([1, 6, 11, 16])
  })

  test('不正値は既存の盤面を汚さない', () => {
    const board = new RealtimeCommunityCards()
    board.apply(PhaseType.FLOP, [0, 5, 10])
    expect(board.apply(PhaseType.TURN, [52])).toEqual([0, 5, 10])
    expect(board.apply(PhaseType.TURN, [1.5])).toEqual([0, 5, 10])
  })
})

describe('hasBoardForPhase', () => {
  test.each([
    [PhaseType.PREFLOP, [], true],
    [PhaseType.FLOP, [], false],
    [PhaseType.FLOP, [0, 5, 10], true],
    [PhaseType.TURN, [0, 5, 10], false],
    [PhaseType.TURN, [0, 5, 10, 15], true],
    [PhaseType.RIVER, [0, 5, 10, 15], false],
    [PhaseType.RIVER, [0, 5, 10, 15, 20], true]
  ])('phase=%sの盤面が足りるかを判定する', (phase, cards, expected) => {
    expect(hasBoardForPhase(phase, cards)).toBe(expected)
  })
})
