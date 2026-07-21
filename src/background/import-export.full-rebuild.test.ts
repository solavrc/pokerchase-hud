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
    await chrome.storage.local.set({ [PokerChaseService.STORAGE_KEY]: undefined })
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

  test('a failed post-import rebuild surfaces as an import error and keeps the newly-stored raw rows', async () => {
    const fullExport = [ENTRY_QUEUED, ...HAND1_EVENTS]

    await runWithFreshDb(async ({ db, handlers }) => {
      // Damaged DB, same as the parity test: DEAL+RESULTS present, ACTIONs
      // missing -- so the re-import below stores new raw rows into a
      // non-empty DB and importData() must attempt a full rebuild.
      await db.apiEvents.bulkAdd([ENTRY_QUEUED, HAND1_DEAL, HAND1_RESULTS] as never[])
      await handlers.rebuildAllData()

      // Force the rebuild's entity-generation step to blow up.
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

      // An error rebuildProgress message was surfaced (per #202's
      // error-surfacing contract, preserved for the import-triggered path).
      const errorMessages = (chrome.runtime.sendMessage as jest.Mock).mock.calls
        .map(([msg]) => msg as { action?: string, state?: string })
        .filter(msg => msg?.action === 'rebuildProgress' && msg?.state === 'error')
      expect(errorMessages.length).toBeGreaterThan(0)
    })
  })
})
