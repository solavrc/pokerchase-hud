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
import type { Hand } from '../types/entities'

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
