import { formatCardsArray } from './card-utils'

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