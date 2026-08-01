/**
 * 合成イベント（ApiTypeId 90001 = `ApiType.REPLAY_HAND_DETAIL`）の**不可視性**
 * を固定する。
 *
 * この行は保存・同期・エクスポート／インポートの経路には**載る**（Raw Event
 * Lakeのアプリケーションイベントとして扱うことで、既存の輸送経路が無改修で
 * 運ぶ）。一方で対局イベントではないので、派生エンティティと統計からは
 * **一切見えてはならない**（MUST NOT）。
 *
 * 「switchのdefault落ちで自然に無視される」は実装の性質であって保証ではない。
 * 将来 `default:` が足されたり、イベント数を数える処理が入ったりしたときに
 * 気付けるよう、ここで振る舞いとして固定する。
 */
import { EntityConverter } from '../entity-converter'
import { ApiType, isApplicationApiEvent, parseApiEvent } from '../types/api'
import type { ApiEvent, Session } from '../types'
import { orderAndFilterApplicationEventsForReplay } from '../utils/database-utils'

const sessionOf = (): Session => ({
  id: undefined,
  battleType: undefined,
  name: undefined,
  players: new Map(),
  reset: () => undefined
})

const HERO = 561384657
const VILLAIN = 619317634

/** 最小のハンド1つぶん（DEAL → ACTION → RESULTS）。 */
const handEvents = (): any[] => [
  {
    ApiTypeId: ApiType.EVT_DEAL,
    timestamp: 1000,
    SeatUserIds: [HERO, VILLAIN, -1, -1, -1, -1],
    Game: {
      CurrentBlindLv: 1, NextBlindUnixSeconds: -1, Ante: 0,
      SmallBlind: 100, BigBlind: 200, ButtonSeat: 0, SmallBlindSeat: 0, BigBlindSeat: 1
    },
    Player: { SeatIndex: 0, BetStatus: 1, HoleCards: [37, 51], Chip: 19900, BetChip: 100 },
    OtherPlayers: [{ SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 19800, BetChip: 200 }],
    Progress: {
      Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 3, 4, 5],
      NextExtraLimitSeconds: 1, MinRaise: 400, Pot: 300, SidePot: []
    }
  },
  {
    ApiTypeId: ApiType.EVT_ACTION,
    timestamp: 1100,
    SeatIndex: 0,
    ActionType: 2,
    Chip: 19900,
    BetChip: 100,
    Progress: {
      Phase: 0, NextActionSeat: 1, NextActionTypes: [0],
      NextExtraLimitSeconds: 1, MinRaise: 0, Pot: 300, SidePot: []
    }
  },
  {
    ApiTypeId: ApiType.EVT_HAND_RESULTS,
    timestamp: 1200,
    CommunityCards: [],
    Pot: 300,
    SidePot: [],
    ResultType: 0,
    DefeatStatus: 0,
    HandId: 424242,
    Results: [
      { UserId: VILLAIN, HoleCards: [], RankType: 10, Hands: [], HandRanking: -1, Ranking: -2, RewardChip: 300 }
    ],
    Player: { SeatIndex: 0, BetStatus: -1, Chip: 19900, BetChip: 0 },
    OtherPlayers: [{ SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 20000, BetChip: 0 }]
  }
]

/** リプレイ詳細の合成イベント。ハンドの合間に差し込まれる。 */
const replayDetailEvent = (handId: number, timestamp: number) => ({
  ApiTypeId: ApiType.REPLAY_HAND_DETAIL,
  timestamp,
  HandId: handId,
  payload: {
    Game: { PlayerNum: 6, CommunityCardList: [39, 17, 11, 44, 24] },
    Player: { SeatIndex: 0, UserId: HERO, HoleCardList: [37, 51] },
    OtherPlayerList: [{ SeatIndex: 1, UserId: VILLAIN, HoleCardList: [1, 0] }]
  },
  fetchedAt: timestamp,
  clientMeta: { appVer: '2.06', dataVer: '2_06_0_test', masterVer: 'master-test' }
})

describe('合成イベント 90001 の不可視性', () => {
  test('スキーマ検証を通り、アプリケーションイベントとして扱われる（＝保存・同期の対象）', () => {
    const event = replayDetailEvent(424242, 1300)
    expect(parseApiEvent(event as any)).not.toBeNull()
    expect(isApplicationApiEvent(event)).toBe(true)
  })

  test('payloadの中身は検証しない（運営コンテンツのメタルール）', () => {
    // 未知のキー・想定外の型が来ても弾かない。弾くと保存経路から落ちる。
    const event = {
      ...replayDetailEvent(424243, 1400),
      payload: { UnknownFutureField: [1, 2, 3], Nested: { Whatever: 'x' } }
    }
    expect(isApplicationApiEvent(event)).toBe(true)
  })

  test('EntityConverter は 90001 を無視し、生成物が完全に一致する', () => {
    const withoutDetail = new EntityConverter(sessionOf())
      .convertEventsToEntities(handEvents() as ApiEvent[])
    const withDetail = new EntityConverter(sessionOf())
      .convertEventsToEntities([
        ...handEvents(),
        replayDetailEvent(424242, 1300)
      ] as ApiEvent[])

    expect(withDetail).toEqual(withoutDetail)
    expect(withDetail.hands).toHaveLength(1)
  })

  test('ハンドの途中に挟まっても、ハンド境界を壊さない', () => {
    const events = handEvents()
    const interleaved = [
      events[0],
      replayDetailEvent(999999, 1050),
      events[1],
      events[2]
    ]
    const withDetail = new EntityConverter(sessionOf())
      .convertEventsToEntities(interleaved as ApiEvent[])
    const withoutDetail = new EntityConverter(sessionOf())
      .convertEventsToEntities(handEvents() as ApiEvent[])

    expect(withDetail).toEqual(withoutDetail)
  })

  /**
   * `verify-stats` と再構築は `orderAndFilterApplicationEventsForReplay` を
   * 通してから `EntityConverter` へ渡す。90001 はここを**通過する**（保存・
   * 同期の対象なので当然）が、その先で無視されるため統計は変わらない。
   */
  test('リプレイ整列フィルタを通過し、その先の派生は変わらない', async () => {
    const raw = [...handEvents(), replayDetailEvent(424242, 1300)]
    const filtered = await orderAndFilterApplicationEventsForReplay(raw as any)
    expect(filtered.some(event => event.ApiTypeId === ApiType.REPLAY_HAND_DETAIL)).toBe(true)

    const fromFiltered = new EntityConverter(sessionOf())
      .convertEventsToEntities(filtered as ApiEvent[])
    const baseline = new EntityConverter(sessionOf())
      .convertEventsToEntities(handEvents() as ApiEvent[])
    expect(fromFiltered).toEqual(baseline)
  })
})
