/**
 * importData() - overlap import repair of derived entities (independent
 * release-audit finding #7)
 *
 * `importData()` stores every new raw line into the apiEvents Lake, but used
 * to feed ONLY the newly-stored events to `EntityConverter`. EntityConverter
 * can only form a hand from a contiguous EVT_DEAL(303) -> ... ->
 * EVT_HAND_RESULTS(306) event run, so when an import partially overlapped
 * existing data -- e.g. re-importing a complete export into a DB that already
 * had a hand's DEAL and RESULTS but was missing the middle ACTIONs -- the new
 * ACTION rows were severed from their duplicate-excluded DEAL/RESULTS,
 * couldn't form a hand boundary, and were silently dropped by the converter:
 * the raw Lake got repaired but the derived hands/phases/actions (and every
 * stat computed from them) stayed stale until a later full rebuild.
 *
 * The fix (see `collectOverlapRepairEvents()` in import-export.ts): when the
 * DB already contained events before the import, the derived-entity pass
 * re-reads the affected range from the Lake -- expanded backwards to the last
 * EVT_ENTRY_QUEUED(201) at/before the earliest new event (hand boundary AND
 * session-context start) and forwards to the first EVT_HAND_RESULTS(306)
 * at/after the latest new event -- and re-derives entities from existing and
 * new rows together. Re-deriving hands already present is idempotent: hands
 * (id), phases ([handId+phase]) and actions ([handId+index]) all have
 * deterministic keys and `saveEntities()` uses bulkPut.
 *
 * Each scenario below asserts the repaired DB's derived state deep-equals a
 * control DB produced by importing the same complete export into an empty DB
 * (complete AND non-duplicated), per the audit's suggested regression test:
 * "DEAL/RESULTS既存・ACTION欠落のDBへ完全exportをimportし、action/statが
 * 再構築されることを確認する".
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
const HAND1_ACTIONS = HAND1_EVENTS.slice(1, 4)
const HAND1_RESULTS = HAND1_EVENTS[4]!

// Structurally identical hands shifted in time with distinct HandIds, for
// boundary/range-scoping assertions.
const shiftHand = (deltaMs: number, handId: number) => HAND1_EVENTS.map(event => {
  const clone = JSON.parse(JSON.stringify(event))
  clone.timestamp = (event as { timestamp: number }).timestamp + deltaMs
  if (clone.ApiTypeId === 306) clone.HandId = handId
  return clone
})

// A second hand strictly after HAND1.
const HAND2_ID = 384370065
const HAND2_EVENTS = shiftHand(1_000_000, HAND2_ID)

// A hand strictly before HAND1 (still after ENTRY_QUEUED's timestamp).
const HAND0_ID = 384370063
const HAND0_EVENTS = shiftHand(-10_000, HAND0_ID)

// An MTT table-move EVT_ENTRY_QUEUED injected INSIDE HAND1 (between its
// EVT_DEAL at ...313426 and its first EVT_ACTION at ...315428) -- the repo
// documents 201 can land mid-hand on MTT table moves (docs/api-events.md).
const MID_HAND_ENTRY_QUEUED = { ...ENTRY_QUEUED, "timestamp": 1752427314500 }

// A malformed EVT_HAND_RESULTS Lake row (numeric timestamp+ApiTypeId only --
// stored raw per the Lake rules, but unparseable under the current schema),
// sitting between HAND1's last ACTION (...318516) and its valid RESULTS
// (...319431).
const MALFORMED_RESULTS_ROW = { "ApiTypeId": 306, "timestamp": 1752427319000 }

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
    db.close()
    await db.delete()
  }
}

describe('importData() overlap import repair (audit finding #7)', () => {
  beforeEach(() => {
    setOperationState({ type: 'idle' })
    ;(chrome.runtime.sendMessage as jest.Mock).mockReturnValue(Promise.resolve())
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('re-importing a complete export into a DB missing a hand\'s middle ACTIONs repairs the derived actions', async () => {
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
      // Its derived state reflects that damage: the hand exists, but with
      // zero actions -- exactly what a rebuild over the damaged Lake yields.
      await handlers.rebuildAllData()
      expect(await db.hands.count()).toBe(1)
      expect(await db.actions.count()).toBe(0)

      // Re-import the complete export: DEAL/RESULTS/201 dedupe away, only
      // the 3 ACTION rows are new.
      const result = await handlers.importData(toJsonl(fullExport))
      expect(result.successCount).toBe(3)
      expect(result.duplicateCount).toBe(3)

      // Derived state must now be complete AND non-duplicated -- identical
      // to a from-scratch import of the same data.
      const repaired = await snapshotDerived(db)
      expect(repaired).toEqual(expected)
      expect(repaired.actions.filter(action => action.handId === HAND1_ID)).toHaveLength(3)
      // Session context was recovered from the EVT_ENTRY_QUEUED anchor, even
      // though the 201 itself was a duplicate (not part of the new events).
      expect(repaired.hands[0]!.session).toMatchObject({ id: 'stage000_003', battleType: 0 })
      expect(await db.hands.count()).toBe(1)
    })
  })

  test('an appended import that completes an unfinished tail hand (existing DEAL, imported ACTIONs+RESULTS) derives the hand', async () => {
    await runWithFreshDb(async ({ db, handlers }) => {
      // The Lake ends mid-hand: DEAL stored, rest never arrived (e.g. crash).
      await db.apiEvents.bulkAdd([ENTRY_QUEUED, HAND1_DEAL] as never[])

      // Import brings the remainder of the hand -- all strictly newer than
      // anything in the DB (pure append), yet still overlap-repair territory
      // because the hand boundary spans existing and new rows.
      const result = await handlers.importData(toJsonl([...HAND1_ACTIONS, HAND1_RESULTS]))
      expect(result.successCount).toBe(4)
      expect(result.duplicateCount).toBe(0)

      expect(await db.hands.get(HAND1_ID)).toBeDefined()
      expect(await db.actions.where('handId').equals(HAND1_ID).count()).toBe(3)
    })
  })

  test('repair covers the affected range only in effect: a later, already-complete hand stays intact and non-duplicated', async () => {
    const fullExport = [ENTRY_QUEUED, ...HAND1_EVENTS, ...HAND2_EVENTS]

    const expected = await runWithFreshDb(async ({ db, handlers }) => {
      await handlers.importData(toJsonl(fullExport))
      return snapshotDerived(db)
    })
    expect(expected.hands).toHaveLength(2)

    await runWithFreshDb(async ({ db, handlers }) => {
      // HAND1 damaged (missing ACTIONs), HAND2 fully present.
      await db.apiEvents.bulkAdd([ENTRY_QUEUED, HAND1_DEAL, HAND1_RESULTS, ...HAND2_EVENTS] as never[])
      await handlers.rebuildAllData()
      expect(await db.hands.count()).toBe(2)
      expect(await db.actions.where('handId').equals(HAND1_ID).count()).toBe(0)
      expect(await db.actions.where('handId').equals(HAND2_ID).count()).toBe(3)

      const result = await handlers.importData(toJsonl(fullExport))
      expect(result.successCount).toBe(3) // HAND1's 3 missing ACTIONs
      expect(result.duplicateCount).toBe(fullExport.length - 3)

      expect(await snapshotDerived(db)).toEqual(expected)
      expect(await db.hands.count()).toBe(2)
      expect(await db.actions.where('handId').equals(HAND1_ID).count()).toBe(3)
      expect(await db.actions.where('handId').equals(HAND2_ID).count()).toBe(3)
    })
  })

  test('falls back to converting from the Lake start when no EVT_ENTRY_QUEUED precedes the new events', async () => {
    await runWithFreshDb(async ({ db, handlers }) => {
      // Same damage as the main scenario, but the Lake has no 201 at all
      // (capture began mid-session).
      await db.apiEvents.bulkAdd([HAND1_DEAL, HAND1_RESULTS] as never[])

      const result = await handlers.importData(toJsonl(HAND1_EVENTS))
      expect(result.successCount).toBe(3)
      expect(result.duplicateCount).toBe(2)

      expect(await db.hands.get(HAND1_ID)).toBeDefined()
      expect(await db.actions.where('handId').equals(HAND1_ID).count()).toBe(3)
    })
  })

  test('a mid-hand MTT table-move 201 does not cut off the opening DEAL: the lower bound is the previous completed-hand boundary (PR #203 codex P2 #1)', async () => {
    // Lake layout: 201 -> HAND0 (complete) -> HAND1's DEAL -> mid-hand 201
    // (MTT table move) -> [missing ACTIONs] -> HAND1's RESULTS. Anchoring on
    // "last 201 at/before the earliest new event" would pick the mid-hand
    // 201 and exclude HAND1's DEAL, so the imported ACTIONs still couldn't
    // form the hand. The correct lower bound walks back to the previous
    // valid EVT_HAND_RESULTS (HAND0's) and then to the 201 before it.
    const fullExport = [
      ENTRY_QUEUED,
      ...HAND0_EVENTS,
      HAND1_DEAL,
      MID_HAND_ENTRY_QUEUED,
      ...HAND1_ACTIONS,
      HAND1_RESULTS,
    ]

    const expected = await runWithFreshDb(async ({ db, handlers }) => {
      await handlers.importData(toJsonl(fullExport))
      return snapshotDerived(db)
    })
    expect(expected.hands.map(hand => hand.id).sort()).toEqual([HAND0_ID, HAND1_ID])

    await runWithFreshDb(async ({ db, handlers }) => {
      // Damaged DB: everything except HAND1's middle ACTIONs.
      await db.apiEvents.bulkAdd([
        ENTRY_QUEUED,
        ...HAND0_EVENTS,
        HAND1_DEAL,
        MID_HAND_ENTRY_QUEUED,
        HAND1_RESULTS,
      ] as never[])
      await handlers.rebuildAllData()
      expect(await db.actions.where('handId').equals(HAND1_ID).count()).toBe(0)

      const result = await handlers.importData(toJsonl(fullExport))
      expect(result.successCount).toBe(3) // HAND1's ACTIONs
      expect(result.duplicateCount).toBe(fullExport.length - 3)

      expect(await snapshotDerived(db)).toEqual(expected)
      expect(await db.actions.where('handId').equals(HAND1_ID).count()).toBe(3)
      expect(await db.actions.where('handId').equals(HAND0_ID).count()).toBe(3)
    })
  })

  test('a malformed 306 Lake row between the new events and the real RESULTS does not truncate the repair range (PR #203 codex P2 #2)', async () => {
    await runWithFreshDb(async ({ db, handlers }) => {
      // Damaged DB: DEAL and valid RESULTS present, ACTIONs missing, plus an
      // unparseable ApiTypeId=306 noise row sitting between where the
      // imported ACTIONs land and the valid RESULTS. A raw-ApiTypeId
      // boundary search would stop at the noise row; the later
      // filterValidApplicationEvents() pass removes it, leaving the hand
      // unterminated and the repair silently ineffective.
      await db.apiEvents.bulkAdd([
        ENTRY_QUEUED,
        HAND1_DEAL,
        MALFORMED_RESULTS_ROW,
        HAND1_RESULTS,
      ] as never[])

      const result = await handlers.importData(toJsonl([ENTRY_QUEUED, ...HAND1_EVENTS]))
      expect(result.successCount).toBe(3)
      expect(result.duplicateCount).toBe(3)

      expect(await db.hands.get(HAND1_ID)).toBeDefined()
      expect(await db.actions.where('handId').equals(HAND1_ID).count()).toBe(3)
      // The noise row itself is untouched Lake data.
      expect(await db.apiEvents.get([1752427319000, 306])).toBeDefined()
    })
  })

  test('an incremental import without a 201 keeps seeding hand.session from the live service.session (PR #203 codex P2 #3)', async () => {
    await runWithFreshDb(async ({ db, service, handlers }) => {
      // Non-empty DB (noise only, no 201 anywhere) forces the overlap path.
      await db.apiEvents.bulkAdd([{ ApiTypeId: 9999, timestamp: 1000 }] as never[])

      // Live in-memory session context, as during mid-play imports -- the
      // same situation the #104 SessionState-seeding regression test covers
      // for the direct path.
      service.session.setId('live-session-456')
      service.session.setBattleType(0)
      service.session.setName('Live Session')

      const result = await handlers.importData(toJsonl(HAND1_EVENTS)) // no EVT_ENTRY_QUEUED in the window
      expect(result.successCount).toBe(HAND1_EVENTS.length)

      const hand = await db.hands.get(HAND1_ID)
      expect(hand).toBeDefined()
      // No session anchor in the repair range -> the live session must seed
      // the converter, exactly like the direct (empty-DB) path would.
      expect(hand!.session).toMatchObject({
        id: 'live-session-456',
        battleType: 0,
        name: 'Live Session',
      })
    })
  })

  test('a capture-gap mis-paired hand is fully replaced on re-import: derived rows absent from the new derivation are deleted (PR #203 codex P2, pass 2)', async () => {
    // Damaged Lake: HAND1's RESULTS and HAND2's DEAL were both lost to a
    // capture gap, so the old derivation pairs HAND1's DEAL with HAND2's
    // RESULTS -- a single chimera hand under HAND2_ID carrying all 6 actions
    // (same table lineup, so no rejection guard fires).
    const damagedLake = [
      ENTRY_QUEUED,
      HAND1_DEAL,
      ...HAND1_ACTIONS,
      ...HAND2_EVENTS.slice(1, 4), // HAND2's ACTIONs
      HAND2_EVENTS[4]!, // HAND2's RESULTS
    ]
    const fullExport = [ENTRY_QUEUED, ...HAND1_EVENTS, ...HAND2_EVENTS]

    const expected = await runWithFreshDb(async ({ db, handlers }) => {
      await handlers.importData(toJsonl(fullExport))
      return snapshotDerived(db)
    })
    expect(expected.hands.map(hand => hand.id).sort()).toEqual([HAND1_ID, HAND2_ID])

    await runWithFreshDb(async ({ db, handlers }) => {
      await db.apiEvents.bulkAdd(damagedLake as never[])
      await handlers.rebuildAllData()
      // Stale state from the old derivation: one chimera hand under
      // HAND2_ID that swallowed HAND1's actions.
      expect(await db.hands.count()).toBe(1)
      expect(await db.hands.get(HAND2_ID)).toBeDefined()
      expect(await db.actions.where('handId').equals(HAND2_ID).count()).toBe(6)

      // Re-import the complete export: only the two gap rows are new.
      const result = await handlers.importData(toJsonl(fullExport))
      expect(result.successCount).toBe(2) // HAND1's RESULTS + HAND2's DEAL
      expect(result.duplicateCount).toBe(fullExport.length - 2)

      // Upsert alone would overwrite the chimera's hand row and action
      // indexes 0-2 but leave the orphaned action tail (indexes 3-5)
      // behind. The stale-window deletion must remove the whole old
      // derivation first, leaving state identical to a from-scratch import.
      expect(await snapshotDerived(db)).toEqual(expected)
      expect(await db.actions.where('handId').equals(HAND2_ID).count()).toBe(3)
      expect(await db.actions.where('handId').equals(HAND1_ID).count()).toBe(3)
    })
  })

  test('a stale mis-paired hand whose id vanishes from the new derivation is deleted, not double-counted (PR #203 codex P2, pass 2)', async () => {
    // Same capture-gap chimera as above, but the import brings only HAND1's
    // events (HAND2's DEAL stays missing). The new derivation emits HAND1
    // only -- HAND2's tail events still can't form a hand -- so the chimera
    // under HAND2_ID must be deleted outright, or stats keep counting both
    // the corrected HAND1 and the stale chimera until a full rebuild.
    const damagedLake = [
      ENTRY_QUEUED,
      HAND1_DEAL,
      ...HAND1_ACTIONS,
      ...HAND2_EVENTS.slice(1, 4),
      HAND2_EVENTS[4]!,
    ]
    const partialImport = [ENTRY_QUEUED, ...HAND1_EVENTS]
    // What the damaged Lake contains AFTER the partial import -- the control
    // is a from-scratch import of exactly that content.
    const postImportLakeContent = [
      ENTRY_QUEUED,
      ...HAND1_EVENTS,
      ...HAND2_EVENTS.slice(1),
    ]

    const expected = await runWithFreshDb(async ({ db, handlers }) => {
      await handlers.importData(toJsonl(postImportLakeContent))
      return snapshotDerived(db)
    })
    expect(expected.hands.map(hand => hand.id)).toEqual([HAND1_ID])

    await runWithFreshDb(async ({ db, handlers }) => {
      await db.apiEvents.bulkAdd(damagedLake as never[])
      await handlers.rebuildAllData()
      expect(await db.hands.get(HAND2_ID)).toBeDefined()

      const result = await handlers.importData(toJsonl(partialImport))
      expect(result.successCount).toBe(1) // HAND1's RESULTS
      expect(result.duplicateCount).toBe(partialImport.length - 1)

      expect(await snapshotDerived(db)).toEqual(expected)
      expect(await db.hands.count()).toBe(1)
      expect(await db.hands.get(HAND2_ID)).toBeUndefined()
    })
  })

  test('a Lake starting with a 201 before its first hand counts as a session anchor: no live session name leaks into first-hand repairs (PR #203 codex P2, pass 3)', async () => {
    await runWithFreshDb(async ({ db, service, handlers }) => {
      // The repaired hand is the FIRST hand in the Lake: no prior 306, so
      // the lower bound falls back to the Lake start -- which begins with a
      // valid 201. The empty rebuild-style session must seed the converter
      // here too: a replayed 201 overwrites id/battleType but NOT
      // session.name, so live-session seeding would leak the live table
      // name into a historical first-hand repair that has no 308.
      await db.apiEvents.bulkAdd([ENTRY_QUEUED, HAND1_DEAL, HAND1_RESULTS] as never[])

      service.session.setId('live-session-456')
      service.session.setBattleType(1)
      service.session.setName('Live Table Name')

      const result = await handlers.importData(toJsonl([ENTRY_QUEUED, ...HAND1_EVENTS]))
      expect(result.successCount).toBe(3)

      const hand = await db.hands.get(HAND1_ID)
      expect(hand).toBeDefined()
      // Session identity comes from the Lake's own 201...
      expect(hand!.session).toMatchObject({ id: 'stage000_003', battleType: 0 })
      // ...and the live table name must NOT have leaked in.
      expect(hand!.session.name).toBeUndefined()
    })
  })

  test('legacy derived hands without approxTimestamp are still cleaned up by the repair (PR #203 codex P2, pass 3)', async () => {
    // Same capture-gap chimera as the pass-2 test, but the stale derived
    // hand row predates approxTimestamp (the model treats it as optional) --
    // a timestamp-window index query would silently skip it and leave the
    // orphaned action tail behind.
    const damagedLake = [
      ENTRY_QUEUED,
      HAND1_DEAL,
      ...HAND1_ACTIONS,
      ...HAND2_EVENTS.slice(1, 4),
      HAND2_EVENTS[4]!,
    ]
    const fullExport = [ENTRY_QUEUED, ...HAND1_EVENTS, ...HAND2_EVENTS]

    const expected = await runWithFreshDb(async ({ db, handlers }) => {
      await handlers.importData(toJsonl(fullExport))
      return snapshotDerived(db)
    })

    await runWithFreshDb(async ({ db, handlers }) => {
      await db.apiEvents.bulkAdd(damagedLake as never[])
      await handlers.rebuildAllData()
      // Simulate a legacy row: strip approxTimestamp from the stale chimera.
      await db.hands.toCollection().modify(hand => { delete (hand as { approxTimestamp?: number }).approxTimestamp })
      expect((await db.hands.get(HAND2_ID))?.approxTimestamp).toBeUndefined()
      expect(await db.actions.where('handId').equals(HAND2_ID).count()).toBe(6)

      const result = await handlers.importData(toJsonl(fullExport))
      expect(result.successCount).toBe(2)

      expect(await snapshotDerived(db)).toEqual(expected)
      expect(await db.actions.where('handId').equals(HAND2_ID).count()).toBe(3)
      expect(await db.actions.where('handId').equals(HAND1_ID).count()).toBe(3)
    })
  })

  test('derived hands whose raw rows no longer validate are NOT deleted by the repair (PR #203 codex P2, pass 3)', async () => {
    await runWithFreshDb(async ({ db, handlers }) => {
      // Lake: a schema-broken hand (raw 303/306 rows that no longer parse
      // under the current schema -- e.g. an old PokerChase payload shape)
      // sits between the 201 and HAND1, whose middle ACTIONs are missing.
      await db.apiEvents.bulkAdd([
        ENTRY_QUEUED,
        { ApiTypeId: 303, timestamp: 1752427305000 }, // malformed DEAL
        { ApiTypeId: 306, timestamp: 1752427306000, HandId: 99999 }, // malformed RESULTS
        HAND1_DEAL,
        HAND1_RESULTS,
      ] as never[])

      // Derived state for the schema-broken hand, as an OLDER schema once
      // produced it. The re-derivation cannot recreate it (its raw rows are
      // filtered out), so the repair must leave it untouched -- exactly the
      // state a plain import would have preserved until an explicit rebuild.
      await db.hands.put({
        id: 99999,
        approxTimestamp: 1752427306000, // inside what a timestamp window would cover
        seatUserIds: [2, 4, 3, 1],
        winningPlayerIds: [4],
        smallBlind: 100,
        bigBlind: 200,
        session: { id: 'stage000_003', battleType: 0 },
        results: [],
      } as never)
      await db.phases.put({ handId: 99999, phase: 0, seatUserIds: [2, 4, 3, 1], communityCards: [] } as never)
      await db.actions.put({ handId: 99999, index: 0, playerId: 2, phase: 0, actionType: 2, bet: 0, pot: 500, sidePot: [], position: 0, actionDetails: [] } as never)

      const result = await handlers.importData(toJsonl([ENTRY_QUEUED, ...HAND1_EVENTS]))
      expect(result.successCount).toBe(3)

      // HAND1 is repaired...
      expect(await db.actions.where('handId').equals(HAND1_ID).count()).toBe(3)
      // ...and the schema-broken hand's derived state survives untouched.
      expect(await db.hands.get(99999)).toBeDefined()
      expect(await db.phases.where('handId').equals(99999).count()).toBe(1)
      expect(await db.actions.where('handId').equals(99999).count()).toBe(1)
      expect(await db.hands.count()).toBe(2)
    })
  })

  test('a table-move 201 inside the PREVIOUS completed hand does not become the anchor: that hand survives the repair (PR #203 codex P2, pass 4)', async () => {
    // Lake layout: 201 -> HAND0's DEAL -> mid-hand 201 (MTT table move
    // INSIDE the previous completed hand) -> HAND0's ACTIONs/RESULTS ->
    // HAND1's DEAL -> [missing ACTIONs] -> HAND1's RESULTS. The anchor scan
    // walks back from HAND0's RESULTS (previous completed-hand boundary);
    // the nearest 201 at/before it is the mid-hand one. Anchoring there
    // would put HAND0's RESULTS inside the repair range but its DEAL
    // outside -- the cleanup would account HAND0's id and delete it while
    // the converter (buffering starts at DEAL) cannot re-emit it, erasing
    // HAND0 until a full rebuild. The anchor must instead walk back past
    // the mid-hand 201 to the outer 201, keeping HAND0 fully in range.
    const MID_HAND0_ENTRY_QUEUED = { ...ENTRY_QUEUED, "timestamp": 1752427304000 } // between HAND0's DEAL (...303426) and its first ACTION (...305428)
    const fullExport = [
      ENTRY_QUEUED,
      HAND0_EVENTS[0]!, // HAND0 DEAL
      MID_HAND0_ENTRY_QUEUED,
      ...HAND0_EVENTS.slice(1), // HAND0 ACTIONs + RESULTS
      ...HAND1_EVENTS,
    ]

    const expected = await runWithFreshDb(async ({ db, handlers }) => {
      await handlers.importData(toJsonl(fullExport))
      return snapshotDerived(db)
    })
    expect(expected.hands.map(hand => hand.id).sort()).toEqual([HAND0_ID, HAND1_ID])

    await runWithFreshDb(async ({ db, handlers }) => {
      // Damaged DB: everything except HAND1's middle ACTIONs.
      await db.apiEvents.bulkAdd([
        ENTRY_QUEUED,
        HAND0_EVENTS[0]!,
        MID_HAND0_ENTRY_QUEUED,
        ...HAND0_EVENTS.slice(1),
        HAND1_DEAL,
        HAND1_RESULTS,
      ] as never[])
      await handlers.rebuildAllData()
      expect(await db.actions.where('handId').equals(HAND0_ID).count()).toBe(3)
      expect(await db.actions.where('handId').equals(HAND1_ID).count()).toBe(0)

      const result = await handlers.importData(toJsonl(fullExport))
      expect(result.successCount).toBe(3) // HAND1's ACTIONs
      expect(result.duplicateCount).toBe(fullExport.length - 3)

      // HAND0 must survive intact (not deleted-without-re-emit), HAND1 must
      // be repaired, and the whole derived state must equal a from-scratch
      // import of the same data.
      expect(await snapshotDerived(db)).toEqual(expected)
      expect(await db.hands.get(HAND0_ID)).toBeDefined()
      expect(await db.actions.where('handId').equals(HAND0_ID).count()).toBe(3)
      expect(await db.actions.where('handId').equals(HAND1_ID).count()).toBe(3)
      expect(await db.hands.count()).toBe(2)
    })
  })

  test('a fresh import into an empty DB still derives entities through the unchanged direct path', async () => {
    await runWithFreshDb(async ({ db, handlers }) => {
      const result = await handlers.importData(toJsonl([ENTRY_QUEUED, ...HAND1_EVENTS]))
      expect(result.successCount).toBe(6)
      expect(result.duplicateCount).toBe(0)

      expect(await db.hands.get(HAND1_ID)).toBeDefined()
      expect(await db.actions.where('handId').equals(HAND1_ID).count()).toBe(3)
      expect(await db.phases.where('handId').equals(HAND1_ID).count()).toBeGreaterThan(0)
    })
  })
})
