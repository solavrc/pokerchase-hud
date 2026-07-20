/**
 * event-ingestion.ts - session-activity arrival-order integrity
 *
 * Verifies two pass-2 findings on PR #196 (both created 2026-07-21,
 * chatgpt-codex-connector, on top of the P2#3 fix that made ACTIVE-marking
 * synchronous while INACTIVE-marking (309) stays behind the Raw Event Lake
 * durability barrier -- an intentional asymmetry, see event-ingestion.ts's
 * markSessionActiveFromRawMessage() docstring):
 *
 * P1 "Preserve session activity ordering across queued events": because
 * ACTIVE-marking (201/303[Player]/308) fires synchronously in
 * port.onMessage while INACTIVE-marking (309) only settles later, behind
 * `ingestionQueue`, the raw arrival order [309, 201] could invert: 201's
 * synchronous ACTIVE mark lands first, then the *older* (but slower to
 * settle) 309's INACTIVE mark overwrites it, leaving the tri-state
 * 'inactive' while a brand new hand is actually live. The fix
 * (update-manager.ts's `arrivalSeq`-gated `markSessionActive`/
 * `markSessionInactive`) makes only the transition with the *newest*
 * arrival sequence number win, regardless of which one settles first.
 *
 * P2 "Skip duplicate starts before arming activity": a reconnect
 * resend/duplicate of an already-stored 201/303/308 arms ACTIVE
 * optimistically (before the queued ConstraintError dedupe check can
 * identify it as a duplicate and skip it), so a stale resend arriving
 * after a genuine 309 can flip sessionActivity back to 'active' with no
 * live hand, blocking pending Forced Updates indefinitely. The fix
 * (`revertSessionActivityIfStillApplied()`) rolls the optimistic ACTIVE
 * mark back to whatever it was immediately before, once the duplicate is
 * confirmed -- but only if nothing newer has applied since.
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { ApiType } from '../types'
import { registerEventIngestion } from './event-ingestion'
import { connectedPorts } from './ports'
import * as updateManager from './update-manager'
import { autoSyncService } from '../services/auto-sync-service'

describe('registerEventIngestion (session-activity arrival-order integrity)', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let onMessageHandler: (message: any) => Promise<void>
  let disconnectHandlers: Array<() => void>
  let mockPort: any

  beforeEach(async () => {
    // update-manager.ts's session-activity state (sessionActivity,
    // lastAppliedSeq, etc.) is module-scope and persists across `test()`
    // blocks within this file (only `registerEventIngestion`'s own
    // `arrivalSequence` closure is fresh per test) -- reset it so each
    // test's arrival sequence numbers are compared against a clean
    // baseline, matching the pattern in update-manager.test.ts /
    // message-router.forced-update.test.ts.
    updateManager.__resetUpdateManagerStateForTests()

    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = new PokerChaseService({ db })
    await service.ready

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

    // These tests are about session-activity ordering, not the sync
    // trigger's own (unrelated, auth/network-dependent) behavior -- mock it
    // out so `isSafeToUpdate()`'s `!autoSyncService.isSyncing` term doesn't
    // introduce timing noise unrelated to what's under test here.
    jest.spyOn(autoSyncService, 'onGameSessionEnd').mockResolvedValue(undefined)
    jest.spyOn(autoSyncService, 'onNewSessionStart').mockResolvedValue(undefined)
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    disconnectHandlers.forEach(fn => fn())
    connectedPorts.clear()
    db.close()
    await db.delete()
  })

  const entryQueued = (timestamp: number) => ({
    ApiTypeId: ApiType.EVT_ENTRY_QUEUED, timestamp, Code: 0, BattleType: 0, Id: 'stage000_003', IsRetire: false
  })

  const sessionResults = (timestamp: number) => ({
    ApiTypeId: ApiType.EVT_SESSION_RESULTS,
    timestamp,
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
  })

  test('P1: raw arrival order [309, 201] -- a 309 whose durability write settles AFTER a later 201 must not overwrite that 201\'s ACTIVE mark (audit\'s exact ordering scenario)', async () => {
    // Make the 309's own apiEvents.add() settle only when we say so, so we
    // can arrange for the 201 (which arrives *after* the 309 chronologically,
    // but whose ACTIVE mark is synchronous) to complete first -- reproducing
    // "session end immediately followed by a new hand, before the 309's raw
    // write has actually settled".
    let resolveSessionResultsAdd!: (key: number) => void
    const realAdd = db.apiEvents.add.bind(db.apiEvents)
    jest.spyOn(db.apiEvents, 'add').mockImplementation(((event: any) => {
      if (event.ApiTypeId === ApiType.EVT_SESSION_RESULTS) {
        return new Promise<number>(resolve => { resolveSessionResultsAdd = resolve })
      }
      return realAdd(event)
    }) as any)

    // 1) The session-end 309 arrives first (true arrival order) -- its
    // processing is now stuck behind the mocked, unresolved add(). Note:
    // `ingestionQueue` strictly serializes `processEvent` calls, so this
    // event's OWN promise won't settle until we release it below -- do not
    // await it yet.
    const pendingSessionResults = onMessageHandler(sessionResults(100))

    // 2) A brand new hand's 201 arrives next (true arrival order: AFTER the
    // 309) -- markSessionActive() fires synchronously in the port.onMessage
    // listener, before this event is even enqueued, so it has already run
    // by the time this call returns (regardless of the fact that this
    // event's own queued processing is stuck behind the still-unresolved
    // 309 and its returned promise won't settle until that unblocks either
    // -- captured but deliberately not awaited yet).
    const pendingEntryQueued = onMessageHandler(entryQueued(200))

    // At this point the newer (201) transition has already applied.
    expect(updateManager.isSafeToUpdate()).toBe(false) // active -- unsafe, correctly

    // Let the queue actually reach the mocked (still-unresolved) 309 add()
    // call before releasing it -- `ingestionQueue.then(...)` and the
    // `await service.ready` / `await apiEvents.add(...)` chain inside
    // `processEvent` each take a few microtask hops to get there.
    await new Promise(resolve => setTimeout(resolve, 0))

    // 3) Now let the 309's raw write settle -- its markSessionInactive()
    // call finally runs, but carries the OLDER arrival sequence number.
    resolveSessionResultsAdd(1)
    await pendingSessionResults
    await pendingEntryQueued

    // The older (309) transition must NOT have overwritten the newer (201)
    // one -- the true arrival order says a new hand is live.
    expect(updateManager.isSafeToUpdate()).toBe(false)
  })

  test('P1 sanity check: raw arrival order [201, 309] (no inversion) still ends inactive as expected', async () => {
    await onMessageHandler(entryQueued(300))
    expect(updateManager.isSafeToUpdate()).toBe(false) // active

    await onMessageHandler(sessionResults(400))
    expect(updateManager.isSafeToUpdate()).toBe(true) // inactive, and no other unsafe condition
  })

  test('P2: a reconnect-resend duplicate of an already-processed 201 does not re-arm session activity after a genuine 309 (audit\'s exact duplicate scenario)', async () => {
    // Genuine session: 201 starts it, 309 ends it.
    const originalEntryQueued = entryQueued(500)
    await onMessageHandler(originalEntryQueued)
    await onMessageHandler(sessionResults(600))

    expect(updateManager.isSafeToUpdate()).toBe(true) // inactive, session truly over

    // A stale reconnect resend of the *exact same* 201 event arrives late
    // (identical timestamp+ApiTypeId+payload -- e.g. a buffered unacked
    // message replayed after the port reconnects). It optimistically arms
    // ACTIVE the instant it arrives (synchronous, fail-closed by design)...
    await onMessageHandler({ ...originalEntryQueued })

    // ...but once its raw add() rejects with a real ConstraintError and the
    // payload comparison confirms it's a true duplicate (not a same-ms
    // collision), the optimistic ACTIVE mark is rolled back to whatever it
    // was immediately before -- 'inactive', matching reality (no live hand).
    expect(updateManager.isSafeToUpdate()).toBe(true)
    expect(await db.apiEvents.count()).toBe(2) // only the two genuine rows, resend added nothing
  })

  test('P2 control: a genuinely NEW 201 after a 309 (not a duplicate) is NOT reverted -- only true duplicates roll back', async () => {
    await onMessageHandler(entryQueued(700))
    await onMessageHandler(sessionResults(800))
    expect(updateManager.isSafeToUpdate()).toBe(true) // inactive

    // A brand new, distinct 201 (different timestamp -- no key collision at
    // all, let alone a duplicate) legitimately starts a new session.
    await onMessageHandler(entryQueued(900))

    expect(updateManager.isSafeToUpdate()).toBe(false) // active, correctly NOT reverted
  })
})
