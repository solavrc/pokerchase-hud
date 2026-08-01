import { SUIT_COLORS, formatCardsArray, isRedSuit, suitColor } from './card-utils'

test('カードを文字列に変換できる', () => {
  expect(formatCardsArray([37, 51])).toStrictEqual(['Jh', 'Ac'])
  expect(formatCardsArray([29, 22, 7, 32, 39])).toStrictEqual(['9h', '7d', '3c', 'Ts', 'Jc'])
  expect(formatCardsArray([
    0, 1, 2, 3,
    4, 5, 6, 7,
    8, 9, 10, 11,
    12, 13, 14, 15,
    16, 17, 18, 19,
    20, 21, 22, 23,
    24, 25, 26, 27,
    28, 29, 30, 31,
    32, 33, 34, 35,
    36, 37, 38, 39,
    40, 41, 42, 43,
    44, 45, 46, 47,
    48, 49, 50, 51,
  ])).toStrictEqual([
    '2s', '2h', '2d', '2c', // 0
    '3s', '3h', '3d', '3c', // 4
    '4s', '4h', '4d', '4c', // 8
    '5s', '5h', '5d', '5c', // 12
    '6s', '6h', '6d', '6c', // 16
    '7s', '7h', '7d', '7c', // 20
    '8s', '8h', '8d', '8c', // 24
    '9s', '9h', '9d', '9c', // 28
    'Ts', 'Th', 'Td', 'Tc', // 32
    'Js', 'Jh', 'Jd', 'Jc', // 36
    'Qs', 'Qh', 'Qd', 'Qc', // 40
    'Ks', 'Kh', 'Kd', 'Kc', // 44
    'As', 'Ah', 'Ad', 'Ac', // 48
  ])
})

describe('isRedSuit', () => {
  test('数値カード番号でハート/ダイヤをred判定できる', () => {
    expect(isRedSuit(1)).toBe(true)  // 2h
    expect(isRedSuit(2)).toBe(true)  // 2d
    expect(isRedSuit(0)).toBe(false) // 2s
    expect(isRedSuit(3)).toBe(false) // 2c
  })

  test('フォーマット済みカード文字列でも判定できる', () => {
    expect(isRedSuit('Ah')).toBe(true)
    expect(isRedSuit('Kd')).toBe(true)
    expect(isRedSuit('As')).toBe(false)
    expect(isRedSuit('Kc')).toBe(false)
  })
})
// #353: 4色デッキ（スペード=既定色 / ハート=赤 / ダイヤ=青 / クラブ=緑）
describe('suitColor', () => {
  test('カード番号からスート別の色を返す', () => {
    expect(suitColor(0)).toBe(SUIT_COLORS.s)  // 2s
    expect(suitColor(1)).toBe(SUIT_COLORS.h)  // 2h
    expect(suitColor(2)).toBe(SUIT_COLORS.d)  // 2d
    expect(suitColor(3)).toBe(SUIT_COLORS.c)  // 2c
    expect(suitColor(51)).toBe(SUIT_COLORS.c) // Ac
  })

  test('整形済みカード文字列からも同じ色を返す', () => {
    expect(suitColor('As')).toBe(SUIT_COLORS.s)
    expect(suitColor('Ah')).toBe(SUIT_COLORS.h)
    expect(suitColor('Kd')).toBe(SUIT_COLORS.d)
    expect(suitColor('Kc')).toBe(SUIT_COLORS.c)
  })

  test('4スートが互いに異なる色である（4色表現の要件）', () => {
    const colors = Object.values(SUIT_COLORS)
    expect(new Set(colors).size).toBe(4)
  })

  test('解釈できないスートは既定色へ倒す（表示でHUDを落とさない）', () => {
    expect(suitColor('A?')).toBe(SUIT_COLORS.s)
    expect(suitColor('')).toBe(SUIT_COLORS.s)
  })
})
