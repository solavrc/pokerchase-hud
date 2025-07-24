/**
 * Auto Sync Service
 * Handles automatic synchronization between local and cloud storage
 */

import { firestoreBackupService } from './firestore-backup-service'
import { firebaseAuthService } from './firebase-auth-service'
import { PokerChaseDB } from '../db/poker-chase-db'
import { EntityConverter } from '../entity-converter'
import { ApiType } from '../types'
import type { ApiEvent } from '../types'

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
            } else if (event.ApiTypeId === ApiType.EVT_ENTRY_QUEUED) {
              const entryEvent = event as ApiEvent<ApiType.EVT_ENTRY_QUEUED>
              service.session.id = entryEvent.Id
              service.session.battleType = entryEvent.BattleType
            } else if (event.ApiTypeId === ApiType.EVT_SESSION_DETAILS) {
              const detailsEvent = event as ApiEvent<ApiType.EVT_SESSION_DETAILS>
              service.session.name = detailsEvent.Name
            } else if (event.ApiTypeId === ApiType.EVT_PLAYER_SEAT_ASSIGNED) {
              const seatEvent = event as ApiEvent<ApiType.EVT_PLAYER_SEAT_ASSIGNED>
              if (seatEvent.TableUsers) {
                seatEvent.TableUsers.forEach(tableUser => {
                  service.session.players.set(tableUser.UserId, {
                    name: tableUser.UserName,
                    rank: tableUser.Rank.RankId
                  })
                })
              }
            } else if (event.ApiTypeId === ApiType.EVT_PLAYER_JOIN) {
              const joinEvent = event as ApiEvent<ApiType.EVT_PLAYER_JOIN>
              if (joinEvent.JoinUser) {
                service.session.players.set(joinEvent.JoinUser.UserId, {
                  name: joinEvent.JoinUser.UserName,
                  rank: joinEvent.JoinUser.Rank.RankId
                })
              }
            }
          }
          
          if (service.session.id) {
            console.log(`[AutoSync] Restored session: ${service.session.id} - ${service.session.name || 'Unknown'}`)
          }
          
          // 最新のEVT_DEALイベントを検索してhero情報を復元
          const latestDealEvent = cloudEvents
            .filter((e: ApiEvent) => e.ApiTypeId === ApiType.EVT_DEAL)
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0]
          
          if (latestDealEvent) {
            console.log('[AutoSync] Restoring service state from latest EVT_DEAL event')
            service.latestEvtDeal = latestDealEvent as ApiEvent<ApiType.EVT_DEAL>
            
            // playerIdを設定
            const dealEvent = latestDealEvent as ApiEvent<ApiType.EVT_DEAL>
            if (dealEvent.Player && dealEvent.Player.SeatIndex >= 0 && dealEvent.SeatUserIds) {
              const playerId = dealEvent.SeatUserIds[dealEvent.Player.SeatIndex]
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

}

// Export singleton instance
export const autoSyncService = new AutoSyncService()