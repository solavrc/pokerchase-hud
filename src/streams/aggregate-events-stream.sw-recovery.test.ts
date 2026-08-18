import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { ApiType, type ApiEvent } from '../types'
import { MTT_TABLE_MOVE_FIXTURE } from '../test-fixtures/mtt-table-move-lifecycle'
import { mergeApiEvents, type RawApiEvent } from '../utils/api-event-key'
import { trackServiceForTeardown } from '../utils/test-service-teardown'
import { STATS_PENDING_HAND_DERIVATION_META_PREFIX } from '../stats/stat-ledger'
import { AutoSyncService } from '../services/auto-sync-service'
import { SessionState } from '../services/poker-chase-service'
import * as portNotifications from '../background/ports'
import { getRecentHands } from '../services/recent-hands-service'
import { __resetActivePortStateForTests, claimActivePort, resolveGeneration } from '../background/active-port'
import {
  __resetStatsOutputContextForTests,
  setDefaultStatsContextProvider,
} from './stats-output-context'

describe('AggregateEventsStreamのRaw Lake全再構築handoff', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let nodeEnvBeforeTest: string | undefined

  beforeEach(async () => {
    nodeEnvBeforeTest = process.env.NODE_ENV
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = trackServiceForTeardown(new PokerChaseService({ db }))
    await service.ready
    service.session.setId('recovery-test')
    jest.spyOn(service.statsOutputStream, 'write').mockImplementation(() => {})
    jest.spyOn(portNotifications, 'notifyRecoveredHandCompletion')
    ;(globalThis as any).service = service
    ;(chrome.runtime.sendMessage as jest.Mock).mockResolvedValue(undefined)
  })

  afterEach(async () => {
    if (nodeEnvBeforeTest === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = nodeEnvBeforeTest
    await service.statsOutputStream.whenIdle().catch(() => {})
    jest.restoreAllMocks()
    __resetActivePortStateForTests()
    __resetStatsOutputContextForTests()
    delete (globalThis as any).service
    db.close()
    await db.delete()
  })

  const firstHand = (): ApiEvent[] =>
    structuredClone(MTT_TABLE_MOVE_FIXTURE.events.slice(0, 6)) as ApiEvent[]

  const seedRaw = async (events: ApiEvent[]): Promise<ApiEvent<ApiType.EVT_HAND_RESULTS>[]> => {
    const merged = await mergeApiEvents(db, structuredClone(events) as unknown as RawApiEvent[], {
      atomicMetaRecordsForAdded: added =>
        service.statsLedger.createPendingHandDerivationFenceRecords(added),
    })
    return merged.added.filter(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS) as
      ApiEvent<ApiType.EVT_HAND_RESULTS>[]
  }

  const fenceCount = async (): Promise<number> =>
    await db.meta.where('id').startsWith(STATS_PENDING_HAND_DERIVATION_META_PREFIX).count()

  const wireRecovery = (autoSync: AutoSyncService): {
    fenceId?: string
    wait: () => Promise<void>
  } => {
    let recoveryPromise: Promise<void> | undefined
    let fenceId: string | undefined
    service.handAggregateStream.on('error', error => {
      const canonicalError = error as {
        canonicalRecoveryRequired?: true
        canonicalRecoveryFenceId?: string
      }
      if (canonicalError.canonicalRecoveryRequired !== true) return
      fenceId = canonicalError.canonicalRecoveryFenceId
      recoveryPromise = autoSync.scheduleCanonicalRebuildRecovery(fenceId)
    })
    return {
      get fenceId() {
        return fenceId
      },
      wait: async () => {
        if (!recoveryPromise) throw new Error('canonical recovery was not requested')
        await recoveryPromise
      },
    }
  }

  const canonicalRows = async () => ({
    hands: await db.hands.toArray(),
    phases: await db.phases.toArray(),
    actions: await db.actions.toArray(),
  })

  const ledgerContributions = async () =>
    (await db.statHandContributions.where('generation')
      .equals((await service.statsLedger.getActiveHead())!.generation).toArray())
      .map(({ generation: _generation, ...row }) => row)

  const hydrateAllPlayers = async (): Promise<void> => {
    for (const playerId of MTT_TABLE_MOVE_FIXTURE.oldLineup) {
      await service.statsLedger.readPlayerSnapshot(playerId)
    }
  }

  test('Raw DEALが保存済みでRESULTSだけを受けてもfull replayと同じhand/ledgerを一度だけ反映する', async () => {
    process.env.NODE_ENV = 'production'
    service.playerId = MTT_TABLE_MOVE_FIXTURE.heroId
    const cachedBeforeRecovery = await getRecentHands(db, service, MTT_TABLE_MOVE_FIXTURE.heroId, 10)
    const [result] = await seedRaw(firstHand())
    expect(result).toBeDefined()
    const autoSync = new AutoSyncService(db)
    const rebuild = jest.spyOn(autoSync as any, 'rebuildLocalEntities')
    const recovery = wireRecovery(autoSync)

    service.handAggregateStream.write(result!)
    await service.handAggregateStream.whenIdle()
    await recovery.wait()

    expect(rebuild).toHaveBeenCalledTimes(1)
    expect(portNotifications.notifyRecoveredHandCompletion).toHaveBeenCalledTimes(1)
    expect(recovery.fenceId).toContain(String(result!.HandId))
    expect(await db.hands.count()).toBe(1)
    expect(await db.apiEvents.count()).toBe(6)
    expect(await fenceCount()).toBe(0)
    const refreshedAfterRecovery = await getRecentHands(db, service, MTT_TABLE_MOVE_FIXTURE.heroId, 10)
    expect(refreshedAfterRecovery).not.toBe(cachedBeforeRecovery)
    expect(refreshedAfterRecovery.hands.map(hand => hand.handId)).toContain(result!.HandId)
    await hydrateAllPlayers()
    const recoveredCanonical = await canonicalRows()
    const recoveredLedger = await ledgerContributions()

    // 同じ既存full replayをもう一度実行し、復旧結果のcanonical/ledgerと比較する。
    rebuild.mockRestore()
    await (autoSync as any).rebuildLocalEntities()
    expect(portNotifications.notifyRecoveredHandCompletion).toHaveBeenCalledTimes(1)
    await hydrateAllPlayers()
    expect(await canonicalRows()).toEqual(recoveredCanonical)
    expect(await ledgerContributions()).toEqual(recoveredLedger)
  })

  test('Raw LakeにDEALがないRESULTSは一度のfull replayでfenceを終端し、再起動ループを作らない', async () => {
    const result = structuredClone(MTT_TABLE_MOVE_FIXTURE.events[5]!) as
      ApiEvent<ApiType.EVT_HAND_RESULTS>
    result.HandId += 10_000
    result.timestamp = (result.timestamp ?? 0) + 100
    const [stored] = await seedRaw([result])
    const autoSync = new AutoSyncService(db)
    const rebuild = jest.spyOn(autoSync as any, 'rebuildLocalEntities')
    const recovery = wireRecovery(autoSync)

    service.handAggregateStream.write(stored!)
    await service.handAggregateStream.whenIdle()
    await recovery.wait()

    expect(rebuild).toHaveBeenCalledTimes(1)
    expect(portNotifications.notifyRecoveredHandCompletion).not.toHaveBeenCalled()
    expect(await db.hands.count()).toBe(0)
    expect(await fenceCount()).toBe(0)
    await expect(autoSync.recoverInterruptedCanonicalRebuild()).resolves.toBe(false)
  })

  test('duplicate/reconnectは新しいraw/fenceを作らず台帳を二重加算しない', async () => {
    const [result] = await seedRaw(firstHand())
    const duplicateBefore = await mergeApiEvents(db, [
      structuredClone(result!) as unknown as RawApiEvent,
    ], {
      atomicMetaRecordsForAdded: added =>
        service.statsLedger.createPendingHandDerivationFenceRecords(added),
    })
    expect(duplicateBefore.added).toHaveLength(0)

    const autoSync = new AutoSyncService(db)
    const rebuild = jest.spyOn(autoSync as any, 'rebuildLocalEntities')
    const recovery = wireRecovery(autoSync)
    service.handAggregateStream.write(result!)
    await service.handAggregateStream.whenIdle()
    await recovery.wait()

    const duplicateAfter = await mergeApiEvents(db, [
      structuredClone(result!) as unknown as RawApiEvent,
    ], {
      atomicMetaRecordsForAdded: added =>
        service.statsLedger.createPendingHandDerivationFenceRecords(added),
    })
    expect(duplicateAfter.added).toHaveLength(0)
    service.handAggregateStream.write(result!)
    await service.handAggregateStream.whenIdle()

    expect(rebuild).toHaveBeenCalledTimes(1)
    expect(await db.apiEvents.count()).toBe(6)
    expect(await fenceCount()).toBe(0)
    expect(await db.hands.count()).toBe(1)
    await hydrateAllPlayers()
    const head = await service.statsLedger.getActiveHead()
    expect(await db.statHandContributions.where('[generation+handId]')
      .equals([head!.generation, result!.HandId]).count()).toBe(MTT_TABLE_MOVE_FIXTURE.oldLineup.length)
  })

  test('同じHandIdの異なるRESULTSと複数fenceを一回のfull replayで処理する', async () => {
    const events = firstHand()
    const secondResult = {
      ...structuredClone(events[5]!),
      timestamp: (events[5]!.timestamp ?? 0) + 1,
      HandLog: 'distinct-terminal-payload',
    } as unknown as ApiEvent
    const results = await seedRaw([...events, secondResult])
    expect(results).toHaveLength(2)
    for (const result of results) {
      await service.statsLedger.markPendingHandDerivationFailed(result)
    }
    const autoSync = new AutoSyncService(db)
    const rebuild = jest.spyOn(autoSync as any, 'rebuildLocalEntities')

    await autoSync.scheduleCanonicalRebuildRecovery(
      service.statsLedger.getPendingHandDerivationFenceId(results[0]!)
    )

    expect(rebuild).toHaveBeenCalledTimes(1)
    expect(await fenceCount()).toBe(0)
    expect(await db.hands.count()).toBe(1)
    await hydrateAllPlayers()
    const head = await service.statsLedger.getActiveHead()
    expect(await db.statHandContributions.where('[generation+handId]')
      .equals([head!.generation, results[0]!.HandId]).count()).toBe(MTT_TABLE_MOVE_FIXTURE.oldLineup.length)
  })

  test('malformed fenceもfull replayのactivationで終端し、Raw Lakeを変更しない', async () => {
    const malformedId = STATS_PENDING_HAND_DERIVATION_META_PREFIX + 'malformed'
    await db.meta.put({
      id: malformedId,
      value: { notAValidFence: true },
      updatedAt: Date.now(),
    })
    const autoSync = new AutoSyncService(db)

    await autoSync.scheduleCanonicalRebuildRecovery(malformedId)

    expect(await db.meta.get(malformedId)).toBeUndefined()
    expect(await db.apiEvents.count()).toBe(0)
    await expect(autoSync.recoverInterruptedCanonicalRebuild()).resolves.toBe(false)
  })

  test('full replay失敗時は旧canonicalを保ち、failed fenceをretry可能なまま残す', async () => {
    const [oldResult] = await seedRaw(firstHand())
    const autoSync = new AutoSyncService(db)
    await (autoSync as any).rebuildLocalEntities()
    const oldHand = await db.hands.get(oldResult!.HandId)
    expect(oldHand).toBeDefined()

    const nextEvents = firstHand().map(event => ({
      ...event,
      ...(event.ApiTypeId === ApiType.EVT_HAND_RESULTS
        ? { HandId: Number(event.HandId) + 1 }
        : {}),
      timestamp: (event.timestamp ?? 0) + 5_000,
    }))
    const [nextResult] = await seedRaw(nextEvents)
    await service.statsLedger.markPendingHandDerivationFailed(nextResult!)
    jest.spyOn(autoSync as any, 'rebuildLocalEntities')
      .mockRejectedValueOnce(new Error('synthetic full replay failure'))

    await expect(autoSync.scheduleCanonicalRebuildRecovery(
      service.statsLedger.getPendingHandDerivationFenceId(nextResult!)
    )).rejects.toThrow('synthetic full replay failure')

    expect(portNotifications.notifyRecoveredHandCompletion).not.toHaveBeenCalled()

    expect(await db.hands.get(oldResult!.HandId)).toEqual(oldHand)
    expect(await db.hands.get(nextResult!.HandId)).toBeUndefined()
    expect(await db.meta.get(
      service.statsLedger.getPendingHandDerivationFenceId(nextResult!)!
    )).toBeDefined()
  })

  test('ACTIVE世代に同世代DEALが無い間はfull replayが統計を再配信しない', async () => {
    const fakePort = { postMessage: jest.fn() } as unknown as chrome.runtime.Port
    claimActivePort(fakePort)
    const generation = resolveGeneration()
    expect(generation).toBeDefined()
    setDefaultStatsContextProvider(() => ({
      delivery: 'active',
      generation,
      evtDeal: undefined,
    }))
    service.liveEvtDeal = firstHand()[3] as ApiEvent<ApiType.EVT_DEAL>
    const autoSync = new AutoSyncService(db)
    const write = jest.spyOn(service.statsOutputStream, 'write')
    const guard = (autoSync as any).captureServiceContextRestoreGuard(service)

    ;(autoSync as any).publishRebuiltServiceContext(
      service,
      new SessionState(() => {}),
      undefined,
      guard
    )

    expect(write).not.toHaveBeenCalled()

    const trustedDeal = firstHand()[3] as ApiEvent<ApiType.EVT_DEAL>
    setDefaultStatsContextProvider(() => ({
      delivery: 'active',
      generation,
      evtDeal: trustedDeal,
    }))
    ;(autoSync as any).publishRebuiltServiceContext(
      service,
      new SessionState(() => {}),
      undefined,
      guard
    )
    expect(write).toHaveBeenCalledWith(trustedDeal.SeatUserIds.filter(id => id !== -1))
  })
})
