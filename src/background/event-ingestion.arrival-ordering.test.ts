/**
 * event-ingestion.ts - session-activity: strict queue serialization
 *
 * 2026-07-21, pass-3 consolidation. Two earlier rounds of findings against
 * a design where ACTIVE-marking (201/303[Player]/308) fired synchronously
 * in port.onMessage while INACTIVE-marking (309/203) settled later, behind
 * the `ingestionQueue` durability barrier:
 *   - pass-2 P1 "arrival-order inversion": a slow-to-settle 309 could
 *     overwrite a chronologically-newer 201's synchronous ACTIVE mark.
 *     Patched with an `arrivalSeq`-gated ordering scheme.
 *   - pass-2 P2 "duplicate re-arms activity": a stale resend armed ACTIVE
 *     optimistically before the dedupe check could identify it. Patched
 *     with a 1-level rollback.
 *   - pass-3 P2 "stacked duplicate rollback": the 1-level rollback broke
 *     when a reconnect resent MORE THAN ONE stale duplicate in a row (the
 *     second optimistic ACTIVE mark clobbered the rollback slot meant for
 *     the first).
 *
 * Each patch fixed the finding that prompted it but created the next one --
 * the write-side design was fighting itself. The actual fix: move ALL
 * session-activity transitions inside the same serialized `ingestionQueue`
 * that already gates the Raw Event Lake durability barrier and the
 * duplicate/collision dedupe check (see event-ingestion.ts's
 * `applySessionActivity` docstring):
 *   - the queue preserves true arrival order by construction, so there is
 *     no inversion to guard against and no `arrivalSeq` machinery needed
 *   - the dedupe check runs BEFORE the activity decision, so a duplicate
 *     (however many are resent in a row) never reaches
 *     markSessionActive()/markSessionInactive() at all -- nothing to roll
 *     back, ever
 *
 * The original motivation for making ACTIVE-marking synchronous in the
 * first place (a slow/stuck `apiEvents.add()` leaving `sessionActivity`
 * stale while a safety recheck fires) is now solved on the READ side
 * instead: `awaitIngestionDrain()` (see
 * event-ingestion.durability-barrier.test.ts for that test).
 *
 * This file keeps the ordering/duplicate *scenarios* from the earlier
 * rounds (they're still valid regression coverage) and adds the
 * multi-duplicate-burst case that broke the 1-level rollback.
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { ApiType } from '../types'
import { registerEventIngestion } from './event-ingestion'
import { connectedPorts } from './ports'
import * as updateManager from './update-manager'
import { autoSyncService } from '../services/auto-sync-service'

describe('registerEventIngestion (session-activity: strict queue serialization)', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let onMessageHandler: (message: any) => Promise<void>
  let disconnectHandlers: Array<() => void>
  let mockPort: any

  beforeEach(async () => {
    // update-manager.ts's session-activity state is module-scope and
    // persists across `test()` blocks within this file -- reset it,
    // matching the pattern in update-manager.test.ts /
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

    // These tests are about session-activity, not the sync trigger's own
    // (unrelated, auth/network-dependent) behavior -- mock it out so
    // `isSafeToUpdate()`'s `!autoSyncService.isSyncing` term doesn't
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

  test('raw arrival order [309, 201] resolves to ACTIVE (queue serialization preserves true arrival order, no inversion possible)', async () => {
    await onMessageHandler(sessionResults(100))
    expect(updateManager.isSafeToUpdate()).toBe(true) // inactive

    await onMessageHandler(entryQueued(200))
    expect(updateManager.isSafeToUpdate()).toBe(false) // active -- the newer arrival correctly wins
  })

  test('raw arrival order [201, 309] resolves to INACTIVE (the reverse direction, for symmetry)', async () => {
    await onMessageHandler(entryQueued(300))
    expect(updateManager.isSafeToUpdate()).toBe(false) // active

    await onMessageHandler(sessionResults(400))
    expect(updateManager.isSafeToUpdate()).toBe(true) // inactive
  })

  test('a single reconnect-resend duplicate of an already-processed 201 does not re-arm session activity after a genuine 309', async () => {
    const originalEntryQueued = entryQueued(500)
    await onMessageHandler(originalEntryQueued)
    await onMessageHandler(sessionResults(600))

    expect(updateManager.isSafeToUpdate()).toBe(true) // inactive, session truly over

    // A stale reconnect resend of the *exact same* 201 event arrives late
    // (identical timestamp+ApiTypeId+payload). Its raw add() rejects with a
    // real ConstraintError, and the dedupe check runs BEFORE the
    // session-activity decision is ever reached -- the resend never touches
    // markSessionActive() at all.
    await onMessageHandler({ ...originalEntryQueued })

    expect(updateManager.isSafeToUpdate()).toBe(true) // unchanged
    expect(await db.apiEvents.count()).toBe(2) // only the two genuine rows, resend added nothing
  })

  test('a BURST of multiple stacked reconnect-resend duplicates never re-arms session activity (P2, codex review 2026-07-20 pass-3: this is exactly the case that broke the earlier 1-level rollback design)', async () => {
    // Genuine session: 201 (via 308 too, to also exercise that trigger),
    // then a genuine 309 ends it.
    const originalEntryQueued = entryQueued(700)
    const sessionDetails = {
      ApiTypeId: ApiType.EVT_SESSION_DETAILS,
      timestamp: 701,
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
    await onMessageHandler(originalEntryQueued)
    await onMessageHandler(sessionDetails)
    await onMessageHandler(sessionResults(800))

    expect(updateManager.isSafeToUpdate()).toBe(true) // inactive, session truly over

    // A reconnect replays a BURST of multiple already-processed events in a
    // row -- e.g. an old 201 immediately followed by the old 308 for the
    // same (now long-over) session. Under the earlier "optimistic
    // ACTIVE + 1-level rollback" design, the second optimistic ACTIVE mark
    // would clobber the rollback slot meant to restore the first, so
    // deduping the first did nothing and deduping the second restored
    // 'active' instead of the true prior 'inactive'. With activity
    // transitions unified inside the queue (after the dedupe check),
    // NEITHER resend ever reaches markSessionActive() -- there's no
    // optimistic mark to stack or clobber in the first place.
    //
    // Deliberately NOT awaited between the two calls -- the old buggy
    // design only broke when both resends' synchronous "optimistic ACTIVE"
    // marks fired back-to-back, before either one's own async dedupe check
    // (and rollback) had a chance to run. Awaiting each resend fully before
    // sending the next would fully serialize them and never exercise the
    // overlap the bug depended on.
    const pendingResendA = onMessageHandler({ ...originalEntryQueued })
    const pendingResendB = onMessageHandler({ ...sessionDetails })
    await pendingResendA
    await pendingResendB

    expect(updateManager.isSafeToUpdate()).toBe(true) // still inactive -- neither resend moved it
    expect(await db.apiEvents.count()).toBe(3) // only the three genuine rows
  })

  test('control: a genuinely NEW 201 after a 309 (not a duplicate) legitimately arms activity', async () => {
    await onMessageHandler(entryQueued(900))
    await onMessageHandler(sessionResults(1000))
    expect(updateManager.isSafeToUpdate()).toBe(true) // inactive

    // A brand new, distinct 201 (different timestamp -- no key collision at
    // all, let alone a duplicate) legitimately starts a new session.
    await onMessageHandler(entryQueued(1100))

    expect(updateManager.isSafeToUpdate()).toBe(false) // active, correctly not suppressed
  })
})
