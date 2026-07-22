/**
 * rebuildAllData() - Raw Event Lake recovery path
 *
 * Proves the core claim of the Lake redesign: rebuildAllData re-validates
 * every raw apiEvents row (via filterValidApplicationEvents) immediately
 * before EntityConverter, rather than trusting whatever's stored. This is
 * what makes rebuild the *entire* recovery mechanism after a PokerChase
 * schema break gets fixed -- no separate dead-letter/promotion table is
 * needed, because the exact same raw row already sitting in apiEvents gets
 * re-parsed against the current schema on every rebuild.
 *
 * This test is deliberately schema-agnostic: it doesn't depend on the
 * parallel EVT_SESSION_RESULTS schema fix (PR #134 / branch
 * fix/session-results-schema-legend-season3, not merged into this branch).
 * Instead it proves the generic mechanism -- a raw row that fails today
 * would be recovered by a future schema fix, and a raw row that already
 * passes gets converted into entities purely by re-reading apiEvents, with
 * no promotion step. The concrete real-world instance of this mechanism
 * (season-3 EVT_SESSION_RESULTS) is exercised by the verify-stats gate
 * against real captures once both PRs land.
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { createImportExportHandlers } from './import-export'
import { HandLogExporter } from '../utils/hand-log-exporter'

// A known-good hand (EVT_DEAL -> 3x EVT_ACTION -> EVT_HAND_RESULTS), copied
// verbatim from src/app.test.ts's event_timeline fixture (already exercised
// there against the real stats pipeline) so this test isn't hand-authoring
// a new Zod-shaped fixture from scratch.
const VALID_HAND_EVENTS = [
  { "ApiTypeId": 303, "SeatUserIds": [2, 4, 3, 1], "Game": { "CurrentBlindLv": 1, "NextBlindUnixSeconds": 1752427424, "Ante": 50, "SmallBlind": 100, "BigBlind": 200, "ButtonSeat": 3, "SmallBlindSeat": 0, "BigBlindSeat": 1 }, "Player": { "SeatIndex": 1, "BetStatus": 1, "HoleCards": [5, 21], "Chip": 5750, "BetChip": 200 }, "OtherPlayers": [{ "SeatIndex": 0, "Status": 0, "BetStatus": 1, "Chip": 5850, "BetChip": 100, "IsSafeLeave": false }, { "SeatIndex": 2, "Status": 0, "BetStatus": 1, "Chip": 5950, "BetChip": 0, "IsSafeLeave": false }, { "SeatIndex": 3, "Status": 0, "BetStatus": 1, "Chip": 5950, "BetChip": 0, "IsSafeLeave": false }], "Progress": { "Phase": 0, "NextActionSeat": 2, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 1, "MinRaise": 400, "Pot": 500, "SidePot": [] }, "timestamp": 1752427313426 },
  { "ApiTypeId": 304, "SeatIndex": 2, "ActionType": 2, "Chip": 5950, "BetChip": 0, "Progress": { "Phase": 0, "NextActionSeat": 3, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 1, "MinRaise": 400, "Pot": 500, "SidePot": [] }, "timestamp": 1752427315428 },
  { "ApiTypeId": 304, "SeatIndex": 3, "ActionType": 2, "Chip": 5950, "BetChip": 0, "Progress": { "Phase": 0, "NextActionSeat": 0, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 1, "MinRaise": 400, "Pot": 500, "SidePot": [] }, "timestamp": 1752427316928 },
  { "ApiTypeId": 304, "SeatIndex": 0, "ActionType": 2, "Chip": 5850, "BetChip": 100, "Progress": { "Phase": 3, "NextActionSeat": -2, "NextActionTypes": [], "NextExtraLimitSeconds": 0, "MinRaise": 0, "Pot": 500, "SidePot": [] }, "timestamp": 1752427318516 },
  { "ApiTypeId": 306, "CommunityCards": [], "Pot": 500, "SidePot": [], "ResultType": 0, "DefeatStatus": 0, "HandId": 384370064, "HandLog": "", "Results": [{ "UserId": 4, "HoleCards": [], "RankType": 10, "Hands": [], "HandRanking": 1, "Ranking": -2, "RewardChip": 500 }], "Player": { "SeatIndex": 1, "BetStatus": -1, "Chip": 6250, "BetChip": 0 }, "OtherPlayers": [{ "SeatIndex": 0, "Status": 0, "BetStatus": -1, "Chip": 5850, "BetChip": 0, "IsSafeLeave": false }, { "SeatIndex": 2, "Status": 0, "BetStatus": -1, "Chip": 5950, "BetChip": 0, "IsSafeLeave": false }, { "SeatIndex": 3, "Status": 0, "BetStatus": -1, "Chip": 5950, "BetChip": 0, "IsSafeLeave": false }], "timestamp": 1752427319431 },
]

describe('rebuildAllData Raw Event Lake recovery', () => {
  let db: PokerChaseDB
  let service: PokerChaseService

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = new PokerChaseService({ db })
    await service.ready

    // rebuildAllData chains .catch() off chrome.runtime.sendMessage(); the
    // shared test-setup.ts mock returns undefined by default (no implementation)
    ;(chrome.runtime.sendMessage as jest.Mock).mockReturnValue(Promise.resolve())
  })

  afterEach(async () => {
    db.close()
    await db.delete()
  })

  test('rebuild converts a valid hand purely from raw apiEvents rows, tolerating noise/malformed rows alongside it', async () => {
    // Seed apiEvents directly (bypassing event-ingestion.ts) to simulate rows
    // that arrived and were stored by the Lake at some point in the past.
    await db.apiEvents.bulkAdd(VALID_HAND_EVENTS as any)

    // Noise that must NOT crash the rebuild and must NOT produce any entity:
    // a malformed application-type event (still fails today -- no schema fix
    // for it), a known non-application event, and an unknown ApiTypeId.
    await db.apiEvents.bulkAdd([
      { ApiTypeId: 303, timestamp: 999999999 }, // malformed EVT_DEAL, still invalid
      { ApiTypeId: 202, timestamp: 1000000000, Code: 0 }, // known non-app event
      { ApiTypeId: 9999, timestamp: 1000000001, Unknown: true }, // unknown type
    ] as any)

    const handlers = createImportExportHandlers(service, db, 'https://example.com/*')
    const clearCache = jest.spyOn(HandLogExporter, 'clearCache')
    await expect(handlers.rebuildAllData()).resolves.toBeUndefined()
    expect(clearCache).toHaveBeenCalledTimes(1)

    const hand = await db.hands.get(384370064)
    expect(hand).toBeDefined()
    expect(hand?.winningPlayerIds).toEqual([4])
    expect(hand?.seatUserIds).toEqual([2, 4, 3, 1])

    const actions = await db.actions.where('handId').equals(384370064).toArray()
    expect(actions.length).toBeGreaterThan(0)

    const phases = await db.phases.where('handId').equals(384370064).toArray()
    expect(phases.length).toBeGreaterThan(0)

    // Noise rows are untouched raw rows in apiEvents -- nothing was lost or
    // silently rewritten, and none of it produced a spurious entity.
    expect(await db.apiEvents.count()).toBe(VALID_HAND_EVENTS.length + 3)
    expect(await db.hands.count()).toBe(1)
  })

  test('a raw row that now parses under the current schema is picked up automatically -- no promotion step', async () => {
    // Simulates "this row failed to parse when first stored (an old/foreign
    // PokerChase payload shape), but the schema has since been fixed": for
    // the test, that just means the raw row IS today a fully valid
    // application event. The mechanism under test is generic re-validation
    // on rebuild, not any specific historical schema diff.
    await db.apiEvents.bulkAdd(VALID_HAND_EVENTS as any)

    const handlers = createImportExportHandlers(service, db, 'https://example.com/*')
    await handlers.rebuildAllData()

    // Sanity: without any dead-letter/promotion table anywhere in this
    // codebase, the hand is still recovered purely by re-reading apiEvents.
    expect(await db.hands.count()).toBe(1)
    expect((db as any).deadLetterEvents).toBeUndefined()
  })

  test('rebuild is a safe no-op-for-entities when apiEvents contains only unparseable/non-application rows', async () => {
    await db.apiEvents.bulkAdd([
      { ApiTypeId: 303, timestamp: 1 }, // malformed EVT_DEAL
      { ApiTypeId: 202, timestamp: 2, Code: 0 }, // non-app
      { ApiTypeId: 9999, timestamp: 3 }, // unknown
    ] as any)

    const handlers = createImportExportHandlers(service, db, 'https://example.com/*')
    await expect(handlers.rebuildAllData()).resolves.toBeUndefined()

    expect(await db.hands.count()).toBe(0)
    expect(await db.actions.count()).toBe(0)
    // The raw rows themselves are untouched -- still there for a future
    // rebuild once/if a schema fix makes them parseable.
    expect(await db.apiEvents.count()).toBe(3)
  })
})
