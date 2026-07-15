/**
 * Firestore Backup Service.
 *
 * Uses the Firestore REST API directly so the MV3 bundle does not include
 * Firebase SDK code that Chrome Web Store can classify as remote-code loaders.
 */

import { firebaseConfig } from './firebase-config'
import { firebaseAuthService } from './firebase-auth-service'
import type { ApiEvent } from '../types'
import { DATABASE_CONSTANTS } from '../constants/database'

export interface BackupSummary {
  totalEvents: number
  syncedEvents: number
  lastSyncTime: Date
}

export interface CloudSyncOptions {
  afterEvent?: { timestamp: number, apiTypeId: number }
  onBatch: (events: ApiEvent[]) => Promise<void>
  onProgress?: (progress: { current: number, total: number }) => void
}

type FirestoreValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { referenceValue: string }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } }

interface FirestoreDocument {
  name: string
  fields?: Record<string, FirestoreValue>
}

interface RunQueryResult {
  document?: FirestoreDocument
}

interface RunAggregationQueryResult {
  result?: {
    aggregateFields?: Record<string, FirestoreValue>
  }
}

interface FirestoreStatus {
  code?: number
  message?: string
}

interface BatchWriteResponse {
  status?: FirestoreStatus[]
}

interface EventQueryCursor {
  timestamp: FirestoreValue
  documentName: string
}

class FirestoreBatchWriteError extends Error {
  constructor(
    readonly code: number,
    readonly failedWrites: number,
    message: string
  ) {
    super(message)
    this.name = 'FirestoreBatchWriteError'
  }
}

export class FirestoreBackupService {
  private readonly USERS_COLLECTION = 'users'
  private readonly EVENTS_COLLECTION = 'apiEvents'
  private readonly BATCH_SIZE = DATABASE_CONSTANTS.FIRESTORE_BATCH_SIZE
  private readonly BATCH_DELAY_MS = DATABASE_CONSTANTS.FIRESTORE_BATCH_DELAY_MS
  private readonly DELETE_BATCH_SIZE = DATABASE_CONSTANTS.FIRESTORE_DELETE_BATCH
  private readonly DOWNLOAD_PAGE_SIZE = DATABASE_CONSTANTS.FIRESTORE_DOWNLOAD_PAGE_SIZE
  private readonly documentsPath = `projects/${firebaseConfig.projectId}/databases/(default)/documents`
  private readonly baseUrl = `https://firestore.googleapis.com/v1/${this.documentsPath}`

  /**
   * Sync local events to cloud (upload events newer than cloud's latest timestamp).
   */
  async syncToCloud(
    apiEvents: ApiEvent[],
    onProgress?: (progress: { current: number, total: number }) => void
  ): Promise<BackupSummary> {
    const cloudMaxTimestamp = await this.getCloudMaxTimestamp()
    return await this.syncToCloudBatch(apiEvents, cloudMaxTimestamp, onProgress)
  }

  /**
   * Get cloud backup status.
   */
  async getCloudStatus(): Promise<{ eventCount: number }> {
    try {
      const user = await this.requireUser()
      return { eventCount: await this.countEventDocuments(user.uid) }
    } catch (error) {
      console.error('Failed to get cloud status:', error)
      return { eventCount: 0 }
    }
  }

  /**
   * Sync cloud events to local (cloud as source of truth).
   */
  async syncFromCloud(options: CloudSyncOptions): Promise<number> {
    try {
      const user = await this.requireUser()
      const initialCursor = options.afterEvent
        ? this.eventCursor(user.uid, options.afterEvent.timestamp, options.afterEvent.apiTypeId)
        : undefined
      const total = await this.countEventDocuments(user.uid, initialCursor)
      let processed = 0

      for await (const documents of this.queryEventDocumentPages(user.uid, initialCursor)) {
        const events = documents.map(doc => decodeFields(doc.fields ?? {}) as ApiEvent)
        await options.onBatch(events)
        processed += events.length
        options.onProgress?.({ current: processed, total })
      }

      if (processed === 0) {
        options.onProgress?.({ current: 0, total })
      }

      console.log(`[Firestore] Downloaded ${processed} of ${total} matching cloud events`)
      return processed
    } catch (error) {
      console.error('Failed to sync from cloud:', error)
      throw new Error(`Cloud sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Get the latest timestamp from cloud events.
   */
  async getCloudMaxTimestamp(): Promise<number | null> {
    try {
      const events = await this.queryEvents('desc', 1)
      const latestEvent = events[0]
      return typeof latestEvent?.timestamp === 'number' ? latestEvent.timestamp : null
    } catch (error) {
      console.error('Failed to get cloud max timestamp:', error)
      return null
    }
  }

  /**
   * Sync a batch of events to cloud with pre-fetched cloud max timestamp.
   */
  async syncToCloudBatch(
    apiEvents: ApiEvent[],
    cloudMaxTimestamp: number | null,
    onProgress?: (progress: { current: number, total: number }) => void
  ): Promise<BackupSummary> {
    const user = await this.requireUser()

    try {
      let processed = 0
      let synced = 0

      console.log(`[Firestore] Processing batch of ${apiEvents.length} events...`)

      const newEvents = cloudMaxTimestamp
        ? apiEvents.filter(event => (event.timestamp || 0) > cloudMaxTimestamp)
        : apiEvents

      console.log(`[Firestore] ${newEvents.length} new events in this batch`)

      const PARALLEL_BATCHES = DATABASE_CONSTANTS.FIRESTORE_PARALLEL_BATCHES
      for (let i = 0; i < newEvents.length; i += this.BATCH_SIZE * PARALLEL_BATCHES) {
        const batchPromises = []

        for (let j = 0; j < PARALLEL_BATCHES && i + j * this.BATCH_SIZE < newEvents.length; j++) {
          const startIndex = i + j * this.BATCH_SIZE
          const chunk = newEvents.slice(startIndex, startIndex + this.BATCH_SIZE)
          if (chunk.length === 0) break

          batchPromises.push(this.writeBatch(user.uid, chunk))
          synced += chunk.length
        }

        await Promise.all(batchPromises)
        processed = Math.min(i + this.BATCH_SIZE * PARALLEL_BATCHES, newEvents.length)

        if (onProgress) {
          onProgress({ current: processed, total: newEvents.length })
        }

        if (processed < newEvents.length) {
          await new Promise(resolve => setTimeout(resolve, this.BATCH_DELAY_MS))
        }
      }

      if (synced > 0) {
        const maxTimestamp = Math.max(...newEvents.map(e => e.timestamp || 0))
        await this.updateLastSyncTimestamp(user.uid, maxTimestamp)
      }

      return {
        totalEvents: apiEvents.length,
        syncedEvents: synced,
        lastSyncTime: new Date()
      }
    } catch (error) {
      console.error('Failed to sync batch to cloud:', error)
      throw new Error(`Cloud sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Delete all cloud events and user metadata.
   */
  async deleteAllCloudEvents(): Promise<void> {
    try {
      const user = await this.requireUser()
      console.log('[Firestore] Starting optimized delete...')

      let totalDeleted = 0

      while (true) {
        const docs = await this.queryEventDocuments(user.uid, 'asc', this.DELETE_BATCH_SIZE)
        if (docs.length === 0) break

        await this.batchWrite(docs.map(doc => ({ delete: doc.name })))
        totalDeleted += docs.length

        if (Math.floor(totalDeleted / 10000) > Math.floor((totalDeleted - docs.length) / 10000)) {
          console.log(`[Firestore] Deleted ${totalDeleted} events...`)
        }
      }

      await this.setUserMetadata(user.uid, {
        lastSyncTimestamp: null,
        lastSyncTime: null
      }).catch(error => {
        console.warn('[Firestore] Failed to clear user metadata:', error)
      })

      console.log(`[Firestore] Fast delete completed. Total deleted: ${totalDeleted} events`)
    } catch (error) {
      console.error('Failed to delete cloud events:', error)
      throw new Error(`Failed to delete cloud events: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  private async writeBatch(uid: string, events: ApiEvent[]): Promise<void> {
    const writes = events.map(event => {
      const eventId = `${event.timestamp}_${event.ApiTypeId}`
      return {
        update: {
          name: `${this.documentsPath}/${this.docPath(this.USERS_COLLECTION, uid, this.EVENTS_COLLECTION, eventId)}`,
          fields: encodeFields(event as Record<string, unknown>)
        }
      }
    })

    let retries = 3
    while (retries > 0) {
      try {
        await this.batchWrite(writes)
        return
      } catch (error: any) {
        const message = error instanceof Error ? error.message : ''
        const rateLimited = (error instanceof FirestoreBatchWriteError && error.code === 8) ||
          message.includes('RESOURCE_EXHAUSTED') ||
          message.includes('REST request failed: 429')
        if (rateLimited && retries > 1) {
          console.warn(`[Firestore] Rate limit hit, retrying in ${this.BATCH_DELAY_MS}ms...`)
          await new Promise(resolve => setTimeout(resolve, this.BATCH_DELAY_MS))
          retries--
        } else {
          throw error
        }
      }
    }
  }

  private async updateLastSyncTimestamp(uid: string, timestamp: number): Promise<void> {
    try {
      await this.setUserMetadata(uid, {
        lastSyncTimestamp: timestamp,
        lastSyncTime: new Date().toISOString()
      })
    } catch (error) {
      console.error('Failed to update last sync timestamp:', error)
    }
  }

  private async setUserMetadata(uid: string, metadata: Record<string, unknown>): Promise<void> {
    await this.request(`${this.baseUrl}/${this.docPath(this.USERS_COLLECTION, uid)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: encodeFields(metadata) })
    })
  }

  private async queryEvents(direction: 'asc' | 'desc', maxResults?: number): Promise<ApiEvent[]> {
    const user = await this.requireUser()
    const docs = await this.queryEventDocuments(user.uid, direction, maxResults)
    return docs.map(doc => decodeFields(doc.fields ?? {}) as ApiEvent)
  }

  private async *queryEventDocumentPages(uid: string, initialCursor?: EventQueryCursor): AsyncGenerator<FirestoreDocument[]> {
    let cursor = initialCursor

    while (true) {
      const documents = await this.queryEventDocuments(
        uid,
        'asc',
        this.DOWNLOAD_PAGE_SIZE,
        cursor
      )
      if (documents.length === 0) break

      yield documents
      if (documents.length < this.DOWNLOAD_PAGE_SIZE) break

      const lastDocument = documents.at(-1)!
      const timestamp = lastDocument.fields?.timestamp
      if (!timestamp || !('integerValue' in timestamp)) {
        throw new Error(`Firestore event document lacks an integer timestamp: ${lastDocument.name}`)
      }
      cursor = { timestamp, documentName: lastDocument.name }
    }
  }

  private async queryEventDocuments(
    uid: string,
    direction: 'asc' | 'desc',
    maxResults?: number,
    cursor?: EventQueryCursor
  ): Promise<FirestoreDocument[]> {
    const results = await this.request<RunQueryResult[]>(`${this.baseUrl}/${this.docPath(this.USERS_COLLECTION, uid)}:runQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: this.EVENTS_COLLECTION }],
          orderBy: [
            {
              field: { fieldPath: 'timestamp' },
              direction: direction === 'asc' ? 'ASCENDING' : 'DESCENDING'
            },
            {
              field: { fieldPath: '__name__' },
              direction: direction === 'asc' ? 'ASCENDING' : 'DESCENDING'
            }
          ],
          ...(cursor ? {
            startAt: {
              values: [
                cursor.timestamp,
                { referenceValue: cursor.documentName }
              ],
              before: false
            }
          } : {}),
          ...(maxResults ? { limit: maxResults } : {})
        }
      })
    }) ?? []

    return results.map(result => result.document).filter((doc): doc is FirestoreDocument => !!doc)
  }

  private async countEventDocuments(uid: string, cursor?: EventQueryCursor): Promise<number> {
    const alias = 'eventCount'
    const results = await this.request<RunAggregationQueryResult[]>(
      `${this.baseUrl}/${this.docPath(this.USERS_COLLECTION, uid)}:runAggregationQuery`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          structuredAggregationQuery: {
            structuredQuery: {
              from: [{ collectionId: this.EVENTS_COLLECTION }],
              ...(cursor ? {
                orderBy: [
                  { field: { fieldPath: 'timestamp' }, direction: 'ASCENDING' },
                  { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }
                ],
                startAt: {
                  values: [cursor.timestamp, { referenceValue: cursor.documentName }],
                  before: false
                }
              } : {})
            },
            aggregations: [{ alias, count: {} }]
          }
        })
      }
    ) ?? []

    const count = results[0]?.result?.aggregateFields?.[alias]
    return count && 'integerValue' in count ? Number(count.integerValue) : 0
  }

  private async batchWrite(writes: Array<Record<string, unknown>>): Promise<void> {
    const response = await this.request<BatchWriteResponse>(`${this.baseUrl}:batchWrite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes })
    })

    const statuses = response?.status ?? []
    if (statuses.length !== writes.length) {
      throw new Error(
        `Firestore batchWrite returned ${statuses.length} statuses for ${writes.length} writes`
      )
    }

    const failures = statuses
      .map((status, index) => ({ status, index }))
      .filter(({ status }) => (status.code ?? 0) !== 0)
    if (failures.length > 0) {
      const first = failures[0]!
      const code = first.status.code ?? 2
      const details = failures.slice(0, 3)
        .map(({ status, index }) => `write ${index}: code ${status.code ?? 2} ${status.message ?? 'Unknown error'}`)
        .join('; ')
      throw new FirestoreBatchWriteError(
        code,
        failures.length,
        `Firestore batchWrite failed for ${failures.length}/${writes.length} writes (${details})`
      )
    }
  }

  private async request<T = unknown>(url: string, init: RequestInit): Promise<T | null> {
    const token = await firebaseAuthService.getIdToken()
    const response = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${token}`
      }
    })
    const responseText = await response.text()

    if (!response.ok) {
      throw new Error(`Firestore REST request failed: ${response.status} ${responseText}`)
    }

    if (!responseText.trim()) return null

    try {
      return JSON.parse(responseText) as T
    } catch (error) {
      throw new Error(
        `Firestore REST response was invalid JSON (${responseText.length} bytes): ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  private async requireUser() {
    await firebaseAuthService.ready()
    const user = firebaseAuthService.getCurrentUser()
    if (!user) {
      throw new Error('User not authenticated')
    }
    return user
  }

  private docPath(...segments: string[]): string {
    return segments.map(segment => encodeURIComponent(segment)).join('/')
  }

  private eventCursor(uid: string, timestamp: number, apiTypeId: number): EventQueryCursor {
    const eventId = `${timestamp}_${apiTypeId}`
    return {
      timestamp: { integerValue: String(timestamp) },
      documentName: `${this.documentsPath}/${this.docPath(this.USERS_COLLECTION, uid, this.EVENTS_COLLECTION, eventId)}`
    }
  }
}

function encodeFields(input: Record<string, unknown>): Record<string, FirestoreValue> {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, encodeValue(value)])
  )
}

function encodeValue(value: unknown): FirestoreValue {
  if (value === null) return { nullValue: null }
  if (typeof value === 'boolean') return { booleanValue: value }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value }
  }
  if (typeof value === 'string') return { stringValue: value }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeValue) } }
  }
  if (typeof value === 'object') {
    return { mapValue: { fields: encodeFields(value as Record<string, unknown>) } }
  }
  return { stringValue: String(value) }
}

function decodeFields(fields: Record<string, FirestoreValue>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, decodeValue(value)])
  )
}

function decodeValue(value: FirestoreValue): unknown {
  if ('nullValue' in value) return null
  if ('booleanValue' in value) return value.booleanValue
  if ('integerValue' in value) return Number(value.integerValue)
  if ('doubleValue' in value) return value.doubleValue
  if ('stringValue' in value) return value.stringValue
  if ('referenceValue' in value) return value.referenceValue
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(decodeValue)
  if ('mapValue' in value) return decodeFields(value.mapValue.fields ?? {})
  return null
}

export const firestoreBackupService = new FirestoreBackupService()
