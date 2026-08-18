import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { ApiType, type ApiEvent } from '../types'
import { MTT_TABLE_MOVE_FIXTURE } from '../test-fixtures/mtt-table-move-lifecycle'
import { mergeApiEvents, type RawApiEvent } from '../utils/api-event-key'
import { trackServiceForTeardown } from '../utils/test-service-teardown'
import {
  STATS_PENDING_HAND_DERIVATION_META_PREFIX,
} from '../stats/stat-ledger'
import { AutoSyncService } from '../services/auto-sync-service'

describe('AggregateEventsStream canonical Raw Lake recovery after a Service Worker restart', () => {
  let db: PokerChaseDB
  let service: PokerChaseService

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = trackServiceForTeardown(new PokerChaseService({ db }))
    await service.ready
    service.session.setId('recovery-test')
    ;(globalThis as any).service = service
    ;(chrome.runtime.sendMessage as jest.Mock).mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await service.statsOutputStream.whenIdle().catch(() => {})
    delete (globalThis as any).service
    db.close()
    await db.delete()
  })

  const seedRaw = async (events: ApiEvent[]): Promise<ApiEvent<ApiType.EVT_HAND_RESULTS>> => {
    const merged = await mergeApiEvents(db, structuredClone(events) as unknown as RawApiEvent[], {
      atomicMetaRecordsForAdded: added => service.statsLedger.createPendingHandDerivationFenceRecords(added),
    })
    return merged.added.filter(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS).at(-1)! as
      ApiEvent<ApiType.EVT_HAND_RESULTS>
  }

  const firstHand = (): ApiEvent[] =>
    structuredClone(MTT_TABLE_MOVE_FIXTURE.events.slice(0, 6)) as ApiEvent[]

  const pendingFenceCount = async (): Promise<number> =>
    await db.meta.where('id').startsWith(STATS_PENDING_HAND_DERIVATION_META_PREFIX).count()

  const wireCanonicalRecovery = (autoSync: AutoSyncService): {
    getPromise: () => Promise<void>
  } => {
    let recoveryPromise: Promise<void> | undefined
    service.handAggregateStream.on('error', error => {
      const canonicalError = error as {
        canonicalRecoveryRequired?: true
        canonicalRecoveryFenceId?: string
      }
      if (canonicalError.canonicalRecoveryRequired !== true) return
      recoveryPromise = autoSync.scheduleCanonicalRebuildRecovery(
        canonicalError.canonicalRecoveryFenceId
      )
    })
    return {
      getPromise: async () => {
        if (!recoveryPromise) throw new Error('canonical recovery was not requested')
        return await recoveryPromise
      }
    }
  }

  test('Raw DEAL済み・新streamはRESULTSだけでも非同期canonical replayで一度だけ反映する', async () => {
    const result = await seedRaw(firstHand())
    const autoSync = new AutoSyncService(db)
    const recovery = wireCanonicalRecovery(autoSync)
    const rebuild = jest.spyOn(autoSync as any, 'rebuildLocalEntities')

    service.handAggregateStream.write(result)
    await service.handAggregateStream.whenIdle()
    await recovery.getPromise()

    expect(rebuild).toHaveBeenCalledTimes(1)
    expect(await db.hands.count()).toBe(1)
    expect(await db.hands.get(result.HandId)).toMatchObject({
      id: result.HandId,
      seatUserIds: MTT_TABLE_MOVE_FIXTURE.oldLineup,
      session: { id: 'redacted' }
    })
    expect(await db.apiEvents.count()).toBe(6)
    expect(await pendingFenceCount()).toBe(0)

    const head = await service.statsLedger.getActiveHead()
    const snapshot = await service.statsLedger.readPlayerSnapshot(MTT_TABLE_MOVE_FIXTURE.heroId)
    expect(snapshot.selectedHands).toBe(1)
    expect(await db.statHandContributions
      .where('[generation+handId]')
      .equals([head!.generation, result.HandId])
      .count()).toBe(MTT_TABLE_MOVE_FIXTURE.oldLineup.length)
  })

  test('Raw LakeにもDEALがないRESULTSは1回のfull replayでfenceを終端し、再起動ループを作らない', async () => {
    const result = structuredClone(MTT_TABLE_MOVE_FIXTURE.events[5]!) as ApiEvent<ApiType.EVT_HAND_RESULTS>
    result.timestamp = result.timestamp! + 100
    result.HandId += 1
    await seedRaw([result])

    const autoSync = new AutoSyncService(db)
    const recovery = wireCanonicalRecovery(autoSync)
    const rebuild = jest.spyOn(autoSync as any, 'rebuildLocalEntities')

    service.handAggregateStream.write(result)
    await service.handAggregateStream.whenIdle()
    await recovery.getPromise()

    expect(rebuild).toHaveBeenCalledTimes(1)
    expect(await db.hands.count()).toBe(0)
    expect(await pendingFenceCount()).toBe(0)
    expect(await service.statsLedger.needsCanonicalRebuildRecovery()).toBe(false)

    const restarted = new AutoSyncService(db)
    await expect(restarted.recoverInterruptedCanonicalRebuild()).resolves.toBe(false)
    expect(await pendingFenceCount()).toBe(0)
  })

  test('duplicate/reconnectではRaw dedupが新fenceを作らず、canonicalと台帳を二重加算しない', async () => {
    const result = await seedRaw(firstHand())
    const autoSync = new AutoSyncService(db)
    const recovery = wireCanonicalRecovery(autoSync)
    const rebuild = jest.spyOn(autoSync as any, 'rebuildLocalEntities')

    service.handAggregateStream.write(result)
    await service.handAggregateStream.whenIdle()
    await recovery.getPromise()

    const duplicate = await mergeApiEvents(db, [structuredClone(result) as unknown as RawApiEvent], {
      atomicMetaRecordsForAdded: added => service.statsLedger.createPendingHandDerivationFenceRecords(added),
    })
    expect(duplicate.added).toHaveLength(0)
    expect(await pendingFenceCount()).toBe(0)

    // transport再送がstreamまで届く場合もexact fenceが無いため再構築を予約しない。
    service.handAggregateStream.write(result)
    await service.handAggregateStream.whenIdle()
    expect(rebuild).toHaveBeenCalledTimes(1)
    expect(await db.hands.count()).toBe(1)
    const snapshot = await service.statsLedger.readPlayerSnapshot(MTT_TABLE_MOVE_FIXTURE.heroId)
    expect(snapshot.selectedHands).toBe(1)
    const head = await service.statsLedger.getActiveHead()
    const aggregate = await db.statPlayerAggregates.get([head!.generation, MTT_TABLE_MOVE_FIXTURE.heroId])
    expect(aggregate?.totals[0]).toBe(1)
  })

  test('canonical replay失敗時は旧derivedを保ち、対象fenceを次回retryへ残す', async () => {
    await db.apiEvents.bulkAdd(firstHand())
    const autoSync = new AutoSyncService(db)
    await (autoSync as any).rebuildLocalEntities()
    const oldHand = await db.hands.get(MTT_TABLE_MOVE_FIXTURE.handIds.oldAccepted)
    expect(oldHand).toBeDefined()

    const result = structuredClone(MTT_TABLE_MOVE_FIXTURE.events[5]!) as ApiEvent<ApiType.EVT_HAND_RESULTS>
    result.timestamp = result.timestamp! + 100
    result.HandId += 1
    await seedRaw([result])

    jest.spyOn(autoSync as any, 'rebuildLocalEntities')
      .mockRejectedValueOnce(new Error('synthetic canonical replay failure'))
    const recovery = wireCanonicalRecovery(autoSync)

    service.handAggregateStream.write(result)
    await service.handAggregateStream.whenIdle()
    await expect(recovery.getPromise()).rejects.toThrow('synthetic canonical replay failure')

    expect(await db.hands.get(MTT_TABLE_MOVE_FIXTURE.handIds.oldAccepted)).toEqual(oldHand)
    expect(await pendingFenceCount()).toBe(1)
    expect(await db.apiEvents.count()).toBe(7)
  })
})
