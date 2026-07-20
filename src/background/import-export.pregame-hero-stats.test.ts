/**
 * getLatestSessionStats() - pre-game hero stats fallback
 *
 * Before the first EVT_DEAL of a browser session establishes a live seat
 * lineup, the HUD has nothing to show for any seat -- including the
 * hero's own. This exercises the fallback added to getLatestSessionStats()
 * (called via the 'requestLatestStats' message with `preGame: true`, sent
 * only by content_script.ts's mountApp() -- see message-router.ts): when
 * the hero's persisted playerId is known, it computes the hero's stats via
 * ReadEntityStream.calcStats() (the exact same computation the live
 * pipeline uses -- no forked implementation) for a hero-only lineup, and
 * pads the remaining 5 seats with the {playerId:-1} empty-seat sentinel
 * App.tsx's EMPTY_SEATS default already uses, so the returned array is
 * always the same 6-element shape the HUD renders (see App.tsx's
 * seat-keyed panels).
 *
 * `preGame: false`/omitted (the pre-existing post-import `refreshStats`
 * round-trip) must keep the original "always return []" stub behavior
 * verbatim, since import completion already triggers its own real
 * recompute+broadcast moments before that call fires -- see the race
 * explained in getLatestSessionStats()'s own comment.
 *
 * Direct-call style (bypassing chrome.tabs.sendMessage, which isn't mocked
 * in test-setup.ts): createImportExportHandlers() exports
 * getLatestSessionStats itself, same as its sibling rebuildAllData/
 * importData in import-export.rebuild.test.ts.
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { createImportExportHandlers } from './import-export'
import { BattleType } from '../types/game'
import { ApiType } from '../types'
import type { ApiEvent } from '../types'
import type { Hand } from '../types/entities'
import { findLatestPlayerDealEvent } from '../utils/database-utils'

// Wraps the real findLatestPlayerDealEvent by default (every existing test
// below relies on its actual DB-querying behavior); only the concurrent-live-
// EVT_DEAL regression test below overrides it per-call via
// mockImplementationOnce to control exactly when the DB lookup "resolves".
jest.mock('../utils/database-utils', () => {
  const actual = jest.requireActual('../utils/database-utils')
  return {
    ...actual,
    findLatestPlayerDealEvent: jest.fn(actual.findLatestPlayerDealEvent),
  }
})

const HERO_ID = 1
const EMPTY_SEAT = { playerId: -1 }

function makeHand(overrides: Partial<Hand> & { id: number, seatUserIds: number[] }): Hand {
  return {
    bigBlindUserId: overrides.seatUserIds[1] ?? -1,
    winningPlayerIds: [],
    smallBlind: 100,
    bigBlind: 200,
    session: { battleType: BattleType.TOURNAMENT },
    results: [],
    ...overrides
  }
}

describe('getLatestSessionStats -- pre-game hero stats fallback', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let getLatestSessionStats: (preGame: boolean) => Promise<any[]>

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = new PokerChaseService({ db })
    await service.ready

    await db.hands.bulkAdd([
      makeHand({ id: 1, seatUserIds: [HERO_ID, 2, 3, 4, 5, 6] }),
      makeHand({ id: 2, seatUserIds: [HERO_ID, 2, 3, 4, 5, -1] }),
    ])

    ;(getLatestSessionStats = createImportExportHandlers(service, db, 'https://example.com/*').getLatestSessionStats)
  })

  afterEach(async () => {
    db.close()
    await db.delete()
  })

  test('hero-lineup fallback (preGame:true): known playerId -> hero stats at index 0, seats 1-5 padded empty', async () => {
    service.playerId = HERO_ID

    const stats = await getLatestSessionStats(true)

    expect(stats).toHaveLength(6)
    expect(stats[0].playerId).toBe(HERO_ID)
    expect('statResults' in stats[0] && stats[0].statResults).toBeDefined()
    const handsResult = stats[0].statResults.find((r: any) => r.id === 'hands')
    expect(handsResult?.value).toBe(2) // both seeded hands counted

    for (let i = 1; i < 6; i++) {
      expect(stats[i]).toEqual(EMPTY_SEAT)
    }
  })

  test('unknown playerId (fresh install), preGame:true: no-op, returns []', async () => {
    expect(service.playerId).toBeUndefined()

    const stats = await getLatestSessionStats(true)

    expect(stats).toEqual([])
  })

  test('preGame:false/omitted (post-import refreshStats path): always no-op, even with a known hero -- avoids clobbering the fresher real broadcast that import completion already triggered', async () => {
    service.playerId = HERO_ID

    expect(await getLatestSessionStats(false)).toEqual([])
  })

  test('batch mode (import/rebuild in flight), preGame:true: no-op, returns [] even with a known hero', async () => {
    service.playerId = HERO_ID
    service.setBatchMode(true)

    const stats = await getLatestSessionStats(true)

    expect(stats).toEqual([])
  })

  test('filter application: the fallback respects the active battleTypeFilter, same as the live pipeline', async () => {
    service.playerId = HERO_ID
    // Both seeded hands are TOURNAMENT; narrow to RING_GAME only -> hero has
    // prior hands (2) but none match, so calcStats' early-return kicks in:
    // statResults: [] rather than a placeholder/omission.
    service.battleTypeFilter = [BattleType.RING_GAME]

    const stats = await getLatestSessionStats(true)

    expect(stats).toHaveLength(6)
    expect(stats[0].playerId).toBe(HERO_ID)
    expect(stats[0].statResults).toEqual([])
  })

  test('filter application: handLimitFilter narrows the hand population the hero stats are computed over', async () => {
    service.playerId = HERO_ID
    service.handLimitFilter = 1

    const stats = await getLatestSessionStats(true)

    const handsResult = stats[0].statResults.find((r: any) => r.id === 'hands')
    expect(handsResult?.value).toBe(1) // most recent hand only
  })

  test('cold SW start: waits for service.filtersRestored before computing, so a filter restored mid-flight is respected', async () => {
    // background.ts's real startup sequence: arm the gate synchronously, then
    // (asynchronously) restore battleType/tableSize/handLimit filters and call
    // markFiltersRestored() once they're applied. `service.ready` alone
    // (chrome.storage.local's playerId/session restore) doesn't cover this --
    // it's a separate restoration path (background.ts's loadOptions().then(...)).
    service.playerId = HERO_ID
    service.beginFiltersRestore()

    let settled = false
    const statsPromise = getLatestSessionStats(true).then(stats => {
      settled = true
      return stats
    })

    // Let every already-queued microtask run (service.ready resolves, batchMode/
    // playerId checks pass) -- calcStats() must NOT have started yet because
    // filtersRestored is still pending.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settled).toBe(false)

    // Simulate background.ts's loadOptions().then(...) applying the user's saved
    // filter, then resolving the gate.
    service.handLimitFilter = 1
    service.markFiltersRestored()

    const stats = await statsPromise
    expect(settled).toBe(true)
    // The restored handLimitFilter (applied *during* the wait, not before
    // getLatestSessionStats was called) was respected -- not the pre-restore
    // default of "all hands" (which would have counted both seeded hands).
    const handsResult = stats[0].statResults.find((r: any) => r.id === 'hands')
    expect(handsResult?.value).toBe(1)
  })
})

/**
 * getLatestSessionStats() - DB-inference fallback when `service.playerId` is
 * unknown in memory
 *
 * Real-world trigger (see fix/pregame-playerid-inference): a freshly-loaded
 * unpacked extension instance starts with empty in-memory service state.
 * After a cloud download or NDJSON import, the local DB already has hero
 * deal events, but until a live EVT_DEAL arrives `service.playerId` is still
 * unset, so the pre-existing "unknown playerId -> no-op" branch left the
 * pre-game panel dark even though the hero's identity was recoverable.
 *
 * This mirrors the DB-recovery derivation `PokerChaseService.
 * recalculateAllStats()` already performs on batch-mode exit (see
 * poker-chase-service.ts): `findLatestPlayerDealEvent(db)`, then
 * `Player?.SeatIndex !== undefined` -> `SeatUserIds[Player.SeatIndex]`. The
 * derived id is assigned through the `service.playerId` setter so it
 * persists via the service's normal 500ms-debounced chrome.storage.local
 * save, same as if it had come from a live EVT_DEAL.
 */
describe('getLatestSessionStats -- DB-inference fallback for unknown in-memory playerId', () => {
  const STORAGE_KEY = PokerChaseService.STORAGE_KEY

  const dealEvent: ApiEvent<ApiType.EVT_DEAL> = {
    ApiTypeId: ApiType.EVT_DEAL,
    SeatUserIds: [HERO_ID, 2, 3, 4], // >=4 seats required by the EVT_DEAL schema (see ApiEventSchema)
    Game: { CurrentBlindLv: 1, NextBlindUnixSeconds: 0, Ante: 0, SmallBlind: 100, BigBlind: 200, ButtonSeat: 0, SmallBlindSeat: 1, BigBlindSeat: 2 },
    Player: { SeatIndex: 0, BetStatus: 1, HoleCards: [0, 1], Chip: 5000, BetChip: 0 },
    OtherPlayers: [
      { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 100, IsSafeLeave: false },
      { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 200, IsSafeLeave: false },
      { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
    ],
    Progress: { Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 400, Pot: 300, SidePot: [] },
    timestamp: 1000,
  }

  let db: PokerChaseDB
  let service: PokerChaseService
  let getLatestSessionStats: (preGame: boolean) => Promise<any[]>

  beforeEach(async () => {
    // Fake only setTimeout/setInterval (used by the service's 500ms
    // persistState debounce) -- fake-indexeddb schedules its own request/
    // versionchange events via a real setImmediate internally, so faking
    // that too would hang db.open()/apiEvents.add()/db.delete() below.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] })

    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = new PokerChaseService({ db })
    await service.ready

    await db.hands.bulkAdd([
      makeHand({ id: 1, seatUserIds: [HERO_ID, 2, 3, 4, 5, 6] }),
      makeHand({ id: 2, seatUserIds: [HERO_ID, 2, 3, 4, 5, -1] }),
    ])

    ;(getLatestSessionStats = createImportExportHandlers(service, db, 'https://example.com/*').getLatestSessionStats)
  })

  afterEach(async () => {
    jest.useRealTimers()
    db.close()
    await db.delete()
    await chrome.storage.local.set({ [STORAGE_KEY]: undefined })
    jest.clearAllMocks()
  })

  test('hero deal event recoverable from DB: derives playerId, sets+persists it on the service, and returns hero stats', async () => {
    await db.apiEvents.add(dealEvent)
    expect(service.playerId).toBeUndefined()

    const stats = await getLatestSessionStats(true)

    // Set on the service itself (not just used locally for this one call) --
    // later features (live pipeline, next mount, etc.) see it too.
    expect(service.playerId).toBe(HERO_ID)

    expect(stats).toHaveLength(6)
    expect(stats[0].playerId).toBe(HERO_ID)
    const handsResult = stats[0].statResults.find((r: any) => r.id === 'hands')
    expect(handsResult?.value).toBe(2)
    for (let i = 1; i < 6; i++) {
      expect(stats[i]).toEqual(EMPTY_SEAT)
    }

    // Persists via the normal debounced save (the plain `service.playerId =`
    // setter), same as PokerChaseService.recalculateAllStats()'s DB-recovery
    // path -- not a one-off side-channel write.
    expect(chrome.storage.local.set).not.toHaveBeenCalled() // still inside the 500ms debounce window
    jest.advanceTimersByTime(500)
    await Promise.resolve()
    expect(chrome.storage.local.set).toHaveBeenCalled()
    const lastCall = (chrome.storage.local.set as jest.Mock).mock.calls.at(-1)
    expect(lastCall[0][STORAGE_KEY].playerId).toBe(HERO_ID)
  })

  test('live EVT_DEAL sets service.playerId while the DB lookup is still in flight: the live value wins, the DB-derived value is discarded (see fix/pregame-playerid-inference PR #175 review)', async () => {
    const LIVE_ID = 999
    await db.apiEvents.add(dealEvent) // DB has a recoverable candidate for HERO_ID

    // Signals the exact moment getLatestSessionStats() actually invokes
    // findLatestPlayerDealEvent(db) -- i.e. once it's past the outer
    // `if (!service.playerId)` guard and truly mid-lookup -- so the manual
    // trigger below lands inside the await window, not before or after it.
    let lookupStarted = false
    let resolveDealEvent!: (value: typeof dealEvent) => void
    const pendingLookup = new Promise<typeof dealEvent>(resolve => { resolveDealEvent = resolve })
    ;(findLatestPlayerDealEvent as jest.Mock).mockImplementationOnce(() => {
      lookupStarted = true
      return pendingLookup
    })

    const statsPromise = getLatestSessionStats(true)

    // Let queued microtasks (service.ready / service.filtersRestored, both
    // already-resolved) drain until the mocked DB lookup actually starts.
    for (let i = 0; i < 20 && !lookupStarted; i++) {
      await Promise.resolve()
    }
    expect(lookupStarted).toBe(true) // sanity: the race window below is real, not skipped
    expect(service.playerId).toBeUndefined() // still unset at the moment the DB lookup began

    // Simulate a live EVT_DEAL landing on the service (e.g. via ReadEntityStream)
    // while findLatestPlayerDealEvent(db) is still awaiting.
    service.playerId = LIVE_ID

    // Now the (now-stale) DB lookup resolves with the old candidate.
    resolveDealEvent(dealEvent)
    const stats = await statsPromise

    // The live value must not be clobbered by the DB-derived one.
    expect(service.playerId).toBe(LIVE_ID)
    expect(stats[0].playerId).toBe(LIVE_ID)
  })

  test('no hero deal event anywhere in the DB (true fresh install / never played): stays a silent no-op, returns []', async () => {
    // apiEvents left empty -- findLatestPlayerDealEvent() finds nothing to recover.
    const stats = await getLatestSessionStats(true)

    expect(service.playerId).toBeUndefined()
    expect(stats).toEqual([])

    jest.advanceTimersByTime(500)
    await Promise.resolve()
    expect(chrome.storage.local.set).not.toHaveBeenCalled()
  })

  test('known in-memory playerId: DB is never consulted (no apiEvents lookup), existing behavior unchanged', async () => {
    service.playerId = HERO_ID
    jest.advanceTimersByTime(500)
    await Promise.resolve()
    ;(chrome.storage.local.set as jest.Mock).mockClear()

    const whereSpy = jest.spyOn(db.apiEvents, 'where')

    const stats = await getLatestSessionStats(true)

    expect(whereSpy).not.toHaveBeenCalled() // findLatestPlayerDealEvent() was never invoked
    expect(stats[0].playerId).toBe(HERO_ID)
  })

  test('batch mode still wins over DB inference: no-op, returns [], even with a recoverable hero deal event in the DB', async () => {
    await db.apiEvents.add(dealEvent)
    service.setBatchMode(true)

    const stats = await getLatestSessionStats(true)

    expect(service.playerId).toBeUndefined() // inference never ran
    expect(stats).toEqual([])
  })
})
