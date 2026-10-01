import { calculatePreflopProbabilities } from './preflop-probabilities'

const totalBoards = 2_118_760
const keys = ['straightflush', 'fourofakind', 'fullhouse', 'flush', 'straight',
  'threeofakind', 'twopair', 'onepair', 'highcard']

describe('プリフロップの正確な最終役分布', () => {
  // 各ホールカードについて50枚から5枚を全列挙し、各7枚から21通りの5枚を
  // 独立評価した結果。実装のランク多重集合・スート補正は期待値に共有しない。
  test.each([
    { cards: [48, 49], counts: [216, 17848, 181104, 41562, 25816, 249458, 840456, 762300, 0] },
    { cards: [48, 44], counts: [1162, 2668, 47124, 138296, 65508, 92004, 469092, 916776, 386130] },
    { cards: [48, 45], counts: [216, 2668, 47124, 41562, 69954, 93808, 480080, 965568, 417780] }
  ])('独立した全ボード列挙と一致する: $cards', ({ cards, counts }) => {
    const result = calculatePreflopProbabilities(cards)
    expect(counts.reduce((a, b) => a + b, 0)).toBe(totalBoards)
    keys.forEach((key, index) => {
      expect(result[key]).toBeCloseTo(counts[index]! * 100 / totalBoards, 10)
    })
  })

  test('全169分類が非負・合計100%で、クワッズ確率の独立した式に一致する', () => {
    const choose = (n: number, k: number): number => {
      let result = 1
      for (let i = 1; i <= k; i++) result = result * (n - i + 1) / i
      return result
    }
    let classes = 0
    for (let high = 0; high < 13; high++) {
      for (let low = 0; low <= high; low++) {
        const hands = high === low
          ? [[high * 4, low * 4 + 1]]
          : [[high * 4, low * 4], [high * 4, low * 4 + 1]]
        for (const cards of hands) {
          const result = calculatePreflopProbabilities(cards)
          expect(Object.values(result).every(p => p >= 0 && p <= 100)).toBe(true)
          expect(Object.values(result).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 10)
          // ペア: 残り2枚＋任意3枚、または別ランク4枚＋任意1枚。
          // 非ペア: いずれかのホールランクの残り3枚＋任意2枚、または別ランク4枚＋1枚。
          const quads = high === low
            ? choose(48, 3) + 12 * 46
            : 2 * choose(47, 2) + 11 * 46
          expect(result.fourofakind).toBeCloseTo(quads * 100 / totalBoards, 10)
          if (high === low) expect(result.highcard).toBe(0)
          classes++
        }
      }
    }
    expect(classes).toBe(169)
  })

  test('ランクの連続性を反映し、suitedというだけで同じ確率にしない', () => {
    expect(calculatePreflopProbabilities([28, 24]).straight)
      .toBeGreaterThan(calculatePreflopProbabilities([20, 0]).straight!)
  })

  test('カード順とスート置換で変わらず、キャッシュを外から変更できない', () => {
    const first = calculatePreflopProbabilities([48, 44])
    expect(calculatePreflopProbabilities([44, 48])).toBe(first)
    expect(calculatePreflopProbabilities([49, 45])).toBe(first)
    expect(Object.isFrozen(first)).toBe(true)
  })

  test.each([[], [48], [48, 48], [-1, 4], [0, 52], [0.5, 4], [NaN, 4], [0, 4, 8]])(
    '不正なホールカードを拒否する: %j', (...cards: number[]) => {
      expect(() => calculatePreflopProbabilities(cards)).toThrow()
    }
  )
})
