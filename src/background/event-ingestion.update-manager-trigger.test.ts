/**
 * event-ingestion.ts - update-manager wiring
 *
 * Verifies the Forced Update safety predicate's session-activity tracking is
 * hooked at the same ApiTypeId boundaries as content_script.ts's keepalive
 * gate (EVT_SESSION_DETAILS = active, EVT_SESSION_RESULTS = inactive), and
 * that session end (309) is one of update-manager's safety-recheck points
 * (alongside operation completion and SW startup -- see update-manager.ts).
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { ApiType } from '../types'
import { registerEventIngestion } from './event-ingestion'
import { connectedPorts } from './ports'
import * as updateManager from './update-manager'

describe('registerEventIngestion (update-manager triggers)', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let onMessageHandler: (message: any) => Promise<void>
  let disconnectHandlers: Array<() => void>
  let mockPort: any
  let markSessionActiveSpy: jest.SpyInstance
  let markSessionInactiveSpy: jest.SpyInstance
  let recheckPendingUpdateSpy: jest.SpyInstance

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = new PokerChaseService({ db })
    await service.ready

    markSessionActiveSpy = jest.spyOn(updateManager, 'markSessionActive')
    markSessionInactiveSpy = jest.spyOn(updateManager, 'markSessionInactive')
    recheckPendingUpdateSpy = jest.spyOn(updateManager, 'recheckPendingUpdate').mockResolvedValue(undefined)

    ;(chrome.runtime as any).onConnect = { addListener: jest.fn() }
    registerEventIngestion(service)
    const connectListener = (chrome.runtime as any).onConnect.addListener.mock.calls[0][0]

    disconnectHandlers = []
    mockPort = {
      name: PokerChaseService.POKER_CHASE_SERVICE_EVENT,
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn((fn: () => void) => disconnectHandlers.push(fn)) },
      postMessage: jest.fn()
    }
    connectListener(mockPort)
    onMessageHandler = mockPort.onMessage.addListener.mock.calls[0][0]
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    disconnectHandlers.forEach(fn => fn())
    connectedPorts.clear()
    db.close()
    await db.delete()
  })

  test('EVT_SESSION_DETAILS (308) marks the session active', async () => {
    const sessionDetailsEvent = {
      ApiTypeId: ApiType.EVT_SESSION_DETAILS,
      timestamp: 3000,
      BlindStructures: [{ ActiveMinutes: 4, Ante: 50, BigBlind: 200, Lv: 1 }],
      CoinNum: -1,
      DefaultChip: 20000,
      IsReplay: false,
      Items: [],
      LimitSeconds: 8,
      MoneyList: [],
      Name: 'テストセッション',
      Name2: ''
    }
    await onMessageHandler(sessionDetailsEvent)

    expect(markSessionActiveSpy).toHaveBeenCalledTimes(1)
    expect(markSessionInactiveSpy).not.toHaveBeenCalled()
  })

  test('EVT_SESSION_RESULTS (309) marks the session inactive and re-checks the pending update', async () => {
    const sessionResultsEvent = {
      ApiTypeId: ApiType.EVT_SESSION_RESULTS,
      timestamp: 1000,
      Ranking: 3,
      IsLeave: false,
      IsRebuy: false,
      TotalMatch: 100,
      RankReward: {
        IsSeasonal: true,
        RankPoint: 10,
        RankPointDiff: 1,
        Rank: { RankId: 'gold', RankName: 'ゴールド', RankLvId: 'gold', RankLvName: 'ゴールド' },
        SeasonalRanking: 0
      },
      Rewards: [],
      EventRewards: [],
      Charas: [],
      Costumes: [],
      Decos: [],
      Items: [],
      Money: { FreeMoney: -1, PaidMoney: -1 },
      Emblems: []
    }
    await onMessageHandler(sessionResultsEvent)

    expect(markSessionInactiveSpy).toHaveBeenCalledTimes(1)
    expect(markSessionActiveSpy).not.toHaveBeenCalled()
    expect(recheckPendingUpdateSpy).toHaveBeenCalledTimes(1)
  })

  test('an unrelated application event (EVT_DEAL) does not touch session-activity tracking', async () => {
    const dealEvent = {
      ApiTypeId: ApiType.EVT_DEAL,
      timestamp: 4000,
      SeatUserIds: [1, 2, 3],
      Game: { CurrentBlindLv: 1, NextBlindUnixSeconds: 0, Ante: 0, SmallBlind: 100, BigBlind: 200, ButtonSeat: 0, SmallBlindSeat: 1, BigBlindSeat: 2 },
      Player: { SeatIndex: 0, BetStatus: 1, HoleCards: [0, 1], Chip: 5000, BetChip: 0 },
      OtherPlayers: [
        { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 100 },
        { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 200 }
      ],
      Progress: { Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 400, Pot: 300, SidePot: [] }
    }
    await onMessageHandler(dealEvent)

    expect(markSessionActiveSpy).not.toHaveBeenCalled()
    expect(markSessionInactiveSpy).not.toHaveBeenCalled()
    expect(recheckPendingUpdateSpy).not.toHaveBeenCalled()
  })
})
