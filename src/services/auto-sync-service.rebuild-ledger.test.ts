import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { EntityConverter, type EntityBundle } from '../entity-converter'
import { getStatCounter } from '../stats/hand-contribution'
import {
  STATS_CANONICAL_REBUILD_META_ID,
  STATS_LEDGER_STAGING_META_ID,
  STATS_PENDING_HAND_DERIVATION_META_PREFIX,
  StatsLedger,
} from '../stats/stat-ledger'
import type { ApiEvent, Session } from '../types'
import { getOperationState } from '../background/operation-state'
import { trackServiceForTeardown } from '../utils/test-service-teardown'
import {
  AutoSyncService,
  REBUILD_AFTER_DOWNLOAD_FAILED_MESSAGE,
} from './auto-sync-service'
import { firestoreBackupService } from './firestore-backup-service'
import { mergeApiEvents, type RawApiEvent } from '../utils/api-event-key'

const HERO_ID = 4
const FIRST_HAND_ID = 384370064

function handEvents(handId: number, dealTimestamp: number): ApiEvent[] {
  return [
    {
      ApiTypeId: 303,
      SeatUserIds: [2, HERO_ID, 3, 1],
      Game: {
        CurrentBlindLv: 1,
        NextBlindUnixSeconds: -1,
        Ante: 50,
        SmallBlind: 100,
        BigBlind: 200,
        ButtonSeat: 3,
        SmallBlindSeat: 0,
        BigBlindSeat: 1,
      },
      Player: { SeatIndex: 1, BetStatus: 1, HoleCards: [5, 21], Chip: 5750, BetChip: 200 },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 5850, BetChip: 100, IsSafeLeave: false },
        { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 5950, BetChip: 0, IsSafeLeave: false },
        { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 5950, BetChip: 0, IsSafeLeave: false },
      ],
      Progress: {
        Phase: 0,
        NextActionSeat: 2,
        NextActionTypes: [2, 3, 4, 5],
        NextExtraLimitSeconds: 1,
        MinRaise: 400,
        Pot: 500,
        SidePot: [],
      },
      timestamp: dealTimestamp,
    },
    {
      ApiTypeId: 306,
      CommunityCards: [],
      Pot: 500,
      SidePot: [],
      ResultType: 0,
      DefeatStatus: 0,
      HandId: handId,
      HandLog: '',
      Results: [{ UserId: HERO_ID, HoleCards: [], RankType: 10, Hands: [], HandRanking: 1, Ranking: -2, RewardChip: 500 }],
      Player: { SeatIndex: 1, BetStatus: -1, Chip: 6250, BetChip: 0 },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: -1, Chip: 5850, BetChip: 0, IsSafeLeave: false },
        { SeatIndex: 2, Status: 0, BetStatus: -1, Chip: 5950, BetChip: 0, IsSafeLeave: false },
        { SeatIndex: 3, Status: 0, BetStatus: -1, Chip: 5950, BetChip: 0, IsSafeLeave: false },
      ],
      timestamp: dealTimestamp + 1000,
    },
  ] as unknown as ApiEvent[]
}

function convert(events: ApiEvent[]): EntityBundle {
  const session: Session = {
    id: undefined,
    battleType: undefined,
    name: undefined,
    players: new Map(),
    reset: () => {},
  }
  return new EntityConverter(session).convertEventsToEntities(events)
}

async function waitForGenerationRemoval(db: PokerChaseDB, generation: number): Promise<void> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const [contributions, aggregates] = await Promise.all([
      db.statHandContributions.where('generation').equals(generation).count(),
      db.statPlayerAggregates.where('generation').equals(generation).count(),
    ])
    if (contributions === 0 && aggregates === 0) return
    await new Promise<void>(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for inactive statistics generation ${generation} cleanup`)
}

describe('AutoSyncService cloud rebuild stats ledger generation', () => {
  let db: PokerChaseDB
  let syncDb: PokerChaseDB
  let service: PokerChaseService
  let autoSyncService: AutoSyncService

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    // 本番と同じくAutoSync singletonとPokerChaseServiceは別Dexie connection。
    syncDb = new PokerChaseDB(indexedDB, IDBKeyRange)
    await syncDb.open()
    service = trackServiceForTeardown(new PokerChaseService({ db }))
    await service.ready
    jest.spyOn(service.statsOutputStream, 'write').mockImplementation(() => {})
    ;(globalThis as any).service = service
    ;(chrome.runtime.sendMessage as jest.Mock).mockResolvedValue(undefined)
    autoSyncService = new AutoSyncService(syncDb)
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    delete (globalThis as any).service
    syncDb.close()
    db.close()
    await db.delete()
  })

  test('activation failure rolls back stale canonical cleanup and leaves the old ledger head visible', async () => {
    await db.apiEvents.bulkAdd(handEvents(FIRST_HAND_ID, 1000))
    await (autoSyncService as any).rebuildLocalEntities()

    const oldHead = await service.statsLedger.getActiveHead()
    const oldImportStatus = await db.meta.get('importStatus')
    expect(oldHead).not.toBeNull()
    expect((await service.statsLedger.readPlayerSnapshot(HERO_ID)).selectedHands).toBe(1)

    // 既存handをキメラにするcloud-only DEAL。成功時はcanonical replayから消える。
    const tableMoveDeal = {
      ...structuredClone(handEvents(FIRST_HAND_ID, 1000)[0]),
      SeatUserIds: [10, 20, 30, 40],
      timestamp: 1999,
    } as ApiEvent
    await db.apiEvents.add(tableMoveDeal)
    // final activationまでcanonical chunkを実際にcommitさせる。新staging台帳は
    // 全player分の二重保持を避けるため空のままである。
    await db.apiEvents.bulkAdd(handEvents(FIRST_HAND_ID + 1, 3000))
    const originalPrepare = StatsLedger.prototype.prepareStagingGeneration
    let failedGeneration: number | undefined
    jest.spyOn(StatsLedger.prototype, 'prepareStagingGeneration')
      .mockImplementationOnce(async function (this: StatsLedger, generation) {
        const head = await originalPrepare.call(this, generation)
        failedGeneration = head.generation
        return head
      })
    const originalActivate = StatsLedger.prototype.activateStagingGeneration
    jest.spyOn(StatsLedger.prototype, 'activateStagingGeneration')
      .mockImplementationOnce(async function (this: StatsLedger, generation) {
        await originalActivate.call(this, generation)
        // 実head更新の後で外側transactionを失敗させ、独立commitを検出する。
        throw new Error('synthetic post-activation failure')
      })
    const originalAbandon = StatsLedger.prototype.abandonStagingGeneration
    let stagedRowsBeforeAbandon = 0
    jest.spyOn(StatsLedger.prototype, 'abandonStagingGeneration')
      .mockImplementationOnce(async function (this: StatsLedger, generation) {
        stagedRowsBeforeAbandon = await this.db.statHandContributions
          .where('generation').equals(generation).count()
        await originalAbandon.call(this, generation)
      })

    await expect((autoSyncService as any).rebuildLocalEntities())
      .rejects.toThrow(REBUILD_AFTER_DOWNLOAD_FAILED_MESSAGE)

    // cleanup/head/importStatusは1 transactionなので、どれかだけ進んではならない。
    expect(await db.hands.get(FIRST_HAND_ID)).toBeDefined()
    expect(await service.statsLedger.getActiveHead()).toEqual(oldHead)
    expect(await db.meta.get('importStatus')).toEqual(oldImportStatus)
    expect(await db.meta.get('statsLedgerStaging')).toBeUndefined()
    expect((await service.statsLedger.readPlayerSnapshot(HERO_ID)).selectedHands).toBe(1)
    expect(failedGeneration).toBeDefined()
    expect(stagedRowsBeforeAbandon).toBe(0)
    await waitForGenerationRemoval(db, failedGeneration!)
  })

  test('a staging append failure rolls back the matching canonical chunk', async () => {
    await db.apiEvents.bulkAdd(handEvents(FIRST_HAND_ID, 1000))
    const originalPrepare = StatsLedger.prototype.prepareStagingGeneration
    let failedGeneration: number | undefined
    jest.spyOn(StatsLedger.prototype, 'prepareStagingGeneration')
      .mockImplementationOnce(async function (this: StatsLedger, generation) {
        const head = await originalPrepare.call(this, generation)
        failedGeneration = head.generation
        return head
      })
    const originalAppend = StatsLedger.prototype.appendStagingEntityBundle
    jest.spyOn(StatsLedger.prototype, 'appendStagingEntityBundle')
      .mockImplementationOnce(async function (this: StatsLedger, generation, bundle) {
        await originalAppend.call(this, generation, bundle)
        throw new Error('synthetic post-append failure')
      })

    await expect((autoSyncService as any).rebuildLocalEntities())
      .rejects.toThrow(REBUILD_AFTER_DOWNLOAD_FAILED_MESSAGE)

    // canonicalと寄与の片方だけをcommitしてはならない（MUST NOT）。
    expect(await db.hands.count()).toBe(0)
    expect(await db.phases.count()).toBe(0)
    expect(await db.actions.count()).toBe(0)
    const emptyActiveHead = await service.statsLedger.getActiveHead()
    expect(emptyActiveHead).not.toBeNull()
    expect(await db.statHandContributions.where('generation').equals(emptyActiveHead!.generation).count()).toBe(0)
    expect(await db.statPlayerAggregates.where('generation').equals(emptyActiveHead!.generation).count()).toBe(0)
    expect(await db.meta.get('statsLedgerStaging')).toBeUndefined()
    expect(failedGeneration).toBeDefined()
    await waitForGenerationRemoval(db, failedGeneration!)
    expect(await db.apiEvents.count()).toBe(2)
  })

  test('a hand completed during replay is recovered from canonical after the empty head switch', async () => {
    const replayEvents = handEvents(FIRST_HAND_ID, 1000)
    // cursor通過後にclock-skewed keyで着地するlive hand。dynamic replayの
    // 次queryでは拾えないが、canonicalには残るためlazy baselineで回収できる。
    const liveEvents = handEvents(FIRST_HAND_ID + 1, 500)
    const liveBundle = convert(liveEvents)
    await db.apiEvents.bulkAdd(replayEvents)

    const originalSave = (AutoSyncService.prototype as any).saveRebuiltEntities as (
      this: AutoSyncService,
      bundle: EntityBundle,
      generation: number
    ) => Promise<void>
    let injected = false
    jest.spyOn(AutoSyncService.prototype as any, 'saveRebuiltEntities')
      .mockImplementation(async function (
        this: AutoSyncService,
        ...args: unknown[]
      ) {
        const [bundle, generation] = args as [EntityBundle, number]
        await originalSave.call(this, bundle, generation)
        if (injected) return
        injected = true

        // replay cursor通過後にraw保存→WriteEntityStream commitが走る形を再現する。
        await db.apiEvents.bulkAdd(liveEvents)
        await db.transaction('rw', [
          db.hands,
          db.phases,
          db.actions,
          db.meta,
          db.statHandContributions,
          db.statPlayerAggregates,
        ], async () => {
          await db.hands.bulkPut(liveBundle.hands)
          await db.phases.bulkPut(liveBundle.phases)
          await db.actions.bulkPut(liveBundle.actions)
          await service.statsLedger.replaceCompletedHandContributions(liveBundle)
        })
      })

    await (autoSyncService as any).rebuildLocalEntities()

    expect(await db.hands.count()).toBe(2)
    const activeHead = await service.statsLedger.getActiveHead()
    expect(activeHead).not.toBeNull()
    // 全player stagingは作らず空headを公開する。
    expect(await db.statHandContributions.get([
      activeHead!.generation,
      HERO_ID,
      FIRST_HAND_ID + 1,
    ])).toBeUndefined()
    expect(await db.statPlayerAggregates.get([activeHead!.generation, HERO_ID])).toBeUndefined()
    const snapshot = await service.statsLedger.readPlayerSnapshot(HERO_ID)
    expect(snapshot.selectedHands).toBe(2)
    expect(snapshot.totalHands).toBe(2)
    const aggregate = await db.statPlayerAggregates.get([activeHead!.generation, HERO_ID])
    expect(aggregate?.ready).toBe(true)
    expect(getStatCounter(aggregate!.totals, 'hands')).toEqual([2, 0])
    // 後着live rowsはreplay cursorより前でもcanonical lazy baselineで合流する。
    expect((await db.meta.get('importStatus'))?.value).toMatchObject({
      lastProcessedEventCount: replayEvents.length,
      lastProcessedTimestamp: 2000,
    })
  })

  test('cold boot recovery ignores auth/lastSyncTime and repairs a foreign interrupted rebuild from the Raw Lake', async () => {
    const firstEvents = handEvents(FIRST_HAND_ID, 1000)
    const secondEvents = handEvents(FIRST_HAND_ID + 1, 3000)
    await db.apiEvents.bulkAdd([...firstEvents, ...secondEvents])
    await (autoSyncService as any).rebuildLocalEntities()
    await service.statsLedger.readPlayerSnapshot(HERO_ID)
    const previousHead = await service.statsLedger.getActiveHead()

    const staging = await service.statsLedger.prepareStagingGeneration()
    const secondBundle = convert(secondEvents)
    await db.transaction('rw', [
      db.hands,
      db.phases,
      db.actions,
      db.meta,
      db.statHandContributions,
      db.statPlayerAggregates,
    ], async () => {
      // 旧workerがcanonicalの一部を不正に置換した直後に停止した形。
      await db.hands.put({ ...secondBundle.hands[0]!, seatUserIds: [91, 92, 93, 94] })
      await service.statsLedger.appendStagingEntityBundle(staging.generation, secondBundle)
    })
    for (const id of [STATS_LEDGER_STAGING_META_ID, STATS_CANONICAL_REBUILD_META_ID]) {
      const row = await db.meta.get(id)
      await db.meta.put({
        ...row!,
        value: { ...(row!.value as object), ownerId: 'dead-worker' },
      })
    }
    await chrome.storage.local.set({ autoSyncLastTime: new Date(0).toISOString() })

    const restarted = new AutoSyncService(syncDb)
    const originalRebuild = (restarted as any).rebuildLocalEntities.bind(restarted)
    let releaseRecovery!: () => void
    let recoveryEnteredResolve!: () => void
    const recoveryGate = new Promise<void>(resolve => { releaseRecovery = resolve })
    const recoveryEntered = new Promise<void>(resolve => { recoveryEnteredResolve = resolve })
    jest.spyOn(restarted as any, 'rebuildLocalEntities').mockImplementationOnce(async () => {
      recoveryEnteredResolve()
      await recoveryGate
      await originalRebuild()
    })
    const recovery = restarted.recoverInterruptedCanonicalRebuild()
    await recoveryEntered
    // recoveryはoperation slotを取るが、既存ready headのread/live ingestionをロックしない。
    expect((await service.statsLedger.readPlayerSnapshot(HERO_ID)).selectedHands).toBe(2)
    releaseRecovery()
    await expect(recovery).resolves.toBe(true)

    expect(await db.meta.get(STATS_LEDGER_STAGING_META_ID)).toBeUndefined()
    expect(await db.meta.get(STATS_CANONICAL_REBUILD_META_ID)).toBeUndefined()
    expect((await service.statsLedger.getActiveHead())?.generation).not.toBe(previousHead?.generation)
    expect((await db.hands.get(FIRST_HAND_ID + 1))?.seatUserIds).toEqual([2, HERO_ID, 3, 1])
    expect((await service.statsLedger.readPlayerSnapshot(HERO_ID)).selectedHands).toBe(2)
    expect(getOperationState().type).toBe('idle')
  })

  test('chunked recovery clears only its start snapshot and preserves a live result fence added after the scan starts', async () => {
    const replayEvents = handEvents(FIRST_HAND_ID, 1000)
    const seeded = await mergeApiEvents(db, replayEvents as unknown as RawApiEvent[], {
      atomicMetaRecordsForAdded: added =>
        service.statsLedger.createPendingHandDerivationFenceRecords(added),
    })
    const replayResult = seeded.added.find(event => event.ApiTypeId === 306)!
    const recoveredId = `${STATS_PENDING_HAND_DERIVATION_META_PREFIX}${replayResult.HandId}:${replayResult.timestamp}:${replayResult.sequence}`
    const recoveredRow = await db.meta.get(recoveredId)
    await db.meta.put({
      ...recoveredRow!,
      value: { ...(recoveredRow!.value as object), ownerId: 'dead-worker' },
    })

    const lateResult = {
      ...structuredClone(replayEvents[1]!),
      HandId: FIRST_HAND_ID + 99,
      timestamp: 5000,
    } as unknown as RawApiEvent
    let lateId: string | undefined
    const originalSave = (AutoSyncService.prototype as any).saveRebuiltEntities as (
      this: AutoSyncService,
      bundle: EntityBundle,
      generation: number
    ) => Promise<void>
    jest.spyOn(AutoSyncService.prototype as any, 'saveRebuiltEntities')
      .mockImplementationOnce(async function (
        this: AutoSyncService,
        ...args: unknown[]
      ) {
        const [bundle, generation] = args as [EntityBundle, number]
        await originalSave.call(this, bundle, generation)
        const lateMerge = await mergeApiEvents(db, [lateResult], {
          atomicMetaRecordsForAdded: added =>
            service.statsLedger.createPendingHandDerivationFenceRecords(added),
        })
        const stored = lateMerge.added[0]!
        lateId = `${STATS_PENDING_HAND_DERIVATION_META_PREFIX}${stored.HandId}:${stored.timestamp}:${stored.sequence}`
      })

    await (autoSyncService as any).rebuildLocalEntities()

    expect(await db.meta.get(recoveredId)).toBeUndefined()
    expect(lateId).toBeDefined()
    expect(await db.meta.get(lateId!)).toBeDefined()
    expect(await service.statsLedger.needsCanonicalRebuildRecovery()).toBe(false)
  })

  test('forced live recovery consumes an exact current-worker fence without a failed marker', async () => {
    const replayEvents = handEvents(FIRST_HAND_ID, 1000)
    const seeded = await mergeApiEvents(db, replayEvents as unknown as RawApiEvent[], {
      atomicMetaRecordsForAdded: added =>
        service.statsLedger.createPendingHandDerivationFenceRecords(added),
    })
    const replayResult = seeded.added.find(event => event.ApiTypeId === 306)!
    const pendingFenceId = `${STATS_PENDING_HAND_DERIVATION_META_PREFIX}${replayResult.HandId}:${replayResult.timestamp}:${replayResult.sequence}`

    // current worker所有・未failedなので通常のboot判定からは意図的に除外される。
    expect(await service.statsLedger.needsCanonicalRebuildRecovery()).toBe(false)

    await autoSyncService.scheduleCanonicalRebuildRecovery(pendingFenceId)

    expect(await db.hands.get(FIRST_HAND_ID)).toBeDefined()
    expect(await db.meta.get(pendingFenceId)).toBeUndefined()
    expect((await service.statsLedger.readPlayerSnapshot(HERO_ID)).selectedHands).toBe(1)
  })

  test('exact hand recovery keeps large replay memory and canonical commit bounded', async () => {
    const history = Array.from({ length: 120 }, (_, index) =>
      handEvents(FIRST_HAND_ID + index, 10_000 + index * 2_000)
    ).flat()
    await db.apiEvents.bulkAdd(history)
    const target = await db.apiEvents.get([10_000 + 119 * 2_000 + 1000, 306, 0])
    expect(target).toBeDefined()
    const fence = service.statsLedger.createPendingHandDerivationFenceRecords([target! as unknown as RawApiEvent])[0]!
    await db.meta.put(fence)
    const fenceId = fence.id

    const handPut = jest.spyOn(syncDb.hands, 'put')
    await autoSyncService.scheduleCanonicalRebuildRecovery(fenceId)

    // 120-hand history was replayed by the canonical converter, but only the
    // requested hand crosses the recovery commit boundary.
    expect(handPut).toHaveBeenCalledTimes(1)
    expect(await db.hands.count()).toBe(1)
    expect(await db.hands.get(FIRST_HAND_ID + 119)).toBeDefined()
    expect(await db.statHandContributions.where('[generation+handId]')
      .equals([(await service.statsLedger.getActiveHead())!.generation, FIRST_HAND_ID + 119])
      .count()).toBe(4)
    expect((autoSyncService as any).rebuildEntityBuffer).toBeUndefined()
    expect(await db.meta.get(fenceId)).toBeUndefined()
  })

  test('exact hand commit failure keeps old canonical rows and the fence retryable', async () => {
    const oldEvents = handEvents(FIRST_HAND_ID, 1000)
    await db.apiEvents.bulkAdd(oldEvents)
    await (autoSyncService as any).rebuildLocalEntities()
    const oldHand = await db.hands.get(FIRST_HAND_ID)
    expect(oldHand).toBeDefined()

    const newEvents = handEvents(FIRST_HAND_ID + 1, 4000)
    const merged = await mergeApiEvents(syncDb, newEvents as unknown as RawApiEvent[], {
      atomicMetaRecordsForAdded: added =>
        service.statsLedger.createPendingHandDerivationFenceRecords(added),
    })
    const result = merged.added.find(event => event.ApiTypeId === 306)!
    const fenceId = service.statsLedger.getPendingHandDerivationFenceId(result)!
    const putSpy = jest.spyOn(syncDb.hands, 'put')
      .mockRejectedValueOnce(new Error('synthetic hand commit failure'))

    await expect(autoSyncService.scheduleCanonicalRebuildRecovery(fenceId))
      .rejects.toThrow('synthetic hand commit failure')
    expect(await db.hands.get(FIRST_HAND_ID)).toEqual(oldHand)
    expect(await db.hands.get(FIRST_HAND_ID + 1)).toBeUndefined()
    expect(await db.meta.get(fenceId)).toBeDefined()

    putSpy.mockRestore()
    await autoSyncService.scheduleCanonicalRebuildRecovery(fenceId)
    expect(await db.hands.get(FIRST_HAND_ID)).toEqual(oldHand)
    expect(await db.hands.get(FIRST_HAND_ID + 1)).toBeDefined()
    expect(await db.meta.get(fenceId)).toBeUndefined()
  })

  test('a partial cloud page atomically leaves a boot-recovery fence before rebuild starts', async () => {
    const events = handEvents(FIRST_HAND_ID, 1000)
    const cloudSpy = jest.spyOn(firestoreBackupService, 'syncFromCloud').mockImplementation(async options => {
      await options.onBatch(events)
      throw new Error('synthetic network failure after first page')
    })
    const failedRebuild = jest.spyOn(autoSyncService as any, 'rebuildLocalEntities')
      .mockRejectedValueOnce(new Error('synthetic rebuild failure'))

    await expect((autoSyncService as any).downloadAndRebuildFromCloud())
      .rejects.toThrow('synthetic network failure after first page')

    expect(await db.apiEvents.count()).toBe(events.length)
    expect(await db.meta.get(STATS_CANONICAL_REBUILD_META_ID)).toBeDefined()
    expect(await db.hands.count()).toBe(0)

    failedRebuild.mockRestore()
    cloudSpy.mockRestore()
    const restarted = new AutoSyncService(syncDb)
    await expect(restarted.recoverInterruptedCanonicalRebuild()).resolves.toBe(true)
    expect(await db.meta.get(STATS_CANONICAL_REBUILD_META_ID)).toBeUndefined()
    expect(await db.hands.get(FIRST_HAND_ID)).toBeDefined()
    expect((await service.statsLedger.readPlayerSnapshot(HERO_ID)).selectedHands).toBe(1)
  })

  test('boot recovery failure keeps dirty markers and releases operation/keepalive ownership', async () => {
    await service.statsLedger.prepareStagingGeneration()
    ;(chrome.runtime.sendMessage as jest.Mock).mockResolvedValue(undefined)
    jest.spyOn(autoSyncService as any, 'rebuildLocalEntities')
      .mockRejectedValueOnce(new Error('synthetic recovery failure'))

    await expect(autoSyncService.recoverInterruptedCanonicalRebuild())
      .rejects.toThrow('synthetic recovery failure')

    expect(await db.meta.get(STATS_LEDGER_STAGING_META_ID)).toBeDefined()
    expect(await db.meta.get(STATS_CANONICAL_REBUILD_META_ID)).toBeDefined()
    expect(getOperationState().type).toBe('idle')
    expect(autoSyncService.getSyncState()).toMatchObject({
      status: 'error',
      error: 'synthetic recovery failure',
    })
  })

  test('live recovery scheduling coalesces overlap and drains a marker added mid-pass', async () => {
    let resolveFirst!: (value: boolean) => void
    const firstRecovery = new Promise<boolean>(resolve => {
      resolveFirst = resolve
    })
    const recover = jest.spyOn(autoSyncService, 'recoverInterruptedCanonicalRebuild')
      .mockImplementationOnce(async () => await firstRecovery)
      .mockResolvedValueOnce(false)
    const needsRecovery = jest.spyOn(
      (autoSyncService as unknown as { statsLedger: StatsLedger }).statsLedger,
      'needsCanonicalRebuildRecovery'
    ).mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const first = autoSyncService.scheduleCanonicalRebuildRecovery()
    const overlapping = autoSyncService.scheduleCanonicalRebuildRecovery()
    expect(recover).toHaveBeenCalledTimes(1)

    resolveFirst(true)
    await Promise.all([first, overlapping])

    expect(recover).toHaveBeenCalledTimes(2)
    expect(needsRecovery).toHaveBeenCalledTimes(2)
  })

  test('a failed scheduled recovery can be requested again by the next live failure', async () => {
    const recover = jest.spyOn(autoSyncService, 'recoverInterruptedCanonicalRebuild')
      .mockRejectedValueOnce(new Error('synthetic live recovery failure'))
      .mockResolvedValueOnce(false)
    jest.spyOn(
      (autoSyncService as unknown as { statsLedger: StatsLedger }).statsLedger,
      'needsCanonicalRebuildRecovery'
    ).mockResolvedValue(false)

    await expect(autoSyncService.scheduleCanonicalRebuildRecovery())
      .rejects.toThrow('synthetic live recovery failure')
    await expect(autoSyncService.scheduleCanonicalRebuildRecovery()).resolves.toBeUndefined()
    expect(recover).toHaveBeenCalledTimes(2)
  })

  test('upload-only sync does not overwrite a dirty rebuild error before local recovery succeeds', async () => {
    await service.statsLedger.prepareStagingGeneration()
    const recovery = jest.spyOn(autoSyncService as any, 'recoverCanonicalRebuildWithOwnedSlot')
      .mockRejectedValueOnce(new Error('local recovery still required'))
    const upload = jest.spyOn(autoSyncService as any, 'syncToCloud')

    await expect(autoSyncService.performSync('upload')).resolves.toEqual({
      success: false,
      error: 'local recovery still required',
    })
    expect(recovery).toHaveBeenCalledWith('sync', true)
    expect(upload).not.toHaveBeenCalled()
    expect(await db.meta.get(STATS_CANONICAL_REBUILD_META_ID)).toBeDefined()
  })

  test('cold boot maintenance resumes GC after a post-activation worker stop', async () => {
    // 旧workerのactivation後、GC timer発火前に停止した状態を作る。
    ;(service.statsLedger as unknown as { cleanupScheduled: boolean }).cleanupScheduled = true
    await service.statsLedger.replaceGenerationFromEntityBundle(
      convert(handEvents(FIRST_HAND_ID, 1000)),
      { generation: 900 }
    )
    await service.statsLedger.replaceGenerationFromEntityBundle(
      convert(handEvents(FIRST_HAND_ID + 1, 3000)),
      { generation: 901 }
    )
    expect(await db.statHandContributions.where('generation').equals(900).count()).toBeGreaterThan(0)

    const restarted = new AutoSyncService(syncDb)
    await expect(restarted.recoverInterruptedCanonicalRebuild()).resolves.toBe(false)
    await waitForGenerationRemoval(db, 900)
    expect(await db.statHandContributions.where('generation').equals(901).count()).toBeGreaterThan(0)
  })
})
