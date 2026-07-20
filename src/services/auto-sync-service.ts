/**
 * Auto Sync Service
 * Handles automatic synchronization between local and cloud storage
 */

import { firestoreBackupService } from './firestore-backup-service'
import { firebaseAuthService } from './firebase-auth-service'
import { PokerChaseDB } from '../db/poker-chase-db'
import { EntityConverter } from '../entity-converter'
import { ApiType, isApiEventType, isApplicationApiEvent } from '../types'
import type { ApiEvent } from '../types'
import { processInChunks, saveEntities, filterValidApplicationEvents } from '../utils/database-utils'
import { DATABASE_CONSTANTS } from '../constants/database'
import { isCloudSyncBlockedByMinVersionGate } from './min-version-gate'

/** Shown in the popup and logged when the min-version gate stops cloud sync (#forced-update). */
export const MIN_VERSION_SYNC_BLOCKED_MESSAGE = 'このバージョンはサポートが終了しました。Chromeを再起動すると更新が適用されます'

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

export class AutoSyncService {
  private db: PokerChaseDB
  private syncState: SyncState = { status: 'idle' }
  private _isSyncing = false
  private lastSyncAttempt = 0
  private readonly MIN_SYNC_INTERVAL_MS = 0 // No minimum interval restriction
  private readonly SYNC_STORAGE_KEY = 'autoSyncLastTime'
  private readonly EVENTS_THRESHOLD = 100 // 100イベント溜まったら同期

  constructor(db?: PokerChaseDB) {
    this.db = db ?? new PokerChaseDB(self.indexedDB, self.IDBKeyRange)
  }

  /**
   * `true` while an upload/download sync is in flight. Read-only outside this
   * class -- used by `src/background/update-manager.ts`'s safety predicate
   * (part of the "SAFE to auto-apply an update" check) so the extension never
   * reloads mid-sync.
   */
  get isSyncing(): boolean {
    return this._isSyncing
  }

  /**
   * Initialize auto sync service
   */
  async initialize(): Promise<void> {
    try {
      // Load last sync time from storage
      const stored = await chrome.storage.local.get(this.SYNC_STORAGE_KEY) as Record<string, any>
      if (stored[this.SYNC_STORAGE_KEY]) {
        this.syncState.lastSyncTime = new Date(stored[this.SYNC_STORAGE_KEY] as string | number)
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
    if (this._isSyncing) {
      console.log('[AutoSync] Sync already in progress')
      return
    }

    // Latch BEFORE the awaited gate check below (codex#3612092798): if we set
    // this after awaiting, two performSync() calls arriving close together can
    // both pass the `this._isSyncing` check above, both await the gate, and
    // then both proceed to sync concurrently -- reopening the double-sync
    // race this flag exists to prevent. Reset in `finally` so every return
    // path (gate-blocked or sync completed/failed) releases the latch.
    this._isSyncing = true

    try {
      // Remote min-version gate (kill switch, #forced-update): every sync entry
      // point funnels through performSync(), so a single guard here covers
      // manual sync, auto sync (session end/start triggers), and initialize()'s
      // first-time sync alike. Fail-open by design (see min-version-gate.ts) --
      // this only ever fires when the extension's own version has been
      // explicitly marked unsupported in the remote config.
      if (await isCloudSyncBlockedByMinVersionGate()) {
        console.warn('[AutoSync] Cloud sync blocked: extension version is below the remote minimum-supported version')
        this.updateSyncState({ status: 'error', error: MIN_VERSION_SYNC_BLOCKED_MESSAGE })
        return
      }

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
      }
    } finally {
      this._isSyncing = false
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
      // Get chunk of raw events newer than lastProcessedTimestamp. apiEvents is the
      // raw Lake (see docs/architecture.md) — it may contain non-application noise
      // (202/205 keepalive/timer events) that we deliberately never sync to cloud
      // (cost decision: only application-type events go to Firestore).
      const rawChunk = await this.db.apiEvents
        .where('timestamp')
        .above(lastProcessedTimestamp)
        .limit(CHUNK_SIZE)
        .toArray()

      if (rawChunk.length === 0) break

      // Sort chunk by timestamp to ensure order
      rawChunk.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))

      // Application-type-only filter for cloud upload. Deliberately filtered AFTER
      // sorting/tracking the raw chunk's boundary, not before: lastProcessedTimestamp
      // must advance based on the raw chunk regardless of how many rows in it are
      // noise, otherwise a chunk containing only non-application events would never
      // advance the cursor and the loop would refetch it forever.
      const chunk = rawChunk.filter(isApplicationApiEvent)

      // Sync this chunk (skip the Firestore round-trip entirely if it's all noise)
      if (chunk.length > 0) {
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
      }

      processed += rawChunk.length

      // Update timestamp for next chunk (based on the raw chunk, see comment above)
      const lastRawEvent = rawChunk[rawChunk.length - 1]
      if (lastRawEvent && lastRawEvent.timestamp) {
        lastProcessedTimestamp = lastRawEvent.timestamp
      }
    }

    console.log(`[AutoSync] Uploaded ${synced} new events to cloud`)
  }

  /**
   * Sync cloud events to local (cloud as source of truth)
   */
  private async syncFromCloud(): Promise<void> {
    console.log('[AutoSync] Starting complete download from cloud...')

    let downloadedEvents = 0

    try {
      await firestoreBackupService.syncFromCloud({
        onBatch: async (events) => {
          await this.db.apiEvents.bulkPut(events)
          downloadedEvents += events.length
        },
        onProgress: (progress) => {
          this.updateSyncState({
            progress: { ...progress, direction: 'download' }
          })
        }
      })
    } catch (error) {
      // A previous page may already be durable. Rebuild before surfacing the
      // error so partially downloaded raw events cannot leave entities stale.
      if (downloadedEvents > 0) await this.rebuildLocalEntities()
      throw error
    }

    if (downloadedEvents > 0) {
      console.log(`[AutoSync] Downloaded and updated ${downloadedEvents} events from cloud`)
      await this.rebuildLocalEntities()
    }
  }

  /** Rebuild derived tables without loading the entire event history into memory. */
  private async rebuildLocalEntities(): Promise<void> {
    try {
      console.log('[AutoSync] Triggering chunked data rebuild after download...')

      const defaultSession = {
        id: undefined,
        battleType: undefined,
        name: undefined,
        players: new Map(),
        reset: () => { }
      }
      const converter = new EntityConverter(defaultSession)
      const service = (self as any).service
      const totalEventCount = await this.db.apiEvents.count()
      let lastProcessedTimestamp = 0
      let latestDealEvent: ApiEvent | undefined

      if (service?.session) service.session.reset()

      for await (const events of processInChunks(
        this.db.apiEvents.orderBy('[timestamp+ApiTypeId]'),
        DATABASE_CONSTANTS.SYNC_CHUNK_SIZE
      )) {
        // events is a raw Lake chunk (see docs/architecture.md) — it may contain
        // non-application noise, unknown ApiTypeIds, or app-type payloads that
        // fail the current schema. EntityConverter reads required fields (e.g.
        // EVT_DEAL.Game.SmallBlind) without guards, so only hand it validated
        // application events; isApiEventType()/restoreSessionEvent() below
        // already re-validate internally so they're safe on the raw chunk as-is.
        const validEvents = await filterValidApplicationEvents(events)
        const entities = converter.convertEventChunk(validEvents)
        await this.saveRebuiltEntities(entities)

        for (const event of events) {
          lastProcessedTimestamp = Math.max(lastProcessedTimestamp, event.timestamp || 0)
          this.restoreSessionEvent(service, event)
          if (isApiEventType(event, ApiType.EVT_DEAL)) latestDealEvent = event
        }
      }

      await this.saveRebuiltEntities(converter.flush())
      await this.db.meta.put({
        id: 'importStatus',
        value: {
          lastProcessedTimestamp,
          lastProcessedEventCount: totalEventCount,
          lastImportDate: new Date().toISOString()
        },
        updatedAt: Date.now()
      })

      this.restoreLatestDeal(service, latestDealEvent)
      console.log(`[AutoSync] Chunked data rebuild completed (${totalEventCount} events)`)
    } catch (error) {
      console.error('[AutoSync] Data rebuild error:', error)
      // Preserve the existing behavior: raw event sync remains successful even
      // if rebuilding derived data fails.
    }
  }

  private async saveRebuiltEntities(entities: ReturnType<EntityConverter['flush']>): Promise<void> {
    await saveEntities(this.db, entities, {
      onProgress: (counts) => {
        if (counts.hands + counts.phases + counts.actions > 0) {
          console.log(`[AutoSync] Generated entities - Hands: ${counts.hands}, Phases: ${counts.phases}, Actions: ${counts.actions}`)
        }
      }
    })
  }

  private restoreSessionEvent(service: any, event: ApiEvent): void {
    if (!service?.session) return

    if (event.ApiTypeId === ApiType.EVT_SESSION_RESULTS) {
      service.session.reset()
    } else if (isApiEventType(event, ApiType.EVT_ENTRY_QUEUED)) {
      service.session.setId(event.Id)
      service.session.setBattleType(event.BattleType)
    } else if (isApiEventType(event, ApiType.EVT_SESSION_DETAILS)) {
      service.session.setName(event.Name)
    } else if (isApiEventType(event, ApiType.EVT_PLAYER_SEAT_ASSIGNED)) {
      event.TableUsers?.forEach(tableUser => {
        service.session.setPlayer(tableUser.UserId, {
          name: tableUser.UserName,
          rank: tableUser.Rank.RankId
        })
      })
    } else if (isApiEventType(event, ApiType.EVT_PLAYER_JOIN) && event.JoinUser) {
      service.session.setPlayer(event.JoinUser.UserId, {
        name: event.JoinUser.UserName,
        rank: event.JoinUser.Rank.RankId
      })
    }
  }

  private restoreLatestDeal(service: any, latestDealEvent?: ApiEvent): void {
    if (!service) return

    if (service.session?.id) {
      console.log(`[AutoSync] Restored session: ${service.session.id} - ${service.session.name || 'Unknown'}`)
    }

    if (latestDealEvent && isApiEventType(latestDealEvent, ApiType.EVT_DEAL)) {
      service.latestEvtDeal = latestDealEvent
      const playerSeatIndex = latestDealEvent.Player?.SeatIndex
      if (playerSeatIndex !== undefined && playerSeatIndex >= 0) {
        const playerId = latestDealEvent.SeatUserIds?.[playerSeatIndex]
        if (playerId && playerId !== -1) service.playerId = playerId
      }
    }

    if (service.latestEvtDeal?.SeatUserIds) {
      const playerIds = service.latestEvtDeal.SeatUserIds.filter((id: number) => id !== -1)
      if (playerIds.length > 0) service.statsOutputStream.write(playerIds)
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

  // Note on the raw `.count()`/`.where(...).count()` calls below (onGameSessionEnd,
  // getUnsyncedEventCount, getSyncInfo): apiEvents is the raw Lake and these counts
  // include non-application noise (202/205 keepalive/timer events) that syncToCloud()
  // never actually uploads (see its isApplicationApiEvent filter above). This was
  // already true before the Lake restoration — Dexie's `.count()` doesn't invoke the
  // `reading` hook that used to hide non-application rows, so these thresholds/UI
  // counts have always been raw-row counts, not "events that will actually sync"
  // counts. Left as-is here (not over-engineered into per-call `.and(isApplicationApiEvent)`
  // filters): they're a "is there enough new activity to justify a sync" threshold and a
  // rough "pending" UI number, not billing-accurate counts.

  /**
   * バックログが閾値を超えていればuploadを起動する共通ロジック。
   * `onGameSessionEnd`（309到着時）と`onNewSessionStart`（201/308到着時、
   * postmortem再発防止#3のフォールバックトリガー）の両方から呼ばれる。
   *
   * 二重発火ガード: `this.isSyncing`チェックと、成功した同期が
   * `syncState.lastSyncTime`を進める（＝以降のバックログ件数を減らす）ことの
   * 組み合わせで自然に防がれる。309が正常に動作していれば、その直後に
   * 201/308が来てもバックログは既に閾値未満になっているため再発火しない。
   */
  private async syncIfBacklogExceedsThreshold(trigger: string): Promise<void> {
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
        console.log(`[AutoSync] ${trigger} with ${newEventsCount} new events, performing upload sync...`)
        await this.performSync('upload')
      } else {
        console.log(`[AutoSync] ${trigger} with only ${newEventsCount} new events, skipping sync (threshold: ${this.EVENTS_THRESHOLD})`)
      }
    } catch (error) {
      console.error(`[AutoSync] Error checking event count (${trigger}):`, error)
    }
  }

  /**
   * Handle game session end (EVT_SESSION_RESULTS / 309). Primary auto-sync trigger.
   */
  async onGameSessionEnd(): Promise<void> {
    await this.syncIfBacklogExceedsThreshold('Game ended')
  }

  /**
   * Handle new session start (EVT_ENTRY_QUEUED / 201, EVT_SESSION_DETAILS / 308).
   *
   * postmortem再発防止#3（docs/postmortems/2026-07-session-results-drop.md）:
   * 309単一トリガーはSPOFだった（2026年シーズン3で実際にRP/セッション結果が
   * 半年間喪失した）。新セッション開始はまだ進行中ハンドが存在しない安全な
   * タイミングなので、ここでも同じ閾値判定でuploadを起動し、309が再び壊れても
   * 「最大1セッション遅れ」を保証するフォールバックにする。
   */
  async onNewSessionStart(): Promise<void> {
    await this.syncIfBacklogExceedsThreshold('New session started')
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
