import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { trackServiceForTeardown } from '../utils/test-service-teardown'
import { ActionType, ApiType, PhaseType } from '../types'
import { registerEventIngestion } from './event-ingestion'
import { connectedPorts, setLastKnownStats } from './ports'

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

const makeAction = (timestamp: number) => ({
  ApiTypeId: ApiType.EVT_ACTION,
  timestamp,
  SeatIndex: 0,
  ActionType: ActionType.CALL,
  Chip: 980,
  BetChip: 20,
  Progress: {
    Phase: PhaseType.PREFLOP,
    NextActionSeat: 1,
    NextActionTypes: [ActionType.CHECK, ActionType.BET, ActionType.ALL_IN],
    NextExtraLimitSeconds: 30,
    MinRaise: 40,
    Pot: 40,
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

describe('real-time stats are local to their source port', () => {
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
    setLastKnownStats([])
    db.close()
    await db.delete()
  })

  test('tab A session end does not stop tab B calculations or clear its display', async () => {
    await sendB(makeDeal(100, 101))
    await waitUntil(() => tabB.port.postMessage.mock.calls.some(([message]) =>
      Object.keys(message.realTimeStats?.heroStats ?? {}).length > 0
    ))
    tabA.port.postMessage.mockClear()
    tabB.port.postMessage.mockClear()

    await sendA(sessionResults)
    await sendB(makeAction(201))
    await waitUntil(() => tabB.port.postMessage.mock.calls.some(([message]) =>
      Object.keys(message.realTimeStats?.heroStats ?? {}).length > 0
    ))

    expect(tabA.port.postMessage).not.toHaveBeenCalled()
    expect(tabB.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      realTimeStats: expect.objectContaining({ heroStats: expect.any(Object) })
    }))
  })

  test('tab A spectator deal neither clears nor stops tab B real-time stats', async () => {
    await sendB(makeDeal(300, 101))
    await waitUntil(() => tabB.port.postMessage.mock.calls.some(([message]) =>
      Object.keys(message.realTimeStats?.heroStats ?? {}).length > 0
    ))
    tabA.port.postMessage.mockClear()
    tabB.port.postMessage.mockClear()

    await sendA(makeDeal(301, 901, true))
    await sendB(makeAction(302))
    await waitUntil(() => tabB.port.postMessage.mock.calls.some(([message]) =>
      Object.keys(message.realTimeStats?.heroStats ?? {}).length > 0
    ))

    const spectatorMessage = tabA.port.postMessage.mock.calls[0][0]
    expect(spectatorMessage.realTimeOnly).toBe(true)
    expect(spectatorMessage.evtDeal).toBeUndefined()
    expect(spectatorMessage.realTimeStats).toEqual({ heroStats: {}, playerStats: {} })
    expect(
      tabB.port.postMessage.mock.calls.every(
        ([message]) => message.evtDeal?.SeatUserIds?.[0] !== 901,
      ),
    ).toBe(true)
    expect(tabB.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      realTimeStats: expect.objectContaining({ heroStats: expect.any(Object) })
    }))
  })
})
