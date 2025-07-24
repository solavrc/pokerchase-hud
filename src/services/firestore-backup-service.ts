/**
 * Firestore Backup Service
 * Handles backup and restore operations using Firestore
 * Works in Service Worker environment (no XMLHttpRequest issues)
 */

import { 
  collection,
  doc,
  getDocs,
  writeBatch,
  query,
  orderBy,
  setDoc,
  limit
} from 'firebase/firestore'
import { firestore } from './firebase-config'
import { firebaseAuthService } from './firebase-auth-service'
import type { ApiEvent } from '../types'
import { DATABASE_CONSTANTS } from '../constants/database'

export interface BackupSummary {
  totalEvents: number
  syncedEvents: number
  lastSyncTime: Date
}

export class FirestoreBackupService {
  private readonly USERS_COLLECTION = 'users'
  private readonly EVENTS_COLLECTION = 'apiEvents'
  private readonly BATCH_SIZE = DATABASE_CONSTANTS.FIRESTORE_BATCH_SIZE
  private readonly BATCH_DELAY_MS = DATABASE_CONSTANTS.FIRESTORE_BATCH_DELAY_MS
  private readonly DELETE_BATCH_SIZE = DATABASE_CONSTANTS.FIRESTORE_DELETE_BATCH

  /**
   * Get current user document reference
   */
  private getUserRef() {
    const user = firebaseAuthService.getCurrentUser()
    if (!user) {
      throw new Error('User not authenticated')
    }
    return doc(firestore, this.USERS_COLLECTION, user.uid)
  }

  /**
   * Sync local events to cloud (upload events newer than cloud's latest timestamp)
   */
  async syncToCloud(
    apiEvents: ApiEvent[], 
    onProgress?: (progress: { current: number, total: number }) => void
  ): Promise<BackupSummary> {
    const user = firebaseAuthService.getCurrentUser()
    if (!user) {
      throw new Error('User not authenticated')
    }

    const userRef = this.getUserRef()
    const eventsCollection = collection(userRef, this.EVENTS_COLLECTION)
    
    try {
      let processed = 0
      let synced = 0

      console.log(`[Firestore] Starting sync of ${apiEvents.length} events...`)

      // Get the latest timestamp from cloud
      const cloudMaxTimestamp = await this.getCloudMaxTimestamp()
      console.log(`[Firestore] Cloud max timestamp: ${cloudMaxTimestamp || 'none'}`)

      // Filter events newer than cloud's latest timestamp
      const newEvents = cloudMaxTimestamp 
        ? apiEvents.filter(event => (event.timestamp || 0) > cloudMaxTimestamp)
        : apiEvents

      console.log(`[Firestore] ${newEvents.length} new events to sync (after timestamp ${cloudMaxTimestamp || 0})`)

      // Process only new events in batches
      const PARALLEL_BATCHES = DATABASE_CONSTANTS.FIRESTORE_PARALLEL_BATCHES
      for (let i = 0; i < newEvents.length; i += this.BATCH_SIZE * PARALLEL_BATCHES) {
        const batchPromises = []
        
        // Create multiple batches to process in parallel
        for (let j = 0; j < PARALLEL_BATCHES && i + j * this.BATCH_SIZE < newEvents.length; j++) {
          const startIndex = i + j * this.BATCH_SIZE
          const chunk = newEvents.slice(startIndex, startIndex + this.BATCH_SIZE)
          if (chunk.length === 0) break

          const batchPromise = this.writeBatch(eventsCollection, chunk)
          batchPromises.push(batchPromise)
          synced += chunk.length
        }

        // Wait for all parallel batches to complete
        await Promise.all(batchPromises)
        
        processed = Math.min(i + this.BATCH_SIZE * PARALLEL_BATCHES, newEvents.length)

        if (onProgress) {
          // Show progress based on total events, not just new ones
          const totalProcessed = apiEvents.length - newEvents.length + processed
          onProgress({ current: totalProcessed, total: apiEvents.length })
        }

        // Only add delay if we have more batches to process
        if (processed < newEvents.length) {
          await new Promise(resolve => setTimeout(resolve, this.BATCH_DELAY_MS))
        }
      }

      // Update last sync timestamp if we synced any events
      if (synced > 0) {
        const maxTimestamp = Math.max(...newEvents.map(e => e.timestamp || 0))
        await this.updateLastSyncTimestamp(maxTimestamp)
      }

      return {
        totalEvents: apiEvents.length,
        syncedEvents: synced,
        lastSyncTime: new Date()
      }
    } catch (error) {
      console.error('Failed to sync to cloud:', error)
      throw new Error(`Cloud sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Write a batch of events with retry logic
   */
  private async writeBatch(eventsCollection: any, events: ApiEvent[]): Promise<void> {
    const batch = writeBatch(firestore)
    
    events.forEach(event => {
      const eventId = `${event.timestamp}_${event.ApiTypeId}`
      const eventDoc = doc(eventsCollection, eventId)
      batch.set(eventDoc, event)
    })

    // Retry logic for rate limit errors
    let retries = 3
    while (retries > 0) {
      try {
        await batch.commit()
        return
      } catch (error: any) {
        if (error?.code === 'resource-exhausted' && retries > 1) {
          console.warn(`[Firestore] Rate limit hit, retrying in ${this.BATCH_DELAY_MS}ms...`)
          await new Promise(resolve => setTimeout(resolve, this.BATCH_DELAY_MS))
          retries--
        } else {
          throw error
        }
      }
    }
  }

  /**
   * Get cloud backup status
   */
  async getCloudStatus(): Promise<{ eventCount: number }> {
    try {
      const userRef = this.getUserRef()
      const eventsCollection = collection(userRef, this.EVENTS_COLLECTION)
      const snapshot = await getDocs(eventsCollection)
      
      return {
        eventCount: snapshot.size
      }
    } catch (error) {
      console.error('Failed to get cloud status:', error)
      return { eventCount: 0 }
    }
  }

  /**
   * Sync cloud events to local (cloud as source of truth)
   */
  async syncFromCloud(
    onProgress?: (progress: { current: number, total: number }) => void
  ): Promise<ApiEvent[]> {
    try {
      const userRef = this.getUserRef()
      const eventsCollection = collection(userRef, this.EVENTS_COLLECTION)
      
      // Get all events from cloud (cloud is the source of truth)
      const q = query(
        eventsCollection,
        orderBy('timestamp', 'asc')
      )
      
      const snapshot = await getDocs(q)
      console.log(`[Firestore] Found ${snapshot.size} events in cloud`)
      
      const newEvents: ApiEvent[] = []
      let processed = 0
      const total = snapshot.size

      snapshot.docs.forEach(doc => {
        const event = doc.data() as ApiEvent
        newEvents.push(event)
        
        processed++
        if (onProgress && processed % 100 === 0) {
          onProgress({ current: processed, total })
        }
      })

      if (onProgress) {
        onProgress({ current: total, total })
      }
      
      return newEvents
    } catch (error) {
      console.error('Failed to sync from cloud:', error)
      throw new Error(`Cloud sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }


  /**
   * Get the latest timestamp from cloud events
   */
  async getCloudMaxTimestamp(): Promise<number | null> {
    try {
      const userRef = this.getUserRef()
      const eventsCollection = collection(userRef, this.EVENTS_COLLECTION)
      
      // Query for the latest event by timestamp
      const q = query(
        eventsCollection,
        orderBy('timestamp', 'desc'),
        limit(1)
      )
      
      const snapshot = await getDocs(q)
      if (!snapshot.empty && snapshot.docs.length > 0) {
        const firstDoc = snapshot.docs[0]
        if (firstDoc) {
          const latestEvent = firstDoc.data() as ApiEvent
          if (latestEvent && typeof latestEvent.timestamp === 'number') {
            return latestEvent.timestamp
          }
        }
      }
      
      return null
    } catch (error) {
      console.error('Failed to get cloud max timestamp:', error)
      return null
    }
  }

  /**
   * Update last sync timestamp in user metadata
   */
  private async updateLastSyncTimestamp(timestamp: number): Promise<void> {
    try {
      await setDoc(this.getUserRef(), {
        lastSyncTimestamp: timestamp,
        lastSyncTime: new Date().toISOString()
      }, { merge: true })
    } catch (error) {
      console.error('Failed to update last sync timestamp:', error)
    }
  }

  /**
   * Sync a batch of events to cloud with pre-fetched cloud max timestamp
   */
  async syncToCloudBatch(
    apiEvents: ApiEvent[],
    cloudMaxTimestamp: number | null,
    onProgress?: (progress: { current: number, total: number }) => void
  ): Promise<BackupSummary> {
    const user = firebaseAuthService.getCurrentUser()
    if (!user) {
      throw new Error('User not authenticated')
    }

    const userRef = this.getUserRef()
    const eventsCollection = collection(userRef, this.EVENTS_COLLECTION)
    
    try {
      let processed = 0
      let synced = 0

      console.log(`[Firestore] Processing batch of ${apiEvents.length} events...`)

      // Filter events newer than cloud's latest timestamp
      const newEvents = cloudMaxTimestamp 
        ? apiEvents.filter(event => (event.timestamp || 0) > cloudMaxTimestamp)
        : apiEvents

      console.log(`[Firestore] ${newEvents.length} new events in this batch`)

      // Process new events in batches
      const PARALLEL_BATCHES = DATABASE_CONSTANTS.FIRESTORE_PARALLEL_BATCHES
      for (let i = 0; i < newEvents.length; i += this.BATCH_SIZE * PARALLEL_BATCHES) {
        const batchPromises = []
        
        for (let j = 0; j < PARALLEL_BATCHES && i + j * this.BATCH_SIZE < newEvents.length; j++) {
          const startIndex = i + j * this.BATCH_SIZE
          const chunk = newEvents.slice(startIndex, startIndex + this.BATCH_SIZE)
          if (chunk.length === 0) break

          const batchPromise = this.writeBatch(eventsCollection, chunk)
          batchPromises.push(batchPromise)
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

      // Update last sync timestamp if we synced any events
      if (synced > 0) {
        const maxTimestamp = Math.max(...newEvents.map(e => e.timestamp || 0))
        await this.updateLastSyncTimestamp(maxTimestamp)
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
   * Delete all cloud events and user metadata
   */
  async deleteAllCloudEvents(): Promise<void> {
    try {
      const userRef = this.getUserRef()
      const eventsCollection = collection(userRef, this.EVENTS_COLLECTION)
      
      console.log('[Firestore] Starting optimized delete...')
      
      // Delete events in chunks - simple and efficient
      let totalDeleted = 0
      
      while (true) {
        // Get next chunk
        const q = query(eventsCollection, limit(this.DELETE_BATCH_SIZE))
        const snapshot = await getDocs(q)
        
        if (snapshot.empty) break
        
        // Create and commit batch immediately
        const batch = writeBatch(firestore)
        snapshot.docs.forEach(doc => batch.delete(doc.ref))
        await batch.commit()
        
        totalDeleted += snapshot.size
        
        // Log progress every 10,000 documents
        if (Math.floor(totalDeleted / 10000) > Math.floor((totalDeleted - snapshot.size) / 10000)) {
          console.log(`[Firestore] Deleted ${totalDeleted} events...`)
        }
      }
      
      // Clear user metadata
      try {
        await setDoc(userRef, {
          lastSyncTimestamp: null,
          lastSyncTime: null
        }, { merge: true })
      } catch (error) {
        console.warn('[Firestore] Failed to clear user metadata:', error)
      }
      
      console.log(`[Firestore] Fast delete completed. Total deleted: ${totalDeleted} events`)
    } catch (error) {
      console.error('Failed to delete cloud events:', error)
      throw new Error(`Failed to delete cloud events: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

}

// Export singleton instance
export const firestoreBackupService = new FirestoreBackupService()