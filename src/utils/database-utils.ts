/**
 * Database utility functions for PokerChase HUD
 * Common patterns for database operations
 */

import type { PokerChaseDB } from '../db/poker-chase-db'
import type { EntityBundle } from '../entity-converter'
import type { ApiEvent } from '../types/api'
import type Dexie from 'dexie'
import {
  API_EVENT_PRIMARY_KEY,
  type ApiEventKey,
  getApiEventSequence,
  orderApiEventsForReplay,
  type RawApiEvent
} from './api-event-key'

/**
 * Save entities to database in a transaction
 * Consolidates duplicate bulk save patterns across the codebase
 */
export async function saveEntities(
  db: PokerChaseDB,
  entities: EntityBundle,
  options?: {
    includesMeta?: boolean
    onProgress?: (counts: { hands: number; phases: number; actions: number }) => void
  }
): Promise<{ hands: number; phases: number; actions: number }> {
  const tables: Dexie.Table[] = [db.hands, db.phases, db.actions]
  if (options?.includesMeta) {
    tables.push(db.meta as any) // Meta table has different structure
  }

  return await db.transaction('rw', tables, async () => {
    const counts = { hands: 0, phases: 0, actions: 0 }

    if (entities.hands.length > 0) {
      await db.hands.bulkPut(entities.hands)
      counts.hands = entities.hands.length
    }

    if (entities.phases.length > 0) {
      await db.phases.bulkPut(entities.phases)
      counts.phases = entities.phases.length
    }

    if (entities.actions.length > 0) {
      await db.actions.bulkPut(entities.actions)
      counts.actions = entities.actions.length
    }

    options?.onProgress?.(counts)
    return counts
  })
}

/**
 * Process a Dexie table in chunks using true cursor-based pagination.
 * Generic helper for chunked data processing.
 *
 * IMPORTANT (see CLAUDE.md "Dexie Collection reuse"): `.offset(n).limit(m)`
 * on a single, already-built `Dexie.Collection` instance is NOT safe
 * pagination. Dexie Collections accumulate query modifiers rather than
 * replacing them, so calling `.offset()`/`.limit()` again on the SAME
 * Collection object on the next loop iteration stacks a second offset/limit
 * on top of the first one instead of re-querying from scratch. A prior
 * version of this helper took a single pre-built `Collection<T>` and looped
 * `.offset(offset).limit(chunkSize)` over it -- after the first chunk, the
 * Collection was already permanently limited to `chunkSize` rows, so every
 * subsequent `.offset()` call skipped past that already-exhausted result set
 * and every later chunk silently came back empty (the loop's
 * `chunk.length === 0` check then ended iteration early). For any
 * caller with `total > chunkSize` this meant only the FIRST chunk was ever
 * processed, with no error -- e.g. a cloud restore rebuild would silently
 * stop deriving hands/phases/actions after the first `chunkSize` raw events
 * while still marking the import complete.
 *
 * This version takes the `Dexie.Table` itself (not a Collection) and issues
 * a brand-new query for every chunk, cursoring on the table's
 * `[timestamp+ApiTypeId+sequence]` compound primary key -- exactly the pattern
 * CLAUDE.md prescribes: `where('[timestamp+ApiTypeId+sequence]').above(lastKey).limit(N)`.
 * This is currently only used against `db.apiEvents` (whose primary key is
 * that compound index); if a future caller needs this for a table with a
 * different key shape, extend/generalize the cursor extraction rather than
 * reusing this implementation's hardcoded `timestamp`/`ApiTypeId` fields.
 */
export async function* processInChunks<T extends { timestamp?: number; ApiTypeId: number; sequence?: number }>(
  table: Dexie.Table<T, any>,
  chunkSize: number,
  options?: {
    /**
     * Only include rows whose `timestamp` is strictly greater than this
     * value -- matches the semantics of the `.where('timestamp').above(x)`
     * queries this helper's callers previously built by hand.
     */
    afterTimestamp?: number
    /** Resume strictly after this exact raw-event key. */
    afterKey?: ApiEventKey
    onProgress?: (current: number, total: number) => void
  }
): AsyncGenerator<T[], void, unknown> {
  const afterKey = options?.afterKey
  const afterTimestamp = options?.afterTimestamp
  const total = afterKey !== undefined
    ? await table.where(API_EVENT_PRIMARY_KEY).above(afterKey).count()
    : afterTimestamp !== undefined
    ? await table.where('timestamp').above(afterTimestamp).count()
    : await table.count()

  if (total === 0) return

  // Cursor into the `[timestamp+ApiTypeId+sequence]` compound primary key. When
  // filtering by `afterTimestamp`, seed the cursor at
  // `[afterTimestamp, MAX_SAFE_INTEGER, MAX_SAFE_INTEGER]`. `.above()` this
  // sentinel excludes every row tied at `afterTimestamp` regardless of its
  // `ApiTypeId`/sequence, matching the strict
  // `timestamp > afterTimestamp` filter it replaces, while still being a
  // real (sortable) key the compound index can seek on.
  let cursor: ApiEventKey | undefined = afterKey ?? (afterTimestamp !== undefined
    ? [afterTimestamp, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
    : undefined)
  let processed = 0

  while (true) {
    // Fresh query every iteration -- never reuse a Collection across chunks.
    const collection = cursor !== undefined
      ? table.where(API_EVENT_PRIMARY_KEY).above(cursor)
      : table.orderBy(API_EVENT_PRIMARY_KEY)

    const chunk = await collection.limit(chunkSize).toArray()
    if (chunk.length === 0) break

    yield chunk
    processed += chunk.length

    const last = chunk[chunk.length - 1]!
    cursor = [last.timestamp!, last.ApiTypeId, getApiEventSequence(last)]

    options?.onProgress?.(processed, total)
  }
}

/**
 * Primary-key cursor pagination with equal-timestamp groups replayed together.
 *
 * A raw page may end between two event types sharing a millisecond. Holding its
 * trailing timestamp until the following page lets the causal resolver inspect
 * the complete group even at a chunk boundary.
 */
export async function* processInReplayChunks<T extends { timestamp?: number; ApiTypeId: number; sequence?: number }>(
  table: Dexie.Table<T, any>,
  chunkSize: number,
  options?: {
    onProgress?: (current: number, total: number) => void
  }
): AsyncGenerator<T[], void, unknown> {
  const total = await table.count()
  if (total === 0) return

  let cursor: ApiEventKey | undefined
  let carry: T[] = []
  let processed = 0

  while (true) {
    const rawChunk = await (cursor
      ? table.where(API_EVENT_PRIMARY_KEY).above(cursor)
      : table.orderBy(API_EVENT_PRIMARY_KEY))
      .limit(chunkSize)
      .toArray()

    if (rawChunk.length === 0) {
      if (carry.length > 0) {
        const ordered = orderApiEventsForReplay(carry as unknown as RawApiEvent[]) as unknown as T[]
        yield ordered
        processed += ordered.length
        options?.onProgress?.(processed, total)
      }
      break
    }

    const last = rawChunk[rawChunk.length - 1]!
    cursor = [last.timestamp!, last.ApiTypeId, getApiEventSequence(last)]
    const combined = [...carry, ...rawChunk]

    if (rawChunk.length < chunkSize) {
      const ordered = orderApiEventsForReplay(combined as unknown as RawApiEvent[]) as unknown as T[]
      yield ordered
      processed += ordered.length
      options?.onProgress?.(processed, total)
      break
    }

    const trailingTimestamp = combined[combined.length - 1]!.timestamp
    let splitIndex = combined.length - 1
    while (splitIndex > 0 && combined[splitIndex - 1]!.timestamp === trailingTimestamp) splitIndex--

    const ready = combined.slice(0, splitIndex)
    carry = combined.slice(splitIndex)
    if (ready.length > 0) {
      const ordered = orderApiEventsForReplay(ready as unknown as RawApiEvent[]) as unknown as T[]
      yield ordered
      processed += ordered.length
      options?.onProgress?.(processed, total)
    }
  }
}

/**
 * Find the latest EVT_DEAL event with Player.SeatIndex
 * Consolidates the repeated pattern across services
 */
export async function findLatestPlayerDealEvent(
  db: PokerChaseDB,
  searchLimit = 10,
  maxAttempts = 100
): Promise<any | undefined> {
  const { ApiType, isApiEventType } = await import('../types/api')
  
  let offset = 0
  
  while (offset < maxAttempts) {
    const events = await db.apiEvents
      .where('ApiTypeId').equals(ApiType.EVT_DEAL)
      .reverse()
      .offset(offset)
      .limit(searchLimit)
      .toArray()
    
    if (events.length === 0) break
    
    const dealEvent = events.find(event =>
      isApiEventType(event, ApiType.EVT_DEAL) && event.Player?.SeatIndex !== undefined
    )
    
    if (dealEvent) return dealEvent
    
    offset += searchLimit
  }
  
  return undefined
}

/**
 * Filter raw `apiEvents` rows down to ones that currently parse as a known,
 * validated application event.
 *
 * `apiEvents` is the raw "Lake" (see docs/architecture.md "Raw Event Lake") —
 * it may contain non-application noise (202/205 keepalive/timer spam),
 * ApiTypeIds unknown to the current schema (a future PokerChase payload
 * type), or application-type events whose payload doesn't match the current
 * Zod schema (either a PokerChase payload change not yet accounted for, or
 * one already fixed since the row was first stored). `EntityConverter` and
 * `HandLogProcessor` assume well-typed, schema-valid `ApiEvent` shapes and
 * read required fields (e.g. `EVT_DEAL.Game.SmallBlind`) without guards —
 * feeding them raw, unvalidated rows can throw and abort a whole rebuild or
 * export. Re-running `parseApiEvent` here before handing events to either of
 * those is what keeps that safe.
 *
 * It's also what makes a later schema fix retroactively recover previously
 * unparseable rows on the very next rebuild: no separate promotion mechanism
 * is needed, because the fix is validated against the exact same raw rows
 * that have been sitting in `apiEvents` all along.
 */
export async function filterValidApplicationEvents(rawEvents: unknown[]): Promise<ApiEvent[]> {
  const { parseApiEvent, isApplicationApiEvent } = await import('../types/api')
  const valid: ApiEvent[] = []
  for (const raw of rawEvents) {
    const parsed = parseApiEvent(raw)
    if (parsed && isApplicationApiEvent(parsed)) valid.push(parsed)
  }
  return valid
}

/**
 * Execute a database transaction with proper error handling
 * Wraps common transaction patterns with consistent error handling
 */
export async function withTransaction<T>(
  db: PokerChaseDB,
  mode: 'r' | 'rw',
  tables: Dexie.Table<any, any>[],
  operation: () => Promise<T>,
  context: string
): Promise<T> {
  try {
    return await db.transaction(mode, tables, operation)
  } catch (error) {
    console.error(`[${context}] Transaction failed:`, error)
    
    // Handle specific error types
    if (error instanceof Error) {
      if (error.name === 'QuotaExceededError') {
        console.error(`[${context}] Storage quota exceeded`)
        // Could trigger cleanup here
      } else if (error.name === 'ConstraintError') {
        console.error(`[${context}] Database constraint violation`)
      }
    }
    
    throw error
  }
}
