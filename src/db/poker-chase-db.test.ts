/**
 * PokerChaseDB - Raw Event Lake (apiEvents hook removal)
 *
 * Verifies apiEvents is a raw, unfiltered log again (docs/architecture.md
 * "Raw Event Lake"). The `creating`/`reading` hooks added in commit a6480ff
 * (2025-07-24) silently hid non-application events from every reader — and,
 * because the `creating` hook's `this.onsuccess = null` never actually
 * aborted the underlying IndexedDB write, those rows were already being
 * physically stored while invisible. This suite locks in that both hooks are
 * gone: whatever is written is exactly what comes back on read.
 */
import Dexie from 'dexie'
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { PokerChaseDB } from './poker-chase-db'
import { API_EVENT_PRIMARY_KEY } from '../utils/api-event-key'
import { processInChunks } from '../utils/database-utils'

describe('PokerChaseDB Raw Event Lake', () => {
  let db: PokerChaseDB

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
  })

  afterEach(async () => {
    db.close()
    await db.delete()
  })

  it('uses database version 7 after adding the experimental replay store', () => {
    expect(db.verno).toBe(7)
  })

  it('stores and reads back a known non-application event (202) unfiltered', async () => {
    const nonAppEvent = { ApiTypeId: 202, Code: 0, timestamp: 123 }
    await db.apiEvents.add(nonAppEvent as any)

    const stored = await db.apiEvents.toArray()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toEqual(nonAppEvent)

    const byKey = await db.apiEvents.get([123, 202, 0])
    expect(byKey).toEqual(nonAppEvent)
  })

  it('stores and reads back an event with an ApiTypeId unknown to any schema', async () => {
    const unknownEvent = { ApiTypeId: 9999, timestamp: 456, SomeFutureField: 'x' }
    await db.apiEvents.add(unknownEvent as any)

    const stored = await db.apiEvents.toArray()
    expect(stored).toEqual([unknownEvent])
  })

  it('stores and reads back an application-type event whose payload fails the current schema', async () => {
    // A malformed EVT_DEAL (303) missing every required field — simulates a
    // PokerChase payload shape change that broke Zod validation.
    const brokenAppEvent = { ApiTypeId: 303, timestamp: 789 }
    await db.apiEvents.add(brokenAppEvent as any)

    const stored = await db.apiEvents.toArray()
    expect(stored).toEqual([brokenAppEvent])
  })

  it('mixes application, non-application, and unknown events without any of them disappearing on read', async () => {
    const events = [
      { ApiTypeId: 201, timestamp: 1, Code: 0, BattleType: 0, Id: 'a', IsRetire: false }, // valid app event
      { ApiTypeId: 202, timestamp: 2, Code: 0 }, // valid non-app event
      { ApiTypeId: 9999, timestamp: 3 }, // unknown type
      { ApiTypeId: 303, timestamp: 4 }, // broken app event
    ]
    await db.apiEvents.bulkAdd(events as any)

    const stored = await db.apiEvents.orderBy(API_EVENT_PRIMARY_KEY).toArray()
    expect(stored).toHaveLength(4)
    expect(stored.map((e: any) => e.ApiTypeId)).toEqual([201, 202, 9999, 303])
  })
})

describe('PokerChaseDB v3 -> v7 apiEvents sequence-key migration', () => {
  afterEach(async () => {
    const cleanup = new PokerChaseDB(indexedDB, IDBKeyRange)
    await cleanup.delete()
  })

  test('migrates every old-key row intact with sequence 0 and keeps cursor pagination usable', async () => {
    const legacy = new Dexie('PokerChaseDB', { indexedDB, IDBKeyRange })
    legacy.version(3).stores({
      apiEvents: '[timestamp+ApiTypeId],timestamp,ApiTypeId,[ApiTypeId+timestamp]',
      hands: 'id,*seatUserIds,*winningPlayerIds,approxTimestamp',
      phases: '[handId+phase],handId,*seatUserIds,phase',
      actions: '[handId+index],handId,playerId,phase,actionType,*actionDetails,[playerId+phase],[playerId+actionType]',
      meta: 'id,updatedAt'
    })
    await legacy.open()
    // Cross the production migration's 5,000-row copy boundary so both
    // staging directions exercise their cursor-resume path.
    const oldRows = Array.from({ length: 5002 }, (_, index) => ({
      timestamp: 100 + index,
      ApiTypeId: 202,
      Code: 0,
      marker: `row-${index}`
    }))
    await legacy.table('apiEvents').bulkAdd(oldRows)
    legacy.close()

    const migrated = new PokerChaseDB(indexedDB, IDBKeyRange)
    await migrated.open()

    expect(migrated.verno).toBe(7)
    const stored = await migrated.apiEvents.orderBy(API_EVENT_PRIMARY_KEY).toArray() as any[]
    expect(stored).toEqual(oldRows.map(row => ({ ...row, sequence: 0 })))

    const chunks: any[][] = []
    for await (const chunk of processInChunks(migrated.apiEvents, 2000)) chunks.push(chunk)
    expect(chunks.map(chunk => chunk.length)).toEqual([2000, 2000, 1002])
    expect(chunks.flat().map(row => row.marker)).toEqual(oldRows.map(row => row.marker))

    migrated.close()
  }, 15_000)
})
