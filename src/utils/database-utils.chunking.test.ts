/**
 * Regression tests for `processInChunks()` cursor-based pagination.
 *
 * Audit finding (independent, reproduced in-memory): the previous
 * implementation applied `.offset(n).limit(chunkSize)` to the SAME
 * `Dexie.Collection` object on every loop iteration. Dexie Collections
 * accumulate query modifiers rather than replacing them, so the second
 * iteration's `.offset(chunkSize)` was applied ON TOP OF the first
 * iteration's already-applied `.limit(chunkSize)` -- which had permanently
 * restricted the Collection to its first `chunkSize` rows. Every
 * `.offset()` call from the second iteration onward therefore skipped past
 * an already-exhausted result set and returned an empty array, and the
 * generator's `chunk.length === 0` check ended iteration right there. For
 * any caller with more rows than one `chunkSize`, only the FIRST chunk was
 * ever processed -- silently, with no error.
 *
 * Concretely, this meant the cloud-restore rebuild path
 * (`AutoSyncService.rebuildLocalEntities`, `src/services/auto-sync-service.ts`)
 * stopped deriving hands/phases/actions after the first
 * `DATABASE_CONSTANTS.SYNC_CHUNK_SIZE` (5,000) raw events, while still
 * marking the import complete.
 *
 * These tests use a REAL `PokerChaseDB` backed by `fake-indexeddb` rather
 * than a mocked Collection -- a `.offset()/.limit()` mock built with
 * `mockReturnThis()` (as `database-utils.test.ts` used before this fix)
 * cannot distinguish "fresh query per chunk" from "cumulative modifiers on
 * one Collection", which is exactly what let the original bug ship
 * unnoticed. See CLAUDE.md "Dexie Collection reuse".
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { processInChunks, processInReplayChunks, filterValidApplicationEvents, saveEntities } from './database-utils'
import { PokerChaseDB } from '../db/poker-chase-db'
import { EntityConverter } from '../entity-converter'
import type { Session } from '../types/entities'
import {
  API_EVENT_PRIMARY_KEY,
  getApiEventKey,
  mergeApiEvents,
  type ApiEventKey,
  type RawApiEvent
} from './api-event-key'

// A known-good hand (EVT_DEAL -> 3x EVT_ACTION -> EVT_HAND_RESULTS), copied
// verbatim from src/app.test.ts's event_timeline fixture (also reused by
// src/background/import-export.rebuild.test.ts) so this file isn't
// hand-authoring a new Zod-shaped fixture from scratch.
const VALID_HAND_EVENTS_TEMPLATE = [
  { "ApiTypeId": 303, "SeatUserIds": [2, 4, 3, 1], "Game": { "CurrentBlindLv": 1, "NextBlindUnixSeconds": 1752427424, "Ante": 50, "SmallBlind": 100, "BigBlind": 200, "ButtonSeat": 3, "SmallBlindSeat": 0, "BigBlindSeat": 1 }, "Player": { "SeatIndex": 1, "BetStatus": 1, "HoleCards": [5, 21], "Chip": 5750, "BetChip": 200 }, "OtherPlayers": [{ "SeatIndex": 0, "Status": 0, "BetStatus": 1, "Chip": 5850, "BetChip": 100, "IsSafeLeave": false }, { "SeatIndex": 2, "Status": 0, "BetStatus": 1, "Chip": 5950, "BetChip": 0, "IsSafeLeave": false }, { "SeatIndex": 3, "Status": 0, "BetStatus": 1, "Chip": 5950, "BetChip": 0, "IsSafeLeave": false }], "Progress": { "Phase": 0, "NextActionSeat": 2, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 1, "MinRaise": 400, "Pot": 500, "SidePot": [] }, "timestamp": 1752427313426 },
  { "ApiTypeId": 304, "SeatIndex": 2, "ActionType": 2, "Chip": 5950, "BetChip": 0, "Progress": { "Phase": 0, "NextActionSeat": 3, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 1, "MinRaise": 400, "Pot": 500, "SidePot": [] }, "timestamp": 1752427315428 },
  { "ApiTypeId": 304, "SeatIndex": 3, "ActionType": 2, "Chip": 5950, "BetChip": 0, "Progress": { "Phase": 0, "NextActionSeat": 0, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 1, "MinRaise": 400, "Pot": 500, "SidePot": [] }, "timestamp": 1752427316928 },
  { "ApiTypeId": 304, "SeatIndex": 0, "ActionType": 2, "Chip": 5850, "BetChip": 100, "Progress": { "Phase": 3, "NextActionSeat": -2, "NextActionTypes": [], "NextExtraLimitSeconds": 0, "MinRaise": 0, "Pot": 500, "SidePot": [] }, "timestamp": 1752427318516 },
  { "ApiTypeId": 306, "CommunityCards": [], "Pot": 500, "SidePot": [], "ResultType": 0, "DefeatStatus": 0, "HandId": 384370064, "HandLog": "", "Results": [{ "UserId": 4, "HoleCards": [], "RankType": 10, "Hands": [], "HandRanking": 1, "Ranking": -2, "RewardChip": 500 }], "Player": { "SeatIndex": 1, "BetStatus": -1, "Chip": 6250, "BetChip": 0 }, "OtherPlayers": [{ "SeatIndex": 0, "Status": 0, "BetStatus": -1, "Chip": 5850, "BetChip": 0, "IsSafeLeave": false }, { "SeatIndex": 2, "Status": 0, "BetStatus": -1, "Chip": 5950, "BetChip": 0, "IsSafeLeave": false }, { "SeatIndex": 3, "Status": 0, "BetStatus": -1, "Chip": 5950, "BetChip": 0, "IsSafeLeave": false }], "timestamp": 1752427319431 },
]

/** Deep-clone the fixture hand with a distinct HandId and timestamps shifted by `offsetMs`. */
function makeHandEvents(handId: number, offsetMs: number): any[] {
  const clone = JSON.parse(JSON.stringify(VALID_HAND_EVENTS_TEMPLATE))
  for (const event of clone) {
    event.timestamp += offsetMs
    if (event.ApiTypeId === 306) event.HandId = handId
  }
  return clone
}

describe('processInChunks (cursor-based pagination over a real Dexie table)', () => {
  let db: PokerChaseDB

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
  })

  afterEach(async () => {
    db.close()
    await db.delete()
  })

  test('audit repro: 12 rows, chunkSize=5 -> all 3 batches fire, all 12 ids seen exactly once', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      timestamp: 1_000 + i,
      ApiTypeId: 304,
      id: i,
    }))
    await db.apiEvents.bulkAdd(rows as any)

    const chunks: any[][] = []
    for await (const chunk of processInChunks(db.apiEvents, 5)) {
      chunks.push(chunk)
    }

    // This is the exact shape the audit reports for the unfixed helper: with
    // 12 rows and chunkSize=5, only the FIRST chunk (5 rows) would come
    // back -- `chunks` would have length 1, not 3.
    expect(chunks).toHaveLength(3)
    expect(chunks.map(c => c.length)).toEqual([5, 5, 2])

    const seenIds = chunks.flat().map((r: any) => r.id as number)
    expect(seenIds.slice().sort((a, b) => a - b)).toEqual(rows.map(r => r.id))
    expect(new Set(seenIds).size).toBe(12) // every id exactly once, no dupes
  })

  test('durable checkpoint resumes after a mid-scan transaction abort without omissions or duplicates across four real pages', async () => {
    const uniqueRows: RawApiEvent[] = [
      { timestamp: 100, ApiTypeId: 201, marker: 'a' },
      { timestamp: 101, ApiTypeId: 201, marker: 'b' },
      { timestamp: 102, ApiTypeId: 201, marker: 'c' },
      // A same-millisecond, same-type burst crosses the 3-row page boundary.
      // All callers must cursor on the complete primary key, including sequence.
      { timestamp: 103, ApiTypeId: 304, marker: 'burst-0' },
      { timestamp: 103, ApiTypeId: 304, marker: 'burst-1' },
      { timestamp: 103, ApiTypeId: 304, marker: 'burst-2' },
      { timestamp: 104, ApiTypeId: 306, marker: 'd' },
      { timestamp: 105, ApiTypeId: 201, marker: 'e' },
      { timestamp: 106, ApiTypeId: 306, marker: 'f' },
      { timestamp: 107, ApiTypeId: 201, marker: 'g' },
      { timestamp: 108, ApiTypeId: 306, marker: 'h' },
      { timestamp: 109, ApiTypeId: 201, marker: 'i' }
    ]
    const duplicate = structuredClone(uniqueRows[4]!)
    const merged = await mergeApiEvents(db, [...uniqueRows, duplicate])
    expect(merged.added).toHaveLength(uniqueRows.length)
    expect(merged.duplicates).toBe(1)

    const checkpointId = 'cursorInvariantConsumer'
    let failOnce = true
    const consumeFrom = async (afterKey?: ApiEventKey): Promise<void> => {
      for await (const chunk of processInChunks(db.apiEvents, 3, { afterKey })) {
        await db.transaction('rw', db.meta, async () => {
          const previous = await db.meta.get(checkpointId)
          const durableKeys = (previous?.value?.keys ?? []) as ApiEventKey[]
          const chunkKeys = (chunk as unknown as RawApiEvent[]).map(getApiEventKey)
          await db.meta.put({
            id: checkpointId,
            value: {
              keys: [...durableKeys, ...chunkKeys],
              afterKey: chunkKeys[chunkKeys.length - 1]
            },
            updatedAt: Date.now()
          })

          // Fail after the second page's writes have been issued. The real
          // fake-indexeddb transaction must roll back both the processed-key
          // record and its cursor, so the retry starts from the last durable
          // page rather than skipping the aborted page.
          if (failOnce && chunk.some(row => (row as RawApiEvent).marker === 'burst-2')) {
            failOnce = false
            throw new Error('synthetic consumer transaction abort')
          }
        })
      }
    }

    await expect(consumeFrom()).rejects.toThrow('synthetic consumer transaction abort')
    const afterAbort = await db.meta.get(checkpointId)
    expect(afterAbort?.value.keys).toHaveLength(3)

    await consumeFrom(afterAbort?.value.afterKey as ApiEventKey)

    const durable = await db.meta.get(checkpointId)
    const durableKeys = durable?.value.keys as ApiEventKey[]
    const expectedKeys = (await db.apiEvents.orderBy(API_EVENT_PRIMARY_KEY).toArray() as unknown as RawApiEvent[])
      .map(getApiEventKey)
    expect(durableKeys).toEqual(expectedKeys)
    expect(new Set(durableKeys.map(key => key.join(':'))).size).toBe(expectedKeys.length)
  })

  test('yields nothing for an empty table', async () => {
    const chunks: any[][] = []
    for await (const chunk of processInChunks(db.apiEvents, 10)) {
      chunks.push(chunk)
    }
    expect(chunks).toHaveLength(0)
  })

  test('reports cumulative onProgress against a stable total across chunks', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ timestamp: 2_000 + i, ApiTypeId: 304 }))
    await db.apiEvents.bulkAdd(rows as any)

    const onProgress = jest.fn()
    const chunks: any[][] = []
    for await (const chunk of processInChunks(db.apiEvents, 10, { onProgress })) {
      chunks.push(chunk)
    }

    expect(chunks).toHaveLength(2)
    expect(onProgress).toHaveBeenCalledWith(10, 20)
    expect(onProgress).toHaveBeenCalledWith(20, 20)
  })

  test('afterTimestamp excludes rows tied at the boundary regardless of ApiTypeId (matches prior where("timestamp").above() semantics)', async () => {
    await db.apiEvents.bulkAdd([
      { timestamp: 100, ApiTypeId: 1 },
      { timestamp: 100, ApiTypeId: 999 }, // tied at the boundary -- must be excluded
      { timestamp: 101, ApiTypeId: 1 },
      { timestamp: 102, ApiTypeId: 5 },
    ] as any)

    const chunks: any[][] = []
    for await (const chunk of processInChunks(db.apiEvents, 10, { afterTimestamp: 100 })) {
      chunks.push(chunk)
    }

    const seen = chunks.flat() as any[]
    expect(seen.map(e => e.timestamp).sort((a, b) => a - b)).toEqual([101, 102])
  })

  test('afterTimestamp also cursors correctly across multiple chunks', async () => {
    // 4 rows above the threshold, chunkSize=2 -> 2 chunks, all 4 seen once.
    await db.apiEvents.bulkAdd([
      { timestamp: 50, ApiTypeId: 1 }, // below threshold, excluded
      { timestamp: 100, ApiTypeId: 1 }, // tied at threshold, excluded
      { timestamp: 101, ApiTypeId: 1 },
      { timestamp: 102, ApiTypeId: 2 },
      { timestamp: 102, ApiTypeId: 3 },
      { timestamp: 103, ApiTypeId: 1 },
    ] as any)

    const chunks: any[][] = []
    for await (const chunk of processInChunks(db.apiEvents, 2, { afterTimestamp: 100 })) {
      chunks.push(chunk)
    }

    expect(chunks).toHaveLength(2)
    const seen = chunks.flat() as any[]
    expect(seen).toHaveLength(4)
    expect(seen.map(e => `${e.timestamp}:${e.ApiTypeId}`).sort()).toEqual(
      ['101:1', '102:2', '102:3', '103:1'].sort()
    )
  })

  test('full-key cursor crosses a same-millisecond same-type sequence boundary without skipping or duplicating', async () => {
    const rows = [
      { timestamp: 100, ApiTypeId: 304, sequence: 0, marker: 'burst-0' },
      { timestamp: 100, ApiTypeId: 304, sequence: 1, marker: 'burst-1' },
      { timestamp: 100, ApiTypeId: 305, sequence: 0, marker: 'next-type' },
      { timestamp: 101, ApiTypeId: 304, sequence: 0, marker: 'next-ms' }
    ]
    await db.apiEvents.bulkAdd(rows as any)

    const chunks: any[][] = []
    for await (const chunk of processInChunks(db.apiEvents, 1, {
      afterKey: [100, 304, 0]
    })) chunks.push(chunk)

    expect(chunks.map(chunk => chunk[0].marker)).toEqual(['burst-1', 'next-type', 'next-ms'])
  })

  test('replay chunks hold an equal-ms group across a primary-key page boundary', async () => {
    await db.apiEvents.bulkAdd([
      {
        timestamp: 100,
        ApiTypeId: 304,
        SeatIndex: 4,
        BetChip: 1_379,
        Chip: 28_428,
        Progress: { Phase: 2, Pot: 5_558 },
        marker: 'turn-action'
      },
      {
        timestamp: 100,
        ApiTypeId: 305,
        Progress: { Phase: 2, Pot: 4_179, NextActionSeat: 4 },
        OtherPlayers: [{ SeatIndex: 4, BetChip: 0, Chip: 29_807 }],
        marker: 'turn-card'
      },
      { timestamp: 101, ApiTypeId: 306, marker: 'result' }
    ] as any)

    const chunks: any[][] = []
    for await (const chunk of processInReplayChunks(db.apiEvents as any, 1)) chunks.push(chunk)

    expect(chunks.flat().map(row => row.marker)).toEqual(['turn-card', 'turn-action', 'result'])
  })

  test('snapshot replay keeps a causal equal-ms group whole across three pages and excludes rows inserted mid-scan', async () => {
    await db.apiEvents.bulkAdd([
      { timestamp: 100, ApiTypeId: 201, marker: 'before-1' },
      { timestamp: 101, ApiTypeId: 201, marker: 'before-2' },
      {
        timestamp: 200,
        ApiTypeId: 304,
        SeatIndex: 4,
        BetChip: 1_379,
        Chip: 28_428,
        Progress: { Phase: 2, Pot: 5_558 },
        marker: 'turn-action'
      },
      {
        timestamp: 200,
        ApiTypeId: 305,
        Progress: { Phase: 2, Pot: 4_179, NextActionSeat: 4 },
        OtherPlayers: [{ SeatIndex: 4, BetChip: 0, Chip: 29_807 }],
        marker: 'turn-card'
      },
      { timestamp: 201, ApiTypeId: 306, marker: 'result' },
      { timestamp: 202, ApiTypeId: 201, marker: 'after-1' },
      { timestamp: 203, ApiTypeId: 306, marker: 'after-2' }
    ] as any)

    const snapshotKeys = await db.apiEvents
      .orderBy(API_EVENT_PRIMARY_KEY)
      .primaryKeys() as ApiEventKey[]
    const iterator = processInReplayChunks(db.apiEvents as any, 3, { snapshotKeys })
    const first = await iterator.next()
    expect(first.done).toBe(false)
    const firstPage = first.value as RawApiEvent[]
    expect(firstPage.map(row => row.marker)).toEqual(['before-1', 'before-2'])

    // One row sorts behind the current cursor and one ahead. Neither belongs
    // to the export/replay snapshot captured above, so neither may leak into
    // the current pass or perturb its page/group boundaries.
    await mergeApiEvents(db, [
      { timestamp: 99, ApiTypeId: 201, marker: 'concurrent-low' },
      { timestamp: 204, ApiTypeId: 201, marker: 'concurrent-high' }
    ])

    const remaining: RawApiEvent[] = []
    while (true) {
      const next = await iterator.next()
      if (next.done) break
      remaining.push(...next.value as RawApiEvent[])
    }

    const replayed = [...firstPage, ...remaining]
    expect(replayed.map(row => row.marker)).toEqual([
      'before-1',
      'before-2',
      // The pair was split between raw pages 1 and 2, then resolved only
      // after the complete timestamp group was available.
      'turn-card',
      'turn-action',
      'result',
      'after-1',
      'after-2'
    ])
    const replayedKeySet = new Set(replayed.map(row => getApiEventKey(row).join(':')))
    expect(replayedKeySet).toEqual(new Set(snapshotKeys.map(key => key.join(':'))))
    expect(replayedKeySet.size).toBe(snapshotKeys.length)
    expect(await db.apiEvents.count()).toBe(snapshotKeys.length + 2)
  })

  test('same-millisecond same-type events both survive storage and entity derivation', async () => {
    const events = makeHandEvents(9_999_001, 0)
    events[2].timestamp = events[1].timestamp
    for (const event of events) event.sequence = 0
    events[2].sequence = 1
    await db.apiEvents.bulkAdd(events)

    const burstRows = await db.apiEvents
      .where('[timestamp+ApiTypeId]')
      .equals([events[1].timestamp, 304])
      .toArray()
    expect(burstRows).toHaveLength(2)

    const validEvents = await filterValidApplicationEvents(
      await db.apiEvents.orderBy('[timestamp+ApiTypeId+sequence]').toArray()
    )
    const defaultSession: Session = {
      id: undefined,
      battleType: undefined,
      name: undefined,
      players: new Map(),
      reset: () => { },
    }
    const converter = new EntityConverter(defaultSession)
    await saveEntities(db, converter.convertEventsToEntities(validEvents))

    expect(await db.hands.count()).toBe(1)
    expect(await db.actions.count()).toBe(3)
  })

  test('rebuild-shaped: derives entities for ALL raw events across >2x chunk-size boundaries, mirroring AutoSyncService.rebuildLocalEntities', async () => {
    // 5 hands x 5 events = 25 raw events, well over 2x a chunkSize of 10 --
    // the exact shape that would have silently stopped after the first
    // chunk (10 events / 2 hands) under the old offset/limit implementation.
    const HAND_COUNT = 5
    const CHUNK_SIZE = 10
    const allEvents: any[] = []
    for (let i = 0; i < HAND_COUNT; i++) {
      allEvents.push(...makeHandEvents(1_000_000 + i, i * 100_000))
    }
    await db.apiEvents.bulkAdd(allEvents)
    expect(await db.apiEvents.count()).toBe(HAND_COUNT * 5)

    // Mirror AutoSyncService.rebuildLocalEntities's exact call shape: one
    // EntityConverter instance spans the whole processInChunks loop (hand
    // boundaries tracked across chunks via convertEventChunk), re-validated
    // per chunk via filterValidApplicationEvents, flush()ed once at the end.
    const defaultSession: Session = {
      id: undefined,
      battleType: undefined,
      name: undefined,
      players: new Map(),
      reset: () => { },
    }
    const converter = new EntityConverter(defaultSession)
    let processedEventCount = 0

    for await (const events of processInChunks(db.apiEvents, CHUNK_SIZE)) {
      processedEventCount += events.length
      const validEvents = await filterValidApplicationEvents(events)
      const entities = converter.convertEventChunk(validEvents)
      await saveEntities(db, entities)
    }
    await saveEntities(db, converter.flush())

    // The core assertion: ALL events were handed to processInChunks (not
    // just the first chunk)...
    expect(processedEventCount).toBe(HAND_COUNT * 5)
    // ...and ALL hands were derived from them, not just the ones in the
    // first chunk (2 of 5, under the pre-fix bug).
    expect(await db.hands.count()).toBe(HAND_COUNT)
    for (let i = 0; i < HAND_COUNT; i++) {
      const hand = await db.hands.get(1_000_000 + i)
      expect(hand).toBeDefined()
    }
    expect(await db.actions.count()).toBeGreaterThan(0)
    expect(await db.phases.count()).toBeGreaterThan(0)
  })
})
