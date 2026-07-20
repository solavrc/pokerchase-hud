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

  test('streams / auto-sync trigger do not run before apiEvents.add() resolves, and do run after (session-activity tracking is exempt -- see the dedicated test below)', async () => {
    const handLogSpy = jest.spyOn(service.handLogStream, 'write')
    const markSessionActiveSpy = jest.spyOn(updateManager, 'markSessionActive')
    const onNewSessionStartSpy = jest.spyOn(autoSyncService, 'onNewSessionStart').mockResolvedValue(undefined)

    let resolveAdd!: (key: number) => void
    jest.spyOn(db.apiEvents, 'add').mockImplementation(
      (() => new Promise<number>(resolve => { resolveAdd = resolve })) as any
    )

    const pending = onMessageHandler(entryQueued(100))

    // markSessionActive() runs synchronously on message arrival, before any
    // await -- see the dedicated durability-exemption test below and
    // markSessionActiveFromRawMessage()'s docstring for why this one is
    // deliberately NOT gated behind the raw-write barrier.
    expect(markSessionActiveSpy).toHaveBeenCalledTimes(1)

    // Flush the microtask queue repeatedly without resolving add() -- if the
    // durability barrier is in place, nothing else downstream may have run
    // yet.
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(handLogSpy).not.toHaveBeenCalled()
    expect(onNewSessionStartSpy).not.toHaveBeenCalled()

    resolveAdd(1)
    await pending

    expect(handLogSpy).toHaveBeenCalledTimes(1)
    expect(onNewSessionStartSpy).toHaveBeenCalledTimes(1)
  })

  test('session-activity tracking (markSessionActive) is exempt from the durability barrier and fires even while apiEvents.add() is still stuck (P2, codex review 2026-07-21)', async () => {
    // A recheck racing the awaited raw-write window must already observe
    // ACTIVE -- session-activity is Service Worker memory-only state with no
    // durability dependency on the raw row, so gating it behind a slow/stuck
    // add() would reopen exactly the risk finding A closed (a stale
    // 'inactive' reading permitting a mid-game reload).
    const markSessionActiveSpy = jest.spyOn(updateManager, 'markSessionActive')
    jest.spyOn(db.apiEvents, 'add').mockImplementation(
      (() => new Promise<number>(() => { /* never resolves */ })) as any
    )

    void onMessageHandler(entryQueued(150))

    expect(markSessionActiveSpy).toHaveBeenCalledTimes(1)
    expect(updateManager.isSafeToUpdate()).toBe(false)
  })

  test('on duplicate-key rejection (event already in the Raw Event Lake), all downstream *pipeline* processing is skipped (dedup semantics, no double-processing) -- session-activity still fires (unconditional, see above)', async () => {
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
    // dedicated collision test below).
    await onMessageHandler({ ...event })

    expect(handLogSpy).not.toHaveBeenCalled()
    expect(aggregateSpy).not.toHaveBeenCalled()
    expect(realTimeSpy).not.toHaveBeenCalled()
    expect(onNewSessionStartSpy).not.toHaveBeenCalled()
    // markSessionActive() is unconditional per raw message (see the
    // dedicated exemption test above) -- it fires again here, harmlessly
    // (idempotent), even though the *pipeline* re-processing is skipped.
    expect(markSessionActiveSpy).toHaveBeenCalledTimes(1)
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
})
