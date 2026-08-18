import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { ApiType, BattleType, type ApiEvent } from '../types'
import { MTT_TABLE_MOVE_FIXTURE } from '../test-fixtures/mtt-table-move-lifecycle'
import { mergeApiEvents, type RawApiEvent } from '../utils/api-event-key'
import { trackServiceForTeardown } from '../utils/test-service-teardown'
import {
  STATS_PENDING_HAND_DERIVATION_META_PREFIX,
} from '../stats/stat-ledger'
import { getStatCounter } from '../stats/hand-contribution'
import { setEventGeneration } from './stats-output-context'

describe('AggregateEventsStream Raw Lake recovery after a Service Worker restart', () => {
  let db: PokerChaseDB
  let service: PokerChaseService

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = trackServiceForTeardown(new PokerChaseService({ db }))
    await service.ready
    service.session.setId('recovery-test')
    service.session.setBattleType(BattleType.TOURNAMENT)
    service.session.setName('recovery-test')
  })

  afterEach(async () => {
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
    structuredClone(MTT_TABLE_MOVE_FIXTURE.events.slice(3, 6)) as ApiEvent[]

  test('raw DEAL済み・RESULTSだけの新streamは短いLake再生でcanonical/ledgerへ一度だけ反映する', async () => {
    const result = await seedRaw(firstHand())
    // 実運用では現在workerのRESULTSだけがACTIVE世代metadataを持つ。
    setEventGeneration(result, 42)

    service.handAggregateStream.write(result)
    await service.handAggregateStream.whenIdle()

    const head = await service.statsLedger.getActiveHead()
    expect(await db.hands.get(result.HandId)).toBeDefined()
    expect(await db.apiEvents.count()).toBe(3)
    expect(service.playerId).toBe(MTT_TABLE_MOVE_FIXTURE.heroId)
    expect(service.latestEvtDeal?.timestamp).toBe(MTT_TABLE_MOVE_FIXTURE.timestamps.oldAcceptedDeal)
    expect(service.liveEvtDeal?.timestamp).toBe(MTT_TABLE_MOVE_FIXTURE.timestamps.oldAcceptedDeal)
    expect(await db.statHandContributions
      .where('[generation+handId]')
      .equals([head!.generation, result.HandId])
      .count()).toBe(MTT_TABLE_MOVE_FIXTURE.oldLineup.length)
    expect(await db.meta
      .where('id')
      .startsWith(STATS_PENDING_HAND_DERIVATION_META_PREFIX)
      .count()).toBe(0)
  })

  test('duplicate/reconnectのRESULTS再送でもcanonicalと台帳を二重加算しない', async () => {
    const result = await seedRaw(firstHand())
    setEventGeneration(result, 42)

    service.handAggregateStream.write(result)
    service.handAggregateStream.write(result)
    await service.handAggregateStream.whenIdle()

    const head = await service.statsLedger.getActiveHead()
    expect(await db.hands.count()).toBe(1)
    expect(await db.statHandContributions
      .where('[generation+handId]')
      .equals([head!.generation, result.HandId])
      .count()).toBe(MTT_TABLE_MOVE_FIXTURE.oldLineup.length)
    const aggregate = await db.statPlayerAggregates.get([head!.generation, MTT_TABLE_MOVE_FIXTURE.heroId])
    expect(aggregate).toBeDefined()
    expect(getStatCounter(aggregate!.totals, 'hands')).toEqual([1, 0])
  })

  test('Raw Lakeにも当該ハンドのDEALが無いRESULTSはfenceを終端化し、再構築ループを作らない', async () => {
    // 前のハンドは既にcanonicalへ反映済みとし、そのfenceだけ先に回収する。
    const previousResult = await seedRaw(firstHand())
    await service.statsLedger.acknowledgePendingHandDerivation(previousResult)
    const currentResult = structuredClone(MTT_TABLE_MOVE_FIXTURE.events[5]!) as ApiEvent<ApiType.EVT_HAND_RESULTS>
    currentResult.timestamp = currentResult.timestamp! + 100
    currentResult.HandId += 1
    // 同一timestampの後着303が主キー順で306より前に見えても、これを
    // current handのDEALとして採用してはいけない。
    const laterDeal = structuredClone(MTT_TABLE_MOVE_FIXTURE.events[3]!) as ApiEvent<ApiType.EVT_DEAL>
    laterDeal.timestamp = currentResult.timestamp
    const result = await seedRaw([currentResult, laterDeal])

    service.handAggregateStream.write(result)
    await service.handAggregateStream.whenIdle()

    expect(await db.hands.count()).toBe(0)
    expect(await db.apiEvents.count()).toBe(5)
    expect(await db.statHandContributions.count()).toBe(0)
    expect(await db.meta
      .where('id')
      .startsWith(STATS_PENDING_HAND_DERIVATION_META_PREFIX)
      .count()).toBe(0)
    expect(await service.statsLedger.needsCanonicalRebuildRecovery()).toBe(false)

    // 後続のreconnect再送も終端扱いとし、全再構築を再開したり古い
    // AggregateEventsStreamバッファを肥大させたりしない。
    service.handAggregateStream.write(result)
    await service.handAggregateStream.whenIdle()
    expect(await db.hands.count()).toBe(0)
    expect(await service.statsLedger.needsCanonicalRebuildRecovery()).toBe(false)
  })
})
