import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { PokerChaseDB } from '../db/poker-chase-db'
import { ApiType } from '../types/api'
import { mergeApiEvents, type RawApiEvent } from '../utils/api-event-key'
import {
  STATS_CANONICAL_REBUILD_META_ID,
  STATS_LEDGER_STAGING_META_ID,
  STATS_PENDING_HAND_DERIVATION_META_PREFIX,
  StatsLedger,
} from './stat-ledger'

const rawResult = (
  handId: number,
  timestamp: number,
  variant: string
): RawApiEvent => ({
  ApiTypeId: ApiType.EVT_HAND_RESULTS,
  HandId: handId,
  timestamp,
  variant,
})

describe('StatsLedger pending hand derivation fence', () => {
  let db: PokerChaseDB
  let ledger: StatsLedger

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    ledger = new StatsLedger(db)
    // これらのテストは非active世代GCを対象にしない。タイマーを
    // DB破棄後まで残さないようスケジュール済み扱いにする。
    ;(ledger as unknown as { cleanupScheduled: boolean }).cleanupScheduled = true
  })

  afterEach(async () => {
    db.close()
    await db.delete()
  })

  const mergeWithFence = async (events: RawApiEvent[]) =>
    await mergeApiEvents(db, events, {
      atomicMetaRecordsForAdded: added =>
        ledger.createPendingHandDerivationFenceRecords(added),
    })

  const pendingRows = async () =>
    await db.meta.where('id').startsWith(STATS_PENDING_HAND_DERIVATION_META_PREFIX).toArray()

  test('raw addとsequence割当後markerは同一transactionでcommit/rollbackする', async () => {
    const event = rawResult(7001, 10_000, 'first')
    const failMarker = (): never => { throw new Error('injected pending marker failure') }
    db.meta.hook('creating', failMarker)
    try {
      await expect(mergeWithFence([event])).rejects.toThrow('injected pending marker failure')
    } finally {
      db.meta.hook('creating').unsubscribe(failMarker)
    }

    expect(await db.apiEvents.count()).toBe(0)
    expect(await pendingRows()).toEqual([])
  })

  test('same-ms/same-HandIdの別payloadはraw sequence別に保留し、先発ackが後発を消さない', async () => {
    const result = await mergeWithFence([
      rawResult(7002, 20_000, 'first'),
      rawResult(7002, 20_000, 'second'),
    ])

    expect(result.added.map(event => event.sequence)).toEqual([0, 1])
    expect((await pendingRows()).map(row => row.id).sort()).toEqual([
      `${STATS_PENDING_HAND_DERIVATION_META_PREFIX}7002:20000:0`,
      `${STATS_PENDING_HAND_DERIVATION_META_PREFIX}7002:20000:1`,
    ])
    // 現在workerの通常in-flightはboot recoveryではない。
    expect(await ledger.needsCanonicalRebuildRecovery()).toBe(false)

    await ledger.acknowledgePendingHandDerivation(result.added[0]!)
    expect((await pendingRows()).map(row => row.id)).toEqual([
      `${STATS_PENDING_HAND_DERIVATION_META_PREFIX}7002:20000:1`,
    ])
    await ledger.acknowledgePendingHandDerivation(result.added[1]!)
    expect(await pendingRows()).toEqual([])
  })

  test('foreign/malformed/明示失敗だけがdirtyとなり、current-owner pendingは除外する', async () => {
    const current = (await mergeWithFence([rawResult(7003, 30_000, 'current')])).added[0]!
    expect(await ledger.needsCanonicalRebuildRecovery()).toBe(false)

    const [row] = await pendingRows()
    await db.meta.put({
      ...row!,
      value: { ...(row!.value as object), ownerId: 'dead-worker' },
    })
    expect(await ledger.needsCanonicalRebuildRecovery()).toBe(true)

    await db.meta.delete(row!.id)
    await mergeWithFence([rawResult(7004, 40_000, 'failed')])
    const failed = (await db.apiEvents.where('ApiTypeId').equals(ApiType.EVT_HAND_RESULTS).last()) as RawApiEvent
    expect(await ledger.markPendingHandDerivationFailed(failed)).toBe(true)
    expect(await ledger.needsCanonicalRebuildRecovery()).toBe(true)

    await ledger.acknowledgePendingHandDerivation(failed)
    await db.meta.put({
      id: `${STATS_PENDING_HAND_DERIVATION_META_PREFIX}malformed`,
      value: { ownerId: 'current-but-malformed' },
    })
    expect(await ledger.needsCanonicalRebuildRecovery()).toBe(true)
    // unused警告回避ではなく、currentのexact markerが元のrawを指すことも固定。
    expect(current.sequence).toBe(0)
  })

  test('chunked activationは開始時snapshotのexact IDだけを消し、後着markerを残す', async () => {
    const first = (await mergeWithFence([rawResult(7005, 50_000, 'orphan')])).added[0]!
    const firstId = `${STATS_PENDING_HAND_DERIVATION_META_PREFIX}7005:50000:0`
    const firstRow = await db.meta.get(firstId)
    await db.meta.put({
      ...firstRow!,
      value: { ...(firstRow!.value as object), ownerId: 'dead-worker' },
    })
    const recoveredIds = await ledger.listInterruptedPendingHandDerivationFenceIds()
    expect(recoveredIds).toEqual([firstId])

    const staging = await ledger.prepareStagingGeneration()
    const late = (await mergeWithFence([rawResult(7006, 60_000, 'late-live')])).added[0]!
    const lateId = `${STATS_PENDING_HAND_DERIVATION_META_PREFIX}7006:60000:0`
    await ledger.activateStagingGeneration(staging.generation, recoveredIds)

    expect(await db.meta.get(firstId)).toBeUndefined()
    expect(await db.meta.get(lateId)).toBeDefined()
    expect(await db.meta.get(STATS_LEDGER_STAGING_META_ID)).toBeUndefined()
    expect(await db.meta.get(STATS_CANONICAL_REBUILD_META_ID)).toBeUndefined()
    expect(await ledger.needsCanonicalRebuildRecovery()).toBe(false)
    expect([first.HandId, late.HandId]).toEqual([7005, 7006])
  })
})
