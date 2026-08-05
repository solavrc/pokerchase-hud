import { EntityConverter } from '../entity-converter'
import { ActionType, PhaseType } from '../types'
import {
  orderApiEventsForReplay,
  type RawApiEvent
} from './api-event-key'

const COLLISION_TIMESTAMP = 1_758_881_253_530

const makeCollisionHand = (): RawApiEvent[] => [
  {
    timestamp: COLLISION_TIMESTAMP - 20,
    ApiTypeId: 303,
    SeatUserIds: [1, 2],
    Game: { SmallBlind: 100, BigBlind: 200, ButtonSeat: 1, SmallBlindSeat: 0, BigBlindSeat: 1 },
    Progress: { Phase: 0, Pot: 300 },
    Player: { SeatIndex: 0, BetStatus: 1, HoleCards: [1, 2], Chip: 10_000, BetChip: 100 },
    OtherPlayers: [{ SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 9_800, BetChip: 200 }]
  },
  {
    timestamp: COLLISION_TIMESTAMP - 10,
    ApiTypeId: 305,
    CommunityCards: [3, 4, 5],
    Progress: { Phase: 1, Pot: 4_179, NextActionSeat: 0 },
    Player: { SeatIndex: 0, BetStatus: 1, HoleCards: [1, 2], Chip: 10_000, BetChip: 0 },
    OtherPlayers: [{ SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 9_800, BetChip: 0 }]
  },
  // Legacy raw export placed 304 before 305 at an equal timestamp because it
  // paginated by [timestamp+ApiTypeId]. The payload is the first TURN action.
  {
    timestamp: COLLISION_TIMESTAMP,
    ApiTypeId: 304,
    SeatIndex: 0,
    ActionType: ActionType.BET,
    BetChip: 1_379,
    Chip: 8_621,
    Progress: { Phase: 2, Pot: 5_558 }
  },
  {
    timestamp: COLLISION_TIMESTAMP,
    ApiTypeId: 305,
    CommunityCards: [6],
    Progress: { Phase: 2, Pot: 4_179, NextActionSeat: 0 },
    Player: { SeatIndex: 1, BetStatus: 1, HoleCards: [1, 2], Chip: 9_800, BetChip: 0 },
    OtherPlayers: [{ SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 10_000, BetChip: 0 }]
  },
  {
    timestamp: COLLISION_TIMESTAMP + 10,
    ApiTypeId: 306,
    HandId: 418_790_443,
    CommunityCards: [3, 4, 5, 6],
    Pot: 5_558,
    SidePot: [],
    ResultType: 0,
    DefeatStatus: 0,
    Results: [{ UserId: 1, HoleCards: [1, 2], RankType: 10, Hands: [], HandRanking: 1, Ranking: -2, RewardChip: 5_558 }],
    Player: { SeatIndex: 0, BetStatus: -1, Chip: 15_558, BetChip: 0 },
    OtherPlayers: [{ SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 4_242, BetChip: 0 }]
  }
]

const convert = (events: RawApiEvent[]) => new EntityConverter({
  id: undefined,
  battleType: undefined,
  name: undefined,
  players: new Map(),
  reset: () => {}
}).convertEventsToEntities(events as any)

describe('raw event replay order', () => {
  test('repairs the observed legacy 304/305 collision and keeps the TURN bet on TURN', () => {
    const primaryOrder = makeCollisionHand()
    // ストリート帰属は保存順に依存しない（#340）。この 304 は 305 より前に
    // 保存されているが、自身の Progress.Phase がTURNを指しているため、
    // 並び替え前でもTURNへ帰属する。並び替えはボード（communityCards）と
    // フェーズレコードの生成順を正すために引き続き必要である。
    const primaryAction = convert(primaryOrder).actions.find(action => action.actionType === ActionType.BET)
    expect(primaryAction?.phase).toBe(PhaseType.TURN)

    const replayOrder = orderApiEventsForReplay(primaryOrder)
    expect(replayOrder.filter(event => event.timestamp === COLLISION_TIMESTAMP).map(event => event.ApiTypeId))
      .toEqual([305, 304])

    const replayAction = convert(replayOrder).actions.find(action => action.actionType === ActionType.BET)
    expect(replayAction?.phase).toBe(PhaseType.TURN)
  })

  test('orders an exact EVT_PLAYER_SEAT_ASSIGNED snapshot before its next action', () => {
    const events: RawApiEvent[] = [
      {
        timestamp: 200,
        ApiTypeId: 304,
        SeatIndex: 4,
        ActionType: ActionType.RAISE,
        BetChip: 2_338,
        Chip: 2_980,
        Progress: { Phase: 3, Pot: 4_951 }
      },
      {
        timestamp: 200,
        ApiTypeId: 313,
        ProcessType: 2,
        Progress: { Phase: 3, Pot: 2_613, NextActionSeat: 4 },
        OtherPlayers: [{ SeatIndex: 4, BetChip: 0, Chip: 5_318 }]
      }
    ]

    expect(orderApiEventsForReplay(events).map(event => event.ApiTypeId)).toEqual([313, 304])
  })

  test('keeps canonical order when snapshot state does not prove causality', () => {
    const events = makeCollisionHand().filter(event => event.timestamp === COLLISION_TIMESTAMP)
    const round = events.find(event => event.ApiTypeId === 305)!
    const otherPlayers = round.OtherPlayers as Array<Record<string, unknown>>
    otherPlayers[0] = { ...otherPlayers[0], Chip: 9_999 }

    expect(orderApiEventsForReplay(events).map(event => event.ApiTypeId)).toEqual([304, 305])
  })

  test('keeps state-independent session details and player roster in canonical order', () => {
    const events: RawApiEvent[] = [
      { timestamp: 300, ApiTypeId: 313, ProcessType: 0 },
      { timestamp: 300, ApiTypeId: 308, Name: 'table' }
    ]

    expect(orderApiEventsForReplay(events).map(event => event.ApiTypeId)).toEqual([308, 313])
  })

  test('fails closed for a compound lifecycle collision without prior state', () => {
    const events: RawApiEvent[] = [
      { timestamp: 400, ApiTypeId: 309, Ranking: 1 },
      { timestamp: 400, ApiTypeId: 308, Name: 'table' },
      { timestamp: 400, ApiTypeId: 306, HandId: 1 },
      { timestamp: 400, ApiTypeId: 201, Id: 'room', BattleType: 0 }
    ]

    // An active old hand would require 306→309→201→308, while an MTT table move
    // can legitimately interleave 201 with a hand. The isolated group cannot
    // distinguish those histories, so the resolver must not invent an edge.
    expect(orderApiEventsForReplay(events).map(event => event.ApiTypeId)).toEqual([201, 306, 308, 309])
  })

  test('keeps a proven local pair canonical when a lifecycle event shares the timestamp', () => {
    const events = [
      ...makeCollisionHand().filter(event => event.timestamp === COLLISION_TIMESTAMP),
      { timestamp: COLLISION_TIMESTAMP, ApiTypeId: 306, HandId: 1 }
    ]

    expect(orderApiEventsForReplay(events).map(event => event.ApiTypeId)).toEqual([304, 305, 306])
  })

  test('replays EVT_HAND_RESULTS before an EVT_DEAL that shares its millisecond', () => {
    const events: RawApiEvent[] = [
      { timestamp: 500, ApiTypeId: 303, HandStart: true },
      { timestamp: 500, ApiTypeId: 306, HandId: 1 }
    ]

    // 主キーは 303 < 306 なので保存順では配札が先に来るが、1ミリ秒で配札から
    // 決着までが完結することはあり得ないため、この 306 は必ず前のハンドの終了行。
    expect(orderApiEventsForReplay(events).map(event => event.ApiTypeId)).toEqual([306, 303])
  })

  test('hoists EVT_HAND_RESULTS out of a compound group that also opens the next hand', () => {
    const events: RawApiEvent[] = [
      { timestamp: 500, ApiTypeId: 304, SeatIndex: 2 },
      { timestamp: 500, ApiTypeId: 303, HandStart: true },
      { timestamp: 500, ApiTypeId: 306, HandId: 1 }
    ]

    expect(orderApiEventsForReplay(events).map(event => event.ApiTypeId)).toEqual([306, 303, 304])
  })

  test('leaves an EVT_HAND_RESULTS group without an EVT_DEAL in canonical order', () => {
    // 実キャプチャで最も多い同一ミリ秒群（306+311 / 306+309 / 306+313）は
    // ハンド境界をまたがないため、一切触らない。
    const events: RawApiEvent[] = [
      { timestamp: 600, ApiTypeId: 306, HandId: 1 },
      { timestamp: 600, ApiTypeId: 311, Ranking: 1 }
    ]

    expect(orderApiEventsForReplay(events).map(event => event.ApiTypeId)).toEqual([306, 311])
  })

  test('an equal-millisecond hand boundary keeps both hands intact end to end', () => {
    const first = makeCollisionHand()
    const boundary = COLLISION_TIMESTAMP + 10 // makeCollisionHand()の EVT_HAND_RESULTS と同一ms
    const second = makeCollisionHand().map(event => ({
      ...event,
      timestamp: event.ApiTypeId === 303 ? boundary : event.timestamp + 100,
      ...(event.ApiTypeId === 306 ? { HandId: 418_790_444 } : {})
    }))

    const wireOrder = [...first, ...second]
    const replayOrder = orderApiEventsForReplay(wireOrder)

    expect(convert(replayOrder).hands.map(hand => hand.id))
      .toEqual(convert(wireOrder).hands.map(hand => hand.id))
    expect(convert(replayOrder).hands.map(hand => hand.id)).toEqual([418_790_443, 418_790_444])
    expect(convert(replayOrder).actions).toHaveLength(convert(wireOrder).actions.length)
  })
})
