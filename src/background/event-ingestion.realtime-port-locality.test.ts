import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB, type ApiEvent } from '../app'
import { trackServiceForTeardown } from '../utils/test-service-teardown'
import { ActionType, ApiType, PhaseType } from '../types'
import { registerEventIngestion } from './event-ingestion'
import {
  connectedPorts,
  getLastKnownStats,
  getLiveBroadcastSequenceForTab,
  claimActivePortForGameEvent,
  registerStreamSubscriptions,
  setLastKnownStats,
  writeConnectedStatsUpdate
} from './ports'
import {
  __resetActivePortStateForTests,
  getActivePort,
  resolveGeneration
} from './active-port'
import { POKER_CHASE_SESSION_START_EVENT } from '../constants/runtime'
import { REPLAY_PORT_CANCEL } from '../replay/protocol'
import * as apiEventKey from '../utils/api-event-key'
import {
  __resetStatsOutputContextForTests,
  setStatsRequestContext
} from '../streams/stats-output-context'

const waitUntil = async (condition: () => boolean, timeoutMs = 2000): Promise<void> => {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`waitUntil timed out after ${timeoutMs}ms`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const makePort = (tabId: number, documentId: string) => {
  const disconnectHandlers: Array<() => void> = []
  const port = {
    name: PokerChaseService.POKER_CHASE_SERVICE_EVENT,
    onMessage: { addListener: jest.fn() },
    onDisconnect: { addListener: jest.fn((handler: () => void) => disconnectHandlers.push(handler)) },
    postMessage: jest.fn(),
    disconnect: jest.fn(),
    sender: { tab: { id: tabId }, documentId },
  }
  return { port, disconnectHandlers }
}

const makeDeal = (
  timestamp: number,
  playerId: number,
  spectator = false
): ApiEvent<ApiType.EVT_DEAL> => ({
  ApiTypeId: ApiType.EVT_DEAL,
  timestamp,
  SeatUserIds: [playerId, playerId + 1, -1, -1],
  ...(spectator ? {} : {
    Player: {
      SeatIndex: 0,
      BetStatus: 1,
      HoleCards: [48, 49],
      Chip: 990,
      BetChip: 10,
    }
  }),
  OtherPlayers: [
    { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 980, BetChip: 20 }
  ],
  Game: {
    CurrentBlindLv: 1,
    NextBlindUnixSeconds: 0,
    Ante: 0,
    SmallBlind: 10,
    BigBlind: 20,
    ButtonSeat: 0,
    SmallBlindSeat: 0,
    BigBlindSeat: 1,
  },
  Progress: {
    Phase: PhaseType.PREFLOP,
    NextActionSeat: 0,
    NextActionTypes: [ActionType.FOLD, ActionType.CALL, ActionType.RAISE, ActionType.ALL_IN],
    NextExtraLimitSeconds: 30,
    MinRaise: 40,
    Pot: 30,
    SidePot: [],
  },
} as ApiEvent<ApiType.EVT_DEAL>)

const makeAction = (timestamp: number) => ({
  ApiTypeId: ApiType.EVT_ACTION,
  timestamp,
  SeatIndex: 1,
  ActionType: ActionType.CALL,
  Chip: 960,
  BetChip: 40,
  Progress: {
    Phase: PhaseType.PREFLOP,
    NextActionSeat: 0,
    NextActionTypes: [ActionType.FOLD, ActionType.CALL, ActionType.RAISE, ActionType.ALL_IN],
    NextExtraLimitSeconds: 30,
    MinRaise: 40,
    Pot: 50,
    SidePot: [],
  },
})

const makeEntryQueued = (timestamp: number) => ({
  ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
  timestamp,
  Code: 0,
  BattleType: 0,
  Id: 'stage000_003',
  IsRetire: false
})

const makeHandResults = (timestamp: number, handId: number) => ({
  ApiTypeId: ApiType.EVT_HAND_RESULTS,
  timestamp,
  HandId: handId,
  CommunityCards: [],
  Pot: 30,
  SidePot: [],
  ResultType: 0,
  DefeatStatus: 0,
  Results: [{
    HandRanking: 1,
    Hands: [],
    HoleCards: [],
    Ranking: -2,
    RankType: 10,
    RewardChip: 30,
    UserId: 101
  }],
  OtherPlayers: [
    { BetChip: 0, BetStatus: -1, Chip: 1_020, SeatIndex: 0, Status: 0 },
    { BetChip: 0, BetStatus: -1, Chip: 980, SeatIndex: 1, Status: 0 }
  ]
})

const sessionResults = {
  ApiTypeId: ApiType.EVT_SESSION_RESULTS,
  timestamp: 200,
  Ranking: 3,
  IsLeave: false,
  IsRebuy: false,
  TotalMatch: 100,
  RankReward: {
    IsSeasonal: true,
    RankPoint: 10,
    RankPointDiff: 1,
    Rank: { RankId: 'gold', RankName: 'ゴールド', RankLvId: 'gold', RankLvName: 'ゴールド' },
    SeasonalRanking: 0,
  },
  Rewards: [],
  EventRewards: [],
  Charas: [],
  Costumes: [],
  Decos: [],
  Items: [],
  Money: { FreeMoney: -1, PaidMoney: -1 },
  Emblems: [],
}

describe('stats delivery follows the active-port token', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let tabA: ReturnType<typeof makePort>
  let tabB: ReturnType<typeof makePort>
  let sendA: (message: any) => Promise<void>
  let sendB: (message: any) => Promise<void>
  let connect: (port: any) => void
  const extraPorts: Array<ReturnType<typeof makePort>> = []

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = trackServiceForTeardown(new PokerChaseService({ db }))
    await service.ready
    setLastKnownStats([
      { playerId: 101, statResults: [] } as any,
      { playerId: 102, statResults: [] } as any,
    ])

    ;(chrome.runtime as any).onConnect = { addListener: jest.fn() }
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    __resetActivePortStateForTests()
    __resetStatsOutputContextForTests()
    registerStreamSubscriptions(service, 'https://example.com/*')
    registerEventIngestion(service)
    connect = (chrome.runtime as any).onConnect.addListener.mock.calls[0][0]
    tabA = makePort(1, 'document-a')
    tabB = makePort(2, 'document-b')
    connect(tabA.port)
    connect(tabB.port)
    sendA = tabA.port.onMessage.addListener.mock.calls[0][0]
    sendB = tabB.port.onMessage.addListener.mock.calls[0][0]
  })

  afterEach(async () => {
    tabA.disconnectHandlers.forEach(handler => handler())
    tabB.disconnectHandlers.forEach(handler => handler())
    extraPorts.splice(0).forEach(item => item.disconnectHandlers.forEach(handler => handler()))
    connectedPorts.clear()
    __resetActivePortStateForTests()
    __resetStatsOutputContextForTests()
    setLastKnownStats([])
    jest.restoreAllMocks()
    db.close()
    await db.delete()
  })

  test('new port claims the token and aggregate/realtime updates stop reaching the relic', async () => {
    await sendB(makeDeal(100, 101))
    await waitUntil(() => tabB.port.postMessage.mock.calls.some(([message]) =>
      Object.keys(message.realTimeStats?.heroStats ?? {}).length > 0
    ))
    expect(getActivePort()).toBe(tabB.port)
    tabA.port.postMessage.mockClear()
    tabB.port.postMessage.mockClear()
    const resetSpy = jest.spyOn(service.realTimeStatsStream, 'reset')

    await sendA(makeDeal(200, 901))
    await waitUntil(() => tabA.port.postMessage.mock.calls.some(([message]) =>
      Object.keys(message.realTimeStats?.heroStats ?? {}).length > 0
    ))
    expect(getActivePort()).toBe(tabA.port)
    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(tabB.port.postMessage).toHaveBeenCalledWith({ type: REPLAY_PORT_CANCEL })
    expect(tabB.port.postMessage.mock.calls.some(([message]) =>
      'stats' in message || 'realTimeStats' in message
    )).toBe(false)
    expect(tabA.port.postMessage.mock.calls[0][0].stats).toBeUndefined()

    tabA.port.postMessage.mockClear()
    tabB.port.postMessage.mockClear()
    ;(service.statsOutputStream as any).emit('data', [
      { playerId: 901, statResults: [] }
    ])
    expect(tabA.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      stats: [expect.objectContaining({ playerId: 901 })],
      evtDeal: expect.objectContaining({ SeatUserIds: expect.arrayContaining([901]) })
    }))
    expect(tabB.port.postMessage).not.toHaveBeenCalled()
  })

  test('relicからの重複再送はtoken・世代・realtime streamを動かさない', async () => {
    const deal = makeDeal(625, 101)
    await sendB(deal)
    await waitUntil(() => getActivePort() === tabB.port as unknown as chrome.runtime.Port)
    const generation = resolveGeneration()
    tabA.port.postMessage.mockClear()
    tabB.port.postMessage.mockClear()
    const resetSpy = jest.spyOn(service.realTimeStatsStream, 'reset')

    await sendA({ ...deal })

    expect(getActivePort()).toBe(tabB.port)
    expect(resolveGeneration()).toBe(generation)
    expect(resetSpy).not.toHaveBeenCalled()
    expect(tabA.port.postMessage).not.toHaveBeenCalled()
    expect(tabB.port.postMessage).not.toHaveBeenCalled()
  })

  test('別世代がDEAL前にtokenを取得しても、旧世代のservice.liveEvtDealを集計statsへ混ぜない', async () => {
    await sendB(makeDeal(650, 101))
    await waitUntil(() => getActivePort() === tabB.port as unknown as chrome.runtime.Port)
    tabA.port.postMessage.mockClear()
    tabB.port.postMessage.mockClear()

    await sendA(makeAction(651))
    await waitUntil(() => getActivePort() === tabA.port as unknown as chrome.runtime.Port)
    expect(tabA.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      realTimeOnly: true,
      realTimeStats: { heroStats: {}, playerStats: {} }
    }))
    tabA.port.postMessage.mockClear()
    ;(service.statsOutputStream as any).emit('data', [
      { playerId: 901, statResults: [] }
    ])

    expect(tabA.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      evtDeal: undefined
    }))
    expect(tabB.port.postMessage).not.toHaveBeenCalled()
  })

  test('旧世代で開始した遅延stats出力をhandover後のACTIVEとcacheへ配信しない', async () => {
    await sendB(makeDeal(700, 101))
    await waitUntil(() => getActivePort() === tabB.port as unknown as chrome.runtime.Port)
    const oldGeneration = resolveGeneration()!
    const oldDeal = makeDeal(700, 101)
    const request = oldDeal.SeatUserIds
    let releaseCalculation!: (stats: any[]) => void
    const calculation = new Promise<any[]>(resolve => { releaseCalculation = resolve })
    const started = new Promise<void>(resolve => {
      jest.spyOn(service.statsOutputStream, 'calcStats').mockImplementation(async () => {
        resolve()
        return await calculation
      })
    })
    setStatsRequestContext(request, {
      delivery: 'active',
      generation: oldGeneration,
      evtDeal: oldDeal
    })
    service.statsOutputStream.write(request)
    await started

    claimActivePortForGameEvent(service, tabA.port as unknown as chrome.runtime.Port, 701)
    expect(getActivePort()).toBe(tabA.port)
    tabA.port.postMessage.mockClear()
    tabB.port.postMessage.mockClear()

    releaseCalculation([{ playerId: 101, statResults: [] }])
    await service.statsOutputStream.whenIdle()

    expect(tabA.port.postMessage).not.toHaveBeenCalled()
    expect(tabB.port.postMessage).not.toHaveBeenCalled()
    expect(getLastKnownStats()).not.toEqual([expect.objectContaining({ playerId: 101 })])
  })

  test('再接続隙間で完了した同一世代statsを後継transportへ引き渡す', async () => {
    await sendB(makeDeal(725, 101))
    await waitUntil(() => getActivePort() === tabB.port as unknown as chrome.runtime.Port)
    const generation = resolveGeneration()!
    const request = [101, 102]
    const delayedStats = [{ playerId: 101, statResults: [] }]
    let releaseCalculation!: () => void
    const calculation = new Promise<any[]>(resolve => {
      releaseCalculation = () => resolve(delayedStats)
    })
    const started = new Promise<void>(resolve => {
      jest.spyOn(service.statsOutputStream, 'calcStats').mockImplementation(async () => {
        resolve()
        return await calculation
      })
    })
    setStatsRequestContext(request, {
      delivery: 'active',
      generation,
      evtDeal: makeDeal(725, 101)
    })
    service.statsOutputStream.write(request)
    await started

    tabB.disconnectHandlers.forEach(handler => handler())
    expect(getActivePort()).toBeUndefined()
    expect(resolveGeneration()).toBe(generation)
    releaseCalculation()
    await service.statsOutputStream.whenIdle()
    expect(getLastKnownStats()).toEqual(delayedStats)

    const replacement = makePort(2, 'document-b')
    extraPorts.push(replacement)
    connect(replacement.port as unknown as chrome.runtime.Port)

    expect(resolveGeneration(replacement.port as unknown as chrome.runtime.Port)).toBe(generation)
    expect(replacement.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      stats: delayedStats
    }))
  })

  test('初回イベントのdedup待ち中に再接続しても、確定世代は後継transportへ乗る', async () => {
    const original = makePort(3, 'document-c')
    extraPorts.push(original)
    connect(original.port as unknown as chrome.runtime.Port)
    const sendOriginal = original.port.onMessage.addListener.mock.calls[0][0]
    let resolveMerge!: (result: { added: apiEventKey.RawApiEvent[], duplicates: number }) => void
    jest.spyOn(apiEventKey, 'mergeApiEvents').mockImplementation(
      async (_db, _events) => await new Promise(resolve => { resolveMerge = resolve })
    )

    const pending = sendOriginal(makeDeal(740, 301))
    await waitUntil(() => resolveMerge !== undefined)
    original.disconnectHandlers.forEach(handler => handler())
    const replacement = makePort(3, 'document-c')
    extraPorts.push(replacement)
    connect(replacement.port as unknown as chrome.runtime.Port)

    resolveMerge({ added: [makeDeal(740, 301) as unknown as apiEventKey.RawApiEvent], duplicates: 0 })
    await pending

    expect(getActivePort()).toBe(replacement.port)
    expect(resolveGeneration(original.port as unknown as chrome.runtime.Port)).toBe(
      resolveGeneration(replacement.port as unknown as chrome.runtime.Port)
    )
    expect(replacement.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      realTimeOnly: true,
      realTimeStats: { heroStats: {}, playerStats: {} }
    }))
  })

  test('dedup通過した成功201だけがbackground権威のsession境界を作る', async () => {
    const entry = makeEntryQueued(750)
    await sendB(entry)
    await sendA({ ...entry })

    const boundaryMessages = [
      ...tabA.port.postMessage.mock.calls,
      ...tabB.port.postMessage.mock.calls
    ].map(([message]) => message).filter(message => message.type === POKER_CHASE_SESSION_START_EVENT)
    expect(boundaryMessages).toEqual([{
      type: POKER_CHASE_SESSION_START_EVENT,
      timestamp: 750
    }])
    expect(getActivePort()).toBe(tabB.port)
  })

  test('ACTIVE未確定でも明示一括stats更新は接続中の全ゲームportへ届く', async () => {
    const explicitStats = [{ playerId: 777, statResults: [] }]
    jest.spyOn(service.statsOutputStream, 'calcStats').mockResolvedValue(explicitStats as any)
    tabA.port.postMessage.mockClear()
    tabB.port.postMessage.mockClear()

    const sequenceA = getLiveBroadcastSequenceForTab(1)
    const sequenceB = getLiveBroadcastSequenceForTab(2)
    writeConnectedStatsUpdate(service, [777])
    await service.statsOutputStream.whenIdle()

    expect(getActivePort()).toBeUndefined()
    expect(tabA.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ stats: explicitStats }))
    expect(tabB.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ stats: explicitStats }))
    expect(getLiveBroadcastSequenceForTab(1)).toBeGreaterThan(sequenceA)
    expect(getLiveBroadcastSequenceForTab(2)).toBeGreaterThan(sequenceB)
  })

  test('token世代が未確定の通常stats出力は接続中の全ゲームportへfallbackする', () => {
    const recoveredStats = [{ playerId: 778, statResults: [] }]
    tabA.port.postMessage.mockClear()
    tabB.port.postMessage.mockClear()

    ;(service.statsOutputStream as any).emit('data', recoveredStats)

    expect(resolveGeneration()).toBeUndefined()
    expect(tabA.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ stats: recoveredStats }))
    expect(tabB.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ stats: recoveredStats }))
  })

  test('実イベント経路でDEAL/RESULTS世代不一致を棄却し、reload再送DEAL後の同一世代handは成立する', async () => {
    await sendA(makeDeal(800, 901))
    await sendB(makeAction(801))
    await sendB(makeHandResults(802, 8_001))
    await service.writeEntityStream.whenIdle()

    expect(await db.hands.get(8_001)).toBeUndefined()

    tabB.disconnectHandlers.forEach(handler => handler())
    const reloaded = makePort(2, 'document-b-reloaded')
    extraPorts.push(reloaded)
    connect(reloaded.port as unknown as chrome.runtime.Port)
    const sendReloaded = reloaded.port.onMessage.addListener.mock.calls[0][0]

    // web_accessible_resource.tsは受信ごとにDate.now()を付け直すため、reload時の
    // bulk resend DEALは新timestampでdedupを抜ける（docs/api-events.mdの同一ms
    // 一括再送）。その実イベントが新世代のbufferを作り直し、続くRESULTSと
    // 同一世代になることをこのfixtureは前提として固定する。
    await sendReloaded(makeDeal(803, 101))
    await sendReloaded(makeHandResults(804, 8_002))
    await service.writeEntityStream.whenIdle()

    expect(await db.hands.get(8_002)).toBeDefined()
  })

  test('同一tab/documentの500ms再接続は進行中ハンドのDEAL・ホールカード・スタックを引き継ぐ', async () => {
    await sendB(makeDeal(600, 101))
    await waitUntil(() => tabB.port.postMessage.mock.calls.some(([message]) =>
      message.realTimeStats?.heroStats?.holeCards?.[0] === 48
    ))

    const resetSpy = jest.spyOn(service.realTimeStatsStream, 'reset')
    tabB.disconnectHandlers.forEach(handler => handler())
    const replacement = makePort(2, 'document-b')
    extraPorts.push(replacement)
    connect(replacement.port as unknown as chrome.runtime.Port)
    const sendReplacement = replacement.port.onMessage.addListener.mock.calls[0][0]

    // onConnectだけでtokenを継承するため、ホーム画面で次イベントが無くてもACTIVE。
    expect(getActivePort()).toBe(replacement.port)

    await sendReplacement(makeAction(601))
    await waitUntil(() => replacement.port.postMessage.mock.calls.some(([message]) =>
      message.realTimeStats?.heroStats?.holeCards?.[0] === 48
    ))

    expect(resetSpy).not.toHaveBeenCalled()
    expect(getActivePort()).toBe(replacement.port)
    expect(replacement.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      realTimeStats: expect.objectContaining({
        heroStats: expect.objectContaining({ holeCards: [48, 49] })
      })
    }))
  })

  test('an old relic port reclaims the token when it delivers a new game event', async () => {
    await sendB(makeDeal(300, 101))
    await waitUntil(() => tabB.port.postMessage.mock.calls.some(([message]) =>
      Object.keys(message.realTimeStats?.heroStats ?? {}).length > 0
    ))
    await sendA(makeDeal(301, 901))
    await waitUntil(() => getActivePort() === tabA.port as unknown as chrome.runtime.Port)
    tabA.port.postMessage.mockClear()
    tabB.port.postMessage.mockClear()

    await sendB(makeDeal(302, 101))
    await waitUntil(() => tabB.port.postMessage.mock.calls.some(([message]) =>
      Object.keys(message.realTimeStats?.heroStats ?? {}).length > 0
    ))
    expect(getActivePort()).toBe(tabB.port)
    expect(tabA.port.postMessage).toHaveBeenCalledWith({ type: REPLAY_PORT_CANCEL })
    expect(tabA.port.postMessage.mock.calls.some(([message]) =>
      'stats' in message || 'realTimeStats' in message
    )).toBe(false)
  })

  test("tab A's 309 leaves relic tab B's retained display untouched", async () => {
    await sendB(makeDeal(400, 101))
    await waitUntil(() => tabB.port.postMessage.mock.calls.some(([message]) =>
      Object.keys(message.realTimeStats?.heroStats ?? {}).length > 0
    ))
    tabA.port.postMessage.mockClear()
    tabB.port.postMessage.mockClear()

    await sendA({ ...sessionResults, timestamp: 401 })

    expect(getActivePort()).toBe(tabA.port)
    expect(tabA.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      realTimeOnly: true,
      realTimeStats: { heroStats: {}, playerStats: {} }
    }))
    expect(tabB.port.postMessage).not.toHaveBeenCalled()
  })

  test("tab A's spectator deal sends nothing to relic tab B", async () => {
    await sendB(makeDeal(500, 101))
    await waitUntil(() => tabB.port.postMessage.mock.calls.some(([message]) =>
      Object.keys(message.realTimeStats?.heroStats ?? {}).length > 0
    ))
    tabA.port.postMessage.mockClear()
    tabB.port.postMessage.mockClear()

    await sendA(makeDeal(501, 901, true))
    await waitUntil(() => tabA.port.postMessage.mock.calls.length > 0)

    const spectatorMessage = tabA.port.postMessage.mock.calls[0][0]
    expect(spectatorMessage.realTimeOnly).toBe(true)
    expect(spectatorMessage.evtDeal).toBeUndefined()
    expect(spectatorMessage.realTimeStats).toEqual({ heroStats: {}, playerStats: {} })
    expect(getActivePort()).toBe(tabA.port)
    expect(tabB.port.postMessage).not.toHaveBeenCalled()
  })
})
