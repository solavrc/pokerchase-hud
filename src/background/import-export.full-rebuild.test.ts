/**
 * importData() - full rebuild after overlapping imports (independent
 * release-audit finding #7, plan C)
 *
 * `importData()` stores every new raw line into the apiEvents Lake, but
 * historically fed ONLY the newly-stored events to `EntityConverter`.
 * EntityConverter can only form a hand from a contiguous EVT_DEAL(303) ->
 * ... -> EVT_HAND_RESULTS(306) event run, so when an import partially
 * overlapped existing data -- e.g. re-importing a complete export into a DB
 * that already had a hand's DEAL and RESULTS but was missing the middle
 * ACTIONs -- the new ACTION rows were severed from their duplicate-excluded
 * DEAL/RESULTS, couldn't form a hand boundary, and were silently dropped by
 * the converter: the raw Lake got repaired but the derived hands/phases/
 * actions (and every stat computed from them) stayed stale until a later
 * full rebuild.
 *
 * PR #203 attempted a surgical incremental repair of only the affected
 * range; after 11 review rounds it proved non-convergent (it re-implements
 * full-rebuild semantics piecemeal). The owner-approved fix (plan C) drops
 * that machinery entirely: when an import into a non-empty DB actually
 * stores at least one new raw row, `importData()` runs the same full
 * rebuild the popup's "データ再構築" button uses
 * (`performFullRebuild`/`rebuildAllData`) instead of incremental entity
 * generation. This test proves the resulting derived state is identical to
 * what a from-scratch import of the same complete export would produce --
 * the audit's suggested regression test: "DEAL/RESULTS既存・ACTION欠落の
 * DBへ完全exportをimportし、action/statが再構築されることを確認する".
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { createImportExportHandlers } from './import-export'
import { setOperationState } from './operation-state'
import { EntityConverter } from '../entity-converter'
import * as databaseUtils from '../utils/database-utils'
import { getRebuildAdvisoryState, REBUILD_ADVISORY_STORAGE_KEY } from './rebuild-advisory'
import { REBUILD_ADVISORY_VERSION } from '../constants/database'

// A known-good session-start + hand (EVT_ENTRY_QUEUED, then EVT_DEAL -> 3x
// EVT_ACTION -> EVT_HAND_RESULTS), copied verbatim from src/app.test.ts's
// event_timeline fixture (already exercised there against the real stats
// pipeline) so this test isn't hand-authoring a new Zod-shaped fixture.
const ENTRY_QUEUED = { "ApiTypeId": 201, "Code": 0, "BattleType": 0, "Id": "stage000_003", "IsRetire": false, "timestamp": 1752427303234 }

const HAND1_EVENTS = [
  { "ApiTypeId": 303, "SeatUserIds": [2, 4, 3, 1], "Game": { "CurrentBlindLv": 1, "NextBlindUnixSeconds": 1752427424, "Ante": 50, "SmallBlind": 100, "BigBlind": 200, "ButtonSeat": 3, "SmallBlindSeat": 0, "BigBlindSeat": 1 }, "Player": { "SeatIndex": 1, "BetStatus": 1, "HoleCards": [5, 21], "Chip": 5750, "BetChip": 200 }, "OtherPlayers": [{ "SeatIndex": 0, "Status": 0, "BetStatus": 1, "Chip": 5850, "BetChip": 100, "IsSafeLeave": false }, { "SeatIndex": 2, "Status": 0, "BetStatus": 1, "Chip": 5950, "BetChip": 0, "IsSafeLeave": false }, { "SeatIndex": 3, "Status": 0, "BetStatus": 1, "Chip": 5950, "BetChip": 0, "IsSafeLeave": false }], "Progress": { "Phase": 0, "NextActionSeat": 2, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 1, "MinRaise": 400, "Pot": 500, "SidePot": [] }, "timestamp": 1752427313426 },
  { "ApiTypeId": 304, "SeatIndex": 2, "ActionType": 2, "Chip": 5950, "BetChip": 0, "Progress": { "Phase": 0, "NextActionSeat": 3, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 1, "MinRaise": 400, "Pot": 500, "SidePot": [] }, "timestamp": 1752427315428 },
  { "ApiTypeId": 304, "SeatIndex": 3, "ActionType": 2, "Chip": 5950, "BetChip": 0, "Progress": { "Phase": 0, "NextActionSeat": 0, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 1, "MinRaise": 400, "Pot": 500, "SidePot": [] }, "timestamp": 1752427316928 },
  { "ApiTypeId": 304, "SeatIndex": 0, "ActionType": 2, "Chip": 5850, "BetChip": 100, "Progress": { "Phase": 3, "NextActionSeat": -2, "NextActionTypes": [], "NextExtraLimitSeconds": 0, "MinRaise": 0, "Pot": 500, "SidePot": [] }, "timestamp": 1752427318516 },
  { "ApiTypeId": 306, "CommunityCards": [], "Pot": 500, "SidePot": [], "ResultType": 0, "DefeatStatus": 0, "HandId": 384370064, "HandLog": "", "Results": [{ "UserId": 4, "HoleCards": [], "RankType": 10, "Hands": [], "HandRanking": 1, "Ranking": -2, "RewardChip": 500 }], "Player": { "SeatIndex": 1, "BetStatus": -1, "Chip": 6250, "BetChip": 0 }, "OtherPlayers": [{ "SeatIndex": 0, "Status": 0, "BetStatus": -1, "Chip": 5850, "BetChip": 0, "IsSafeLeave": false }, { "SeatIndex": 2, "Status": 0, "BetStatus": -1, "Chip": 5950, "BetChip": 0, "IsSafeLeave": false }, { "SeatIndex": 3, "Status": 0, "BetStatus": -1, "Chip": 5950, "BetChip": 0, "IsSafeLeave": false }], "timestamp": 1752427319431 },
]
const HAND1_ID = 384370064
const HAND1_DEAL = HAND1_EVENTS[0]!
const HAND1_RESULTS = HAND1_EVENTS[4]!

// A second, structurally-identical hand shifted well after HAND1 in time,
// with a distinct HandId -- stands in for "a hand that completes via live
// play while a rebuild's snapshot read is in flight" (codex PR #207 P2
// pass-3, "Preserve live hands written after the rebuild snapshot").
const HAND2_ID = 384370065
const HAND2_EVENTS = HAND1_EVENTS.map(event => {
  const clone = JSON.parse(JSON.stringify(event))
  clone.timestamp = (event as { timestamp: number }).timestamp + 1_000_000
  if (clone.ApiTypeId === 306) clone.HandId = HAND2_ID
  return clone
})

// A third, structurally-identical hand slotted chronologically BETWEEN
// ENTRY_QUEUED and HAND1 (still a normal, non-interleaved consecutive hand
// in the same session -- shifted -8000ms keeps its own span from 305426 to
// 311431, entirely before HAND1_DEAL at 313426), but with a distinct HandId.
// Its [timestamp+ApiTypeId] compound key therefore sorts BELOW the
// snapshot's max key (HAND1's EVT_HAND_RESULTS at 319431) even though it
// arrives (in Lake-storage terms) AFTER the snapshot was read. Stands in for
// a live row that lands after the snapshot but does NOT sort after it
// (clock skew, a same-millisecond row with a lower ApiTypeId, etc.) --
// codex PR #207 pass-4, "Merge live rows that do not sort after the
// snapshot". (Shifting it before ENTRY_QUEUED itself, rather than merely
// before HAND1, would desync from the control below: an ordinary import
// processes events in file order rather than re-sorting by timestamp, so a
// hand chronologically preceding its own session-establishing ENTRY_QUEUED
// would attribute session context differently there than in a
// snapshot-order-respecting rebuild -- an artifact of the fixture, not the
// bug this test targets.)
const HAND0_ID = 384370063
const HAND0_EVENTS = HAND1_EVENTS.map(event => {
  const clone = JSON.parse(JSON.stringify(event))
  clone.timestamp = (event as { timestamp: number }).timestamp - 8_000
  if (clone.ApiTypeId === 306) clone.HandId = HAND0_ID
  return clone
})

const toJsonl = (events: unknown[]): string => events.map(event => JSON.stringify(event)).join('\n')

const snapshotDerived = async (db: PokerChaseDB) => ({
  hands: await db.hands.orderBy('id').toArray(),
  phases: await db.phases.orderBy('[handId+phase]').toArray(),
  actions: await db.actions.orderBy('[handId+index]').toArray(),
})

/**
 * Run `fn` against a freshly created DB/service/handlers and always delete
 * the DB afterwards. Sequential (never concurrent) because PokerChaseDB's
 * IndexedDB database name is fixed -- two live instances would share storage.
 */
const runWithFreshDb = async <T>(
  fn: (ctx: { db: PokerChaseDB, service: PokerChaseService, handlers: ReturnType<typeof createImportExportHandlers> }) => Promise<T>
): Promise<T> => {
  const db = new PokerChaseDB(indexedDB, IDBKeyRange)
  await db.open()
  const service = new PokerChaseService({ db })
  await service.ready
  // These tests assert persisted entities directly; the post-import stats
  // broadcast (statsOutputStream -> ReadEntityStream) is irrelevant here and
  // would otherwise race the teardown's db.close() with async DB reads.
  jest.spyOn(service.statsOutputStream, 'write').mockImplementation()
  const handlers = createImportExportHandlers(service, db, 'https://example.com/*')
  try {
    return await fn({ db, service, handlers })
  } finally {
    // Cancel PokerChaseService's pending 500ms-debounced persistState() timer
    // -- without this, it can fire during a LATER test in this file and
    // write this (now-defunct) service's session into the shared
    // chrome.storage.local mock (test-setup.ts's mock storage is a single
    // module-scoped object).
    clearTimeout((service as unknown as { _persistStateTimer?: ReturnType<typeof setTimeout> })._persistStateTimer)
    db.close()
    await db.delete()
  }
}

describe('importData() full rebuild after overlapping imports (audit finding #7, plan C)', () => {
  beforeEach(async () => {
    setOperationState({ type: 'idle' })
    ;(chrome.runtime.sendMessage as jest.Mock).mockClear().mockReturnValue(Promise.resolve())
    await chrome.storage.local.set({ [PokerChaseService.STORAGE_KEY]: undefined, [REBUILD_ADVISORY_STORAGE_KEY]: undefined })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('re-importing a complete export into a DB missing a hand\'s middle ACTIONs rebuilds derived state to match a from-scratch import (rebuild-parity property)', async () => {
    const fullExport = [ENTRY_QUEUED, ...HAND1_EVENTS]

    // Control: the same complete export imported into an empty DB.
    const expected = await runWithFreshDb(async ({ db, handlers }) => {
      await handlers.importData(toJsonl(fullExport))
      return snapshotDerived(db)
    })
    // Sanity on the control itself -- if this fails the fixture is broken.
    expect(expected.hands).toHaveLength(1)
    expect(expected.actions.length).toBeGreaterThan(0)

    await runWithFreshDb(async ({ db, handlers }) => {
      // Damaged DB (the audit's exact scenario): the hand's DEAL and RESULTS
      // raw rows exist, the middle ACTIONs were lost (e.g. a capture gap).
      await db.apiEvents.bulkAdd([ENTRY_QUEUED, HAND1_DEAL, HAND1_RESULTS] as never[])
      // Its derived state reflects that damage: the hand exists (chimeric --
      // DEAL+RESULTS but no ACTIONs), exactly what a rebuild over the
      // damaged Lake yields.
      await handlers.rebuildAllData()
      expect(await db.hands.count()).toBe(1)
      expect(await db.actions.count()).toBe(0)

      // Re-import the complete export: DEAL/RESULTS/201 dedupe away, only
      // the 3 ACTION rows are new -- this is a non-empty DB receiving new
      // rows, so importData() must run a full rebuild rather than an
      // incremental conversion of just the 3 new ACTION events (which,
      // lacking DEAL/RESULTS context in the same EntityConverter call,
      // could never form a hand on their own).
      const result = await handlers.importData(toJsonl(fullExport))
      expect(result.successCount).toBe(3)
      expect(result.duplicateCount).toBe(3)

      // Derived state must now be complete AND non-duplicated -- identical
      // to a from-scratch import of the same data.
      const repaired = await snapshotDerived(db)
      expect(repaired).toEqual(expected)
      expect(repaired.actions.filter(action => action.handId === HAND1_ID)).toHaveLength(3)
      expect(await db.hands.count()).toBe(1)
    })
  })

  test('a pure-duplicate import into a non-empty DB does not trigger a rebuild and leaves derived state unchanged', async () => {
    const fullExport = [ENTRY_QUEUED, ...HAND1_EVENTS]

    await runWithFreshDb(async ({ db, handlers }) => {
      // Seed a complete, healthy hand via a normal (empty-DB) import.
      await handlers.importData(toJsonl(fullExport))
      const before = await snapshotDerived(db)
      expect(before.hands).toHaveLength(1)

      // Only messages sent by the *next* (duplicate) import matter here --
      // clear the mock's call history accumulated by the seed import above
      // (chrome.runtime.sendMessage is a module-scoped jest.fn shared across
      // tests in this file/test-setup.ts, not auto-reset between calls).
      ;(chrome.runtime.sendMessage as jest.Mock).mockClear()

      // Spy on the entity-table clear that only `performFullRebuild` issues
      // (both `rebuildAllData` and importData's non-empty-DB rebuild branch
      // share that one code path) -- a pure-duplicate import must never
      // reach it. This is a more precise probe than spying on the exported
      // `rebuildAllData` handler, since importData() invokes the shared
      // internal rebuild routine directly rather than going through that
      // public entry point.
      const handsClearSpy = jest.spyOn(db.hands, 'clear')

      // Re-import the exact same complete export: every row is a duplicate,
      // zero new raw rows are stored.
      const result = await handlers.importData(toJsonl(fullExport))
      expect(result.successCount).toBe(0)
      expect(result.duplicateCount).toBe(fullExport.length)

      // No rebuild was invoked.
      expect(handsClearSpy).not.toHaveBeenCalled()
      const rebuildProgressCalls = (chrome.runtime.sendMessage as jest.Mock).mock.calls
        .filter(([msg]) => (msg as { action?: string })?.action === 'rebuildProgress')
      expect(rebuildProgressCalls).toHaveLength(0)

      const after = await snapshotDerived(db)
      expect(after).toEqual(before)
    })
  })

  test('a failed post-import rebuild surfaces as an import error, keeps the newly-stored raw rows, AND leaves the old derived rows untouched (codex PR #207 P2)', async () => {
    const fullExport = [ENTRY_QUEUED, ...HAND1_EVENTS]

    await runWithFreshDb(async ({ db, handlers }) => {
      // Damaged DB, same as the parity test: DEAL+RESULTS present, ACTIONs
      // missing -- so the re-import below stores new raw rows into a
      // non-empty DB and importData() must attempt a full rebuild.
      await db.apiEvents.bulkAdd([ENTRY_QUEUED, HAND1_DEAL, HAND1_RESULTS] as never[])
      await handlers.rebuildAllData()

      // Snapshot the derived state produced by that successful rebuild --
      // chimeric (hand exists, zero actions), but it's real, previously
      // working HUD data. A failed rebuild attempt below must leave this
      // exactly as-is: `performFullRebuild()` used to clear hands/phases/
      // actions BEFORE attempting conversion/save, so a conversion or
      // save failure left the tables empty -- strictly worse than the
      // pre-import staleness this whole feature exists to fix. The fix
      // defers the clear until it can be committed atomically together
      // with the new data (a single Dexie 'rw' transaction), so a failure
      // after that point rolls the clear back too.
      const beforeFailedRebuild = await snapshotDerived(db)
      expect(beforeFailedRebuild.hands).toHaveLength(1)
      expect(beforeFailedRebuild.actions).toHaveLength(0)

      // Force the rebuild's entity-generation step to blow up -- this runs
      // BEFORE any table is touched (see performFullRebuild's JSDoc), so
      // it's the cleanest failure point to prove "nothing was written yet"
      // survives. A failure inside the write transaction itself (e.g. a
      // bulkPut quota error) is covered by the same atomicity guarantee and
      // is exercised implicitly: Dexie either commits the whole
      // clear+bulkPut+meta.put transaction or none of it.
      const converterError = new Error('synthetic rebuild failure')
      const EntityConverterModule = await import('../entity-converter')
      const convertSpy = jest.spyOn(EntityConverterModule.EntityConverter.prototype, 'convertEventsToEntities')
        .mockImplementation(() => { throw converterError })

      await expect(handlers.importData(toJsonl(fullExport))).rejects.toThrow(/rebuild failed/i)

      convertSpy.mockRestore()

      // Raw rows are committed regardless of rebuild outcome (Raw Event
      // Lake write happens before the rebuild is attempted) -- the 3 new
      // ACTION rows must still be present.
      const rawCount = await db.apiEvents.count()
      expect(rawCount).toBe(fullExport.length) // 201 + DEAL + 3 ACTIONs + RESULTS, all now stored

      // The invariant this test exists to prove: derived state after a
      // failed rebuild must be byte-identical to derived state before the
      // attempt -- import must never leave derived data worse than it
      // found it. NOT empty tables, NOT a partial write -- the untouched
      // pre-attempt snapshot.
      const afterFailedRebuild = await snapshotDerived(db)
      expect(afterFailedRebuild).toEqual(beforeFailedRebuild)

      // An error rebuildProgress message was surfaced (per #202's
      // error-surfacing contract, preserved for the import-triggered path).
      const errorMessages = (chrome.runtime.sendMessage as jest.Mock).mock.calls
        .map(([msg]) => msg as { action?: string, state?: string })
        .filter(msg => msg?.action === 'rebuildProgress' && msg?.state === 'error')
      expect(errorMessages.length).toBeGreaterThan(0)
    })
  })

  describe('service-worker keepalive during an import-triggered rebuild (codex PR #207 P2 pass-3, "Keep the worker alive during import-triggered rebuilds")', () => {
    afterEach(() => {
      jest.restoreAllMocks()
    })

    test('engages the same 25s keepalive interval startKeepAlive() uses (export paths), and stops it once the import-triggered rebuild completes', async () => {
      const fullExport = [ENTRY_QUEUED, ...HAND1_EVENTS]

      // Real timers throughout -- fake-indexeddb dispatches its events via
      // real setImmediate/timers internally, so freezing timers here would
      // deadlock the DB operations. We don't need time to actually elapse:
      // we just need to observe that startKeepAlive()'s setInterval(...,
      // 25000) was armed and later torn down; the callback itself is
      // invoked directly below rather than by waiting out a real 25s.
      chrome.runtime.getPlatformInfo = jest.fn().mockResolvedValue({})

      await runWithFreshDb(async ({ db, handlers }) => {
        // Damaged DB, same setup as the parity test: DEAL+RESULTS present,
        // ACTIONs missing -- the re-import below stores new raw rows into a
        // non-empty DB, so importData() must run the full rebuild path.
        await db.apiEvents.bulkAdd([ENTRY_QUEUED, HAND1_DEAL, HAND1_RESULTS] as never[])

        const setIntervalSpy = jest.spyOn(global, 'setInterval')
        const clearIntervalSpy = jest.spyOn(global, 'clearInterval')

        await handlers.importData(toJsonl(fullExport))

        // startKeepAlive()'s observable effect (import-export.ts): a
        // setInterval(..., 25000) that pings an Extension API on a timer to
        // keep the MV3 service worker from being reaped mid-rebuild.
        const keepAliveCallIndex = setIntervalSpy.mock.calls.findIndex(([, delay]) => delay === 25000)
        expect(keepAliveCallIndex).toBeGreaterThanOrEqual(0)

        // Invoking the captured callback directly proves it's really
        // startKeepAlive()'s ping (not some unrelated 25000ms timer that
        // happens to share the delay).
        const keepAliveFn = setIntervalSpy.mock.calls[keepAliveCallIndex]![0] as () => void
        keepAliveFn()
        expect(chrome.runtime.getPlatformInfo).toHaveBeenCalled()

        // The interval was torn down again (stopKeepAlive() ran in
        // performFullRebuild's `finally`), not left dangling after the
        // import completed -- clean up the real interval either way so it
        // can't fire after this test ends.
        const keepAliveIntervalId = setIntervalSpy.mock.results[keepAliveCallIndex]!.value
        expect(clearIntervalSpy).toHaveBeenCalledWith(keepAliveIntervalId)
        clearInterval(keepAliveIntervalId)
      })
    })
  })

  describe('preserving live hands written after the rebuild snapshot (codex PR #207 P2 pass-3, "Preserve live hands written after the rebuild snapshot")', () => {
    afterEach(() => {
      jest.restoreAllMocks()
    })

    test('a hand completing via live play while the rebuild snapshot is being read/converted is not lost, and derives correctly alongside the snapshot hand', async () => {
      const fullExport = [ENTRY_QUEUED, ...HAND1_EVENTS]

      // Control: a from-scratch import of BOTH hands into an empty DB --
      // the target shape the "live write survives" path must match.
      const expected = await runWithFreshDb(async ({ db, handlers }) => {
        await handlers.importData(toJsonl([...fullExport, ...HAND2_EVENTS]))
        return snapshotDerived(db)
      })
      expect(expected.hands).toHaveLength(2)

      await runWithFreshDb(async ({ db, handlers }) => {
        // Damaged DB, same setup as the parity test: DEAL+RESULTS present
        // for HAND1, ACTIONs missing -- the re-import below stores new raw
        // rows into a non-empty DB, triggering importData()'s rebuild path.
        await db.apiEvents.bulkAdd([ENTRY_QUEUED, HAND1_DEAL, HAND1_RESULTS] as never[])

        // Hook the FIRST call to orderAndFilterApplicationEventsForReplay -- this is
        // performFullRebuild's snapshot-processing call (the empty-DB
        // import path above never calls it; a possible second call, if the
        // fix's merge-and-redo path fires, is left untouched below). Right
        // as the snapshot is being processed, simulate HAND2 completing via
        // live play: WriteEntityStream (write-entity-stream.ts) writes
        // straight to hands/phases/actions regardless of service.batchMode
        // (see performFullRebuild's JSDoc) -- reproduced here by directly
        // deriving HAND2 with a throwaway EntityConverter and bulkPutting
        // it, plus storing its raw events into apiEvents (event-ingestion.ts's
        // job, simulated directly since that pipeline isn't wired up in this
        // unit test).
        let hooked = false
        // Capture the real implementation BEFORE spying -- jest.spyOn
        // mutates the shared module-namespace object in place, so calling
        // through via jest.requireActual() here would return that SAME
        // (already-mutated) object and recurse into the mock forever.
        const originalOrderAndFilter = databaseUtils.orderAndFilterApplicationEventsForReplay
        const filterSpy = jest.spyOn(databaseUtils, 'orderAndFilterApplicationEventsForReplay')
          .mockImplementation(async (rawEvents) => {
            const result = await originalOrderAndFilter(rawEvents)
            if (!hooked) {
              hooked = true
              await db.apiEvents.bulkAdd(HAND2_EVENTS as never[])
              const liveEntities = new EntityConverter({
                id: undefined, battleType: undefined, name: undefined, players: new Map(), reset: () => { }
              }).convertEventsToEntities(HAND2_EVENTS as never[])
              await db.hands.bulkPut(liveEntities.hands)
              await db.phases.bulkPut(liveEntities.phases)
              await db.actions.bulkPut(liveEntities.actions)
            }
            return result
          })

        const result = await handlers.importData(toJsonl(fullExport))
        expect(result.successCount).toBe(3) // the 3 missing HAND1 ACTIONs

        filterSpy.mockRestore()

        // HAND2 (the "live" hand) must survive AND be correctly derived --
        // not merely present-but-stale, not lost to the clear() -- matching
        // the from-scratch control exactly for both hands.
        const repaired = await snapshotDerived(db)
        expect(repaired).toEqual(expected)
        expect(repaired.hands.map(h => h.id).sort()).toEqual([HAND1_ID, HAND2_ID].sort())

        // Raw Lake integrity: both hands' raw events are present regardless.
        const rawCount = await db.apiEvents.count()
        expect(rawCount).toBe(fullExport.length + HAND2_EVENTS.length)
      })
    })

    test('a live hand whose raw rows arrive after the snapshot but sort BELOW the snapshot boundary key is still preserved (codex PR #207 pass-4, "Merge live rows that do not sort after the snapshot")', async () => {
      const fullExport = [ENTRY_QUEUED, ...HAND1_EVENTS]

      // Control: a from-scratch import of both hands into an empty DB, in
      // chronological order (ENTRY_QUEUED, then HAND0, then HAND1) --
      // matching how the rebuild path (which reads apiEvents sorted by
      // [timestamp+ApiTypeId]) will see them, so this is a true apples-to-
      // apples control rather than an artifact of file ordering.
      const expected = await runWithFreshDb(async ({ db, handlers }) => {
        await handlers.importData(toJsonl([ENTRY_QUEUED, ...HAND0_EVENTS, ...HAND1_EVENTS]))
        return snapshotDerived(db)
      })
      expect(expected.hands).toHaveLength(2)

      await runWithFreshDb(async ({ db, handlers }) => {
        // Damaged DB, same setup as the parity test.
        await db.apiEvents.bulkAdd([ENTRY_QUEUED, HAND1_DEAL, HAND1_RESULTS] as never[])

        // Hook the first orderAndFilterApplicationEventsForReplay call (the snapshot
        // processing step) to inject HAND0 -- whose [timestamp+ApiTypeId]
        // keys sort BELOW every row already in the snapshot (HAND0_EVENTS
        // is timestamped 2,000,000ms before HAND1). A boundary-comparison
        // recheck (`.where(...).above(snapshotUpperBound)`) would miss
        // this entirely, since it only looks for keys greater than the
        // snapshot's own max key -- exactly the bug this test targets.
        const originalOrderAndFilter = databaseUtils.orderAndFilterApplicationEventsForReplay
        let hooked = false
        const filterSpy = jest.spyOn(databaseUtils, 'orderAndFilterApplicationEventsForReplay')
          .mockImplementation(async (rawEvents) => {
            const result = await originalOrderAndFilter(rawEvents)
            if (!hooked) {
              hooked = true
              await db.apiEvents.bulkAdd(HAND0_EVENTS as never[])
              const liveEntities = new EntityConverter({
                id: undefined, battleType: undefined, name: undefined, players: new Map(), reset: () => { }
              }).convertEventsToEntities(HAND0_EVENTS as never[])
              await db.hands.bulkPut(liveEntities.hands)
              await db.phases.bulkPut(liveEntities.phases)
              await db.actions.bulkPut(liveEntities.actions)
            }
            return result
          })

        const result = await handlers.importData(toJsonl(fullExport))
        expect(result.successCount).toBe(3) // the 3 missing HAND1 ACTIONs

        filterSpy.mockRestore()

        // HAND0 (the low-key "live" hand) must survive AND be correctly
        // derived -- matching the from-scratch control for both hands,
        // regardless of key ordering.
        const repaired = await snapshotDerived(db)
        expect(repaired).toEqual(expected)
        expect(repaired.hands.map(h => h.id).sort()).toEqual([HAND0_ID, HAND1_ID].sort())

        const rawCount = await db.apiEvents.count()
        expect(rawCount).toBe(fullExport.length + HAND0_EVENTS.length)
      })
    })
  })

  describe('recheck apiEvents before clearing the zero-count path (codex PR #207 pass-4, "Recheck apiEvents before clearing the zero-count path")', () => {
    afterEach(() => {
      jest.restoreAllMocks()
    })

    test('a live hand that lands right after apiEvents.count() reports 0 -- but before the rebuild clears the tables -- is not lost', async () => {
      // Control: a from-scratch import of the (soon-to-be "live") hand into
      // an empty DB.
      const expected = await runWithFreshDb(async ({ db, handlers }) => {
        await handlers.importData(toJsonl(HAND1_EVENTS))
        return snapshotDerived(db)
      })
      expect(expected.hands).toHaveLength(1)

      await runWithFreshDb(async ({ db, handlers }) => {
        // apiEvents starts genuinely empty -- this is the manual "データ再構築"
        // button scenario codex's finding describes (rebuildAllData on an
        // empty Lake), not an import.
        expect(await db.apiEvents.count()).toBe(0)

        // Hook the FIRST db.apiEvents.count() call (performFullRebuild's
        // initial, non-authoritative estimate) to inject a live hand right
        // after it observes 0 -- simulating event-ingestion.ts storing the
        // raw rows and WriteEntityStream writing the derived hand in the
        // gap between that estimate and the final clear+write transaction.
        const originalCount = db.apiEvents.count.bind(db.apiEvents)
        let hooked = false
        const countSpy = jest.spyOn(db.apiEvents, 'count').mockImplementation((async () => {
          const result = await originalCount()
          if (!hooked && result === 0) {
            hooked = true
            await db.apiEvents.bulkAdd(HAND1_EVENTS as never[])
            const liveEntities = new EntityConverter({
              id: undefined, battleType: undefined, name: undefined, players: new Map(), reset: () => { }
            }).convertEventsToEntities(HAND1_EVENTS as never[])
            await db.hands.bulkPut(liveEntities.hands)
            await db.phases.bulkPut(liveEntities.phases)
            await db.actions.bulkPut(liveEntities.actions)
          }
          return result
        }) as unknown as typeof db.apiEvents.count)

        await handlers.rebuildAllData()

        countSpy.mockRestore()

        // The live hand must survive the rebuild -- not cleared and left
        // unrebuilt under the old "count() said 0, so just clear and
        // report done" shortcut.
        const repaired = await snapshotDerived(db)
        expect(repaired).toEqual(expected)
        expect(await db.hands.count()).toBe(1)
      })
    })
  })

  describe('retry rebuild after a failed import instead of silently skipping duplicates (codex PR #207 pass-4, "Retry rebuild after failed import instead of skipping duplicates")', () => {
    afterEach(() => {
      jest.restoreAllMocks()
    })

    test('a failed post-import rebuild marks the rebuild advisory pending, so a later successful rebuild is what actually repairs the derived data', async () => {
      const fullExport = [ENTRY_QUEUED, ...HAND1_EVENTS]

      await runWithFreshDb(async ({ db, handlers }) => {
        // Damaged DB, same setup as the parity test: DEAL+RESULTS present,
        // ACTIONs missing -- the re-import below stores new raw rows into a
        // non-empty DB and triggers importData()'s rebuild path.
        await db.apiEvents.bulkAdd([ENTRY_QUEUED, HAND1_DEAL, HAND1_RESULTS] as never[])
        await handlers.rebuildAllData()

        expect((await getRebuildAdvisoryState()).pendingVersion).toBeUndefined()

        // Force the rebuild to fail.
        const convertSpy = jest.spyOn(EntityConverter.prototype, 'convertEventsToEntities')
          .mockImplementation(() => { throw new Error('synthetic rebuild failure') })

        await expect(handlers.importData(toJsonl(fullExport))).rejects.toThrow(/rebuild failed/i)

        convertSpy.mockRestore()

        // The failure must not be a dead end: marking the advisory pending
        // is what lets the user retry via the "データ再構築" button even
        // though a naive re-import of the same file would now just see
        // duplicates and skip the rebuild entirely (see the next assertion).
        expect((await getRebuildAdvisoryState()).pendingVersion).toBe(REBUILD_ADVISORY_VERSION)

        // Confirms the actual dead end this test guards against: retrying
        // the SAME import is a no-op for the rebuild (every row is now a
        // duplicate), so the advisory marker is genuinely the only path to
        // recovery here, not an incidental side effect.
        const retryResult = await handlers.importData(toJsonl(fullExport))
        expect(retryResult.successCount).toBe(0)
        expect(retryResult.duplicateCount).toBe(fullExport.length)
        expect(await db.actions.count()).toBe(0) // still chimeric -- the retried import did not repair it

        // The advisory-driven recovery path: the user clicks "データ再構築".
        await handlers.rebuildAllData()

        const repaired = await snapshotDerived(db)
        expect(repaired.actions.filter(a => a.handId === HAND1_ID)).toHaveLength(3)
        expect((await getRebuildAdvisoryState()).pendingVersion).toBeUndefined()
      })
    })

    test('a failed first import marks the rebuild advisory pending because retrying the same file only sees duplicates', async () => {
      const fullExport = [ENTRY_QUEUED, ...HAND1_EVENTS]

      await runWithFreshDb(async ({ db, handlers }) => {
        expect(await db.apiEvents.count()).toBe(0)
        expect((await getRebuildAdvisoryState()).pendingVersion).toBeUndefined()

        const convertSpy = jest.spyOn(EntityConverter.prototype, 'convertEventsToEntities')
          .mockImplementation(() => { throw new Error('synthetic initial entity-generation failure') })

        await expect(handlers.importData(toJsonl(fullExport))).rejects.toThrow(/entity generation failed/i)
        convertSpy.mockRestore()

        // Raw rows landed before entity generation failed, so the next import
        // is no longer an "empty DB" import even though no derived rows exist.
        expect(await db.apiEvents.count()).toBe(fullExport.length)
        expect(await db.hands.count()).toBe(0)
        expect(await db.actions.count()).toBe(0)

        // Required recovery invariant: the user must keep seeing the manual
        // rebuild prompt, because retrying this exact file cannot trigger the
        // non-empty/new-row rebuild branch (all rows are now duplicates).
        expect((await getRebuildAdvisoryState()).pendingVersion).toBe(REBUILD_ADVISORY_VERSION)

        const retryResult = await handlers.importData(toJsonl(fullExport))
        expect(retryResult.successCount).toBe(0)
        expect(retryResult.duplicateCount).toBe(fullExport.length)
        expect(await db.hands.count()).toBe(0)
      })
    })
  })
})
