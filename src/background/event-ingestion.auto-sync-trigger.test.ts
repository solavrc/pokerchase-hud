/**
 * event-ingestion.ts - auto-sync trigger wiring
 *
 * Verifies which ApiTypeIds fire AutoSyncService's sync triggers:
 *  - EVT_SESSION_RESULTS (309, session end) -> onGameSessionEnd (primary trigger)
 *  - EVT_ENTRY_QUEUED (201) / EVT_SESSION_DETAILS (308, session start) ->
 *    onNewSessionStart (fallback trigger added per postmortem
 *    docs/postmortems/2026-07-session-results-drop.md 再発防止#3, so a
 *    broken 309 doesn't leave sync stuck forever)
 *  - no other application event fires either trigger
 *  - these triggers are hooked off the RAW ApiTypeId (codex review, PR #150
 *    audit finding #1), same as update-manager's session-activity tracking:
 *    onGameSessionEnd()/onNewSessionStart() only read the already-persisted
 *    raw apiEvents Lake row count and never touch the parsed payload, so a
 *    parse failure (parseApiEvent() -> null, e.g. a PokerChase payload
 *    schema change) must not skip them
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { ApiType } from '../types'
import { registerEventIngestion } from './event-ingestion'
import { connectedPorts } from './ports'
import { autoSyncService } from '../services/auto-sync-service'

describe('registerEventIngestion (auto-sync triggers)', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let onMessageHandler: (message: any) => Promise<void>
  let disconnectHandlers: Array<() => void>
  let mockPort: any
  let onGameSessionEndSpy: jest.SpyInstance
  let onNewSessionStartSpy: jest.SpyInstance

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = new PokerChaseService({ db })
    await service.ready

    onGameSessionEndSpy = jest.spyOn(autoSyncService, 'onGameSessionEnd').mockResolvedValue(undefined)
    onNewSessionStartSpy = jest.spyOn(autoSyncService, 'onNewSessionStart').mockResolvedValue(undefined)

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

  test('EVT_SESSION_RESULTS (309, session end) triggers onGameSessionEnd, not onNewSessionStart', async () => {
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

    expect(onGameSessionEndSpy).toHaveBeenCalledTimes(1)
    expect(onNewSessionStartSpy).not.toHaveBeenCalled()
  })

  test('EVT_ENTRY_QUEUED (201, session start) triggers onNewSessionStart, not onGameSessionEnd', async () => {
    const entryQueuedEvent = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 2000,
      Code: 0,
      BattleType: 0,
      Id: 'stage000_003',
      IsRetire: false
    }
    await onMessageHandler(entryQueuedEvent)

    expect(onNewSessionStartSpy).toHaveBeenCalledTimes(1)
    expect(onGameSessionEndSpy).not.toHaveBeenCalled()
  })

  test('EVT_SESSION_DETAILS (308, session start) triggers onNewSessionStart, not onGameSessionEnd', async () => {
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

    expect(onNewSessionStartSpy).toHaveBeenCalledTimes(1)
    expect(onGameSessionEndSpy).not.toHaveBeenCalled()
  })

  test('an unrelated application event (EVT_DEAL) triggers neither sync path', async () => {
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

    expect(onGameSessionEndSpy).not.toHaveBeenCalled()
    expect(onNewSessionStartSpy).not.toHaveBeenCalled()
  })

  test('a parse-failed EVT_ENTRY_QUEUED (201) still triggers onNewSessionStart via the raw ApiTypeId (codex review, PR #150 audit)', async () => {
    // Missing every required field -- fails Zod validation (parseApiEvent()
    // returns null), so this never reaches the parsed-data ApiTypeId
    // dispatch below the isApplicationApiEvent gate. Before this fix the
    // trigger lived exclusively in that unreachable parsed branch, so a
    // schema change on 201 would have silently dropped the fallback sync
    // trigger too (same root cause as the 309 pending-update-recheck bug).
    const brokenEntryQueuedEvent = { ApiTypeId: ApiType.EVT_ENTRY_QUEUED, timestamp: 5000 }
    await onMessageHandler(brokenEntryQueuedEvent)

    expect(onNewSessionStartSpy).toHaveBeenCalledTimes(1)
    expect(onGameSessionEndSpy).not.toHaveBeenCalled()
  })

  test('a parse-failed EVT_SESSION_RESULTS (309) still triggers onGameSessionEnd -> recheckPendingUpdate via the raw ApiTypeId (codex review, PR #150 audit finding #1)', async () => {
    // Simulates the season-3 postmortem scenario: PokerChase changes the 309
    // payload shape so parseApiEvent() returns null. The raw event is still
    // persisted to the apiEvents Lake above, and onGameSessionEnd() only
    // counts raw Lake rows -- it doesn't need the parsed payload -- so there
    // is no reason for a parse failure to skip it. Before this fix, this
    // trigger (and the recheckPendingUpdate() chained after it) lived only
    // in the parsed-data branch, which `return`s early on parse failure, so
    // a malformed 309 left any pending Forced Update stuck until the *next*
    // session ended.
    const brokenSessionResultsEvent = { ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 6000 }
    await onMessageHandler(brokenSessionResultsEvent)

    expect(onGameSessionEndSpy).toHaveBeenCalledTimes(1)
    expect(onNewSessionStartSpy).not.toHaveBeenCalled()
  })
})
