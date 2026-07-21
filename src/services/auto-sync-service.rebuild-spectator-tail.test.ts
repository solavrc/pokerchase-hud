/**
 * AutoSyncService.rebuildLocalEntities() -- seated-deal guard on cloud restore
 *
 * Regression test for a P2 finding filed on the already-merged #177 (the
 * two inline review comments posted 2026-07-20T12:39, after #177/#179/#181/
 * #182/#184/#185 had all landed on main):
 *
 * `rebuildLocalEntities()` (called after `syncFromCloud()` downloads any
 * events -- see `performSync('download')`/`performSync('both')`) used to
 * record the LAST EVT_DEAL seen while chunk-scanning the rebuilt history as
 * `latestDealEvent`, regardless of whether it carried `Player.SeatIndex`.
 * If a cloud download/restore's raw event history happens to end on a
 * spectator-mode deal (hero busted mid-session, client kept receiving
 * another table's deals -- see docs/api-events.md "観戦モード"), that
 * spectator deal was fed straight into `service.latestEvtDeal`'s setter
 * (poker-chase-service.ts), which:
 *   (1) also syncs the live-display `liveEvtDeal` field to the same
 *       spectator-mode deal, and
 *   (2) cannot recover `service.playerId` (a spectator deal has no
 *       `Player.SeatIndex` to read a hero seat from),
 * recreating on the cloud-restore path exactly the mixed
 * hero-identity/spectator-context state #177 fixed for the live pipeline --
 * and doing so on the *recovery* path (a fresh install restoring from
 * cloud), which is the worst place for it to resurface.
 *
 * Fix: `rebuildLocalEntities()`'s per-event loop now only updates
 * `latestDealEvent` when `event.Player?.SeatIndex !== undefined` -- the
 * same discrimination `findLatestPlayerDealEvent()` (database-utils.ts)
 * applies for the equivalent DB-driven recovery paths (import-export.ts,
 * poker-chase-service.ts's `recalculateAllStats()`). A spectator-mode tail
 * event is simply ignored during rebuild (not fed to any field, persisted
 * or otherwise) -- rebuild is not a live-display moment, so there is no
 * `liveEvtDeal`-equivalent value for it to usefully seed; the next real
 * live EVT_DEAL will populate `liveEvtDeal` correctly on its own.
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { ApiType } from '../types'
import type { ApiEvent } from '../types'
import { AutoSyncService } from './auto-sync-service'
import { firestoreBackupService } from './firestore-backup-service'

const HERO_ID = 4

// Hero's last SEATED deal -- Player.SeatIndex present, hero is UserId 4 at
// seat 1 (SeatUserIds[1]).
const SEATED_DEAL = {
  ApiTypeId: ApiType.EVT_DEAL,
  SeatUserIds: [2, 4, 3, 1],
  Game: { CurrentBlindLv: 1, NextBlindUnixSeconds: -1, Ante: 0, SmallBlind: 100, BigBlind: 200, ButtonSeat: 3, SmallBlindSeat: 0, BigBlindSeat: 1 },
  Player: { SeatIndex: 1, BetStatus: 1, HoleCards: [5, 21], Chip: 5750, BetChip: 200 },
  OtherPlayers: [
    { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 5850, BetChip: 100, IsSafeLeave: false },
    { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 5950, BetChip: 0, IsSafeLeave: false },
    { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 5950, BetChip: 0, IsSafeLeave: false },
  ],
  Progress: { Phase: 0, NextActionSeat: 2, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 400, Pot: 500, SidePot: [] },
  timestamp: 1000,
} as unknown as ApiEvent

// Tail of the downloaded history: hero busted, client kept receiving deals
// for a different table it's now only spectating -- Player is absent.
const SPECTATOR_DEAL = {
  ApiTypeId: ApiType.EVT_DEAL,
  SeatUserIds: [10, 20, 30, 40],
  Game: { CurrentBlindLv: 2, NextBlindUnixSeconds: -1, Ante: 0, SmallBlind: 200, BigBlind: 400, ButtonSeat: 1, SmallBlindSeat: 2, BigBlindSeat: 3 },
  OtherPlayers: [
    { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 3000, BetChip: 0, IsSafeLeave: false },
    { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 3000, BetChip: 0, IsSafeLeave: false },
    { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 3000, BetChip: 200, IsSafeLeave: false },
    { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 3000, BetChip: 400, IsSafeLeave: false },
  ],
  Progress: { Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 400, Pot: 600, SidePot: [] },
  timestamp: 2000,
} as unknown as ApiEvent

describe('AutoSyncService.rebuildLocalEntities() -- seated-deal guard on cloud restore', () => {
  let db: PokerChaseDB
  let service: PokerChaseService

  beforeEach(async () => {
    const sendMessageMock = chrome.runtime.sendMessage as jest.Mock
    sendMessageMock.mockResolvedValue(undefined)
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = new PokerChaseService({ db })
    await service.ready
    // rebuildLocalEntities() reads the live singleton off `self.service`
    // (see auto-sync-service.ts) -- in a jsdom jest environment `self` is
    // `globalThis`/`window`, so this is the same object the module reads.
    ;(globalThis as any).service = service
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    delete (globalThis as any).service
    db.close()
    await db.delete()
  })

  test('a cloud download ending on a spectator-mode deal restores the hero-anchored SEATED deal, not the spectator tail', async () => {
    jest.spyOn(firestoreBackupService, 'syncFromCloud').mockImplementation(async options => {
      // Cloud history arrives oldest-first, ending on the spectator tail --
      // exactly the shape rebuildLocalEntities() chunk-scans in timestamp order.
      await options.onBatch([SEATED_DEAL, SPECTATOR_DEAL])
      options.onProgress?.({ current: 2, total: 2 })
      return 2
    })

    const autoSyncService = new AutoSyncService(db)
    await autoSyncService.performSync('download')

    // playerId recovered from the seated deal, not left undefined (a
    // spectator deal has no Player.SeatIndex to derive it from).
    expect(service.playerId).toBe(HERO_ID)
    // latestEvtDeal (persisted, hero-anchored context) is the last SEATED
    // deal -- the spectator tail never reaches it.
    expect(service.latestEvtDeal).toEqual({ ...SEATED_DEAL, sequence: 0 })
    // The latestEvtDeal setter syncs liveEvtDeal too (poker-chase-service.ts)
    // -- the spectator tail is ignored outright, not fed to either field.
    expect(service.liveEvtDeal).toEqual({ ...SEATED_DEAL, sequence: 0 })
  })

  test('control: a cloud download ending on a seated deal still restores it as before', async () => {
    const laterSeatedDeal = { ...SEATED_DEAL, timestamp: 3000, SeatUserIds: [5, 4, 6, 7] } as ApiEvent
    jest.spyOn(firestoreBackupService, 'syncFromCloud').mockImplementation(async options => {
      await options.onBatch([SEATED_DEAL, laterSeatedDeal])
      options.onProgress?.({ current: 2, total: 2 })
      return 2
    })

    const autoSyncService = new AutoSyncService(db)
    await autoSyncService.performSync('download')

    expect(service.playerId).toBe(HERO_ID)
    expect(service.latestEvtDeal).toEqual({ ...laterSeatedDeal, sequence: 0 })
    expect(service.liveEvtDeal).toEqual({ ...laterSeatedDeal, sequence: 0 })
  })
})
