import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import type { EntityBundle } from '../entity-converter'
import { MTT_TABLE_MOVE_FIXTURE } from '../test-fixtures/mtt-table-move-lifecycle'
import {
  ActionDetail,
  ActionType,
  ApiType,
  BattleType,
  PhaseType,
  Position,
  type ApiHandEvent,
} from '../types'
import {
  getStatCounter,
  statValueFromCounterVector,
} from '../stats/hand-contribution'
import {
  STATS_CANONICAL_REBUILD_META_ID,
  STATS_LEDGER_HEAD_META_ID,
  STATS_PENDING_HAND_DERIVATION_META_PREFIX,
} from '../stats/stat-ledger'
import { setEventGeneration } from './stats-output-context'
import { trackServiceForTeardown } from '../utils/test-service-teardown'
import {
  type CanonicalWriteFailureError,
  WriteEntityStream,
} from './write-entity-stream'
import { AutoSyncService } from '../services/auto-sync-service'
import { mergeApiEvents, type RawApiEvent } from '../utils/api-event-key'

const HERO_ID = MTT_TABLE_MOVE_FIXTURE.heroId
const FIRST_HAND_ID = MTT_TABLE_MOVE_FIXTURE.handIds.oldAccepted

function cloneFirstAcceptedHandEvents(): ApiHandEvent[] {
  return structuredClone(MTT_TABLE_MOVE_FIXTURE.events.slice(3, 6)) as ApiHandEvent[]
}

function replacementBundle(): EntityBundle {
  const replacementPlayerId = 9_001
  return {
    hands: [{
      id: FIRST_HAND_ID,
      approxTimestamp: MTT_TABLE_MOVE_FIXTURE.timestamps.oldAcceptedDeal + 100_000,
      seatUserIds: [HERO_ID, replacementPlayerId, -1, -1, -1, -1],
      winningPlayerIds: [replacementPlayerId],
      smallBlind: 100,
      bigBlind: 200,
      bigBlindUserId: HERO_ID,
      session: {
        id: 'replacement-session',
        battleType: BattleType.RING_GAME,
        name: 'replacement',
      },
      results: [],
    }],
    actions: [{
      handId: FIRST_HAND_ID,
      index: 0,
      playerId: HERO_ID,
      phase: PhaseType.PREFLOP,
      actionType: ActionType.CALL,
      bet: 200,
      pot: 400,
      sidePot: [],
      position: Position.BB,
      actionDetails: [ActionDetail.VPIP],
    }],
    phases: [{
      handId: FIRST_HAND_ID,
      phase: PhaseType.PREFLOP,
      seatUserIds: [HERO_ID, replacementPlayerId],
      communityCards: [],
    }],
  }
}

describe('WriteEntityStream -> StatsLedger integration', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let writeStream: WriteEntityStream

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = trackServiceForTeardown(new PokerChaseService({ db }))
    await service.ready
    // service所有streamの下流ReadEntityStreamにlazy baselineを作らせると、WESが
    // 台帳を書かなかった回帰まで見かけ上passし得る。未pipeの同一実装を使い、
    // commit直後の生テーブルだけを検証する。
    writeStream = new WriteEntityStream(service)
    service.session.setId('live-session')
    service.session.setBattleType(BattleType.TOURNAMENT)
    service.session.setName('live')
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    db.close()
    await db.delete()
  })

  async function writeHand(events = cloneFirstAcceptedHandEvents()): Promise<void> {
    writeStream.write(events)
    await writeStream.whenIdle()
  }

  async function seedRawFence(events = cloneFirstAcceptedHandEvents()): Promise<{
    events: ApiHandEvent[]
    markerId: string
  }> {
    const cloned = structuredClone(events)
    const merge = await mergeApiEvents(db, cloned as unknown as RawApiEvent[], {
      atomicMetaRecordsForAdded: added =>
        service.statsLedger.createPendingHandDerivationFenceRecords(added),
    })
    const storedResult = merge.added.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)!
    const resultIndex = cloned.findIndex(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)
    cloned[resultIndex] = { ...cloned[resultIndex]!, sequence: storedResult.sequence }
    return {
      events: cloned,
      markerId: `${STATS_PENDING_HAND_DERIVATION_META_PREFIX}${storedResult.HandId}:${storedResult.timestamp}:${storedResult.sequence}`,
    }
  }

  test('canonical entity・ハンド寄与・player累積を同じライブ完了で永続化する', async () => {
    const completed: number[][] = []
    writeStream.on('data', lineup => completed.push([...lineup]))

    await writeHand()

    const head = await service.statsLedger.getActiveHead()
    expect(head).not.toBeNull()
    expect(await db.hands.get(FIRST_HAND_ID)).toBeDefined()
    expect(await db.actions.where('handId').equals(FIRST_HAND_ID).count()).toBe(1)
    expect(await db.phases.where('handId').equals(FIRST_HAND_ID).count()).toBe(1)

    // readPlayerSnapshot()のlazy baselineに救済させず、生の台帳行がライブcommitで
    // 既に揃っていることを確認する。
    const contributions = await db.statHandContributions
      .where('[generation+handId]')
      .equals([head!.generation, FIRST_HAND_ID])
      .toArray()
    const aggregates = await db.statPlayerAggregates
      .where('generation')
      .equals(head!.generation)
      .toArray()
    expect(contributions).toHaveLength(MTT_TABLE_MOVE_FIXTURE.oldLineup.length)
    expect(aggregates).toHaveLength(MTT_TABLE_MOVE_FIXTURE.oldLineup.length)
    expect(contributions.map(row => row.playerId).sort((a, b) => a - b)).toEqual(
      [...MTT_TABLE_MOVE_FIXTURE.oldLineup].sort((a, b) => a - b)
    )
    for (const aggregate of aggregates) {
      expect(statValueFromCounterVector(aggregate.totals, 'hands')).toBe(1)
    }
    expect(completed).toEqual([[...MTT_TABLE_MOVE_FIXTURE.oldLineup]])
  })

  test('raw-result fenceはcanonical・台帳と同じ成功commitで外す', async () => {
    const seeded = await seedRawFence()
    expect(await db.meta.get(seeded.markerId)).toBeDefined()

    await writeHand(seeded.events)

    expect(await db.hands.get(FIRST_HAND_ID)).toBeDefined()
    expect(await db.meta.get(seeded.markerId)).toBeUndefined()
    expect(await db.meta.get(STATS_CANONICAL_REBUILD_META_ID)).toBeUndefined()
  })

  test('fence delete失敗はcanonical・台帳もrollbackし、exact markerをfailedで残す', async () => {
    const seeded = await seedRawFence()
    const streamErrors: unknown[] = []
    writeStream.on('error', error => streamErrors.push(error))
    jest.spyOn(console, 'error').mockImplementation(() => {})
    const failFenceDelete = (primaryKey: unknown): void => {
      if (primaryKey === seeded.markerId) throw new Error('injected fence delete failure')
    }
    db.meta.hook('deleting', failFenceDelete)
    try {
      await writeHand(seeded.events)
    } finally {
      db.meta.hook('deleting').unsubscribe(failFenceDelete)
    }

    expect(streamErrors).toHaveLength(1)
    expect(await db.hands.get(FIRST_HAND_ID)).toBeUndefined()
    expect(await db.statHandContributions.count()).toBe(0)
    expect((await db.meta.get(seeded.markerId))?.value).toMatchObject({ failed: true })
    // production tokenがある失敗はfixed markerへ折り畳まず、並行handと
    // cloud staging ownerを保護する。
    expect(await db.meta.get(STATS_CANONICAL_REBUILD_META_ID)).toBeUndefined()
    expect(await service.statsLedger.needsCanonicalRebuildRecovery()).toBe(true)
  })

  test('marker failed化も失敗した場合はexact fence IDを同一worker回復へ通知する', async () => {
    const seeded = await seedRawFence()
    const streamErrors: CanonicalWriteFailureError[] = []
    writeStream.on('error', error => streamErrors.push(error as CanonicalWriteFailureError))
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.spyOn(service.statsLedger, 'acknowledgePendingHandDerivation')
      .mockRejectedValueOnce(new Error('injected canonical transaction failure'))
    jest.spyOn(service.statsLedger, 'markPendingHandDerivationFailed')
      .mockRejectedValueOnce(new Error('injected marker update failure'))

    await writeHand(seeded.events)

    expect(streamErrors).toHaveLength(1)
    expect(streamErrors[0]?.canonicalRecoveryRequired).toBe(true)
    expect(streamErrors[0]?.canonicalRecoveryFenceId).toBe(seeded.markerId)
    expect((await db.meta.get(seeded.markerId))?.value).not.toEqual(
      expect.objectContaining({ failed: true })
    )
    expect(await service.statsLedger.needsCanonicalRebuildRecovery()).toBe(false)
  })

  test('同じ完成イベントを再投入しても寄与と累積を二重加算しない', async () => {
    const events = cloneFirstAcceptedHandEvents()
    await writeHand(events)
    await writeHand(structuredClone(events))

    const head = (await service.statsLedger.getActiveHead())!
    expect(await db.hands.count()).toBe(1)
    expect(await db.actions.where('handId').equals(FIRST_HAND_ID).count()).toBe(1)
    expect(await db.phases.where('handId').equals(FIRST_HAND_ID).count()).toBe(1)
    expect(await db.statHandContributions
      .where('[generation+handId]')
      .equals([head.generation, FIRST_HAND_ID])
      .count()).toBe(MTT_TABLE_MOVE_FIXTURE.oldLineup.length)

    const heroAggregate = await db.statPlayerAggregates.get([head.generation, HERO_ID])
    expect(heroAggregate).toBeDefined()
    expect(getStatCounter(heroAggregate!.totals, 'hands')).toEqual([1, 0])
    expect(getStatCounter(heroAggregate!.totals, 'vpip')).toEqual([1, 1])
  })

  test('同じHandIdの置換は旧player/tag/position寄与を減算して新寄与へ入れ替える', async () => {
    await writeHand()
    const head = (await service.statsLedger.getActiveHead())!
    const oldHeroContribution = await db.statHandContributions.get([
      head.generation,
      HERO_ID,
      FIRST_HAND_ID,
    ])
    expect(oldHeroContribution).toBeDefined()

    const bundle = replacementBundle()
    await db.transaction('rw', [
      db.hands,
      db.actions,
      db.phases,
      db.meta,
      db.statHandContributions,
      db.statPlayerAggregates,
    ], async () => {
      // WESと同じouter transaction内でhelperを直接呼ぶ。helper自身が別commitを
      // 開始するとこのテストの原子性境界を満たせない。
      await service.statsLedger.replaceCompletedHandContributions(bundle)
    })

    const replacementPlayerId = bundle.hands[0]!.seatUserIds[1]!
    const currentRows = await db.statHandContributions
      .where('[generation+handId]')
      .equals([head.generation, FIRST_HAND_ID])
      .toArray()
    expect(currentRows.map(row => row.playerId).sort((a, b) => a - b)).toEqual(
      [HERO_ID, replacementPlayerId].sort((a, b) => a - b)
    )

    const heroContribution = currentRows.find(row => row.playerId === HERO_ID)!
    expect(heroContribution.battleType).toBe(BattleType.RING_GAME)
    expect(heroContribution.tableSizeLayer).toBe('hu')
    expect(heroContribution.position).toBe(Position.BB)
    expect({
      battleType: heroContribution.battleType,
      tableSizeLayer: heroContribution.tableSizeLayer,
      position: heroContribution.position,
    }).not.toEqual({
      battleType: oldHeroContribution!.battleType,
      tableSizeLayer: oldHeroContribution!.tableSizeLayer,
      position: oldHeroContribution!.position,
    })

    const removedPlayerId = MTT_TABLE_MOVE_FIXTURE.oldLineup.find(playerId => playerId !== HERO_ID)!
    expect(await db.statHandContributions.get([
      head.generation,
      removedPlayerId,
      FIRST_HAND_ID,
    ])).toBeUndefined()
    const removedAggregate = await db.statPlayerAggregates.get([head.generation, removedPlayerId])
    expect(removedAggregate === undefined ||
      statValueFromCounterVector(removedAggregate.totals, 'hands') === 0).toBe(true)

    const heroAggregate = (await db.statPlayerAggregates.get([head.generation, HERO_ID]))!
    const replacementAggregate = (await db.statPlayerAggregates.get([
      head.generation,
      replacementPlayerId,
    ]))!
    expect(statValueFromCounterVector(heroAggregate.totals, 'hands')).toBe(1)
    expect(statValueFromCounterVector(replacementAggregate.totals, 'hands')).toBe(1)
    expect(heroAggregate.buckets.find(bucket =>
      bucket.battleBucket === oldHeroContribution!.battleBucket &&
      bucket.tableBucket === oldHeroContribution!.tableBucket &&
      bucket.positionBucket === oldHeroContribution!.positionBucket
    )).toBeUndefined()
    expect(heroAggregate.buckets.find(bucket =>
      bucket.battleBucket === heroContribution.battleBucket &&
      bucket.tableBucket === heroContribution.tableBucket &&
      bucket.positionBucket === heroContribution.positionBucket
    )?.handsN).toBe(1)
  })

  test('stat table書込失敗時はcanonicalもrollbackし完了通知を出さない', async () => {
    const completed: number[][] = []
    const streamErrors: unknown[] = []
    jest.spyOn(console, 'error').mockImplementation(() => {})
    writeStream.on('data', lineup => completed.push([...lineup]))
    writeStream.on('error', error => streamErrors.push(error))

    const events = cloneFirstAcceptedHandEvents()
    // 本番と同じくRaw LakeはWESより先に確定している。
    await db.apiEvents.bulkAdd(events)

    // aggregate作成時点まで進めてから失敗させ、先行したcanonical/contributionを
    // outer transactionごとrollbackできることを固定する。
    const failAggregateCreate = (): never => {
      throw new Error('injected aggregate write failure')
    }
    db.statPlayerAggregates.hook('creating', failAggregateCreate)
    try {
      await writeHand(events)
    } finally {
      db.statPlayerAggregates.hook('creating').unsubscribe(failAggregateCreate)
    }

    expect(streamErrors).toHaveLength(1)
    expect(completed).toEqual([])
    expect(await db.hands.get(FIRST_HAND_ID)).toBeUndefined()
    expect(await db.actions.where('handId').equals(FIRST_HAND_ID).count()).toBe(0)
    expect(await db.phases.where('handId').equals(FIRST_HAND_ID).count()).toBe(0)
    expect(await db.statHandContributions.count()).toBe(0)
    expect(await db.statPlayerAggregates.count()).toBe(0)
    expect(await db.meta.get(STATS_LEDGER_HEAD_META_ID)).toBeUndefined()
    expect(await db.meta.get(STATS_CANONICAL_REBUILD_META_ID)).toBeDefined()

    // markerは単なる警告ではなく、次回SW起動でRaw Lakeから自動復旧する。
    jest.spyOn(service.statsOutputStream, 'write').mockImplementation(() => {})
    ;(globalThis as any).service = service
    try {
      const restarted = new AutoSyncService(db)
      await expect(restarted.recoverInterruptedCanonicalRebuild()).resolves.toBe(true)
    } finally {
      delete (globalThis as any).service
    }
    expect(await db.meta.get(STATS_CANONICAL_REBUILD_META_ID)).toBeUndefined()
    expect(await db.hands.get(FIRST_HAND_ID)).toBeDefined()
    expect((await service.statsLedger.readPlayerSnapshot(HERO_ID)).selectedHands).toBe(1)
  })

  test('世代跨ぎとキメラの完成候補はcanonicalにも台帳にも書かない', async () => {
    const completed: number[][] = []
    writeStream.on('data', lineup => completed.push([...lineup]))
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})

    const crossGeneration = cloneFirstAcceptedHandEvents()
    setEventGeneration(crossGeneration[0]!, 10)
    setEventGeneration(crossGeneration.at(-1)!, 11)
    await writeHand(crossGeneration)

    const chimera = structuredClone([
      MTT_TABLE_MOVE_FIXTURE.events[12]!,
      MTT_TABLE_MOVE_FIXTURE.events[16]!,
    ]) as ApiHandEvent[]
    await writeHand(chimera)

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Rejected cross-generation hand'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Rejected chimera hand'))
    expect(completed).toEqual([])
    expect(await db.hands.count()).toBe(0)
    expect(await db.actions.count()).toBe(0)
    expect(await db.phases.count()).toBe(0)
    expect(await db.statHandContributions.count()).toBe(0)
    expect(await db.statPlayerAggregates.count()).toBe(0)
    expect(await db.meta.get(STATS_LEDGER_HEAD_META_ID)).toBeUndefined()
  })

  test('世代跨ぎとキメラの意図的棄却は対応するexact fenceを終端化する', async () => {
    const crossGeneration = await seedRawFence(cloneFirstAcceptedHandEvents())
    setEventGeneration(crossGeneration.events[0]!, 10)
    setEventGeneration(crossGeneration.events.at(-1)!, 11)
    await writeHand(crossGeneration.events)
    expect(await db.meta.get(crossGeneration.markerId)).toBeUndefined()

    const chimeraEvents = structuredClone([
      MTT_TABLE_MOVE_FIXTURE.events[12]!,
      MTT_TABLE_MOVE_FIXTURE.events[16]!,
    ]) as ApiHandEvent[]
    const chimera = await seedRawFence(chimeraEvents)
    await writeHand(chimera.events)
    expect(await db.meta.get(chimera.markerId)).toBeUndefined()
    expect(await db.hands.count()).toBe(0)
  })
})
