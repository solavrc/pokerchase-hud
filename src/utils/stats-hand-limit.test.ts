import {
  MAX_STATS_LATEST_HANDS,
  normalizeStatsLatestHands,
  STATS_LATEST_HAND_OPTIONS,
} from './stats-hand-limit'

describe('stats hand-limit contract', () => {
  test.each([
    [0.5, undefined],
    [10, undefined],
    [300, undefined],
    [20, 20],
    [50, 50],
    [100, 100],
    [200, 200],
    [500, 500],
    [501, 500],
    [1_000, 500],
    [0, undefined],
    [-1, undefined],
    [Number.NaN, undefined],
    [Number.POSITIVE_INFINITY, undefined],
    [null, undefined],
    [undefined, undefined],
    ['500', undefined],
  ])('normalizeStatsLatestHands(%p) -> %p', (input, expected) => {
    expect(normalizeStatsLatestHands(input)).toBe(expected)
  })

  test('Popupの最大選択肢と永続寄与window上限が一致する', () => {
    expect(STATS_LATEST_HAND_OPTIONS.at(-1)).toBe(MAX_STATS_LATEST_HANDS)
  })
})
