/**
 * Auto Sync Service
 * Handles automatic synchronization between local and cloud storage
 */

import { firestoreBackupService } from './firestore-backup-service'
import { firebaseAuthService } from './firebase-auth-service'
import { PokerChaseDB } from '../db/poker-chase-db'
import { EntityConverter } from '../entity-converter'
import { ApiType, isApiEventType } from '../types'
import type { ApiEvent } from '../types'
import { saveEntities } from '../utils/database-utils'
import { DATABASE_CONSTANTS } from '../constants/database'

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'success'
export type SyncDirection = 'upload' | 'download' | 'both'

export interface SyncState {
  status: SyncStatus
  lastSyncTime?: Date
  localLastTimestamp?: number
  cloudLastTimestamp?: number
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

      // Update timestamps
      await this.updateTimestamps()

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
   * Perform sync with optional direction
   * @param direction - Optional sync direction: 'upload', 'download', or 'both' (default)
   */
  async performSync(direction: SyncDirection = 'both'): Promise<void> {
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
      // Perform sync based on direction
      if (direction === 'upload' || direction === 'both') {
        await this.syncToCloud()
      }

      if (direction === 'download' || direction === 'both') {
        await this.syncFromCloud()
      }

      // Update success state
      this.syncState.lastSyncTime = new Date()
      await chrome.storage.local.set({ [this.SYNC_STORAGE_KEY]: this.syncState.lastSyncTime.toISOString() })
      
      // Update timestamps after sync
      await this.updateTimestamps()
      
      this.updateSyncState({ 
        status: 'success',
        lastSyncTime: this.syncState.lastSyncTime,
        error: undefined 
      })

      console.log(`[AutoSync] Sync completed successfully (direction: ${direction})`)
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
    
    // Get the latest timestamp from cloud first
    const cloudMaxTimestamp = await firestoreBackupService.getCloudMaxTimestamp()
    console.log(`[AutoSync] Cloud max timestamp: ${cloudMaxTimestamp || 'none'}`)
    
    // Count events newer than cloud's latest
    const totalCount = cloudMaxTimestamp
      ? await this.db.apiEvents.where('timestamp').above(cloudMaxTimestamp).count()
      : await this.db.apiEvents.count()
    
    if (totalCount === 0) {
      console.log('[AutoSync] No new events to sync')
      return
    }
    
    console.log(`[AutoSync] Found ${totalCount} new events to sync`)
    
    // Process in chunks to avoid memory issues
    const CHUNK_SIZE = DATABASE_CONSTANTS.SYNC_CHUNK_SIZE
    let processed = 0
    let synced = 0
    let lastProcessedTimestamp = cloudMaxTimestamp || 0
    
    while (processed < totalCount) {
      // Get chunk of events newer than lastProcessedTimestamp
      const chunk = await this.db.apiEvents
        .where('timestamp')
        .above(lastProcessedTimestamp)
        .limit(CHUNK_SIZE)
        .toArray()
      
      if (chunk.length === 0) break
      
      // Sort chunk by timestamp to ensure order
      chunk.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
      
      // Sync this chunk
      const summary = await firestoreBackupService.syncToCloudBatch(
        chunk, 
        cloudMaxTimestamp,
        (progress) => {
          this.updateSyncState({
            progress: { 
              current: processed + progress.current, 
              total: totalCount, 
              direction: 'upload' 
            }
          })
        }
      )
      
      synced += summary.syncedEvents
      processed += chunk.length
      
      // Update timestamp for next chunk
      const lastEvent = chunk[chunk.length - 1]
      if (lastEvent && lastEvent.timestamp) {
        lastProcessedTimestamp = lastEvent.timestamp
      }
    }

    console.log(`[AutoSync] Uploaded ${synced} new events to cloud`)
  }

  /**
   * Sync cloud events to local (cloud as source of truth)
   */
  private async syncFromCloud(): Promise<void> {
    console.log('[AutoSync] Starting download from cloud (cloud as source of truth)...')

    // Get all events from cloud
    const cloudEvents = await firestoreBackupService.syncFromCloud((progress) => {
      this.updateSyncState({
        progress: { ...progress, direction: 'download' }
      })
    })

    if (cloudEvents.length > 0) {
      // Use bulkPut to update existing events and add new ones
      await this.db.apiEvents.bulkPut(cloudEvents)
      console.log(`[AutoSync] Downloaded and updated ${cloudEvents.length} events from cloud`)
      
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
        const entities = converter.convertEventsToEntities(cloudEvents)
        
        // Save entities using common utility
        await saveEntities(this.db, entities, {
          onProgress: (counts) => {
            console.log(`[AutoSync] Generated entities - Hands: ${counts.hands}, Phases: ${counts.phases}, Actions: ${counts.actions}`)
          }
        })
        
        // Update metadata separately
        const lastTimestamp = cloudEvents.reduce((max, event) => {
          const timestamp = event.timestamp || 0
          return timestamp > max ? timestamp : max
        }, 0)
        
        await this.db.meta.put({
          id: 'importStatus',
          value: {
            lastProcessedTimestamp: lastTimestamp,
            lastProcessedEventCount: cloudEvents.length,
            lastImportDate: new Date().toISOString()
          },
          updatedAt: Date.now()
        })
        
        console.log('[AutoSync] Data rebuild completed')
        
        // serviceの状態を復元
        const service = (self as any).service
        if (service) {
          // セッション情報を復元（最新のセッションを特定するためEVT_SESSION_RESULTSも含める）
          const sessionEvents = cloudEvents
            .filter((e: ApiEvent) => 
              e.ApiTypeId === ApiType.EVT_ENTRY_QUEUED || 
              e.ApiTypeId === ApiType.EVT_SESSION_DETAILS ||
              e.ApiTypeId === ApiType.EVT_PLAYER_SEAT_ASSIGNED ||
              e.ApiTypeId === ApiType.EVT_PLAYER_JOIN ||
              e.ApiTypeId === ApiType.EVT_SESSION_RESULTS
            )
            .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
          
          // セッション情報をリセット
          if (service.session) {
            service.session.reset()
          }
          
          // セッションイベントを順番に処理
          for (const event of sessionEvents) {
            if (event.ApiTypeId === ApiType.EVT_SESSION_RESULTS) {
              // セッション終了イベント: 次のセッションのためにリセット
              service.session.reset()
            } else if (isApiEventType(event, ApiType.EVT_ENTRY_QUEUED)) {
              service.session.id = event.Id
              service.session.battleType = event.BattleType
            } else if (isApiEventType(event, ApiType.EVT_SESSION_DETAILS)) {
              service.session.name = event.Name
            } else if (isApiEventType(event, ApiType.EVT_PLAYER_SEAT_ASSIGNED)) {
              if (event.TableUsers) {
                event.TableUsers.forEach(tableUser => {
                  service.session.players.set(tableUser.UserId, {
                    name: tableUser.UserName,
                    rank: tableUser.Rank.RankId
                  })
                })
              }
            } else if (isApiEventType(event, ApiType.EVT_PLAYER_JOIN)) {
              if (event.JoinUser) {
                service.session.players.set(event.JoinUser.UserId, {
                  name: event.JoinUser.UserName,
                  rank: event.JoinUser.Rank.RankId
                })
              }
            }
          }
          
          if (service.session.id) {
            console.log(`[AutoSync] Restored session: ${service.session.id} - ${service.session.name || 'Unknown'}`)
          }
          
          // 最新のEVT_DEALイベントを検索してhero情報を復元
          const latestDealEvent = cloudEvents
            .filter((e: ApiEvent) => isApiEventType(e, ApiType.EVT_DEAL))
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0]
          
          if (latestDealEvent && isApiEventType(latestDealEvent, ApiType.EVT_DEAL)) {
            console.log('[AutoSync] Restoring service state from latest EVT_DEAL event')
            service.latestEvtDeal = latestDealEvent
            
            // playerIdを設定
            if (latestDealEvent.Player && latestDealEvent.Player.SeatIndex >= 0 && latestDealEvent.SeatUserIds) {
              const playerId = latestDealEvent.SeatUserIds[latestDealEvent.Player.SeatIndex]
              if (playerId && playerId !== -1) {
                service.playerId = playerId
                console.log(`[AutoSync] Restored playerId: ${playerId}`)
              }
            }
          }
          
          // 統計の再計算をトリガー（latestEvtDealがある場合）
          if (service.latestEvtDeal && service.latestEvtDeal.SeatUserIds) {
            const playerIds = service.latestEvtDeal.SeatUserIds.filter((id: number) => id !== -1)
            if (playerIds.length > 0) {
              console.log('[AutoSync] Triggering stats recalculation...')
              service.statsOutputStream.write(playerIds)
            }
          }
        }
      } catch (error) {
        console.error('[AutoSync] Data rebuild error:', error)
        // エラーが発生しても同期自体は成功とする
      }
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
        console.log(`[AutoSync] Game ended with ${newEventsCount} new events, performing upload sync...`)
        await this.performSync('upload')
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

  /**
   * Update local and cloud last timestamps
   */
  async updateTimestamps(): Promise<void> {
    try {
      // Get local last timestamp
      const localLastEvent = await this.db.apiEvents
        .orderBy('timestamp')
        .reverse()
        .limit(1)
        .first()
      
      if (localLastEvent) {
        this.syncState.localLastTimestamp = localLastEvent.timestamp
      }

      // Get cloud last timestamp if authenticated
      const user = firebaseAuthService.getCurrentUser()
      if (user) {
        const cloudMaxTimestamp = await firestoreBackupService.getCloudMaxTimestamp()
        this.syncState.cloudLastTimestamp = cloudMaxTimestamp || undefined
      }

      // Notify UI of updated state
      this.updateSyncState({
        localLastTimestamp: this.syncState.localLastTimestamp,
        cloudLastTimestamp: this.syncState.cloudLastTimestamp
      })
    } catch (error) {
      console.error('[AutoSync] Error updating timestamps:', error)
    }
  }

  /**
   * Get sync info for display
   */
  async getSyncInfo(): Promise<{
    localLastTimestamp?: number
    cloudLastTimestamp?: number
    uploadPendingCount: number
  }> {
    await this.updateTimestamps()
    
    // Calculate upload pending count based on cloud timestamp
    let uploadPendingCount = 0
    if (this.syncState.cloudLastTimestamp !== undefined) {
      uploadPendingCount = await this.db.apiEvents
        .where('timestamp')
        .above(this.syncState.cloudLastTimestamp)
        .count()
    } else {
      // If no cloud timestamp, all events are pending
      uploadPendingCount = await this.db.apiEvents.count()
    }
    
    return {
      localLastTimestamp: this.syncState.localLastTimestamp,
      cloudLastTimestamp: this.syncState.cloudLastTimestamp,
      uploadPendingCount
    }
  }

}

// Export singleton instance
export const autoSyncService = new AutoSyncService()