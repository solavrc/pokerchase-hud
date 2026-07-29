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
import { ApiType, BattleType } from '../types'
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

const makeHandResult = (handId: number, timestamp: number) => ({
  ApiTypeId: ApiType.EVT_HAND_RESULTS,
  CommunityCards: [],
  Pot: 500,
  SidePot: [],
  ResultType: 0,
  DefeatStatus: 0,
  HandId: handId,
  HandLog: '',
  Results: [{
    UserId: HERO_ID,
    HoleCards: [],
    RankType: 10,
    Hands: [],
    HandRanking: 1,
    Ranking: -2,
    RewardChip: 500,
  }],
  Player: {
    SeatIndex: 1,
    BetStatus: -1,
    Chip: 6000,
    BetChip: 0,
  },
  OtherPlayers: [
    { SeatIndex: 0, Status: 0, BetStatus: -1, Chip: 5800, BetChip: 0, IsSafeLeave: false },
    { SeatIndex: 2, Status: 0, BetStatus: -1, Chip: 5900, BetChip: 0, IsSafeLeave: false },
    { SeatIndex: 3, Status: 0, BetStatus: -1, Chip: 5900, BetChip: 0, IsSafeLeave: false },
  ],
  timestamp,
})

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

  test('cloud replay preserves the live automatic category until atomically committing the rebuilt session', async () => {
    service.autoBattleTypeFilter = true
    service.session.setId('live-sng')
    service.session.setBattleType(BattleType.SIT_AND_GO)
    const initialRevision = service.autoBattleTypeFilterRevision

    await db.apiEvents.put({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'rebuilt-ring',
      IsRetire: false,
      timestamp: 500,
      sequence: 0,
    } as ApiEvent)

    const autoSyncService = new AutoSyncService(db)
    const originalSave = (autoSyncService as any).saveRebuiltEntities.bind(autoSyncService)
    let releaseSave!: () => void
    let signalSaveStarted!: () => void
    const saveBlocked = new Promise<void>(resolve => { releaseSave = resolve })
    const saveStarted = new Promise<void>(resolve => { signalSaveStarted = resolve })
    jest.spyOn(autoSyncService as any, 'saveRebuiltEntities')
      .mockImplementationOnce(async (entities: unknown) => {
        signalSaveStarted()
        await saveBlocked
        return originalSave(entities)
      })

    const rebuild = (autoSyncService as any).rebuildLocalEntities()
    await saveStarted

    // The service remains usable with its live category throughout awaited replay work.
    expect(service.session.id).toBe('live-sng')
    expect(service.session.battleType).toBe(BattleType.SIT_AND_GO)
    expect(service.autoBattleTypeFilterRevision).toBe(initialRevision)

    releaseSave()
    await rebuild

    expect(service.session.id).toBe('rebuilt-ring')
    expect(service.session.battleType).toBe(BattleType.RING_GAME)
    expect(service.autoBattleTypeFilterRevision).toBe(initialRevision + 1)
  })

  test('download sync does not release its operation before the replay session snapshot is durable', async () => {
    service.autoBattleTypeFilter = true
    service.session.setId('stale-active-session')
    service.session.setBattleType(BattleType.SIT_AND_GO)

    jest.spyOn(firestoreBackupService, 'syncFromCloud').mockImplementation(async options => {
      await options.onBatch([
        {
          ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
          Code: 0,
          BattleType: BattleType.RING_GAME,
          Id: 'downloaded-ring',
          IsRetire: false,
          timestamp: 500,
        },
        {
          ApiTypeId: ApiType.EVT_SESSION_RESULTS,
          timestamp: 600,
        },
      ] as any)
      return 2
    })

    let releaseFlush!: () => void
    let signalFlushStarted!: () => void
    const flushBlocked = new Promise<void>(resolve => { releaseFlush = resolve })
    const flushStarted = new Promise<void>(resolve => { signalFlushStarted = resolve })
    const originalFlush = service.flushStatePersistence.bind(service)
    jest.spyOn(service, 'flushStatePersistence').mockImplementation(async () => {
      signalFlushStarted()
      await flushBlocked
      await originalFlush()
    })

    const autoSyncService = new AutoSyncService(db)
    let settled = false
    const sync = autoSyncService.performSync('download')
      .then(result => {
        settled = true
        return result
      })

    await flushStarted
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(service.session.id).toBeUndefined()
    expect(service.session.battleType).toBeUndefined()

    releaseFlush()
    await expect(sync).resolves.toEqual({ success: true })
  })

  test('cloud replay does not overwrite a newer live session at its final commit point', async () => {
    service.autoBattleTypeFilter = true
    service.session.setId('initial-sng')
    service.session.setBattleType(BattleType.SIT_AND_GO)
    const recalculateSpy = jest.spyOn(service.statsOutputStream, 'recalculateStats')
      .mockResolvedValue()

    await db.apiEvents.put({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'rebuilt-ring',
      IsRetire: false,
      timestamp: 500,
      sequence: 0,
    } as ApiEvent)

    const autoSyncService = new AutoSyncService(db)
    const originalPut = db.meta.put.bind(db.meta)
    let releaseMetadata!: () => void
    let signalMetadataStarted!: () => void
    const metadataBlocked = new Promise<void>(resolve => { releaseMetadata = resolve })
    const metadataStarted = new Promise<void>(resolve => { signalMetadataStarted = resolve })
    jest.spyOn(db.meta, 'put').mockImplementation((async (...args: Parameters<typeof db.meta.put>) => {
      const record = args[0]
      if (record.id === 'importStatus') {
        signalMetadataStarted()
        await metadataBlocked
      }
      return originalPut(...args)
    }) as any)

    const rebuild = (autoSyncService as any).rebuildLocalEntities()
    await metadataStarted

    service.session.setId('new-live-mtt')
    service.session.setBattleType(BattleType.TOURNAMENT)
    service.latestEvtDeal = SEATED_DEAL as any
    const liveDeal = service.latestEvtDeal

    releaseMetadata()
    await rebuild

    expect(service.session.id).toBe('new-live-mtt')
    expect(service.session.battleType).toBe(BattleType.TOURNAMENT)
    expect(service.latestEvtDeal).toBe(liveDeal)
    expect(recalculateSpy).toHaveBeenCalledTimes(1)
  })

  test('an ended replay does not restore or broadcast its historical seated deal', async () => {
    await db.apiEvents.bulkPut([
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        Code: 0,
        BattleType: BattleType.SIT_AND_GO,
        Id: 'ended-sng',
        IsRetire: false,
        timestamp: 400,
        sequence: 0,
      },
      { ...SEATED_DEAL, timestamp: 500, sequence: 0 },
      // Raw replay state must recognize the boundary even when a future 309
      // schema change makes the application payload unparseable.
      { ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 600, sequence: 0 },
    ] as any)
    const writeSpy = jest.spyOn(service.statsOutputStream, 'write')

    const autoSyncService = new AutoSyncService(db)
    await (autoSyncService as any).rebuildLocalEntities()

    expect(service.session.id).toBeUndefined()
    expect(service.session.battleType).toBeUndefined()
    expect(service.latestEvtDeal).toBeUndefined()
    expect(writeSpy).not.toHaveBeenCalled()
  })

  test('a final entry without a deal never reuses the preceding session deal', async () => {
    service.latestEvtDeal = SEATED_DEAL as any
    const preservedLiveDeal = service.latestEvtDeal
    await db.apiEvents.bulkPut([
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        Code: 0,
        BattleType: BattleType.SIT_AND_GO,
        Id: 'old-sng',
        IsRetire: false,
        timestamp: 400,
        sequence: 0,
      },
      { ...SEATED_DEAL, timestamp: 500, sequence: 0 },
      { ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 600, sequence: 0 },
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        Code: 0,
        BattleType: BattleType.RING_GAME,
        Id: 'new-ring-without-deal',
        IsRetire: false,
        timestamp: 700,
        sequence: 0,
      },
    ] as any)
    const writeSpy = jest.spyOn(service.statsOutputStream, 'write')

    const autoSyncService = new AutoSyncService(db)
    await (autoSyncService as any).rebuildLocalEntities()

    expect(service.session.id).toBe('new-ring-without-deal')
    expect(service.session.battleType).toBe(BattleType.RING_GAME)
    expect(service.latestEvtDeal).toBe(preservedLiveDeal)
    expect(writeSpy).not.toHaveBeenCalled()
  })

  test('a terminal Friend SNG result clears replay state at end of history', async () => {
    await db.apiEvents.bulkPut([
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        Code: 0,
        BattleType: BattleType.FRIEND_SIT_AND_GO,
        Id: 'finished-friend',
        IsRetire: false,
        timestamp: 800,
        sequence: 0,
      },
      { ...SEATED_DEAL, timestamp: 900, sequence: 0 },
      { ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 1000, sequence: 0 },
    ] as any)
    const writeSpy = jest.spyOn(service.statsOutputStream, 'write')

    const autoSyncService = new AutoSyncService(db)
    await (autoSyncService as any).rebuildLocalEntities()

    expect(service.session.id).toBeUndefined()
    expect(service.session.battleType).toBeUndefined()
    expect(service.latestEvtDeal).toBeUndefined()
    expect(writeSpy).not.toHaveBeenCalled()
  })

  test('a later seated deal without a captured start boundary keeps Friend SNG attribution fail-closed', async () => {
    const continuationDeal = {
      ...SEATED_DEAL,
      timestamp: 1300,
      SeatUserIds: [8, HERO_ID, 9, 10],
    } as ApiEvent
    await db.apiEvents.bulkPut([
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        Code: 0,
        BattleType: BattleType.FRIEND_SIT_AND_GO,
        Id: 'continuing-friend',
        IsRetire: false,
        timestamp: 1100,
        sequence: 0,
      },
      { ...SEATED_DEAL, timestamp: 1150, sequence: 0 },
      { ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 1200, sequence: 0 },
      { ...continuationDeal, sequence: 0 },
    ] as any)

    const autoSyncService = new AutoSyncService(db)
    await (autoSyncService as any).rebuildLocalEntities()

    expect(service.session.id).toBeUndefined()
    expect(service.session.battleType).toBeUndefined()
    expect(service.latestEvtDeal).toEqual({ ...continuationDeal, sequence: 0 })
  })

  test('an explicit failed replay entry does not replace the active session', async () => {
    await db.apiEvents.bulkPut([
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        Code: 0,
        BattleType: BattleType.SIT_AND_GO,
        Id: 'active-sng',
        IsRetire: false,
        timestamp: 1400,
        sequence: 0,
      },
      { ...SEATED_DEAL, timestamp: 1450, sequence: 0 },
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        Code: 5205,
        BattleType: BattleType.RING_GAME,
        Id: 'rejected-ring',
        IsRetire: false,
        timestamp: 1500,
        sequence: 0,
      },
    ] as any)

    const autoSyncService = new AutoSyncService(db)
    await (autoSyncService as any).rebuildLocalEntities()

    expect(service.session.id).toBe('active-sng')
    expect(service.session.battleType).toBe(BattleType.SIT_AND_GO)
    expect(service.latestEvtDeal).toEqual({ ...SEATED_DEAL, timestamp: 1450, sequence: 0 })
  })

  test('a minimally valid raw entry prevents a prior Friend snapshot from crossing categories', async () => {
    const ringDeal = {
      ...SEATED_DEAL,
      timestamp: 1800,
      SeatUserIds: [11, HERO_ID, 12, 13],
    } as ApiEvent
    await db.apiEvents.bulkPut([
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        Code: 0,
        BattleType: BattleType.FRIEND_SIT_AND_GO,
        Id: 'old-friend',
        IsRetire: false,
        timestamp: 1600,
        sequence: 0,
      },
      { ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 1650, sequence: 0 },
      // Missing IsRetire: application parsing fails, but the raw boundary is
      // sufficient to install the new category.
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        Code: 0,
        BattleType: BattleType.RING_GAME,
        Id: 'raw-ring',
        timestamp: 1700,
        sequence: 0,
      },
      { ...ringDeal, sequence: 0 },
    ] as any)

    const autoSyncService = new AutoSyncService(db)
    await (autoSyncService as any).rebuildLocalEntities()

    expect(service.session.id).toBe('raw-ring')
    expect(service.session.battleType).toBe(BattleType.RING_GAME)
    expect(service.latestEvtDeal).toEqual({ ...ringDeal, sequence: 0 })
  })

  test('a minimally valid raw entry classifies subsequently rebuilt hands', async () => {
    await db.apiEvents.bulkPut([
      // Missing IsRetire deliberately makes this boundary unparseable while
      // retaining the raw identity/category recovered by live ingestion.
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        Code: 0,
        BattleType: BattleType.RING_GAME,
        Id: 'raw-ring-hand',
        timestamp: 1900,
        sequence: 0,
      },
      { ...SEATED_DEAL, timestamp: 1910, sequence: 0 },
      { ...makeHandResult(991, 1920), sequence: 0 },
    ] as any)

    const autoSyncService = new AutoSyncService(db)
    await (autoSyncService as any).rebuildLocalEntities()

    expect((await db.hands.get(991))?.session).toEqual({
      id: 'raw-ring-hand',
      battleType: BattleType.RING_GAME,
      name: undefined,
    })
  })

  test('raw entry cancellation retires the queued replay session before commit', async () => {
    await db.apiEvents.bulkPut([
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        Code: 0,
        BattleType: BattleType.RING_GAME,
        Id: 'cancelled-ring',
        IsRetire: false,
        timestamp: 700,
        sequence: 0,
      },
      { ApiTypeId: 203, Code: 0, timestamp: 800, sequence: 0 },
    ] as any)

    const autoSyncService = new AutoSyncService(db)
    await (autoSyncService as any).rebuildLocalEntities()

    expect(service.session.id).toBeUndefined()
    expect(service.session.battleType).toBeUndefined()
    expect(service.getEffectiveBattleTypeFilter()).toBeUndefined()
  })

  test('raw entry cancellation clears converter category before a later hand', async () => {
    await db.apiEvents.bulkPut([
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        Code: 0,
        BattleType: BattleType.RING_GAME,
        Id: 'cancelled-before-hand',
        IsRetire: false,
        timestamp: 2000,
        sequence: 0,
      },
      { ApiTypeId: 203, Code: 0, timestamp: 2010, sequence: 0 },
      { ...SEATED_DEAL, timestamp: 2020, sequence: 0 },
      { ...makeHandResult(992, 2030), sequence: 0 },
    ] as any)

    const autoSyncService = new AutoSyncService(db)
    await (autoSyncService as any).rebuildLocalEntities()

    expect((await db.hands.get(992))?.session).toEqual({
      id: undefined,
      battleType: undefined,
      name: undefined,
    })
  })

  test('a raw session result clears converter category before a later hand', async () => {
    await db.apiEvents.bulkPut([
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        Code: 0,
        BattleType: BattleType.SIT_AND_GO,
        Id: 'finished-before-hand',
        IsRetire: false,
        timestamp: 2100,
        sequence: 0,
      },
      { ...SEATED_DEAL, timestamp: 2110, sequence: 0 },
      { ...makeHandResult(993, 2120), sequence: 0 },
      // Deliberately unparseable: raw lifecycle recovery must still retire
      // the preceding converter context.
      { ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 2130, sequence: 0 },
      { ...SEATED_DEAL, timestamp: 2140, sequence: 0 },
      { ...makeHandResult(994, 2150), sequence: 0 },
    ] as any)

    const autoSyncService = new AutoSyncService(db)
    await (autoSyncService as any).rebuildLocalEntities()

    expect((await db.hands.get(993))?.session).toEqual({
      id: 'finished-before-hand',
      battleType: BattleType.SIT_AND_GO,
      name: undefined,
    })
    expect((await db.hands.get(994))?.session).toEqual({
      id: undefined,
      battleType: undefined,
      name: undefined,
    })
  })

  test('a seated deal alone does not restore ended Friend SNG context before converting its hand', async () => {
    const continuationDeal = {
      ...SEATED_DEAL,
      timestamp: 2220,
      SeatUserIds: [8, HERO_ID, 9, 10],
    } as ApiEvent
    await db.apiEvents.bulkPut([
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        Code: 0,
        BattleType: BattleType.FRIEND_SIT_AND_GO,
        Id: 'continuing-friend-hand',
        IsRetire: false,
        timestamp: 2200,
        sequence: 0,
      },
      { ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 2210, sequence: 0 },
      { ...continuationDeal, sequence: 0 },
      { ...makeHandResult(995, 2230), sequence: 0 },
    ] as any)

    const autoSyncService = new AutoSyncService(db)
    await (autoSyncService as any).rebuildLocalEntities()

    expect((await db.hands.get(995))?.session).toEqual({})
  })

  test('Friend SNG replay keeps a pre-terminal hand context but leaves later deals unclassified without a start boundary', async () => {
    const spectatorDeal = {
      ...SEATED_DEAL,
      Player: undefined,
      timestamp: 2340,
    } as unknown as ApiEvent
    const continuationDeal = {
      ...SEATED_DEAL,
      timestamp: 2360,
      SeatUserIds: [8, HERO_ID, 9, 10],
    } as ApiEvent
    await db.apiEvents.bulkPut([
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        Code: 0,
        BattleType: BattleType.FRIEND_SIT_AND_GO,
        Id: 'interleaved-friend',
        IsRetire: false,
        timestamp: 2300,
        sequence: 0,
      },
      { ...SEATED_DEAL, timestamp: 2310, sequence: 0 },
      { ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 2320, sequence: 0 },
      // This result completes the Friend hand that began before the
      // interleaved 309, so it must retain the provisional Friend context.
      { ...makeHandResult(996, 2330), sequence: 0 },
      { ...spectatorDeal, sequence: 0 },
      { ...makeHandResult(997, 2350), sequence: 0 },
      { ...continuationDeal, sequence: 0 },
      { ...makeHandResult(998, 2370), sequence: 0 },
    ] as any)

    const autoSyncService = new AutoSyncService(db)
    await (autoSyncService as any).rebuildLocalEntities()

    expect((await db.hands.get(996))?.session).toEqual({
      id: 'interleaved-friend',
      battleType: BattleType.FRIEND_SIT_AND_GO,
      name: undefined,
    })
    expect((await db.hands.get(997))?.session).toEqual({
      id: undefined,
      battleType: undefined,
      name: undefined,
    })
    expect((await db.hands.get(998))?.session).toEqual({})
  })
})
