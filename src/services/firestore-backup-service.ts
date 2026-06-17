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

type FirestoreValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } }

interface FirestoreDocument {
  name: string
  fields?: Record<string, FirestoreValue>
}

interface RunQueryResult {
  document?: FirestoreDocument
}

export class FirestoreBackupService {
  private readonly USERS_COLLECTION = 'users'
  private readonly EVENTS_COLLECTION = 'apiEvents'
  private readonly BATCH_SIZE = DATABASE_CONSTANTS.FIRESTORE_BATCH_SIZE
  private readonly BATCH_DELAY_MS = DATABASE_CONSTANTS.FIRESTORE_BATCH_DELAY_MS
  private readonly DELETE_BATCH_SIZE = DATABASE_CONSTANTS.FIRESTORE_DELETE_BATCH
  private readonly baseUrl = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents`

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
      const events = await this.queryEvents('asc')
      return { eventCount: events.length }
    } catch (error) {
      console.error('Failed to get cloud status:', error)
      return { eventCount: 0 }
    }
  }

  /**
   * Sync cloud events to local (cloud as source of truth).
   */
  async syncFromCloud(
    onProgress?: (progress: { current: number, total: number }) => void
  ): Promise<ApiEvent[]> {
    try {
      const newEvents = await this.queryEvents('asc')
      const total = newEvents.length
      console.log(`[Firestore] Found ${total} events in cloud`)

      if (onProgress) {
        for (let processed = 100; processed < total; processed += 100) {
          onProgress({ current: processed, total })
        }
        onProgress({ current: total, total })
      }

      return newEvents
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
          name: `${this.baseUrl}/${this.docPath(this.USERS_COLLECTION, uid, this.EVENTS_COLLECTION, eventId)}`,
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
        if ((error?.message || '').includes('RESOURCE_EXHAUSTED') && retries > 1) {
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

  private async queryEventDocuments(uid: string, direction: 'asc' | 'desc', maxResults?: number): Promise<FirestoreDocument[]> {
    const results = await this.request(`${this.baseUrl}/${this.docPath(this.USERS_COLLECTION, uid)}:runQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: this.EVENTS_COLLECTION }],
          orderBy: [{
            field: { fieldPath: 'timestamp' },
            direction: direction === 'asc' ? 'ASCENDING' : 'DESCENDING'
          }],
          ...(maxResults ? { limit: maxResults } : {})
        }
      })
    }) as RunQueryResult[]

    return results.map(result => result.document).filter((doc): doc is FirestoreDocument => !!doc)
  }

  private async batchWrite(writes: Array<Record<string, unknown>>): Promise<void> {
    await this.request(`${this.baseUrl}:batchWrite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes })
    })
  }

  private async request(url: string, init: RequestInit): Promise<unknown> {
    const token = await firebaseAuthService.getIdToken()
    const response = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${token}`
      }
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Firestore REST request failed: ${response.status} ${errorText}`)
    }

    return await response.json()
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
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(decodeValue)
  if ('mapValue' in value) return decodeFields(value.mapValue.fields ?? {})
  return null
}

export const firestoreBackupService = new FirestoreBackupService()
