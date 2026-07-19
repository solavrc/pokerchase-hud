/**
 * Database utility functions for PokerChase HUD
 * Common patterns for database operations
 */

import type { PokerChaseDB } from '../db/poker-chase-db'
import type { EntityBundle } from '../entity-converter'
import type { ApiEvent } from '../types/api'
import type Dexie from 'dexie'

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
 * Process database queries in chunks to avoid memory issues
 * Generic helper for chunked data processing
 */
export async function* processInChunks<T>(
  query: Dexie.Collection<T>,
  chunkSize: number,
  options?: {
    orderBy?: string
    onProgress?: (current: number, total: number) => void
  }
): AsyncGenerator<T[], void, unknown> {
  const total = await query.count()
  let offset = 0

  while (offset < total) {
    const chunk = await query
      .offset(offset)
      .limit(chunkSize)
      .toArray()

    if (chunk.length === 0) break

    yield chunk
    offset += chunk.length

    options?.onProgress?.(offset, total)
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