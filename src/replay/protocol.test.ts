import {
  REPLAY_FETCH_BATCH_LIMIT,
  REPLAY_FETCH_INTERVAL_MS,
  REPLAY_FETCH_TIMEOUT_MS,
  readReplayLedger,
  replayFetchBatchTimeoutMs,
  sanitizeReplayDetail
} from './protocol'

// Codexレビュー指摘: ページ側は2件目以降の各リクエスト前に必ず間隔を空ける
// ので、依頼元の上限が固定値だと件数が増えた瞬間に**必ず**先に切れる。
// しかもページ側はバッチ完了時に一括で返すため、切れた場合に得られるのは
// 部分結果ではなく空配列になる。
describe('replayFetchBatchTimeoutMs', () => {
  test('ページ側が要しうる最長時間より必ず長い', () => {
    for (const count of [1, 2, 50, REPLAY_FETCH_BATCH_LIMIT]) {
      // 1件あたり最大 REPLAY_FETCH_TIMEOUT_MS、2件目以降は毎回間隔待ち
      const worstCasePageTime =
        count * REPLAY_FETCH_TIMEOUT_MS + Math.max(0, count - 1) * REPLAY_FETCH_INTERVAL_MS
      expect(replayFetchBatchTimeoutMs(count)).toBeGreaterThan(worstCasePageTime)
    }
  })

  test('上限100件でも固定120秒より長い（旧実装は必ず先に切れていた）', () => {
    expect(replayFetchBatchTimeoutMs(REPLAY_FETCH_BATCH_LIMIT)).toBeGreaterThan(120_000)
  })
})

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

  test('エンベロープ側のフィールドを読む', () => {
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
