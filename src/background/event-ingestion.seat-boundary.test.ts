import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { ApiType, type ApiEvent } from '../types/api'
import { trackServiceForTeardown } from '../utils/test-service-teardown'
import { registerEventIngestion } from './event-ingestion'
import { connectedPorts } from './ports'
import * as ports from './ports'
import { __resetUpdateManagerStateForTests } from './update-manager'
import { AutoSyncService, autoSyncService } from '../services/auto-sync-service'
import { clearRecentHandsCache, getRecentHands } from '../services/recent-hands-service'
import * as apiEventKey from '../utils/api-event-key'
import { STATS_PENDING_HAND_DERIVATION_META_PREFIX } from '../stats/stat-ledger'
import { HandLogExporter } from '../utils/hand-log-exporter'
import { setOperationState } from './operation-state'
import type { HandLogEvent } from '../types/hand-log'

const fixture = (): ApiEvent[] => JSON.parse('[' + readFileSync(join(process.cwd(), 'e2e/fixtures/hand-ring-seat-replacement.ndjson'), 'utf8').trim().split('\n').join(',') + ']')

describe('301 at the completed-hand timestamp survives raw persistence and canonical recovery', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let deliver: (event: ApiEvent) => Promise<void>
  let disconnect: Array<() => void>
  let autoSync: AutoSyncService
  let logEvents: HandLogEvent[]

  beforeEach(async () => {
    __resetUpdateManagerStateForTests()
    setOperationState({ type: 'idle' })
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = trackServiceForTeardown(new PokerChaseService({ db }))
    await service.ready
    autoSync = new AutoSyncService(db)
    ;(globalThis as any).service = service
    jest.spyOn(autoSyncService, 'onNewSessionStart').mockResolvedValue(undefined)
    jest.spyOn(autoSyncService, 'scheduleCanonicalRebuildRecovery').mockImplementation(id => autoSync.scheduleCanonicalRebuildRecovery(id))
    ;(chrome.runtime as any).onConnect = { addListener: jest.fn() }
    registerEventIngestion(service)
    disconnect = []
    const port = { name: PokerChaseService.POKER_CHASE_SERVICE_EVENT,
      onMessage: { addListener: jest.fn() }, onDisconnect: { addListener: jest.fn(fn => disconnect.push(fn)) }, postMessage: jest.fn() }
    ;(chrome.runtime as any).onConnect.addListener.mock.calls[0][0](port)
    deliver = port.onMessage.addListener.mock.calls[0]![0]
    logEvents = []
    service.handLogStream.on('data', event => logEvents.push(event))
    HandLogExporter.clearCache()
  })

  afterEach(async () => {
    await service.handAggregateStream.whenIdle()
    await service.handLogStream.whenIdle()
    await service.statsOutputStream.whenIdle()
    service.cancelPendingPersist()
    disconnect.forEach(fn => fn())
    connectedPorts.clear()
    setOperationState({ type: 'idle' })
    delete (globalThis as any).service
    jest.restoreAllMocks()
    db.close()
    await db.delete()
  })

  const prepare = async () => {
    const events = fixture()
    const joinEvent = events.find(event => event.ApiTypeId === ApiType.EVT_PLAYER_JOIN)!
    const result = events.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)!
    joinEvent.timestamp = result.timestamp
    for (const event of events.filter(event => event !== joinEvent)) await deliver(event)
    await service.handAggregateStream.whenIdle()
    await service.handLogStream.whenIdle()
    expect((await db.hands.get(result.HandId))!.playerChipAccounting!['3101']?.totalContribution).toBe(541)
    return { joinEvent, result }
  }
  const fenceCount = () => db.meta.where('id').startsWith(STATS_PENDING_HAND_DERIVATION_META_PREFIX).count()
  const ledgerRows = async () => {
    for (const id of [3101, 3102, 3103, 3104]) await service.statsLedger.readPlayerSnapshot(id)
    const head = (await service.statsLedger.getActiveHead())!
    return (await db.statHandContributions.where('generation').equals(head.generation).toArray())
      .map(({ generation: _generation, ...row }) => row)
  }

  test('late301 raw and result fence commit together, then update hand/log once without duplicate stats', async () => {
    const { joinEvent, result } = await prepare()
    expect(await fenceCount()).toBe(0)
    const merge = apiEventKey.mergeApiEvents
    let fenceObservedAtRawCommit = false
    jest.spyOn(apiEventKey, 'mergeApiEvents').mockImplementation(async (database, events, options) => {
      const merged = await merge(database, events, options)
      if (events[0]?.ApiTypeId === ApiType.EVT_PLAYER_JOIN && merged.added.length > 0) {
        fenceObservedAtRawCommit = await fenceCount() === 1
      }
      return merged
    })
    await deliver(joinEvent)
    await service.handLogStream.whenIdle()
    expect(fenceObservedAtRawCommit).toBe(true)
    expect(await fenceCount()).toBe(0)
    expect((await db.hands.get(result.HandId))!.playerChipAccounting!['3101']).toBeNull()
    const latestLog = logEvents.filter(event => event.type === 'update').at(-1)!
    expect(latestLog.entries!.some(entry => entry.text.includes('Rake unknown'))).toBe(true)
    expect(await HandLogExporter.exportHand(db, result.HandId)).toContain('Rake unknown')
    expect(await HandLogExporter.exportMultipleHands(db, [result.HandId])).toContain('Rake unknown')
    const ledger = await ledgerRows()
    expect(ledger).toHaveLength(4)
    await deliver(joinEvent)
    expect(await db.apiEvents.count()).toBe(8)
    expect((await db.apiEvents.where('[ApiTypeId+timestamp]').equals([ApiType.EVT_PLAYER_JOIN, joinEvent.timestamp!]).first())!).not.toHaveProperty('HandId')
    expect(await ledgerRows()).toEqual(ledger)
    expect(await db.hands.count()).toBe(1)
  })

  test('canonical failure after late301 raw save recovers the hand, cache and completion notification', async () => {
    const { joinEvent, result } = await prepare()
    const rebuild = jest.spyOn(autoSync as any, 'rebuildLocalEntities')
    const notifyRecovered = jest.spyOn(ports, 'notifyRecoveredHandCompletion')
    const previousNodeEnv = process.env.NODE_ENV
    clearRecentHandsCache()
    process.env.NODE_ENV = 'production'
    try {
      expect((await getRecentHands(db, service, 3101)).hands[0]?.netChips).toBe(-541)
      jest.spyOn(db.hands, 'put').mockRejectedValueOnce(new Error('injected boundary canonical failure'))
      await deliver(joinEvent)
      expect(rebuild).toHaveBeenCalledTimes(1)
      expect(await fenceCount()).toBe(0)
      expect((await db.hands.get(result.HandId))!.playerChipAccounting!['3101']).toBeNull()
      expect(await ledgerRows()).toHaveLength(4)
      expect(notifyRecovered).toHaveBeenCalledTimes(1)
      expect((await getRecentHands(db, service, 3101)).hands[0]?.netChips).toBeNull()
    } finally {
      process.env.NODE_ENV = previousNodeEnv
      clearRecentHandsCache()
    }
  })

  test('missing completed buffer after worker restart uses the durable late301 fence to recover', async () => {
    const { joinEvent, result } = await prepare()
    // Same persistence with no in-memory completed-hand state, as after a worker restart.
    const forward = jest.spyOn(service.handAggregateStream, 'write').mockImplementation(() => {})
    const rebuild = jest.spyOn(autoSync as any, 'rebuildLocalEntities')
    await deliver(joinEvent)
    forward.mockRestore()
    expect(rebuild).toHaveBeenCalledTimes(1)
    expect(await fenceCount()).toBe(0)
    expect((await db.hands.get(result.HandId))!.playerChipAccounting!['3101']).toBeNull()
    const ledger = await ledgerRows()
    await (autoSync as any).rebuildLocalEntities()
    expect(await ledgerRows()).toEqual(ledger)
  })
  test('staging activation that captured an older306 fence cannot clear a new301 fence', async () => {
    const { joinEvent, result } = await prepare()
    const storedResult = (await db.apiEvents.where('[ApiTypeId+timestamp]').equals([ApiType.EVT_HAND_RESULTS, result.timestamp!]).first())!
    const oldRecords = service.statsLedger.createPendingHandDerivationFenceRecords([storedResult as unknown as apiEventKey.RawApiEvent])
    await db.meta.bulkPut(oldRecords)
    const capturedIds = oldRecords.map(record => record.id)
    const staging = await service.statsLedger.prepareStagingGeneration()
    const merged = await apiEventKey.mergeApiEvents(db, [joinEvent as apiEventKey.RawApiEvent], {
      atomicMetaRecordsForAdded: added => service.statsLedger.createPendingHandDerivationFenceRecords(
        added.map(event => ({ ...event, HandId: result.HandId }))),
    })
    const target = { ...merged.added[0]!, HandId: result.HandId }
    const newId = service.statsLedger.getPendingHandDerivationFenceId(target)!
    expect(capturedIds).not.toContain(newId)
    expect((await db.meta.get(newId))!.value.rawKey[1]).toBe(ApiType.EVT_PLAYER_JOIN)
    await service.statsLedger.activateStagingGeneration(staging.generation, capturedIds)
    expect(await db.meta.get(capturedIds[0]!)).toBeUndefined()
    expect(await db.meta.get(newId)).toBeDefined()
    // Simulate the next worker observing a fence saved immediately before termination.
    const marker = (await db.meta.get(newId))!
    await db.meta.put({ ...marker, value: { ...marker.value, ownerId: 'previous-worker' } })
    expect(await service.statsLedger.needsCanonicalRebuildRecovery()).toBe(true)
    await autoSync.recoverInterruptedCanonicalRebuild()
    expect(await fenceCount()).toBe(0)
    expect((await db.hands.get(result.HandId))!.playerChipAccounting!['3101']).toBeNull()
  })

  test('one301 at previous306/next303 belongs to both live buffers while HandId-scoped fences stay separate', async () => {
    const { joinEvent, result } = await prepare()
    const next = fixture().filter(event => event.ApiTypeId >= ApiType.EVT_DEAL && event.ApiTypeId <= ApiType.EVT_HAND_RESULTS)
    const nextDeal = next.find(event => event.ApiTypeId === ApiType.EVT_DEAL)!
    const nextResult = next.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)!
    next.forEach((event, index) => { event.timestamp = result.timestamp! + index * 1000 })
    nextResult.HandId += 1
    await deliver(nextDeal)
    await deliver(joinEvent)
    expect((await db.hands.get(result.HandId))!.playerChipAccounting!['3101']).toBeNull()
    const rawJoin = (await db.apiEvents.where('[ApiTypeId+timestamp]').equals([ApiType.EVT_PLAYER_JOIN, joinEvent.timestamp!]).first())!
    const targets = [result.HandId, nextResult.HandId].map(HandId => ({ ...rawJoin, HandId }))
    const markers = service.statsLedger.createPendingHandDerivationFenceRecords(targets as unknown as apiEventKey.RawApiEvent[])
    expect(new Set(markers.map(record => record.id)).size).toBe(2)
    await db.meta.bulkPut(markers)
    await service.statsLedger.acknowledgePendingHandDerivation(targets[0]!)
    expect(await db.meta.get(markers[1]!.id)).toBeDefined()
    for (const event of next.slice(1)) await deliver(event)
    await service.handAggregateStream.whenIdle()
    expect(await db.hands.count()).toBe(2)
    expect((await db.hands.get(nextResult.HandId))!.playerChipAccounting!['3101']).toBeNull()
    expect(await fenceCount()).toBe(0)
    expect(await ledgerRows()).toHaveLength(8)
  })

  test('301 fence write failure rolls back raw and a retry restores the original operation', async () => {
    const { joinEvent, result } = await prepare()
    const put = db.meta.put.bind(db.meta)
    const failure = jest.spyOn(db.meta, 'put').mockImplementation((record: any, key?: any) => {
      if (record.id.startsWith(STATS_PENDING_HAND_DERIVATION_META_PREFIX) && record.id.includes(':301:')) {
        return Promise.reject(new Error('injected join fence write failure')) as any
      }
      return put(record, key)
    })
    await deliver(joinEvent)
    expect(await db.apiEvents.count()).toBe(7)
    expect(await fenceCount()).toBe(0)
    expect((await db.hands.get(result.HandId))!.playerChipAccounting!['3101']?.totalContribution).toBe(541)
    failure.mockRestore()
    await deliver(joinEvent)
    expect(await db.apiEvents.count()).toBe(8)
    expect((await db.hands.get(result.HandId))!.playerChipAccounting!['3101']).toBeNull()
    expect(await fenceCount()).toBe(0)
  })

  test('invalid301 is stored before validation and recovery clears its fence without applying the invalid boundary', async () => {
    const { joinEvent, result } = await prepare()
    delete (joinEvent as any).JoinUser.Rank
    const rebuild = jest.spyOn(autoSync as any, 'rebuildLocalEntities')
    await deliver(joinEvent)
    expect(await db.apiEvents.count()).toBe(8)
    expect(rebuild).toHaveBeenCalledTimes(1)
    expect(await fenceCount()).toBe(0)
    expect((await db.hands.get(result.HandId))!.playerChipAccounting!['3101']?.totalContribution).toBe(541)
  })

})
