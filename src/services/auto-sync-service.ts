/**
 * Auto Sync Service
 * Handles automatic synchronization between local and cloud storage
 */

import { firestoreBackupService } from './firestore-backup-service'
import { firebaseAuthService } from './firebase-auth-service'
import { PokerChaseDB } from '../db/poker-chase-db'
import { EntityConverter } from '../entity-converter'

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'success'
export type SyncDirection = 'upload' | 'download' | 'both'

export interface SyncState {
  status: SyncStatus
  lastSyncTime?: Date
  error?: string
  progress?: {
    current: number
    total: number
    direction: SyncDirection
  }
}

class AutoSyncService {
  private db: PokerChaseDB
  private syncState: SyncState = { status: 'idle' }
  private isSyncing = false
  private lastSyncAttempt = 0
  private readonly MIN_SYNC_INTERVAL_MS = 0 // No minimum interval restriction
  private readonly SYNC_STORAGE_KEY = 'autoSyncLastTime'
  private readonly EVENTS_THRESHOLD = 100 // 100イベント溜まったら同期

  constructor() {
    this.db = new PokerChaseDB(self.indexedDB, self.IDBKeyRange)
  }

  /**
   * Initialize auto sync service
   */
  async initialize(): Promise<void> {
    try {
      // Load last sync time from storage
      const stored = await chrome.storage.local.get(this.SYNC_STORAGE_KEY)
      if (stored[this.SYNC_STORAGE_KEY]) {
        this.syncState.lastSyncTime = new Date(stored[this.SYNC_STORAGE_KEY])
      }

      // Check if user is authenticated
      const user = firebaseAuthService.getCurrentUser()
      if (!user) {
        console.log('[AutoSync] User not authenticated, skipping initialization')
        return
      }

      // Perform initial sync only if never synced before
      if (!this.syncState.lastSyncTime) {
        console.log('[AutoSync] First time sync, performing initial sync...')
        await this.performSync()
      } else {
        console.log('[AutoSync] Last sync was at:', this.syncState.lastSyncTime)
      }
    } catch (error) {
      console.error('[AutoSync] Initialization error:', error)
    }
  }


  /**
   * Perform bidirectional sync
   */
  async performSync(): Promise<void> {
    // Check minimum interval (currently disabled)
    const now = Date.now()
    if (this.MIN_SYNC_INTERVAL_MS > 0 && now - this.lastSyncAttempt < this.MIN_SYNC_INTERVAL_MS) {
      console.log('[AutoSync] Skipping sync - too soon since last attempt')
      return
    }

    // Check if already syncing
    if (this.isSyncing) {
      console.log('[AutoSync] Sync already in progress')
      return
    }

    this.isSyncing = true
    this.lastSyncAttempt = now
    this.updateSyncState({ status: 'syncing' })

    try {
      // First, sync local changes to cloud
      await this.syncToCloud()

      // Then, sync cloud changes to local
      await this.syncFromCloud()

      // Update success state
      this.syncState.lastSyncTime = new Date()
      await chrome.storage.local.set({ [this.SYNC_STORAGE_KEY]: this.syncState.lastSyncTime.toISOString() })
      
      this.updateSyncState({ 
        status: 'success',
        lastSyncTime: this.syncState.lastSyncTime,
        error: undefined 
      })

      console.log('[AutoSync] Sync completed successfully')
    } catch (error) {
      console.error('[AutoSync] Sync error:', error)
      this.updateSyncState({ 
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error'
      })
    } finally {
      this.isSyncing = false
    }
  }

  /**
   * Sync local events to cloud
   */
  private async syncToCloud(): Promise<void> {
    console.log('[AutoSync] Starting upload to cloud...')
    
    const apiEvents = await this.db.apiEvents.toArray()
    if (apiEvents.length === 0) return

    const summary = await firestoreBackupService.syncToCloud(apiEvents, (progress) => {
      this.updateSyncState({
        progress: { ...progress, direction: 'upload' }
      })
    })

    console.log(`[AutoSync] Uploaded ${summary.syncedEvents} new events to cloud`)
  }

  /**
   * Sync cloud events to local
   */
  private async syncFromCloud(): Promise<void> {
    console.log('[AutoSync] Starting download from cloud...')
    
    // Get local max timestamp
    const localMaxTimestamp = await this.getLocalMaxTimestamp()
    console.log(`[AutoSync] Local max timestamp: ${localMaxTimestamp}`)

    // Get new events from cloud
    const newEvents = await firestoreBackupService.syncFromCloud(localMaxTimestamp, (progress) => {
      this.updateSyncState({
        progress: { ...progress, direction: 'download' }
      })
    })

    if (newEvents.length > 0) {
      await this.db.apiEvents.bulkAdd(newEvents)
      console.log(`[AutoSync] Downloaded ${newEvents.length} new events from cloud`)
      
      // データ再構築をトリガー
      try {
        console.log('[AutoSync] Triggering data rebuild after download...')
        
        // EntityConverterを使用してエンティティを生成
        // セッション情報はイベントから自動的に抽出される
        const defaultSession = { 
          id: undefined, 
          battleType: undefined, 
          name: undefined, 
          players: new Map(), 
          reset: () => {} 
        }
        const converter = new EntityConverter(defaultSession)
        const entities = converter.convertEventsToEntities(newEvents)
        
        console.log(`[AutoSync] Generated entities - Hands: ${entities.hands.length}, Phases: ${entities.phases.length}, Actions: ${entities.actions.length}`)
        
        // トランザクション内で一括保存
        await this.db.transaction('rw', [this.db.hands, this.db.phases, this.db.actions, this.db.meta], async () => {
          if (entities.hands.length > 0) {
            await this.db.hands.bulkPut(entities.hands)
          }
          if (entities.phases.length > 0) {
            await this.db.phases.bulkPut(entities.phases)
          }
          if (entities.actions.length > 0) {
            await this.db.actions.bulkPut(entities.actions)
          }
          
          // メタデータを更新
          const lastTimestamp = newEvents.reduce((max, event) => {
            const timestamp = event.timestamp || 0
            return timestamp > max ? timestamp : max
          }, 0)
          
          await this.db.meta.put({
            id: 'lastProcessed',
            lastProcessedTimestamp: lastTimestamp,
            lastProcessedEventCount: newEvents.length,
            lastImportDate: new Date()
          })
        })
        
        console.log('[AutoSync] Data rebuild completed')
        
        // 統計の再計算をトリガー（現在のゲームがある場合）
        const service = (self as any).service
        if (service && service.latestEvtDeal && service.latestEvtDeal.SeatUserIds) {
          const playerIds = service.latestEvtDeal.SeatUserIds.filter((id: number) => id !== -1)
          if (playerIds.length > 0) {
            console.log('[AutoSync] Triggering stats recalculation...')
            service.statsOutputStream.write(playerIds)
          }
        }
      } catch (error) {
        console.error('[AutoSync] Data rebuild error:', error)
        // エラーが発生しても同期自体は成功とする
      }
    }
  }

  /**
   * Get maximum timestamp from local database
   */
  private async getLocalMaxTimestamp(): Promise<number> {
    try {
      const latestEvent = await this.db.apiEvents
        .orderBy('timestamp')
        .reverse()
        .first()
      return latestEvent?.timestamp || 0
    } catch (error) {
      console.error('[AutoSync] Error getting local max timestamp:', error)
      return 0
    }
  }

  /**
   * Update sync state and notify
   */
  private updateSyncState(updates: Partial<SyncState>): void {
    this.syncState = { ...this.syncState, ...updates }
    
    // Send state update to popup if it's open
    chrome.runtime.sendMessage({
      type: 'SYNC_STATE_UPDATE',
      state: this.syncState
    }).catch(() => {
      // Popup might not be open, ignore error
    })
  }

  /**
   * Get current sync state
   */
  getSyncState(): SyncState {
    return { ...this.syncState }
  }

  /**
   * Handle authentication state changes
   */
  async onAuthStateChanged(user: any): Promise<void> {
    if (user) {
      // User logged in, start sync
      await this.initialize()
    } else {
      // User logged out, reset sync state
      this.updateSyncState({ status: 'idle', lastSyncTime: undefined })
    }
  }

  /**
   * Handle game session events
   */
  async onGameSessionEnd(): Promise<void> {
    // Only sync if there are enough new events to justify the cost
    const user = firebaseAuthService.getCurrentUser()
    if (!user || this.isSyncing) return

    try {
      // Check how many events we have since last sync
      const lastSyncTime = this.syncState.lastSyncTime?.getTime() || 0
      const newEventsCount = await this.db.apiEvents
        .where('timestamp')
        .above(lastSyncTime)
        .count()

      if (newEventsCount >= this.EVENTS_THRESHOLD) {
        console.log(`[AutoSync] Game ended with ${newEventsCount} new events, performing sync...`)
        await this.performSync()
      } else {
        console.log(`[AutoSync] Game ended with only ${newEventsCount} new events, skipping sync (threshold: ${this.EVENTS_THRESHOLD})`)
      }
    } catch (error) {
      console.error('[AutoSync] Error checking event count:', error)
    }
  }

  /**
   * Get unsync event count (for UI display)
   */
  async getUnsyncedEventCount(): Promise<number> {
    try {
      const lastSyncTime = this.syncState.lastSyncTime?.getTime() || 0
      return await this.db.apiEvents
        .where('timestamp')
        .above(lastSyncTime)
        .count()
    } catch (error) {
      console.error('[AutoSync] Error getting unsynced count:', error)
      return 0
    }
  }

}

// Export singleton instance
export const autoSyncService = new AutoSyncService()