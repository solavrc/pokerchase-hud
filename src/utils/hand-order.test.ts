import { compareHandsNewestFirst } from './hand-order'

describe('compareHandsNewestFirst', () => {
  test('uses receive timestamps when MTT HandIds locally invert', () => {
    const hands = [
      { id: 288331102, approxTimestamp: 1000 },
      { id: 288331101, approxTimestamp: 2000 },
      { id: 288331638, approxTimestamp: 3000 }
    ]

    expect(hands.sort(compareHandsNewestFirst).map(hand => hand.id)).toEqual([
      288331638,
      288331101,
      288331102
    ])
  })

  test('keeps deterministic HandId fallback for legacy records without timestamps', () => {
    const hands = [{ id: 8 }, { id: 10 }, { id: 9 }]
    expect(hands.sort(compareHandsNewestFirst).map(hand => hand.id)).toEqual([10, 9, 8])
  })

  test('places current timestamped records before legacy records', () => {
    const hands = [
      { id: 999999999 },
      { id: 1, approxTimestamp: 1000 }
    ]
    expect(hands.sort(compareHandsNewestFirst).map(hand => hand.id)).toEqual([1, 999999999])
  })
})
