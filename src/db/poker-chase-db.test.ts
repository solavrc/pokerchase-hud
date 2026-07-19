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
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { PokerChaseDB } from './poker-chase-db'

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

  it('stays on database version 3 (no index change was needed to remove the hooks)', () => {
    expect(db.verno).toBe(3)
  })

  it('stores and reads back a known non-application event (202) unfiltered', async () => {
    const nonAppEvent = { ApiTypeId: 202, Code: 0, timestamp: 123 }
    await db.apiEvents.add(nonAppEvent as any)

    const stored = await db.apiEvents.toArray()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toEqual(nonAppEvent)

    const byKey = await db.apiEvents.get([123, 202])
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

    const stored = await db.apiEvents.orderBy('[timestamp+ApiTypeId]').toArray()
    expect(stored).toHaveLength(4)
    expect(stored.map((e: any) => e.ApiTypeId)).toEqual([201, 202, 9999, 303])
  })
})
