import { ApiType, BattleType } from '../types'
import type { EntityBundle } from '../entity-converter'
import type { Session } from '../types'
import { RawEntityReplay } from './raw-entity-replay'

const HERO_ID = 4
const LINEUP = [2, HERO_ID, 3, 1]

const EMPTY_SESSION: Session = {
  id: undefined,
  battleType: undefined,
  name: undefined,
  players: new Map(),
  reset: () => {},
}

const makeEntry = (
  timestamp: number,
  battleType: BattleType,
  id: string
) => ({
  ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
  Code: 0,
  BattleType: battleType,
  Id: id,
  IsRetire: false,
  timestamp,
})

const makeDeal = (timestamp: number) => ({
  ApiTypeId: ApiType.EVT_DEAL,
  SeatUserIds: LINEUP,
  Game: {
    CurrentBlindLv: 1,
    NextBlindUnixSeconds: -1,
    Ante: 0,
    SmallBlind: 100,
    BigBlind: 200,
    ButtonSeat: 3,
    SmallBlindSeat: 0,
    BigBlindSeat: 1,
  },
  Player: {
    SeatIndex: 1,
    BetStatus: 1,
    HoleCards: [5, 21],
    Chip: 5750,
    BetChip: 200,
  },
  OtherPlayers: [
    { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 5850, BetChip: 100 },
    { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 5950, BetChip: 0 },
    { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 5950, BetChip: 0 },
  ],
  Progress: {
    Phase: 0,
    NextActionSeat: 2,
    NextActionTypes: [2, 3, 4, 5],
    NextExtraLimitSeconds: 1,
    MinRaise: 400,
    Pot: 500,
    SidePot: [],
  },
  timestamp,
})

const makeResult = (timestamp: number, handId: number) => ({
  ApiTypeId: ApiType.EVT_HAND_RESULTS,
  CommunityCards: [],
  Pot: 500,
  SidePot: [],
  ResultType: 0,
  DefeatStatus: 0,
  HandId: handId,
  HandLog: '',
  Results: [{
    UserId: HERO_ID,
    HoleCards: [],
    RankType: 10,
    Hands: [],
    HandRanking: 1,
    Ranking: -2,
    RewardChip: 500,
  }],
  Player: {
    SeatIndex: 1,
    BetStatus: -1,
    Chip: 6250,
    BetChip: 0,
  },
  OtherPlayers: [
    { SeatIndex: 0, Status: 0, BetStatus: -1, Chip: 5850, BetChip: 0 },
    { SeatIndex: 2, Status: 0, BetStatus: -1, Chip: 5950, BetChip: 0 },
    { SeatIndex: 3, Status: 0, BetStatus: -1, Chip: 5950, BetChip: 0 },
  ],
  timestamp,
})

const append = (target: EntityBundle, source: EntityBundle): void => {
  target.hands.push(...source.hands)
  target.phases.push(...source.phases)
  target.actions.push(...source.actions)
}

describe('RawEntityReplay', () => {
  test('recovers a parse-failed successful entry before deriving its hand', () => {
    const replay = new RawEntityReplay(EMPTY_SESSION)
    const rawEntry = makeEntry(100, BattleType.RING_GAME, 'raw-ring')
    delete (rawEntry as { IsRetire?: boolean }).IsRetire

    const result = replay.convertEvents([
      rawEntry,
      makeDeal(110),
      makeResult(120, 1),
    ])

    expect(result.hands[0]?.session).toEqual({
      id: 'raw-ring',
      battleType: BattleType.RING_GAME,
      name: undefined,
    })
  })

  test('clears a cancelled entry before deriving a later hand', () => {
    const replay = new RawEntityReplay(EMPTY_SESSION)
    const result = replay.convertEvents([
      makeEntry(200, BattleType.SIT_AND_GO, 'cancelled-sng'),
      { ApiTypeId: 203, Code: 0, timestamp: 210 },
      makeDeal(220),
      makeResult(230, 2),
    ])

    expect(result.hands[0]?.session).toEqual({
      id: undefined,
      battleType: undefined,
      name: undefined,
    })
  })

  test('keeps a non-Friend terminal reset across replay chunks', () => {
    const replay = new RawEntityReplay(EMPTY_SESSION)
    const result: EntityBundle = { hands: [], phases: [], actions: [] }
    append(result, replay.convertChunk([
      makeEntry(300, BattleType.SIT_AND_GO, 'ended-sng'),
      makeDeal(310),
      makeResult(320, 3),
      { ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 330 },
    ]))
    append(result, replay.convertChunk([
      makeDeal(340),
      makeResult(350, 4),
    ]))
    append(result, replay.flush())

    expect(result.hands.map(hand => hand.session.battleType)).toEqual([
      BattleType.SIT_AND_GO,
      undefined,
    ])
    expect(replay.snapshot().replayEnded).toBe(true)
  })

  test('restores a provisional Friend SNG across replay chunks on a seated deal', () => {
    const replay = new RawEntityReplay(EMPTY_SESSION)
    const result: EntityBundle = { hands: [], phases: [], actions: [] }
    append(result, replay.convertChunk([
      makeEntry(400, BattleType.FRIEND_SIT_AND_GO, 'friend-sng'),
      makeDeal(410),
      makeResult(420, 5),
      { ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 430 },
    ]))
    append(result, replay.convertChunk([
      makeDeal(440),
      makeResult(450, 6),
    ]))
    append(result, replay.flush())

    expect(result.hands.map(hand => hand.session.battleType)).toEqual([
      BattleType.FRIEND_SIT_AND_GO,
      BattleType.FRIEND_SIT_AND_GO,
    ])
    expect(replay.snapshot().replayEnded).toBe(false)
  })

  test('classifies a spectator deal after Friend SNG terminal as empty before a later seated continuation', () => {
    const replay = new RawEntityReplay(EMPTY_SESSION)
    const spectatorDeal = {
      ...makeDeal(460),
      Player: undefined,
    }
    const result = replay.convertEvents([
      makeEntry(400, BattleType.FRIEND_SIT_AND_GO, 'friend-sng'),
      { ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 450 },
      spectatorDeal,
      makeResult(470, 8),
      makeDeal(480),
      makeResult(490, 9),
    ])

    expect(result.hands.map(hand => hand.session.battleType)).toEqual([
      undefined,
      BattleType.FRIEND_SIT_AND_GO,
    ])
    expect(replay.snapshot().replayEnded).toBe(false)
  })

  test('does not let an explicit failed entry replace the active category', () => {
    const replay = new RawEntityReplay(EMPTY_SESSION)
    const result = replay.convertEvents([
      makeEntry(500, BattleType.RING_GAME, 'active-ring'),
      {
        ...makeEntry(510, BattleType.SIT_AND_GO, 'rejected-sng'),
        Code: 5205,
      },
      makeDeal(520),
      makeResult(530, 7),
    ])

    expect(result.hands[0]?.session.battleType).toBe(BattleType.RING_GAME)
  })
})
