import { readReplayLedger, sanitizeReplayDetail } from './protocol'

/** 実測した `/replay/list` 応答の形（2026-08-01）。 */
const LIST_RESPONSE = {
  session: 'secret',
  result: 0,
  status: 0,
  date: 1785554587,
  dataVer: '2_06_0_test',
  appVer: '2.06',
  masterVer: 'master-test',
  trace: '',
  emsg: '',
  behavior: '0',
  message: '',
  param: {
    HandList: [
      {
        Hand: {
          HandId: 533933335,
          BattleType: 0,
          Name: 'text_rank_room_name_legend',
          StartTime: 1785500000,
          HoleCardList: [40, 41],
          CommunityCardList: [39, 17, 11, 44, 24],
          ChipDiff: -6436
        },
        IsFavorite: false
      }
    ],
    CardOpenEndDate: 0,
    IsExpiredCardOpen: false,
    Limit: 100,
    FavoriteCount: 100,
    BattleType: 0
  }
}

describe('readReplayLedger', () => {
  test('台帳に必要な項目だけを取り出す', () => {
    expect(readReplayLedger(LIST_RESPONSE)).toEqual({
      battleType: 0,
      cardOpenEndDate: 0,
      isExpiredCardOpen: false,
      hands: [{ handId: 533933335, startTime: 1785500000, chipDiff: -6436 }]
    })
  })

  // 除外リストではなく許可リストで組み立てているので、応答の全フィールドを
  // 列挙できていなくても未知のフィールドが拡張側へ渡ることが起こらない。
  test('許可リストに無いフィールドは資格情報も含めて一切通さない', () => {
    const ledger = readReplayLedger({
      ...LIST_RESPONSE,
      requestKey: 'uuid',
      param: { ...LIST_RESPONSE.param, UnknownFutureField: { session: 'leak' } }
    })
    const serialized = JSON.stringify(ledger)
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('uuid')
    expect(serialized).not.toContain('leak')
    expect(serialized).not.toContain('UnknownFutureField')
  })

  test('課金状態のフィールドを読む', () => {
    const ledger = readReplayLedger({
      param: { HandList: [], CardOpenEndDate: 1786000000, IsExpiredCardOpen: true, BattleType: 4 }
    })
    expect(ledger).toEqual({
      battleType: 4,
      cardOpenEndDate: 1786000000,
      isExpiredCardOpen: true,
      hands: []
    })
  })

  test('壊れた行は落とすが、残りの行と台帳自体は保つ', () => {
    const ledger = readReplayLedger({
      param: {
        HandList: [
          { Hand: { HandId: 1, StartTime: 10, ChipDiff: 5 } },
          { Hand: { HandId: -1, StartTime: 10, ChipDiff: 5 } },
          { Hand: { HandId: 2, StartTime: 'x', ChipDiff: 5 } },
          { NoHand: true },
          null
        ]
      }
    })
    expect(ledger?.hands).toEqual([{ handId: 1, startTime: 10, chipDiff: 5 }])
  })

  test('台帳でない応答はundefinedを返す', () => {
    expect(readReplayLedger({ param: { CardOpenEndDate: 0 } })).toBeUndefined()
    expect(readReplayLedger({ result: 1, status: 2302 })).toBeUndefined()
    expect(readReplayLedger(null)).toBeUndefined()
  })
})

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
