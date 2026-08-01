import { sanitizeReplayDetail } from './protocol'

describe('sanitizeReplayDetail', () => {
  test('removes transport credentials recursively without changing replay data', () => {
    expect(sanitizeReplayDetail({
      Code: 0,
      session: 'secret',
      param: { HandId: 123, requestKey: 'uuid' },
      Replay: { Players: [{ UserId: 1, HoleCardList: [10, 20] }] }
    })).toEqual({
      Code: 0,
      param: { HandId: 123 },
      Replay: { Players: [{ UserId: 1, HoleCardList: [10, 20] }] }
    })
  })
})
