import { content_scripts } from '../../manifest.json'
import { PokerChaseDB } from '../db/poker-chase-db'
import { AggregateEventsStream } from '../streams/aggregate-events-stream'
import { WriteEntityStream } from '../streams/write-entity-stream'
import { ReadEntityStream } from '../streams/read-entity-stream'
import { HandLogStream } from '../streams/hand-log-stream'
import { RealTimeStatsStream } from '../streams/realtime-stats-stream'
import { setHandImprovementBatchMode } from '../realtime-stats'
import {
  ApiType,
  BATTLE_TYPE_FILTERS,
  isApiEventType
} from '../types'
import type {
  ApiEvent,
  FilterOptions,
  HandLogConfig,
  Session,
  StatDisplayConfig
} from '../types'

/**
 * PokerChase HUDのメインサービスクラス
 *
 * Chrome拡張機能の中核となるサービスで、以下の機能を統合管理する：
 * - 3段階のStreamパイプライン（AggregateEvents → WriteEntity → ReadEntity）
 * - プレイヤーセッション管理（プレイヤー名、ランク、セッション情報）
 * - フィルタリング設定（バトルタイプ、ハンド数制限、統計表示設定）
 * - データベース操作（初期化、リフレッシュ、エクスポート）
 * - PokerStars形式でのハンドヒストリーエクスポート
 * - イベントログ出力とデバッグ支援
 *
 * background.js、content_script.js、Popup.tsxから利用される。
 */
class PokerChaseService {
  private _playerId?: number
  private _latestEvtDeal?: ApiEvent<ApiType.EVT_DEAL>
  private _sessionData: Session
  private _isInitialized: boolean = false
  private _initializationError?: Error
  private _persistStateTimer?: ReturnType<typeof setTimeout>

  // Initialization promise
  public readonly ready: Promise<void>

  // 永続化不要なプロパティ
  battleTypeFilter?: number[] = undefined // undefined = all, array = specific battleTypes
  handLimitFilter?: number = undefined // undefined = all hands, number = limit to recent N hands
  statDisplayConfigs?: StatDisplayConfig[] = undefined // Custom stat display configuration
  handLogConfig?: HandLogConfig = undefined // Hand log display configuration
  batchMode: boolean = false // Batch mode flag for bulk operations

  static readonly POKER_CHASE_SERVICE_EVENT = 'PokerChaseServiceEvent'
  static readonly POKER_CHASE_ORIGIN = new URL(content_scripts[0]!.matches[0]!).origin
  static readonly STORAGE_KEY = 'pokerChaseServiceState'

  // Getter/Setter for automatic persistence
  get playerId(): number | undefined {
    return this._playerId
  }

  set playerId(value: number | undefined) {
    this._playerId = value
    this.persistState()
  }

  get latestEvtDeal(): ApiEvent<ApiType.EVT_DEAL> | undefined {
    return this._latestEvtDeal
  }

  set latestEvtDeal(value: ApiEvent<ApiType.EVT_DEAL> | undefined) {
    this._latestEvtDeal = value
    this.persistState()
  }
  get session(): Session {
    return this._sessionData
  }

  // Check if service is ready
  get isReady(): boolean {
    return this._isInitialized && !this._initializationError
  }

  private initializeSession(): Session {
    const self = this
    const session = {
      _id: undefined as number | undefined,
      _battleType: undefined as number | undefined,
      _name: undefined as string | undefined,
      players: new Map<number, { name: string, rank: string }>(),

      get id() { return this._id },
      set id(value: number | undefined) {
        this._id = value
        self.persistState()
      },

      get battleType() { return this._battleType },
      set battleType(value: number | undefined) {
        this._battleType = value
        self.persistState()
      },

      get name() { return this._name },
      set name(value: string | undefined) {
        this._name = value
        self.persistState()
      },

      reset: function () {
        this.id = undefined
        this.battleType = undefined
        this.name = undefined
        this.players.clear()
        self.persistState()
      }
    }

    // プレイヤー追加時も永続化
    const originalSet = session.players.set.bind(session.players)
    session.players.set = function (key: number, value: { name: string, rank: string }) {
      const result = originalSet(key, value)
      self.persistState()
      return result
    }

    return session as Session
  }

  /** Reset session and clear player data */
  readonly resetSession = () => {
    this.session.reset()
  }

  /** Persist current state to Chrome Storage with debouncing */
  private persistState = () => {
    if (!this._isInitialized || typeof chrome === 'undefined' || !chrome.storage) {
      return
    }

    // Clear existing timer
    if (this._persistStateTimer) {
      clearTimeout(this._persistStateTimer)
    }

    // Debounce persistence to avoid frequent writes
    this._persistStateTimer = setTimeout(() => {
      this.actualPersistState()
    }, 500) // 500ms debounce
  }

  /** Actual persistence logic */
  private actualPersistState = () => {
    // Convert Map to array for serialization
    const playersArray = Array.from(this._sessionData.players.entries())

    const state = {
      playerId: this._playerId,
      latestEvtDeal: this._latestEvtDeal,
      session: {
        id: this._sessionData.id,
        battleType: this._sessionData.battleType,
        name: this._sessionData.name,
        players: playersArray
      },
      lastUpdated: Date.now()
    }

    chrome.storage.local.set({ [PokerChaseService.STORAGE_KEY]: state })
      .catch(err => {
        if (err.message?.includes('QUOTA_BYTES')) {
          console.error('[PokerChaseService] Storage quota exceeded, attempting cleanup')
          // Try to clear some old data
          this.cleanupOldStorageData()
        } else {
          console.error('[PokerChaseService] Failed to persist state:', err)
        }
      })
  }

  /** Clean up old storage data when quota is exceeded */
  private cleanupOldStorageData = async () => {
    try {
      // Clear old extension-specific data
      const allItems = await chrome.storage.local.get(null)
      const keysToRemove: string[] = []

      // Remove old version keys or temporary data
      for (const key in allItems) {
        if (key.startsWith('temp_') || key.startsWith('old_')) {
          keysToRemove.push(key)
        }
      }

      if (keysToRemove.length > 0) {
        await chrome.storage.local.remove(keysToRemove)
        console.log(`[PokerChaseService] Cleaned up ${keysToRemove.length} old storage keys`)
        // Retry persistence
        this.actualPersistState()
      }
    } catch (error) {
      console.error('[PokerChaseService] Failed to cleanup storage:', error)
    }
  }

  /** Restore state from Chrome Storage */
  public async restoreState(): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.storage) {
      this._isInitialized = true // No Chrome storage available, but service is ready
      return
    }

    try {
      const result = await chrome.storage.local.get(PokerChaseService.STORAGE_KEY)
      const state = result[PokerChaseService.STORAGE_KEY]

      if (state) {
        // Don't use setters during restoration to avoid triggering persistence
        this._playerId = state.playerId
        this._latestEvtDeal = state.latestEvtDeal

        if (state.session) {
          // Direct assignment to avoid setter side effects during restoration
          const sessionData = this._sessionData as any // Type assertion for private properties
          sessionData._id = state.session.id
          sessionData._battleType = state.session.battleType
          sessionData._name = state.session.name

          // Restore players Map from array
          if (state.session.players && Array.isArray(state.session.players)) {
            this._sessionData.players.clear()
            state.session.players.forEach(([key, value]: [number, { name: string, rank: string }]) => {
              // Use original Map.set to avoid persistence trigger
              Map.prototype.set.call(this._sessionData.players, key, value)
            })
          }
        }

        console.log('[PokerChaseService] State restored successfully:', {
          playerId: this._playerId,
          sessionId: this._sessionData.id,
          playerCount: this._sessionData.players.size,
          lastUpdated: state.lastUpdated ? new Date(state.lastUpdated).toISOString() : 'unknown'
        })
      }

      // Mark as successfully initialized
      this._isInitialized = true
      this._initializationError = undefined
    } catch (error) {
      console.error('[PokerChaseService] Failed to restore state:', error)
      // Store the initialization error
      this._initializationError = error instanceof Error ? error : new Error(String(error))
      // Still mark as initialized to prevent hanging
      this._isInitialized = true
    }
  }
  readonly db
  readonly handAggregateStream: AggregateEventsStream      // Entry point for all events and groups events by hand
  readonly statsOutputStream: ReadEntityStream             // Calculates and outputs stats
  readonly handLogStream: HandLogStream                    // Real-time hand log display
  readonly realTimeStatsStream: RealTimeStatsStream        // Real-time stats for hero only
  constructor({ db, playerId }: { db: PokerChaseDB, playerId?: number }) {
    this._playerId = playerId
    this._sessionData = this.initializeSession()
    this.db = db

    // Initialize the ready promise
    this.ready = this.restoreState()

    // Create streams
    this.handAggregateStream = new AggregateEventsStream(this)
    this.statsOutputStream = new ReadEntityStream(this)
    this.handLogStream = new HandLogStream(this)
    this.realTimeStatsStream = new RealTimeStatsStream()

    // Main pipeline for stats calculation
    const writeStream = new WriteEntityStream(this)
    this.handAggregateStream
      .pipe<WriteEntityStream>(writeStream)
      .pipe<ReadEntityStream>(this.statsOutputStream)
  }
  readonly setBattleTypeFilter = async (filterOptions: FilterOptions) => {
    const selectedTypes: number[] = []

    if (filterOptions.gameTypes.sng) {
      selectedTypes.push(...BATTLE_TYPE_FILTERS.SNG)
    }
    if (filterOptions.gameTypes.mtt) {
      selectedTypes.push(...BATTLE_TYPE_FILTERS.MTT)
    }
    if (filterOptions.gameTypes.ring) {
      selectedTypes.push(...BATTLE_TYPE_FILTERS.RING)
    }

    // Remove duplicates and set filter
    this.battleTypeFilter = selectedTypes.length > 0
      ? [...new Set(selectedTypes)]
      : undefined // If nothing selected, show all game types

    // Set hand limit filter
    this.handLimitFilter = filterOptions.handLimit

    // Set stat display configuration
    this.statDisplayConfigs = filterOptions.statDisplayConfigs

    // Trigger recalculation using the dedicated method
    await this.statsOutputStream.recalculateStats()
  }

  /**
   * バッチモードの設定
   * インポート時などの大量処理でリアルタイム更新を無効化
   */
  readonly setBatchMode = (enabled: boolean) => {
    this.batchMode = enabled

    // Set batch mode for hand improvement calculations
    setHandImprovementBatchMode(enabled)

    if (!enabled) {
      // バッチモード終了時に統計を一度だけ再計算
      this.recalculateAllStats()
    }
  }

  /**
   * 全統計の再計算（バッチモード終了時に使用）
   */
  private readonly recalculateAllStats = async () => {
    // 最新のplayerIdsを取得して再計算をトリガー
    if (this.latestEvtDeal && this.latestEvtDeal.SeatUserIds) {
      const playerIds = this.latestEvtDeal.SeatUserIds.filter(id => id !== -1)
      if (playerIds.length > 0) {
        this.statsOutputStream.write(playerIds)
      }
    } else {
      // latestEvtDealが無い場合は、最新のEVT_DEALをDBから取得
      // Note: Dexie doesn't support filter() with first(), so we need a workaround
      const SEARCH_LIMIT = 10 // Check last 10 EVT_DEAL events
      let latestDealEvent: ApiEvent<ApiType.EVT_DEAL> | undefined
      
      // Get recent EVT_DEAL events in small batches
      let offset = 0
      while (!latestDealEvent && offset < 100) { // Safety limit
        const events = await this.db.apiEvents
          .where('ApiTypeId').equals(ApiType.EVT_DEAL)
          .reverse()
          .offset(offset)
          .limit(SEARCH_LIMIT)
          .toArray()
        
        if (events.length === 0) break
        
        // Find first event with Player.SeatIndex
        latestDealEvent = events.find(event => 
          isApiEventType(event, ApiType.EVT_DEAL) && event.Player?.SeatIndex !== undefined
        ) as ApiEvent<ApiType.EVT_DEAL> | undefined
        
        offset += SEARCH_LIMIT
      }

      if (latestDealEvent && latestDealEvent.SeatUserIds) {
        this.latestEvtDeal = latestDealEvent

        // プレイヤーIDも更新
        if (latestDealEvent.Player?.SeatIndex !== undefined) {
          this.playerId = latestDealEvent.SeatUserIds[latestDealEvent.Player.SeatIndex]
        }

        const playerIds = latestDealEvent.SeatUserIds.filter(id => id !== -1)
        if (playerIds.length > 0) {
          this.statsOutputStream.write(playerIds)
        }
      }
    }
  }

  readonly exportHandHistory = async (handIds?: number[]): Promise<string> => {
    const { HandLogExporter } = await import('../utils/hand-log-exporter')

    if (!handIds) {
      // Export all hands from the current session or recent hands
      const sessionId = this.session.id
      return HandLogExporter.exportRecentHands(this.db, sessionId, 100)
    }

    if (handIds.length === 0) {
      console.warn('No hands found to export')
      return ''
    }

    return HandLogExporter.exportMultipleHands(this.db, handIds)
  }
  eventLogger = (event: any, level: 'debug' | 'info' | 'warn' | 'error' = 'info') => {
    const timestamp = event.timestamp
      ? new Date(event.timestamp).toISOString().slice(11, 22)
      : new Date().toISOString().slice(11, 22)
    const eventName = ApiType[event.ApiTypeId as number] ?? null
    const logMessage = `[${timestamp}] ${event.ApiTypeId} ${eventName} ${JSON.stringify(event)}`

    switch (level) {
      case 'debug':
        console.debug(logMessage)
        break
      case 'info':
        console.info(logMessage)
        break
      case 'warn':
        console.warn(logMessage)
        break
      case 'error':
        console.error(logMessage)
        break
    }
  }
}

export default PokerChaseService
