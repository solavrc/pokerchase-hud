import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { PokerChaseDB } from '../db/poker-chase-db'
import { BattleType } from '../types'
import {
  SYNC_RESCAN_BACKFILL_DONE_META_KEY,
  SYNC_RESCAN_FLOOR_META_KEY,
} from '../constants/sync'
import {
  getApiEventContentIdentity,
  mergeApiEvents,
  type RawApiEvent,
} from './api-event-key'
import { SessionScopedEntityConverter } from './session-scoped-entity-converter'
import { withRawEventSessionContext } from './raw-event-session-context'
import { MTT_TABLE_MOVE_FIXTURE } from '../test-fixtures/mtt-table-move-lifecycle'

describe('raw event session context', () => {
  test('canonical conversion persists the unique scope key on each hand', () => {
    const context = {
      scopeKey: 'run:4:ring:100',
      id: 'ring',
      battleType: BattleType.RING_GAME,
      startedAt: 100,
    }
    const converter = new SessionScopedEntityConverter({
      players: new Map(),
      reset: () => {},
    })
    const events = MTT_TABLE_MOVE_FIXTURE.events
      .slice(3, 6)
      .map(event => withRawEventSessionContext(structuredClone(event), context))

    const entities = converter.convertEventsToEntities(events)

    expect(entities.hands).toHaveLength(1)
    expect(entities.hands[0]!.session).toMatchObject({
      scopeKey: context.scopeKey,
      id: context.id,
    })
  })

  test('does not change the PokerChase payload identity', () => {
    const raw = { timestamp: 1000, ApiTypeId: 303, SeatUserIds: [1, 2] }
    const scoped = {
      ...raw,
      __pokerChaseHudSessionContext: {
        scopeKey: 'run:4:ring:100',
        id: 'ring',
        battleType: BattleType.RING_GAME,
        startedAt: 100,
      },
    }

    expect(getApiEventContentIdentity(scoped)).toBe(getApiEventContentIdentity(raw))
  })

  test('upgrades a duplicate raw row with missing replay context without adding another event', async () => {
    const db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    try {
      const raw: RawApiEvent = { timestamp: 1000, ApiTypeId: 303, SeatUserIds: [1, 2] }
      await mergeApiEvents(db, [raw])
      const context = {
        scopeKey: 'run:4:ring:100',
        id: 'ring',
        battleType: BattleType.RING_GAME,
        startedAt: 100,
      }

      const result = await mergeApiEvents(db, [{
        ...raw,
        __pokerChaseHudSessionContext: context,
      }])

      expect(result).toEqual({ added: [], duplicates: 1 })
      expect(await db.apiEvents.count()).toBe(1)
      expect(await db.apiEvents.get([1000, 303, 0])).toEqual(expect.objectContaining({
        __pokerChaseHudSessionContext: context,
      }))
    } finally {
      db.close()
      await db.delete()
    }
  })

  test('upgrades a duplicate staged earlier in the same merge batch', async () => {
    const db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    try {
      const raw: RawApiEvent = { timestamp: 1000, ApiTypeId: 303, SeatUserIds: [1, 2] }
      const context = {
        scopeKey: 'run:4:ring:100',
        id: 'ring',
        battleType: BattleType.RING_GAME,
        startedAt: 100,
      }

      const result = await mergeApiEvents(db, [
        raw,
        {
          ...raw,
          __pokerChaseHudSessionContext: context,
        },
      ])

      expect(result.duplicates).toBe(1)
      expect(result.added).toHaveLength(1)
      expect(await db.apiEvents.count()).toBe(1)
      expect(await db.apiEvents.get([1000, 303, 0])).toEqual(expect.objectContaining({
        __pokerChaseHudSessionContext: context,
      }))
    } finally {
      db.close()
      await db.delete()
    }
  })

  test('context enrichment rewinds reconciled cloud scan floors', async () => {
    const db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    try {
      const raw: RawApiEvent = { timestamp: 1000, ApiTypeId: 303, SeatUserIds: [1, 2] }
      await mergeApiEvents(db, [raw])
      await db.meta.bulkPut([
        {
          id: `${SYNC_RESCAN_BACKFILL_DONE_META_KEY}:user-a`,
          value: true,
          updatedAt: 1,
        },
        {
          id: `${SYNC_RESCAN_FLOOR_META_KEY}:user-a`,
          value: 5000,
          updatedAt: 1,
        },
      ])

      await mergeApiEvents(db, [{
        ...raw,
        __pokerChaseHudSessionContext: {
          scopeKey: 'run:4:ring:100',
          id: 'ring',
          battleType: BattleType.RING_GAME,
          startedAt: 100,
        },
      }], {
        protectAddedApplicationEventsFromCloudWatermark: true,
      })

      expect((await db.meta.get(`${SYNC_RESCAN_FLOOR_META_KEY}:user-a`))?.value).toBe(1000)
    } finally {
      db.close()
      await db.delete()
    }
  })

  test.each([
    ['new cancellation tombstone', false],
    ['context-enriched cancellation tombstone', true],
  ])('rewinds cloud scan floors for a %s', async (_label, seedDuplicate) => {
    const db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    try {
      const cancellation: RawApiEvent = {
        timestamp: 1000,
        ApiTypeId: 203,
        IsCancel: true,
      }
      if (seedDuplicate) await mergeApiEvents(db, [cancellation])
      await db.meta.bulkPut([
        {
          id: `${SYNC_RESCAN_BACKFILL_DONE_META_KEY}:user-a`,
          value: true,
          updatedAt: 1,
        },
        {
          id: `${SYNC_RESCAN_FLOOR_META_KEY}:user-a`,
          value: 5000,
          updatedAt: 1,
        },
      ])

      await mergeApiEvents(db, [{
        ...cancellation,
        __pokerChaseHudSessionContext: {
          scopeKey: 'run:4:ring:100',
          id: 'ring',
          battleType: BattleType.RING_GAME,
          startedAt: 100,
        },
      }], {
        protectAddedApplicationEventsFromCloudWatermark: true,
      })

      expect((await db.meta.get(`${SYNC_RESCAN_FLOOR_META_KEY}:user-a`))?.value).toBe(1000)
    } finally {
      db.close()
      await db.delete()
    }
  })
})
