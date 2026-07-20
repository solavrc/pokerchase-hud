/**
 * event-ingestion.ts - Raw Event Lake durability barrier
 *
 * Verifies the release-blocker audit's finding A fix: `db.apiEvents.add()`
 * used to be fire-and-forget, so the parse/validation gate, the three live
 * streams, and the session-end side effects (auto-sync trigger, pending
 * Forced Update recheck -> possible `chrome.runtime.reload()`) could all run
 * while the raw write was still in flight or had failed. That could leave
 * derived stats with no raw recovery row (breaking the Raw Event Lake
 * invariant -- see CLAUDE.md "Raw Event Lake" / "Storage happens *before*
 * the validation gate"), double-process a duplicate-key retry, or let a
 * reload race the in-flight write.
 *
 * The fix serializes each event's processing so nothing downstream
 * (session-activity tracking, the auto-sync trigger, and stream forwarding)
 * runs until that event's `apiEvents.add()` has settled -- successfully, or
 * with a *handled* failure (duplicate-key -> skip as already-processed;
 * any other failure -> drop from the pipeline and surface it via the #141
 * drop-visibility counter, never forward without a raw row).
 *
 * 2026-07-21 pass-3 consolidation: session-activity tracking
 * (markSessionActive/markSessionInactive) used to be deliberately EXEMPT
 * from this barrier (fired synchronously, before the durability await) to
 * avoid a Forced Update safety recheck reading a stale value. Two more
 * rounds of findings (arrival-order inversion, stacked-duplicate rollback
 * corruption) showed that exemption fighting the barrier was the wrong
 * shape of fix. Session-activity tracking now lives fully INSIDE the
 * barrier like everything else (see event-ingestion.ts's
 * `applySessionActivity` docstring) -- the original latency concern is
 * instead solved on the READ side via update-manager.ts's
 * `awaitIngestionDrain()` (see the dedicated test below).
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { ApiType } from '../types'
import { registerEventIngestion } from './event-ingestion'
import { connectedPorts } from './ports'
import * as updateManager from './update-manager'
import { autoSyncService } from '../services/auto-sync-service'
import { getUndecodedEventStats, resetUndecodedEventStats, UNDECODED_EVENT_STATS_KEY } from './undecoded-event-tracker'

describe('registerEventIngestion (raw-write durability barrier)', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let onMessageHandler: (message: any) => Promise<void>
  let disconnectHandlers: Array<() => void>
  let mockPort: any

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    await resetUndecodedEventStats(db)
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

  test('streams / auto-sync trigger / session-activity tracking all wait behind apiEvents.add(), and all run after it resolves', async () => {
    const handLogSpy = jest.spyOn(service.handLogStream, 'write')
    const markSessionActiveSpy = jest.spyOn(updateManager, 'markSessionActive')
    const onNewSessionStartSpy = jest.spyOn(autoSyncService, 'onNewSessionStart').mockResolvedValue(undefined)

    let resolveAdd!: (key: number) => void
    jest.spyOn(db.apiEvents, 'add').mockImplementation(
      (() => new Promise<number>(resolve => { resolveAdd = resolve })) as any
    )

    const pending = onMessageHandler(entryQueued(100))

    // Flush the microtask queue repeatedly without resolving add() -- if the
    // durability barrier is in place, nothing downstream (including
    // session-activity tracking, unified into the same barrier as of the
    // pass-3 consolidation) may have run yet.
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(handLogSpy).not.toHaveBeenCalled()
    expect(onNewSessionStartSpy).not.toHaveBeenCalled()
    expect(markSessionActiveSpy).not.toHaveBeenCalled()

    resolveAdd(1)
    await pending

    expect(handLogSpy).toHaveBeenCalledTimes(1)
    expect(onNewSessionStartSpy).toHaveBeenCalledTimes(1)
    expect(markSessionActiveSpy).toHaveBeenCalledTimes(1)
  })

  test('a reload decision using awaitIngestionDrain() correctly waits out a stuck apiEvents.add() instead of reading stale session-activity state', async () => {
    // This is the read-side fix for the original "mark-active-latency"
    // concern (a slow/stuck add() leaving sessionActivity stale while a
    // safety recheck fires): any reload decision point must await
    // update-manager.ts's `awaitIngestionDrain()` before consulting
    // `isSafeToUpdate()`, not just read it directly.
    let resolveAdd!: (key: number) => void
    jest.spyOn(db.apiEvents, 'add').mockImplementation(
      (() => new Promise<number>(resolve => { resolveAdd = resolve })) as any
    )

    const pending = onMessageHandler(entryQueued(105))
    await new Promise(resolve => setTimeout(resolve, 0))

    // Reading isSafeToUpdate() directly right now would (incorrectly, from
    // a "is a new hand actually live" standpoint) still see the initial
    // 'unknown'/unsafe baseline -- which happens to already be unsafe here,
    // so this assertion alone wouldn't distinguish a real fix from a bug.
    // The actual guarantee under test is that awaitIngestionDrain() doesn't
    // resolve until the stuck add() does.
    let drained = false
    const drainCheck = updateManager.awaitIngestionDrain().then(() => { drained = true })

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(drained).toBe(false) // still stuck behind the unresolved add()

    resolveAdd(1)
    await pending
    await drainCheck

    expect(drained).toBe(true)
    // Now that the queue has drained, isSafeToUpdate() reflects this
    // event's fully-applied ACTIVE transition.
    expect(updateManager.isSafeToUpdate()).toBe(false)
  })

  test('on duplicate-key rejection (event already in the Raw Event Lake), ALL downstream processing is skipped, including session-activity tracking -- duplicates never re-arm', async () => {
    const event = entryQueued(200)
    await onMessageHandler(event) // first arrival: stored + processed normally

    const handLogSpy = jest.spyOn(service.handLogStream, 'write')
    const aggregateSpy = jest.spyOn(service.handAggregateStream, 'write')
    const realTimeSpy = jest.spyOn(service.realTimeStatsStream, 'write')
    const markSessionActiveSpy = jest.spyOn(updateManager, 'markSessionActive')
    const onNewSessionStartSpy = jest.spyOn(autoSyncService, 'onNewSessionStart').mockResolvedValue(undefined)

    // Re-arrival of the exact same (timestamp, ApiTypeId) AND the exact same
    // payload -- Dexie's add() throws a real ConstraintError here
    // (ports.ts/import-export.ts resend scenarios, reconnect replays, etc.),
    // and the payload comparison against the existing row confirms it's a
    // true duplicate (not a same-millisecond key collision -- see the
    // dedicated collision test below). Since the dedup check now runs
    // BEFORE the session-activity decision (2026-07-21 pass-3
    // consolidation), a duplicate never reaches markSessionActive() at
    // all -- there's no optimistic pre-barrier mark left to roll back, so a
    // reconnect resending any number of stacked duplicates can never
    // re-arm activity (see event-ingestion.arrival-ordering.test.ts for the
    // multi-duplicate-burst regression test).
    await onMessageHandler({ ...event })

    expect(handLogSpy).not.toHaveBeenCalled()
    expect(aggregateSpy).not.toHaveBeenCalled()
    expect(realTimeSpy).not.toHaveBeenCalled()
    expect(onNewSessionStartSpy).not.toHaveBeenCalled()
    expect(markSessionActiveSpy).not.toHaveBeenCalled()
    expect(await db.apiEvents.count()).toBe(1)
  })

  test('on a primary-key collision (a DIFFERENT event landing on the same [timestamp+ApiTypeId] -- e.g. a same-millisecond burst), the event is still forwarded to the live pipeline and the raw-row gap is surfaced (audit finding 6, P2 codex review 2026-07-21)', async () => {
    // Two distinct EVT_ENTRY_QUEUED events can share a client timestamp
    // (Date.now() collision in web_accessible_resource.ts under a fast
    // burst), colliding on the [timestamp+ApiTypeId] primary key. Treating
    // this exactly like a true duplicate (skip) would silently drop the
    // second, DIFFERENT event from streams/session-hooks/sync-trigger --
    // that's the regression this test guards against. The interim fix
    // forwards it anyway (the full fix is the wave-3 sequence-key
    // migration) and surfaces the raw-row gap loudly.
    const first = entryQueued(400)
    await onMessageHandler(first)

    const handLogSpy = jest.spyOn(service.handLogStream, 'write')
    const markSessionActiveSpy = jest.spyOn(updateManager, 'markSessionActive')
    const onNewSessionStartSpy = jest.spyOn(autoSyncService, 'onNewSessionStart').mockResolvedValue(undefined)

    // Same (timestamp, ApiTypeId) as `first`, but a genuinely different
    // event (different Id -- a different table/room).
    const second = { ...entryQueued(400), Id: 'stage000_099' }
    await onMessageHandler(second)

    // Forwarded to the live pipeline despite having no raw row of its own.
    expect(handLogSpy).toHaveBeenCalledTimes(1)
    expect(handLogSpy).toHaveBeenCalledWith(expect.objectContaining({ Id: 'stage000_099' }))
    expect(onNewSessionStartSpy).toHaveBeenCalledTimes(1)
    expect(markSessionActiveSpy).toHaveBeenCalledTimes(1)

    // The colliding row was never overwritten -- `first`'s payload is still
    // the one durably stored under this key.
    const stored = await db.apiEvents.get([400, ApiType.EVT_ENTRY_QUEUED])
    expect(stored).toEqual(first)
    expect(await db.apiEvents.count()).toBe(1)

    // The raw-row gap for `second` is surfaced via the drop-visibility
    // counter (#141 mechanism), same as any other raw-write failure.
    await new Promise(resolve => setTimeout(resolve, 550)) // flush the tracker's debounce
    const stats = await getUndecodedEventStats(db)
    expect(stats.total).toBe(1)
    expect(stats.perApiTypeId[ApiType.EVT_ENTRY_QUEUED]).toEqual({ count: 1, lastSeen: 400 })
  })

  test('on a non-duplicate raw-write failure (e.g. quota), the event is dropped from the pipeline entirely (Lake invariant: no derived stats without a raw row) and surfaced via the drop-visibility counter', async () => {
    const handLogSpy = jest.spyOn(service.handLogStream, 'write')
    const markSessionInactiveSpy = jest.spyOn(updateManager, 'markSessionInactive')
    const onGameSessionEndSpy = jest.spyOn(autoSyncService, 'onGameSessionEnd').mockResolvedValue(undefined)
    const recheckPendingUpdateSpy = jest.spyOn(updateManager, 'recheckPendingUpdate').mockResolvedValue(undefined)

    const quotaError = new Error('The quota has been exceeded.')
    quotaError.name = 'QuotaExceededError'
    jest.spyOn(db.apiEvents, 'add').mockRejectedValue(quotaError)

    await onMessageHandler(sessionResults(300))

    // Forbidden state check: no raw row exists...
    expect(await db.apiEvents.count()).toBe(0)
    // ...so nothing downstream may have run, INCLUDING the reload-capable
    // pending-update recheck (chained off onGameSessionEnd in the real 309
    // path) -- a SW reload right now would have nothing to lose, but more
    // importantly this event's session-end side effects must not fire for
    // an event that isn't durably recorded.
    expect(handLogSpy).not.toHaveBeenCalled()
    expect(markSessionInactiveSpy).not.toHaveBeenCalled()
    expect(onGameSessionEndSpy).not.toHaveBeenCalled()
    expect(recheckPendingUpdateSpy).not.toHaveBeenCalled()

    // Drop visibility (#141 mechanism): the failure must not be silent.
    await new Promise(resolve => setTimeout(resolve, 550)) // flush the tracker's debounce
    const stats = await getUndecodedEventStats(db)
    expect(stats.total).toBe(1)
    expect(stats.perApiTypeId[ApiType.EVT_SESSION_RESULTS]).toEqual({ count: 1, lastSeen: 300 })
    const persisted = await db.meta.get(UNDECODED_EVENT_STATS_KEY)
    expect(persisted?.value).toEqual(stats)
  })

  test('a non-duplicate raw-write failure on a session-START event (201) still fails closed to ACTIVE (P2, codex review 2026-07-20 pass-4: "Fail closed on dropped ACTIVE writes")', async () => {
    // Start from a genuine prior 309 so sessionActivity begins 'inactive'.
    await onMessageHandler(sessionResults(350))

    const handLogSpy = jest.spyOn(service.handLogStream, 'write')
    const markSessionActiveSpy = jest.spyOn(updateManager, 'markSessionActive')
    const onNewSessionStartSpy = jest.spyOn(autoSyncService, 'onNewSessionStart').mockResolvedValue(undefined)

    const quotaError = new Error('The quota has been exceeded.')
    quotaError.name = 'QuotaExceededError'
    jest.spyOn(db.apiEvents, 'add').mockRejectedValue(quotaError)

    await onMessageHandler(entryQueued(360))

    // No raw row for this event -- the Lake invariant still holds, and it
    // still isn't forwarded to streams or the auto-sync trigger.
    expect(await db.apiEvents.count()).toBe(1) // only the 309 from setup
    expect(handLogSpy).not.toHaveBeenCalled()
    expect(onNewSessionStartSpy).not.toHaveBeenCalled()
    // But the raw message unambiguously shows a new hand starting -- that
    // fact doesn't depend on whether the write succeeded, so ACTIVE must
    // still be applied. Without this, sessionActivity would incorrectly
    // stay 'inactive' (from the prior 309) through an actually-live hand,
    // and a Forced Update recheck could judge a mid-game reload "safe".
    expect(markSessionActiveSpy).toHaveBeenCalledTimes(1)
    expect(updateManager.isSafeToUpdate()).toBe(false)
  })

  test('control: a non-duplicate raw-write failure on EVT_SESSION_RESULTS (309) does NOT fail open to INACTIVE', async () => {
    // Mirrors the existing quota-failure test above but asserts the
    // asymmetry explicitly: ACTIVE-direction failures fail closed (previous
    // test), INACTIVE-direction failures must NOT fail open, since a
    // failed 309 write is not confirmation the session actually ended.
    jest.spyOn(db.apiEvents, 'add').mockRejectedValue(Object.assign(new Error('quota'), { name: 'QuotaExceededError' }))
    const markSessionInactiveSpy = jest.spyOn(updateManager, 'markSessionInactive')

    await onMessageHandler(sessionResults(370))

    expect(markSessionInactiveSpy).not.toHaveBeenCalled()
  })

  test('a burst of events preserves stream-write order even though each event awaits its own raw add() (serialization invariant)', async () => {
    const writeOrder: number[] = []
    jest.spyOn(service.handLogStream, 'write').mockImplementation((event: any) => {
      writeOrder.push(event.timestamp)
      return true as any
    })

    // Stagger add() latency in *reverse* of arrival order (the earliest
    // event is the slowest) -- if events weren't serialized, a naive
    // implementation could let a later event's write resolve before an
    // earlier one's, reordering what the streams observe.
    const realAdd = db.apiEvents.add.bind(db.apiEvents)
    jest.spyOn(db.apiEvents, 'add').mockImplementation(((event: any) => {
      const index = event.timestamp - 1000
      const delayMs = (5 - index) * 5
      return new Promise((resolve, reject) => {
        setTimeout(() => { realAdd(event).then(resolve, reject) }, delayMs)
      })
    }) as any)

    const events = [0, 1, 2, 3, 4].map(i => entryQueued(1000 + i))
    // Fire the whole burst without awaiting between calls, simulating
    // messages arriving faster than any single event's DB write settles.
    const pending = events.map(event => onMessageHandler(event))

    await Promise.all(pending)

    expect(writeOrder).toEqual([1000, 1001, 1002, 1003, 1004])
  })

  test('raw ingestion is NOT blocked behind autoSyncService.onGameSessionEnd() (P2, codex review 2026-07-20 pass-4: "Don\'t block raw ingestion on cloud uploads")', async () => {
    // Make onGameSessionEnd() (standing in for a real, slow Firestore
    // upload) stay pending indefinitely. Before this fix, the sync trigger
    // was awaited inside processEvent, so the entire ingestionQueue --
    // including apiEvents.add() for the NEXT hand's raw events -- stayed
    // blocked behind it, freezing the live HUD and risking losing those
    // events entirely if the Service Worker suspended/reloaded meanwhile.
    let resolveSync!: () => void
    jest.spyOn(autoSyncService, 'onGameSessionEnd').mockImplementation(
      () => new Promise<void>(resolve => { resolveSync = resolve })
    )

    await onMessageHandler(sessionResults(2200))
    // The next hand's raw event must reach apiEvents.add() promptly --
    // NOT stuck waiting behind the still-pending onGameSessionEnd().
    await onMessageHandler(entryQueued(2300))

    expect(await db.apiEvents.count()).toBe(2)

    resolveSync()
    await new Promise(resolve => setTimeout(resolve, 0)) // let the deferred sync settle cleanly
  })

  test('the session-end reload recheck is skipped (not just delayed) when a newer event was already queued while onGameSessionEnd() was running (P1, codex review 2026-07-20 pass-4: "Don\'t reload before queued session starts run")', async () => {
    // A pending update exists and would become "safe to apply" the instant
    // this 309 marks the session inactive -- but a new hand's 201 arrives
    // and gets queued (behind the 309, ahead of having its own ACTIVE
    // transition applied yet) while the sync trigger is still running.
    await chrome.storage.local.set({ pendingUpdate: { pending: true, version: '9.9.9' } })

    let resolveSync!: () => void
    jest.spyOn(autoSyncService, 'onGameSessionEnd').mockImplementation(
      () => new Promise<void>(resolve => { resolveSync = resolve })
    )
    ;(chrome.runtime.reload as jest.Mock).mockClear()

    const pendingSessionResults = onMessageHandler(sessionResults(2400))
    const pendingNext = onMessageHandler(entryQueued(2500)) // queued behind the 309, not yet processed

    // Let the queue actually reach the mocked (still-unresolved)
    // onGameSessionEnd() call before releasing it -- poll rather than a
    // single fixed tick, since the number of microtask hops through
    // `service.ready` + `apiEvents.add()` before reaching the sync trigger
    // isn't guaranteed stable under parallel test-worker load.
    for (let i = 0; i < 20 && !resolveSync; i++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    resolveSync() // let onGameSessionEnd() settle now that a newer event is already queued
    await pendingSessionResults
    await pendingNext

    // The stale-relative-to-arrival recheck must not have reloaded --
    // reading isSafeToUpdate() at that moment would have seen the 309's
    // 'inactive' without yet reflecting the queued 201's ACTIVE transition.
    expect(chrome.runtime.reload).not.toHaveBeenCalled()
    // The 201 legitimately re-armed the session afterward.
    expect(updateManager.isSafeToUpdate()).toBe(false)
    // The pending update is still recorded (deferred to a later recheck
    // trigger -- the next session end, operation completion, or SW
    // startup), not silently lost.
    const state = await chrome.storage.local.get('pendingUpdate')
    expect((state as any).pendingUpdate?.pending).toBe(true)
  })

  test('control: the session-end reload recheck still applies a safe pending update when nothing new was queued while onGameSessionEnd() was running', async () => {
    await chrome.storage.local.set({ pendingUpdate: { pending: true, version: '9.9.9' } })
    jest.spyOn(autoSyncService, 'onGameSessionEnd').mockResolvedValue(undefined)
    ;(chrome.runtime.reload as jest.Mock).mockClear()

    await onMessageHandler(sessionResults(2600))
    // Let the fire-and-forget sync-trigger/recheck chain (unawaited by
    // processEvent as of the pass-4 decoupling) settle.
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(chrome.runtime.reload).toHaveBeenCalledTimes(1)
  })

  // The companion "an event arrives DURING recheckPendingUpdate()'s own
  // internal awaits (not just before it starts)" scenario (P1, codex
  // review 2026-07-21, pass-5, "Guard reload rechecks through the async
  // path") is covered as a direct, isolated unit test of
  // recheckPendingUpdate()'s isStillFresh evaluation timing in
  // update-manager.test.ts, rather than here: reproducing that exact race
  // through the full event-ingestion.ts integration requires stalling
  // chrome.storage.local.get() globally, which interacts badly with other
  // concurrent callers (getRebuildAdvisoryState() inside setBadge()/
  // clearBadge()) and reliably exhausts the test worker's heap. The
  // property under test -- that isStillFresh is (re-)evaluated after
  // recheckPendingUpdate()'s own awaits, not cached from before they
  // started -- is fully covered without that hazard.

  test('a noise event (202, non-application) queued while onGameSessionEnd() is running does NOT permanently suppress the session-end recheck (P2, codex review 2026-07-21, pass-5: "Don\'t let noise suppress session-end rechecks")', async () => {
    await chrome.storage.local.set({ pendingUpdate: { pending: true, version: '9.9.9' } })

    let resolveSync!: () => void
    jest.spyOn(autoSyncService, 'onGameSessionEnd').mockImplementation(
      () => new Promise<void>(resolve => { resolveSync = resolve })
    )
    ;(chrome.runtime.reload as jest.Mock).mockClear()

    const pendingSessionResults = onMessageHandler(sessionResults(2900))

    // Let the queue reach the mocked (still-unresolved) onGameSessionEnd()
    // call before injecting noise.
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }

    // A non-application "noise" event (202) arrives and gets queued while
    // onGameSessionEnd() is still running. It neither marks the session
    // active nor triggers any recheck of its own -- under the pre-pass-5
    // "any newer queued message invalidates freshness" rule, this alone
    // would have permanently suppressed the 309's recheck this cycle,
    // leaving the pending update blocked until an unrelated operation
    // completion or SW restart even though nothing about the session
    // actually changed.
    const noiseEvent = { ApiTypeId: 202, timestamp: 2950, Code: 0 }
    const pendingNoise = onMessageHandler(noiseEvent)

    resolveSync() // let onGameSessionEnd() settle
    await pendingSessionResults
    await pendingNoise

    // The recheck must still have applied the (still) safe pending update
    // -- the noise event must not have counted against freshness.
    expect(chrome.runtime.reload).toHaveBeenCalledTimes(1)
  })
})
