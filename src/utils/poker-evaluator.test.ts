import { evaluateHand, RankType } from './poker-evaluator'

/** カード表記 (例: 'As', 'Th') をカード番号 (0-51) に変換 */
const c = (card: string): number => {
  const rank = '23456789TJQKA'.indexOf(card[0]!)
  const suit = 'shdc'.indexOf(card[1]!)
  return rank * 4 + suit
}
const cards = (...names: string[]): number[] => names.map(c)

test('A+2-3-4-5-6 はホイールではなく6ハイストレートと判定される', () => {
  const result = evaluateHand(cards('As', 'Ah', '2s', '3h', '4d', '5c', '6h'))
  expect(result.rank).toBe(RankType.STRAIGHT)
  expect(result.value).toBe(4) // 6-high, not wheel (3)
})

test('A-2-3-4-5-6 同スートは6ハイストレートフラッシュと判定される', () => {
  const result = evaluateHand(cards('As', '2s', '3s', '4s', '5s', '6s', 'Kd'))
  expect(result.rank).toBe(RankType.STRAIGHT_FLUSH)
  expect(result.value).toBe(4) // 6-high, not steel wheel (3)
})

test('純粋なホイール (A-2-3-4-5, 6なし) は5ハイストレートのまま', () => {
  const result = evaluateHand(cards('As', '2h', '3d', '4c', '5s'))
  expect(result.rank).toBe(RankType.STRAIGHT)
  expect(result.value).toBe(3)
})

test('7枚でも6が無ければホイールは5ハイストレートのまま', () => {
  const result = evaluateHand(cards('As', 'Ah', '2h', '3d', '4c', '5s', '9d'))
  expect(result.rank).toBe(RankType.STRAIGHT)
  expect(result.value).toBe(3)
})

test('スチールホイール (A-5同スート, 6なし) は5ハイストレートフラッシュのまま', () => {
  const result = evaluateHand(cards('As', '2s', '3s', '4s', '5s'))
  expect(result.rank).toBe(RankType.STRAIGHT_FLUSH)
  expect(result.value).toBe(3)
})

test('A-2-3-4-5-6-7 は7ハイストレートと判定される', () => {
  const result = evaluateHand(cards('As', '2h', '3d', '4c', '5s', '6h', '7d'))
  expect(result.rank).toBe(RankType.STRAIGHT)
  expect(result.value).toBe(5) // 7-high
})

test('2-3-4-5-6 ボードではAA保持者とKK保持者がチョップになる', () => {
  const board = ['2h', '3d', '4c', '5s', '6h']
  const hero = evaluateHand(cards('As', 'Ah', ...board))
  const villain = evaluateHand(cards('Kd', 'Kc', ...board))
  expect(hero.rank).toBe(RankType.STRAIGHT)
  expect(villain.rank).toBe(RankType.STRAIGHT)
  expect(hero.value).toBe(villain.value) // both play the board's 6-high straight
})
