import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { EntityConverter } from '../entity-converter'
import { AutoSyncService, autoSyncService } from '../services/auto-sync-service'
import { ApiType, BattleType, type ApiEvent } from '../types'
import type { HandLogEvent } from '../types/hand-log'
import { getHandSession } from '../utils/hand-session-context'
import {
  orderAndFilterApplicationEventsForReplay,
} from '../utils/database-utils'
import type { RawApiEvent } from '../utils/api-event-key'
import { trackServiceForTeardown } from '../utils/test-service-teardown'
import {
  __resetActivePortStateForTests,
  resolveGeneration,
} from './active-port'
import { registerEventIngestion } from './event-ingestion'
import { setOperationState } from './operation-state'
import { connectedPorts } from './ports'
import { __resetUpdateManagerStateForTests } from './update-manager'
import {
  __resetStatsOutputContextForTests,
  getEventGeneration,
} from '../streams/stats-output-context'
import type { CanonicalWriteFailureError } from '../streams/write-entity-stream'

const loadNdjson = (path: string): ApiEvent[] => readFileSync(path, 'utf8')
  .trim()
  .split('\n')
  .map(line => JSON.parse(line) as ApiEvent)

const seatFixture = (): ApiEvent[] => loadNdjson(join(
  process.cwd(),
  'e2e/fixtures/hand-ring-seat-replacement.ndjson'
))

const sessionDetailsFixture = (): ApiEvent => loadNdjson(join(
  process.cwd(),
  'e2e/fixtures/session-3hands.ndjson'
)).find(event => event.ApiTypeId === ApiType.EVT_SESSION_DETAILS)!

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const emptySession = () => ({
  id: undefined,
  battleType: undefined,
  name: undefined,
  players: new Map(),
  reset: () => {},
})

const makePort = (tabId: number, documentId: string) => {
  const disconnectHandlers: Array<() => void> = []
  const port = {
    name: PokerChaseService.POKER_CHASE_SERVICE_EVENT,
    onMessage: { addListener: jest.fn() },
    onDisconnect: {
      addListener: jest.fn((handler: () => void) => disconnectHandlers.push(handler)),
    },
    postMessage: jest.fn(),
    disconnect: jest.fn(),
    sender: { tab: { id: tabId }, documentId },
  }
  return { port, disconnectHandlers }
}

const accountingAt = async (db: PokerChaseDB, handId: number, playerId = 3101) =>
  (await db.hands.get(handId))!.playerChipAccounting![String(playerId)]

describe('live hand-boundary authority', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let autoSync: AutoSyncService
  let connect: (port: any) => void
  let tabA: ReturnType<typeof makePort>
  let tabB: ReturnType<typeof makePort>
  let sendA: (message: any) => Promise<void>
  let sendB: (message: any) => Promise<void>
  let logEvents: HandLogEvent[]
  let aggregateEvents: ApiEvent[][]
  let cleanupGates: Array<() => void>

  beforeEach(async () => {
    __resetUpdateManagerStateForTests()
    __resetActivePortStateForTests()
    __resetStatsOutputContextForTests()
    setOperationState({ type: 'idle' })
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = trackServiceForTeardown(new PokerChaseService({ db }))
    await service.ready
    jest.spyOn(service, 'eventLogger').mockImplementation(() => undefined)
    autoSync = new AutoSyncService(db)
    ;(globalThis as any).service = service

    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    jest.spyOn(autoSyncService, 'onNewSessionStart').mockResolvedValue(undefined)
    jest.spyOn(autoSyncService, 'scheduleCanonicalRebuildRecovery')
      .mockImplementation(id => autoSync.scheduleCanonicalRebuildRecovery(id))

    ;(chrome.runtime as any).onConnect = { addListener: jest.fn() }
    registerEventIngestion(service)
    connect = (chrome.runtime as any).onConnect.addListener.mock.calls[0][0]
    tabA = makePort(101, 'old-document')
    tabB = makePort(202, 'new-document')
    connect(tabA.port)
    connect(tabB.port)
    sendA = tabA.port.onMessage.addListener.mock.calls[0][0]
    sendB = tabB.port.onMessage.addListener.mock.calls[0][0]

    logEvents = []
    aggregateEvents = []
    cleanupGates = []
    service.handLogStream.on('data', event => logEvents.push(event))
    service.handAggregateStream.on('data', events => aggregateEvents.push(events))
  })

  afterEach(async () => {
    cleanupGates.forEach(release => release())
    await service.handAggregateStream.whenIdle()
    await service.handLogStream.whenIdle()
    await service.statsOutputStream.whenIdle()
    service.cancelPendingPersist()
    tabA.disconnectHandlers.forEach(handler => handler())
    tabB.disconnectHandlers.forEach(handler => handler())
    connectedPorts.clear()
    __resetActivePortStateForTests()
    __resetStatsOutputContextForTests()
    setOperationState({ type: 'idle' })
    delete (globalThis as any).service
    jest.restoreAllMocks()
    db.close()
    await db.delete()
  })

  test('missing-DEAL fence cannot let display stamp the next hand before Aggregate applies its session', async () => {
    service.session.setId('old-session')
    service.session.setBattleType(BattleType.SIT_AND_GO)
    service.session.setName('Old Session')

    const fixture = seatFixture()
    const sourceResult = fixture.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)!
    const strayResult = clone(sourceResult)
    strayResult.timestamp = 1_000
    ;(strayResult as any).HandId = 900_000_030

    const entry = clone(fixture.find(event => event.ApiTypeId === ApiType.EVT_ENTRY_QUEUED)!)
    entry.timestamp = 2_000
    ;(entry as any).Id = 'new-session'
    const details = clone(sessionDetailsFixture())
    details.timestamp = 2_001
    ;(details as any).Name = 'New Session'
    const handEvents = fixture
      .filter(event => [ApiType.EVT_DEAL, ApiType.EVT_ACTION, ApiType.EVT_HAND_RESULTS].includes(event.ApiTypeId as any))
      .map((event, index) => ({ ...clone(event), timestamp: 2_002 + index }))
    const result = handEvents.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)! as ApiEvent<ApiType.EVT_HAND_RESULTS>

    let markStarted!: () => void
    const markHasStarted = new Promise<void>(resolve => { markStarted = resolve })
    let releaseFence!: () => void
    const fenceGate = new Promise<void>(resolve => { releaseFence = resolve })
    cleanupGates.push(releaseFence)
    const originalMark = service.statsLedger.markPendingHandDerivationFailed.bind(service.statsLedger)
    jest.spyOn(service.statsLedger, 'markPendingHandDerivationFailed')
      .mockImplementationOnce(async event => {
        markStarted()
        await fenceGate
        return await originalMark(event)
      })
      .mockImplementation(originalMark)

    let recoveryScheduled!: () => void
    const recoveryHasScheduled = new Promise<void>(resolve => { recoveryScheduled = resolve })
    let releaseRecovery!: () => void
    const recoveryGate = new Promise<void>(resolve => { releaseRecovery = resolve })
    cleanupGates.push(releaseRecovery)
    const recoveryPromises: Promise<void>[] = []
    ;(autoSyncService.scheduleCanonicalRebuildRecovery as jest.Mock).mockImplementation(async id => {
      recoveryScheduled()
      await recoveryGate
      return await autoSync.scheduleCanonicalRebuildRecovery(id)
    })
    const scheduleFromStreamError = (error: unknown) => {
      const canonical = error as CanonicalWriteFailureError
      if (canonical.canonicalRecoveryRequired !== true) return
      recoveryPromises.push(autoSyncService.scheduleCanonicalRebuildRecovery(
        canonical.canonicalRecoveryFenceId
      ))
    }
    service.handAggregateStream.on('error', scheduleFromStreamError)

    const putSessions: Array<Record<string, unknown>> = []
    const originalPut = db.hands.put.bind(db.hands)
    jest.spyOn(db.hands, 'put').mockImplementation((async (hand: Parameters<typeof originalPut>[0]) => {
      putSessions.push({ ...hand.session })
      return await originalPut(hand)
    }) as any)

    await sendA(strayResult)
    await markHasStarted
    for (const event of [entry, details, ...handEvents]) await sendA(event)
    await service.handLogStream.whenIdle()
    // Aggregateが古いRESULTSのdurable fenceを処理中なら、後続HandLogもまだ進まない。
    expect(logEvents).toHaveLength(0)
    const serviceBeforeAggregateRelease = service.session.id

    releaseFence()
    await service.handAggregateStream.whenIdle()
    await service.handLogStream.whenIdle()
    await recoveryHasScheduled
    const livePersistedBeforeRecovery = (await db.hands.get(result.HandId))!.session

    const replayHand = new EntityConverter(emptySession())
      .convertEventsToEntities([entry, details, ...handEvents])
      .hands.find(hand => hand.id === result.HandId)!
    expect(replayHand.session).toEqual({
      id: 'new-session',
      battleType: (entry as any).BattleType,
      name: 'New Session',
    })

    releaseRecovery()
    await Promise.all(recoveryPromises)

    expect(serviceBeforeAggregateRelease).toBe('old-session')
    expect(service.session.id).toBe('new-session')
    const liveDeal = aggregateEvents.flat().find(
      (event): event is ApiEvent<ApiType.EVT_DEAL> => event.ApiTypeId === ApiType.EVT_DEAL
    )!
    expect(getHandSession(liveDeal)).toEqual({
      id: 'new-session',
      battleType: (entry as any).BattleType,
      name: 'New Session',
    })
    expect(putSessions[0]).toEqual({
      id: 'new-session',
      battleType: (entry as any).BattleType,
      name: 'New Session',
    })
    expect(livePersistedBeforeRecovery).toEqual(replayHand.session)
    const completedLog = logEvents.find(event =>
      event.type === 'update' && event.handId === result.HandId
    )
    expect(completedLog?.entries?.map(item => item.text)).toContain(
      "Table 'New Session' 6-max Seat #3 is the button"
    )
    expect((await db.hands.get(result.HandId))!.session).toEqual(replayHand.session)
  })

  test('306 then next 303 then late 301 corrects the prior log without resetting the active hand', async () => {
    const fixture = seatFixture()
    const joinEvent = fixture.find(event => event.ApiTypeId === ApiType.EVT_PLAYER_JOIN)!
    const result = fixture.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)! as ApiEvent<ApiType.EVT_HAND_RESULTS>
    joinEvent.timestamp = result.timestamp
    const firstArrival = fixture.filter(event => event !== joinEvent)

    for (const event of firstArrival) await sendA(event)
    await service.handAggregateStream.whenIdle()
    await service.handLogStream.whenIdle()
    expect((await accountingAt(db, result.HandId))?.totalContribution).toBe(541)

    const priorUpdates = () => logEvents.filter(event => event.type === 'update' && event.handId === result.HandId)
    expect(priorUpdates()).toHaveLength(1)
    expect(priorUpdates()[0]!.entries!.some(entry => entry.text.includes('Rake 541'))).toBe(true)

    const nextDeal = clone(fixture.find(event => event.ApiTypeId === ApiType.EVT_DEAL)!)
    nextDeal.timestamp = result.timestamp
    await sendA(nextDeal)
    const unfinishedAddsBeforeJoin = logEvents.filter(event => event.type === 'add').length
    await sendA(joinEvent)
    await service.handAggregateStream.whenIdle()
    await service.handLogStream.whenIdle()

    expect(await accountingAt(db, result.HandId)).toBeNull()
    expect(priorUpdates()).toHaveLength(2)
    expect(priorUpdates().at(-1)!.entries!.some(entry => entry.text.includes('Rake unknown'))).toBe(true)
    expect(priorUpdates().at(-1)!.preserveIncomplete).toBe(true)
    expect(logEvents.filter(event => event.type === 'add')).toHaveLength(unfinishedAddsBeforeJoin)
    expect(autoSyncService.scheduleCanonicalRebuildRecovery).not.toHaveBeenCalled()

    const continuedAction = clone(fixture.find(event =>
      event.ApiTypeId === ApiType.EVT_ACTION && event.SeatIndex === 2
    )!)
    continuedAction.timestamp = result.timestamp! + 1
    await sendA(continuedAction)
    await service.handAggregateStream.whenIdle()
    await service.handLogStream.whenIdle()
    expect(logEvents.filter(event => event.type === 'add')).toHaveLength(unfinishedAddsBeforeJoin + 1)
    expect(logEvents.at(-1)?.entries?.map(entry => entry.text)).toContain('Player2: folds')

    const arrivalOrder = [...firstArrival, nextDeal, joinEvent]
    const direct = new EntityConverter(emptySession()).convertEventsToEntities(arrivalOrder)
    const directOld = direct.hands.find(hand => hand.id === result.HandId)!
    expect(directOld.approxTimestamp).toBe(
      fixture.find(event => event.ApiTypeId === ApiType.EVT_DEAL)!.timestamp
    )
    expect(directOld.playerChipAccounting!['3101']?.totalContribution).toBe(541)

    const rawRows = await db.apiEvents.toArray() as unknown as RawApiEvent[]
    const replayOrder = await orderAndFilterApplicationEventsForReplay(rawRows)
    const tieOrder = replayOrder
      .filter(event => event.timestamp === result.timestamp)
      .map(event => event.ApiTypeId)
    expect(tieOrder).toEqual([
      ApiType.EVT_PLAYER_JOIN,
      ApiType.EVT_DEAL,
      ApiType.EVT_HAND_RESULTS,
    ])
    const replay = new EntityConverter(emptySession()).convertEventsToEntities(replayOrder)
    const replayOld = replay.hands.find(hand => hand.id === result.HandId)!
    expect(replayOld.approxTimestamp).toBe(result.timestamp)
    expect(replayOld.playerChipAccounting!['3101']).toBeNull()
    expect(replay.actions.filter(action => action.handId === result.HandId)).toHaveLength(0)

  })

  test('names learned from 313 after DEAL remain in the completed authority HandLog', async () => {
    const fixture = seatFixture().map(clone)
    const roster = fixture.find(event => event.ApiTypeId === ApiType.EVT_PLAYER_SEAT_ASSIGNED)!
    const deal = fixture.find(event => event.ApiTypeId === ApiType.EVT_DEAL)!
    const result = fixture.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)! as ApiEvent<ApiType.EVT_HAND_RESULTS>
    fixture.splice(fixture.indexOf(roster), 1)
    roster.timestamp = deal.timestamp
    fixture.splice(fixture.indexOf(deal) + 1, 0, roster)

    for (const event of fixture) await sendA(event)
    await service.handAggregateStream.whenIdle()
    await service.handLogStream.whenIdle()

    const completed = logEvents.find(event =>
      event.type === 'update' && event.handId === result.HandId
    )
    const lines = completed?.entries?.map(entry => entry.text) ?? []
    expect(lines).toContain('Seat 1: Player1 (3491 in chips)')
    expect(lines).toContain('Player1: folds')
    expect(lines).toContain('Player3: posts small blind 25')
    expect(lines).toContain('Player4 collected 50 from pot')
    expect(lines.join('\n')).not.toMatch(/Player310[1-4]/)
  })

  test('one same-ms 301 corrects every eligible completed HandId while a third hand stays active', async () => {
    const fixture = seatFixture()
    const joinEvent = clone(fixture.find(event => event.ApiTypeId === ApiType.EVT_PLAYER_JOIN)!)
    const firstResult = fixture.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)! as ApiEvent<ApiType.EVT_HAND_RESULTS>
    joinEvent.timestamp = firstResult.timestamp

    for (const event of fixture.filter(event => event.ApiTypeId !== ApiType.EVT_PLAYER_JOIN)) {
      await sendA(event)
    }

    const secondDeal = clone(fixture.find(event => event.ApiTypeId === ApiType.EVT_DEAL)!)
    secondDeal.timestamp = firstResult.timestamp
    const secondResult = clone(firstResult)
    secondResult.HandId = firstResult.HandId + 1
    const activeDeal = clone(secondDeal)
    activeDeal.Game.CurrentBlindLv += 1

    await sendA(secondDeal)
    await sendA(secondResult)
    await sendA(activeDeal)
    await service.handAggregateStream.whenIdle()
    await service.handLogStream.whenIdle()

    const updatesFor = (handId: number) => logEvents.filter(event =>
      event.type === 'update' && event.handId === handId
    )
    expect(updatesFor(firstResult.HandId)).toHaveLength(1)
    expect(updatesFor(secondResult.HandId)).toHaveLength(1)
    const activeAddsBeforeJoin = logEvents.filter(event => event.type === 'add').length

    await sendA(joinEvent)
    await service.handAggregateStream.whenIdle()
    await service.handLogStream.whenIdle()

    expect(aggregateEvents.map(events =>
      events.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)?.HandId
    )).toEqual([
      firstResult.HandId,
      secondResult.HandId,
      firstResult.HandId,
      secondResult.HandId,
    ])
    for (const handId of [firstResult.HandId, secondResult.HandId]) {
      expect(await accountingAt(db, handId)).toBeNull()
      expect(updatesFor(handId)).toHaveLength(2)
      expect(updatesFor(handId).at(-1)?.preserveIncomplete).toBe(true)
    }
    expect(logEvents.filter(event => event.type === 'add')).toHaveLength(activeAddsBeforeJoin)

    const continuedAction = clone(fixture.find(event =>
      event.ApiTypeId === ApiType.EVT_ACTION && event.SeatIndex === 2
    )!)
    continuedAction.timestamp = firstResult.timestamp! + 1
    await sendA(continuedAction)
    await service.handAggregateStream.whenIdle()
    await service.handLogStream.whenIdle()
    expect(logEvents.at(-1)?.entries?.map(entry => entry.text)).toContain('Player2: folds')
    expect(autoSyncService.scheduleCanonicalRebuildRecovery).not.toHaveBeenCalled()
  })

  test('a newer timestamp expires the boundary group and an older timestamp cannot reopen it', async () => {
    const fixture = seatFixture()
    const joinEvent = clone(fixture.find(event => event.ApiTypeId === ApiType.EVT_PLAYER_JOIN)!)
    const result = fixture.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)! as ApiEvent<ApiType.EVT_HAND_RESULTS>
    joinEvent.timestamp = result.timestamp

    for (const event of fixture.filter(event => event.ApiTypeId !== ApiType.EVT_PLAYER_JOIN)) {
      service.handAggregateStream.write(event)
    }
    await service.handAggregateStream.whenIdle()
    const updateCount = logEvents.filter(event => event.type === 'update' && event.handId === result.HandId).length

    const newer = clone(sessionDetailsFixture())
    newer.timestamp = result.timestamp! + 1
    service.handAggregateStream.write(newer)
    service.handAggregateStream.write(joinEvent)
    await service.handAggregateStream.whenIdle()
    await service.handLogStream.whenIdle()

    expect(aggregateEvents).toHaveLength(1)
    expect(logEvents.filter(event => event.type === 'update' && event.handId === result.HandId)).toHaveLength(updateCount)
    expect((await accountingAt(db, result.HandId))?.totalContribution).toBe(541)
  })

  test('a timestampless session notice preserves the open group and the numeric frontier', async () => {
    const fixture = seatFixture()
    const joinEvent = clone(fixture.find(event => event.ApiTypeId === ApiType.EVT_PLAYER_JOIN)!)
    const deal = fixture.find(event => event.ApiTypeId === ApiType.EVT_DEAL)!
    const result = fixture.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)! as ApiEvent<ApiType.EVT_HAND_RESULTS>
    joinEvent.timestamp = result.timestamp

    for (const event of fixture.filter(event => event.ApiTypeId !== ApiType.EVT_PLAYER_JOIN)) {
      service.handAggregateStream.write(event)
    }
    await service.handAggregateStream.whenIdle()
    expect(aggregateEvents).toHaveLength(1)

    const untimedNotice = clone(sessionDetailsFixture())
    delete untimedNotice.timestamp
    service.handAggregateStream.write(untimedNotice)
    service.handAggregateStream.write(joinEvent)
    await service.handAggregateStream.whenIdle()
    await service.handLogStream.whenIdle()

    // timestamp無しのsession通知は、直前306と同msの301補正候補を失効しない。
    expect(aggregateEvents).toHaveLength(2)
    expect(await accountingAt(db, result.HandId)).toBeNull()

    const futureDeal = clone(deal)
    futureDeal.timestamp = result.timestamp! + 2
    const olderNotice = clone(sessionDetailsFixture())
    olderNotice.timestamp = result.timestamp! + 1
    const interruptedResult = clone(result)
    interruptedResult.HandId += 100
    interruptedResult.timestamp = result.timestamp! + 3
    service.handAggregateStream.write(futureDeal)
    service.handAggregateStream.write(olderNotice)
    service.handAggregateStream.write(interruptedResult)
    await service.handAggregateStream.whenIdle()

    // 数値frontierはNaN化せず、古い通知がactive bufferを切るためDEALなし306を出力しない。
    expect(aggregateEvents).toHaveLength(2)

    const nextDeal = clone(deal)
    nextDeal.timestamp = result.timestamp! + 4
    const nextResult = clone(result)
    nextResult.HandId += 101
    nextResult.timestamp = result.timestamp! + 5
    service.handAggregateStream.write(nextDeal)
    service.handAggregateStream.write(nextResult)
    await service.handAggregateStream.whenIdle()
    expect(aggregateEvents.map(events =>
      events.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)?.HandId
    )).toEqual([result.HandId, result.HandId, nextResult.HandId])
  })

  test('a known foreign-generation 301 settles every candidate fence without revising either completed hand', async () => {
    const writtenEvents: ApiEvent[] = []
    const originalWrite = service.handAggregateStream.write.bind(service.handAggregateStream)
    jest.spyOn(service.handAggregateStream, 'write').mockImplementation(event => {
      writtenEvents.push(event)
      originalWrite(event)
    })

    const fixture = seatFixture()
    const joinEvent = fixture.find(event => event.ApiTypeId === ApiType.EVT_PLAYER_JOIN)!
    const result = fixture.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)! as ApiEvent<ApiType.EVT_HAND_RESULTS>
    joinEvent.timestamp = result.timestamp
    for (const event of fixture.filter(event => event !== joinEvent)) await sendA(event)
    const secondDeal = clone(fixture.find(event => event.ApiTypeId === ApiType.EVT_DEAL)!)
    secondDeal.timestamp = result.timestamp
    const secondResult = clone(result)
    secondResult.HandId = result.HandId + 1
    await sendA(secondDeal)
    await sendA(secondResult)
    await service.handAggregateStream.whenIdle()
    for (const handId of [result.HandId, secondResult.HandId]) {
      expect((await accountingAt(db, handId))?.totalContribution).toBe(541)
    }

    const unrelatedResult = {
      ...clone(result),
      HandId: result.HandId + 100,
      sequence: 999,
    } as unknown as RawApiEvent
    const unrelatedFence = service.statsLedger.createPendingHandDerivationFenceRecords([unrelatedResult])[0]!
    await db.meta.put(unrelatedFence)

    const putSpy = jest.spyOn(db.hands, 'put')
    const replaceSpy = jest.spyOn(service.statsLedger, 'replaceCompletedHandContributions')
    const logUpdateCount = logEvents.filter(event => event.type === 'update').length

    const oldGeneration = resolveGeneration(tabA.port as unknown as chrome.runtime.Port)!
    expect(oldGeneration).toBeGreaterThan(0)
    await sendB(joinEvent)
    await service.handAggregateStream.whenIdle()
    const newGeneration = resolveGeneration(tabB.port as unknown as chrome.runtime.Port)!
    expect(newGeneration).toBeGreaterThan(oldGeneration)

    expect(aggregateEvents).toHaveLength(2)
    for (const handId of [result.HandId, secondResult.HandId]) {
      expect((await accountingAt(db, handId))?.totalContribution).toBe(541)
    }
    expect(putSpy).not.toHaveBeenCalled()
    expect(replaceSpy).not.toHaveBeenCalled()
    expect(logEvents.filter(event => event.type === 'update')).toHaveLength(logUpdateCount)
    expect(autoSyncService.scheduleCanonicalRebuildRecovery).not.toHaveBeenCalled()

    const storedJoin = (await db.apiEvents
      .where('[ApiTypeId+timestamp]')
      .equals([ApiType.EVT_PLAYER_JOIN, result.timestamp!])
      .first()) as unknown as Record<string, unknown>
    expect(storedJoin).not.toHaveProperty('generation')

    for (const handId of [result.HandId, secondResult.HandId]) {
      const fenceId = service.statsLedger.getPendingHandDerivationFenceId({
        ...storedJoin,
        HandId: handId,
      } as unknown as RawApiEvent)!
      expect(await db.meta.get(fenceId)).toBeUndefined()
    }
    expect(await db.meta.get(unrelatedFence.id)).toEqual(unrelatedFence)

    expect(getEventGeneration(
      writtenEvents.find(event => event.ApiTypeId === ApiType.EVT_PLAYER_JOIN)!
    )).toBe(newGeneration)
  })
})
