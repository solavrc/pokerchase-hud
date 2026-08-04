import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { trackServiceForTeardown } from '../utils/test-service-teardown'
import { ActionType, ApiType, PhaseType } from '../types'
import { registerEventIngestion } from './event-ingestion'
import { connectedPorts, registerStreamSubscriptions, setLastKnownStats } from './ports'
import {
  __resetActivePortStateForTests,
  getActivePort
} from './active-port'

const waitUntil = async (condition: () => boolean, timeoutMs = 2000): Promise<void> => {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`waitUntil timed out after ${timeoutMs}ms`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const makePort = () => {
  const disconnectHandlers: Array<() => void> = []
  const port = {
    name: PokerChaseService.POKER_CHASE_SERVICE_EVENT,
    onMessage: { addListener: jest.fn() },
    onDisconnect: { addListener: jest.fn((handler: () => void) => disconnectHandlers.push(handler)) },
    postMessage: jest.fn(),
  }
  return { port, disconnectHandlers }
}

const makeDeal = (timestamp: number, playerId: number, spectator = false) => ({
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
    registerStreamSubscriptions(service, 'https://example.com/*')
    registerEventIngestion(service)
    const connect = (chrome.runtime as any).onConnect.addListener.mock.calls[0][0]
    tabA = makePort()
    tabB = makePort()
    connect(tabA.port)
    connect(tabB.port)
    sendA = tabA.port.onMessage.addListener.mock.calls[0][0]
    sendB = tabB.port.onMessage.addListener.mock.calls[0][0]
  })

  afterEach(async () => {
    tabA.disconnectHandlers.forEach(handler => handler())
    tabB.disconnectHandlers.forEach(handler => handler())
    connectedPorts.clear()
    __resetActivePortStateForTests()
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
    expect(tabB.port.postMessage).not.toHaveBeenCalled()

    tabA.port.postMessage.mockClear()
    ;(service.statsOutputStream as any).emit('data', [
      { playerId: 901, statResults: [] }
    ])
    expect(tabA.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      stats: [expect.objectContaining({ playerId: 901 })]
    }))
    expect(tabB.port.postMessage).not.toHaveBeenCalled()
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
    expect(tabA.port.postMessage).not.toHaveBeenCalled()
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
    expect(tabA.port.postMessage).not.toHaveBeenCalled()
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
