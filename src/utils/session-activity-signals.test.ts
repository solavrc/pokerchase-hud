import {
  isConfirmedEntryCancellation,
  isExplicitEntryFailure
} from './session-activity-signals'

describe('session activity signals', () => {
  test.each([
    [{ Code: 1 }, true],
    [{ Code: 5003 }, true],
    [{ Code: 0 }, false],
    [{}, false],
    [null, false]
  ])('classifies an explicit entry failure from %p', (response, expected) => {
    expect(isExplicitEntryFailure(response)).toBe(expected)
  })

  test.each([
    [{ Code: 0 }, true],
    [{ Code: 5003 }, false],
    [{}, false],
    [null, false]
  ])('confirms only a successful entry cancellation from %p', (response, expected) => {
    expect(isConfirmedEntryCancellation(response)).toBe(expected)
  })
})
