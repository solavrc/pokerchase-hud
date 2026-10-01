import { RealTimeStatsStream } from './realtime-stats-stream'
import { ActionType, ApiType, BetStatusType, PhaseType } from '../types'
import type { ApiEvent } from '../types'
import type { AllPlayersRealTimeStats } from '../realtime-stats/realtime-stats-service'
import type { HandImprovementResult } from '../realtime-stats/hand-improvement'

type ActionSeat = ApiEvent<ApiType.EVT_ACTION>['Progress']['NextActionSeat']
type RoundPhase = ApiEvent<ApiType.EVT_DEAL_ROUND>['Progress']['Phase']

const progress = <P extends PhaseType>(phase: P, pot = 100, nextActionSeat: ActionSeat = 0) => ({
  Phase: phase, Pot: pot, SidePot: [], NextActionSeat: nextActionSeat,
  NextActionTypes: [ActionType.CHECK, ActionType.BET, ActionType.FOLD, ActionType.CALL, ActionType.RAISE, ActionType.ALL_IN],
  NextExtraLimitSeconds: 30, MinRaise: 20
})

const deal = (): ApiEvent<ApiType.EVT_DEAL> => ({
  ApiTypeId: ApiType.EVT_DEAL, timestamp: 100,
  SeatUserIds: [101, 102, 103, -1, -1, -1],
  Player: { SeatIndex: 0, BetStatus: BetStatusType.BET_ABLE, HoleCards: [48, 49], Chip: 1000, BetChip: 10 },
  OtherPlayers: [
    { SeatIndex: 1, Status: 0, BetStatus: BetStatusType.BET_ABLE, Chip: 1000, BetChip: 20 },
    { SeatIndex: 2, Status: 0, BetStatus: BetStatusType.BET_ABLE, Chip: 1000, BetChip: 0 }
  ],
  Game: {
    CurrentBlindLv: 1, NextBlindUnixSeconds: 0, Ante: 0,
    SmallBlind: 10, BigBlind: 20, ButtonSeat: 2, SmallBlindSeat: 0, BigBlindSeat: 1
  },
  Progress: { ...progress(PhaseType.PREFLOP, 30), NextActionSeat: 0 }
})

const round = (phase: RoundPhase, cards: number[]): ApiEvent<ApiType.EVT_DEAL_ROUND> => ({
  ApiTypeId: ApiType.EVT_DEAL_ROUND, timestamp: 500, CommunityCards: cards,
  Player: { SeatIndex: 0, BetStatus: BetStatusType.BET_ABLE, HoleCards: [48, 49], Chip: 1000, BetChip: 0 },
  OtherPlayers: [{ SeatIndex: 1, Status: 0, BetStatus: BetStatusType.BET_ABLE, Chip: 1000, BetChip: 0 }],
  Progress: { ...progress(phase), MinRaise: 0, NextActionSeat: 0 }
})

const action = (phase: PhaseType, amount = 100, next: ActionSeat = 0): ApiEvent<ApiType.EVT_ACTION> => ({
  ApiTypeId: ApiType.EVT_ACTION, timestamp: 500, SeatIndex: 1,
  ActionType: ActionType.BET, Chip: 1000 - amount, BetChip: amount,
  Progress: progress(phase, 100 + amount, next)
})

describe('リアルタイム統計のレビュー回帰', () => {
  let stream: RealTimeStatsStream
  let outputs: AllPlayersRealTimeStats[]
  let errors: unknown[]

  beforeEach(() => {
    stream = new RealTimeStatsStream()
    outputs = []
    errors = []
    stream.on('data', output => outputs.push(output.stats))
    stream.on('error', error => errors.push(error))
  })

  afterEach(() => stream.reset())

  const send = async (...events: ApiEvent[]) => {
    events.forEach(event => stream.write(event))
    await stream.whenIdle()
    expect(errors).toEqual([])
    expect(outputs.length).toBeGreaterThan(0)
    return outputs[outputs.length - 1]!
  }

  test('リバーACTIONが先行してもカード到着まで確定役を表示しない', async () => {
    await send(deal(), round(PhaseType.FLOP, [0, 5, 10]), round(PhaseType.TURN, [15]))
    const pending = await send(action(PhaseType.RIVER))
    expect(pending.heroStats.currentPhase).toBe('River')
    expect(pending.heroStats.communityCards).toEqual([0, 5, 10, 15])
    expect(pending.heroStats.handImprovement).toBeUndefined()

    const completed = await send(round(PhaseType.RIVER, [20]))
    expect(completed.heroStats.communityCards).toEqual([0, 5, 10, 15, 20])
    expect(completed.heroStats.handImprovement).toBeDefined()
    // 遅着したROUNDの古いPot・BetChipで、既に適用したベットを消さない。
    expect(completed.heroStats.potOdds?.value).toMatchObject({ call: 100, pot: 300 })
    expect(completed.playerStats[1]?.spr).toBe(4.5)
  })

  test('複数streetのACTION後にROUNDが並んでも盤面を累積する', async () => {
    // 人工入力による回帰テスト。実際の通信到着順を主張するfixtureではない。
    const latest = await send(
      deal(), action(PhaseType.FLOP), action(PhaseType.TURN, 200), action(PhaseType.RIVER, 300),
      round(PhaseType.FLOP, [0, 5, 10]), round(PhaseType.TURN, [15]), round(PhaseType.RIVER, [20])
    )
    expect(latest.heroStats.currentPhase).toBe('River')
    expect(latest.heroStats.communityCards).toEqual([0, 5, 10, 15, 20])
    expect(latest.heroStats.potOdds?.value).toMatchObject({ call: 300, pot: 700 })
    const result = latest.heroStats.handImprovement?.value as unknown as HandImprovementResult
    expect(result.improvements.filter(row => row.probability === 100)).toHaveLength(1)
  })

  test('終了行のPhase=3をリバー到達と誤認しない', async () => {
    await send(deal(), round(PhaseType.FLOP, [0, 5, 10]))
    const latest = await send({ ...action(PhaseType.RIVER, 0, -2), ActionType: ActionType.FOLD })
    expect(latest.heroStats.currentPhase).toBe('Flop')
    expect(latest.heroStats.communityCards).toEqual([0, 5, 10])
    expect(latest.heroStats.handImprovement).toBeDefined()
    const result = latest.heroStats.handImprovement?.value as unknown as HandImprovementResult
    expect(result.improvements.some(row => row.probability === 100)).toBe(false)
  })

  test('遅着snapshotは未行動席を補完し、既行動席のチップを保持する', async () => {
    const latest = await send(deal(), action(PhaseType.FLOP), round(PhaseType.FLOP, [0, 5, 10]))
    expect(latest.heroStats.potOdds?.value).toMatchObject({ call: 100, pot: 300 })
    expect(latest.playerStats[1]?.spr).toBe(4.5)
    // 省略された席はtimeout FOLDの可能性があるため行動可能のまま残さない。
    expect(latest.playerStats[2]?.potOdds?.call).toBe(0)
  })

  test('通常の次streetでは前streetのベット額をリセットする', async () => {
    const latest = await send(
      deal(), round(PhaseType.FLOP, [0, 5, 10]), action(PhaseType.FLOP), round(PhaseType.TURN, [15])
    )
    expect(latest.heroStats.currentPhase).toBe('Turn')
    expect(latest.heroStats.potOdds?.value).toMatchObject({ call: 0 })
  })

  test('新しいDEALで前ハンドの未連結カードを再利用しない', async () => {
    await send(deal(), round(PhaseType.RIVER, [20]))
    const latest = await send(deal(), round(PhaseType.TURN, [15]))
    expect(latest.heroStats.communityCards).toEqual([])
    expect(latest.heroStats.handImprovement).toBeUndefined()
  })
})
