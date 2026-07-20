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

    // markSessionInactive() is called synchronously from the raw-message path
    // (before/independent of parsing), so it's already recorded here.
    expect(markSessionInactiveSpy).toHaveBeenCalledTimes(1)
    expect(markSessionActiveSpy).not.toHaveBeenCalled()

    // recheckPendingUpdate() is intentionally chained AFTER
    // autoSyncService.onGameSessionEnd() settles (ordering fix, codex review
    // P1) rather than fired in parallel -- flush the microtask queue for that
    // chain to complete before asserting.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(recheckPendingUpdateSpy).toHaveBeenCalledTimes(1)
  })

  test('a malformed EVT_SESSION_RESULTS (309) still marks the session inactive via the raw ApiTypeId (codex review, P2)', async () => {
    // Missing every required field -- fails Zod validation (parseApiEvent()
    // returns null), simulating PokerChase changing the 309 payload shape
    // (the season-3 postmortem scenario). Before this fix, session-activity
    // tracking read the *parsed* event and would never run here, leaving the
    // Forced Update safety predicate stuck unsafe forever after the prior 308.
    const brokenSessionResultsEvent = {
      ApiTypeId: ApiType.EVT_SESSION_RESULTS,
      timestamp: 6000
      // every other required field omitted -> parseApiEvent() returns null
    }
    await onMessageHandler(brokenSessionResultsEvent)

    expect(markSessionInactiveSpy).toHaveBeenCalledTimes(1)
    expect(markSessionActiveSpy).not.toHaveBeenCalled()
  })

  test('a malformed EVT_SESSION_RESULTS (309) still runs the pending-update recheck via the raw ApiTypeId (codex review, PR #150 audit finding #1)', async () => {
    // The companion regression to the test above: it's not enough for
    // session-activity tracking to survive a malformed 309 -- the actual
    // recheckPendingUpdate() *call* also has to run, or a pending Forced
    // Update stays stuck until the next session ends even though the
    // safety predicate itself would already report inactive/safe. Before
    // this fix, recheckPendingUpdate() was chained only inside the
    // `if (data.ApiTypeId === EVT_SESSION_RESULTS)` branch guarded by a
    // successful `parseApiEvent()`, which this event never reaches (it
    // `return`s early in the `if (!data)` branch).
    const brokenSessionResultsEvent = {
      ApiTypeId: ApiType.EVT_SESSION_RESULTS,
      timestamp: 6100
      // every other required field omitted -> parseApiEvent() returns null
    }
    await onMessageHandler(brokenSessionResultsEvent)

    // recheckPendingUpdate() is chained after autoSyncService.onGameSessionEnd()
    // settles (same ordering fix as the well-formed-309 test above) -- flush
    // the microtask queue for that chain to complete before asserting.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(recheckPendingUpdateSpy).toHaveBeenCalledTimes(1)
  })

  test('a malformed EVT_SESSION_DETAILS (308) still marks the session active via the raw ApiTypeId (codex review, P2)', async () => {
    const brokenSessionDetailsEvent = {
      ApiTypeId: ApiType.EVT_SESSION_DETAILS,
      timestamp: 7000
      // every other required field omitted -> parseApiEvent() returns null
    }
    await onMessageHandler(brokenSessionDetailsEvent)

    expect(markSessionActiveSpy).toHaveBeenCalledTimes(1)
    expect(markSessionInactiveSpy).not.toHaveBeenCalled()
  })

  test('EVT_DEAL (303, hand-in-flight signal) marks the session active (release-blocker audit finding B: 308 alone is not a reliable ACTIVE trigger)', async () => {
    // docs/api-events.md:99 documents 308 (EVT_SESSION_DETAILS) absence as a
    // normal variant (an observation gap), not an anomaly. A new game can
    // legitimately start 201/303-first with no 308 at all. Before this fix,
    // session-activity tracking only listened for 308, so a session ending
    // (309 -> inactive) followed by a 308-less restart left the tri-state
    // stuck inactive, and the Forced Update safety predicate would judge a
    // mid-game reload "safe".
    const dealEvent = {
      ApiTypeId: ApiType.EVT_DEAL,
      timestamp: 4000,
      SeatUserIds: [1, 2, 3, 4],
      Game: { CurrentBlindLv: 1, NextBlindUnixSeconds: 0, Ante: 0, SmallBlind: 100, BigBlind: 200, ButtonSeat: 0, SmallBlindSeat: 1, BigBlindSeat: 2 },
      Player: { SeatIndex: 0, BetStatus: 1, HoleCards: [0, 1], Chip: 5000, BetChip: 0 },
      OtherPlayers: [
        { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 100 },
        { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 200 }
      ],
      Progress: { Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 400, Pot: 300, SidePot: [] }
    }
    await onMessageHandler(dealEvent)

    expect(markSessionActiveSpy).toHaveBeenCalledTimes(1)
    expect(markSessionInactiveSpy).not.toHaveBeenCalled()
    // EVT_DEAL is not a pending-update recheck point (only session end/
    // operation completion/SW startup are, per update-manager.ts) -- marking
    // active is not the same as re-checking a *pending* update.
    expect(recheckPendingUpdateSpy).not.toHaveBeenCalled()
  })

  test('a spectator-mode EVT_DEAL (303, Player absent) does NOT mark the session active (P2, codex review 2026-07-21)', async () => {
    // docs/api-events.md "EVT_DEAL: Playerフィールドの欠落" / spectator-mode
    // deals (e.g. after the hero busts but the client keeps receiving other
    // players' table) have no `Player` field at all. Treating every 303 as
    // ACTIVE would keep sessionActivity stuck 'active' through a spectated
    // session that never gets another 309, blocking pending Forced Updates
    // indefinitely.
    const spectatorDealEvent = {
      ApiTypeId: ApiType.EVT_DEAL,
      timestamp: 4500,
      SeatUserIds: [1, 2, 3, 4],
      Game: { CurrentBlindLv: 1, NextBlindUnixSeconds: 0, Ante: 0, SmallBlind: 100, BigBlind: 200, ButtonSeat: 0, SmallBlindSeat: 1, BigBlindSeat: 2 },
      // Player omitted entirely -- spectator mode
      OtherPlayers: [
        { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 100 },
        { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 200 }
      ],
      Progress: { Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 400, Pot: 300, SidePot: [] }
    }
    await onMessageHandler(spectatorDealEvent)

    expect(markSessionActiveSpy).not.toHaveBeenCalled()
    expect(markSessionInactiveSpy).not.toHaveBeenCalled()
  })

  test('markSessionActive() waits behind the raw-write durability barrier (2026-07-21, pass-3 consolidation)', async () => {
    // Session-activity tracking now lives entirely inside `processEvent`,
    // behind the same `ingestionQueue` durability barrier as
    // streams/sync-triggers (see event-ingestion.ts's `applySessionActivity`
    // docstring for the pass-3 rationale: an earlier design made
    // ACTIVE-marking synchronous/pre-barrier specifically to avoid this,
    // but that created its own class of bugs -- ordering inversions and
    // stacked-duplicate rollback corruption -- so the write side was
    // simplified back to "everything happens in arrival order, inside the
    // queue" and the original latency concern is now handled on the READ
    // side instead, via `awaitIngestionDrain()`).
    let resolveAdd!: (key: number) => void
    jest.spyOn(db.apiEvents, 'add').mockImplementation(
      (() => new Promise<number>(resolve => { resolveAdd = resolve })) as any
    )

    const entryQueuedEvent = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED, timestamp: 9000, Code: 0, BattleType: 0, Id: 'stage000_003', IsRetire: false
    }
    const pending = onMessageHandler(entryQueuedEvent)

    // While add() is stuck, markSessionActive() must NOT have fired yet --
    // and a reload decision reading isSafeToUpdate() directly would still
    // see the previous (here: initial 'unknown') value. This is exactly why
    // reload decision points must use `awaitIngestionDrain()` instead of
    // reading `isSafeToUpdate()` directly (see the dedicated drain-barrier
    // test in event-ingestion.durability-barrier.test.ts).
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(markSessionActiveSpy).not.toHaveBeenCalled()

    resolveAdd(1)
    await pending

    expect(markSessionActiveSpy).toHaveBeenCalledTimes(1)
    expect(updateManager.isSafeToUpdate()).toBe(false)
  })

  test('raw sequence 309 -> 201 -> 303 without an intervening 308 does not leave the session stuck inactive (release-blocker audit exact scenario)', async () => {
    // The audit's precise regression scenario: a session ends (309), then a
    // brand-new game starts 201/303-first with no 308 in between (a normal
    // variant per docs/api-events.md:99, e.g. an observation gap). Only a
    // real EVT_SESSION_RESULTS (309) may mark the tri-state inactive again --
    // it must not silently stay 'inactive' (which `isSafeToUpdate()` would
    // read as SAFE and reload mid-game).
    const sessionResultsEvent = {
      ApiTypeId: ApiType.EVT_SESSION_RESULTS,
      timestamp: 8000,
      Ranking: 1,
      IsLeave: false,
      IsRebuy: false,
      TotalMatch: 10,
      RankReward: {
        IsSeasonal: true,
        RankPoint: 1,
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
    const entryQueuedEvent = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 8100,
      Code: 0,
      BattleType: 0,
      Id: 'stage000_003',
      IsRetire: false
    }
    const dealEvent = {
      ApiTypeId: ApiType.EVT_DEAL,
      timestamp: 8200,
      SeatUserIds: [1, 2, 3, 4],
      Game: { CurrentBlindLv: 1, NextBlindUnixSeconds: 0, Ante: 0, SmallBlind: 100, BigBlind: 200, ButtonSeat: 0, SmallBlindSeat: 1, BigBlindSeat: 2 },
      Player: { SeatIndex: 0, BetStatus: 1, HoleCards: [0, 1], Chip: 5000, BetChip: 0 },
      OtherPlayers: [
        { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 100 },
        { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 200 }
      ],
      Progress: { Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 400, Pot: 300, SidePot: [] }
    }

    await onMessageHandler(sessionResultsEvent)
    await new Promise(resolve => setTimeout(resolve, 0)) // let the 309 recheck chain settle
    recheckPendingUpdateSpy.mockClear()

    await onMessageHandler(entryQueuedEvent)
    await onMessageHandler(dealEvent)

    // No 309 has occurred since the deal -- update-manager must still see
    // the session as active (unsafe to reload), never as stuck 'inactive'.
    expect(updateManager.isSafeToUpdate()).toBe(false)
    // Session start (201/308) is a pending-update recheck point, but a plain
    // EVT_DEAL is not -- confirms the tri-state itself (not just the recheck
    // call) is what's carrying the fix.
    expect(recheckPendingUpdateSpy).not.toHaveBeenCalled()
  })

  test('EVT_ENTRY_CANCELLED (203, 参加取消申込) marks the session inactive when no hand ever started (P2, codex review 2026-07-20 pass-3)', async () => {
    // src/types/api.ts defines 203 as 参加取消申込 (entry cancellation
    // request). If a user enters matchmaking (201) and cancels before any
    // deal/session-result is emitted, the raw sequence is 201 -> 203 --
    // 309 never arrives, since no hand ever started. Before this fix,
    // sessionActivity had no INACTIVE trigger other than 309, so it stayed
    // stuck 'active' (and the mirrored content_script.ts switch kept
    // keepalive armed) until an unrelated future session's 309, or a
    // Service Worker restart.
    const entryQueuedEvent = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 10000,
      Code: 0,
      BattleType: 0,
      Id: 'stage000_003',
      IsRetire: false
    }
    // ApiTypeId 203 is not part of the `ApiType` enum (deliberately, so it
    // doesn't widen isApplicationApiEvent's scope) -- use the raw literal,
    // matching event-ingestion.ts's own EVT_ENTRY_CANCELLED_API_TYPE_ID.
    const entryCancelledEvent = {
      ApiTypeId: 203,
      timestamp: 10100,
      Code: 0
    }

    await onMessageHandler(entryQueuedEvent)
    expect(markSessionActiveSpy).toHaveBeenCalledTimes(1)
    expect(updateManager.isSafeToUpdate()).toBe(false) // active

    await onMessageHandler(entryCancelledEvent)

    expect(markSessionInactiveSpy).toHaveBeenCalledTimes(1)
    expect(updateManager.isSafeToUpdate()).toBe(true) // inactive again -- no hand ever started
  })

  test('EVT_ENTRY_CANCELLED (203) also triggers the pending-update recheck, same as EVT_SESSION_RESULTS (309) (P2, codex review 2026-07-20 pass-4: "Recheck updates after entry cancellation")', async () => {
    // applySessionActivity() treats 203 as an INACTIVE trigger (previous
    // test), but that alone doesn't help a pending Forced Update: without
    // also firing recheckPendingUpdate() here, a pending update stays
    // blocked until some unrelated future trigger (a later session's 309,
    // operation completion, or a Service Worker restart) happens to poke
    // it, even though cancelling the entry is itself the exact moment it
    // became safe to apply.
    const entryQueuedEvent = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 11000,
      Code: 0,
      BattleType: 0,
      Id: 'stage000_003',
      IsRetire: false
    }
    const entryCancelledEvent = {
      ApiTypeId: 203,
      timestamp: 11100,
      Code: 0
    }

    await onMessageHandler(entryQueuedEvent)
    recheckPendingUpdateSpy.mockClear()

    await onMessageHandler(entryCancelledEvent)
    // event-ingestion.ts's 203 branch has no slow upload before its recheck;
    // flush microtasks so the fire-and-forget call is observable here.
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(recheckPendingUpdateSpy).toHaveBeenCalledTimes(1)
  })
})
