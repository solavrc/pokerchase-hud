import { PokerChaseDB } from '../db/poker-chase-db'
import { findLatestPlayerDealEvent } from '../utils/database-utils'
import { AggregateEventsStream } from '../streams/aggregate-events-stream'
import { WriteEntityStream } from '../streams/write-entity-stream'
import { ReadEntityStream } from '../streams/read-entity-stream'
import { HandLogStream } from '../streams/hand-log-stream'
import { RealTimeStatsStream } from '../streams/realtime-stats-stream'
import { setHandImprovementBatchMode } from '../realtime-stats'
import { defaultStatDisplayConfigs, mergeStatDisplayConfigs } from '../stats'
import {
  POKER_CHASE_SERVICE_EVENT,
  POKER_CHASE_ORIGIN,
  STORAGE_KEY
} from '../constants/runtime'
import {
  ApiType,
  BATTLE_TYPE_FILTERS
} from '../types'
import { DEFAULT_TABLE_SIZE_FILTER, selectedTableSizeLayers, type TableSizeLayer } from '../utils/table-size'
import type {
  ApiEvent,
  BattleType,
  FilterOptions,
  HandLogConfig,
  Session,
  StatDisplayConfig
} from '../types'

/** Serialized shape of a single session's player-info entry (persisted as an array tuple). */
type SessionPlayerInfo = { name: string, rank: string }

/**
 * セッション状態を保持するクラス
 *
 * PokerChaseServiceが管理する「現在のセッション」を表す。全てのミューテーション
 * （id/battleType/name/players/reset）は明示的なメソッドを経由し、それぞれが
 * コンストラクタで渡された `notifyChange` を呼び出す一本道になっている。
 * これにより「フィールドを追加したら誰かがpersistState()の呼び出しを
 * 書き忘れる」という構造的な穴を型レベルで塞ぐ（`players`はReadonlyMapとして
 * 公開され、`.set()`は型エラーになる）。
 *
 * リストア時は `hydrate()` を使う。これは同じフィールドを更新するが
 * `notifyChange` を呼ばない（「復元してもストレージに書き戻さない」という
 * 復元専用の経路）。
 */
export class SessionState implements Session {
  private _id?: string
  private _battleType?: BattleType
  private _name?: string
  private readonly _players = new Map<number, SessionPlayerInfo>()

  constructor(private readonly notifyChange: () => void) { }

  get id(): string | undefined { return this._id }
  get battleType(): BattleType | undefined { return this._battleType }
  get name(): string | undefined { return this._name }
  /** 読み取り専用ビュー。ミューテーションは setPlayer()/reset() 経由のみ許可される */
  get players(): ReadonlyMap<number, SessionPlayerInfo> { return this._players }

  setId(value: string | undefined): void {
    this._id = value
    this.notifyChange()
  }

  setBattleType(value: BattleType | undefined): void {
    this._battleType = value
    this.notifyChange()
  }

  setName(value: string | undefined): void {
    this._name = value
    this.notifyChange()
  }

  setPlayer(userId: number, info: SessionPlayerInfo): void {
    this._players.set(userId, info)
    this.notifyChange()
  }

  reset(): void {
    this._id = undefined
    this._battleType = undefined
    this._name = undefined
    this._players.clear()
    this.notifyChange()
  }

  /**
   * ストレージから復元した値を、永続化をトリガーせずに適用する。
   * restoreState() 専用。
   */
  hydrate(data: { id?: string, battleType?: BattleType, name?: string, players?: [number, SessionPlayerInfo][] }): void {
    this._id = data.id
    this._battleType = data.battleType
    this._name = data.name
    this._players.clear()
    if (data.players && Array.isArray(data.players)) {
      for (const [key, value] of data.players) {
        this._players.set(key, value)
      }
    }
  }

  /** シリアライズ用（永続化状態の構築に使用） */
  toJSON() {
    return {
      id: this._id,
      battleType: this._battleType,
      name: this._name,
      players: Array.from(this._players.entries())
    }
  }
}

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
  // ライブ配信専用の「今まさに配信中の席」文脈。Player有無に関わらず毎EVT_DEALで
  // 更新される（aggregate-events-stream.ts参照）が、意図的に永続化しない
  // （persistState()を呼ばない・actualPersistState()のstateに含めない）。
  //
  // なぜ latestEvtDeal と分離しているか（codex #177 再レビューP2）: latestEvtDeal
  // は「ヒーロー在籍」時点のSeatUserIdsという意味論を持ち、recalculateStats()/
  // recalculateAllStats()（フィルター変更・バッチモード終了時の再計算）がこれを
  // 使ってヒーロー基準の統計を再構築する。観戦モードdeal（Playerフィールド欠落）
  // でこれを更新してしまうと、ヒーロー敗退後に観戦しながらフィルターを変更した
  // 際、生きているはずのヒーローplayerIdに対して観戦テーブルの（履歴のない）
  // 顔ぶれで統計が上書きされてしまう。一方 ports.ts のライブブロードキャスト
  // （registerStreamSubscriptions）は座席回転のためだけに「今何が配信されて
  // いるか」という一時的な文脈を必要とし、観戦モードdealでも追従してほしい
  // （さもないと新しい観戦テーブルの統計が古いヒーロー席インデックスで誤回転
  // される）。この2つの要求は両立しないため、フィールドを分けた。
  private _liveEvtDeal?: ApiEvent<ApiType.EVT_DEAL>
  private readonly _sessionData: SessionState
  private _isInitialized: boolean = false
  private _initializationError?: Error
  private _persistStateTimer?: ReturnType<typeof setTimeout>

  // Initialization promise
  public readonly ready: Promise<void>

  // background.ts's loadOptions().then(...) (startup filter restoration) resolves this once
  // battleTypeFilter/tableSizeFilter/handLimitFilter/statDisplayConfigs have been applied
  // (see beginFiltersRestore()/markFiltersRestored()). `ready` alone only covers
  // chrome.storage.local's playerId/session restore -- callers that need the *filters*
  // settled too (e.g. the pre-game hero stats fallback in background/import-export.ts)
  // must await this instead/as well.
  //
  // Defaults to an already-resolved promise: only background.ts's real startup path
  // calls beginFiltersRestore() to arm the gate before it starts restoring options.
  // Every other construction site (Popup, tests that construct PokerChaseService
  // directly without running background.ts's bootstrap) never arms it, so awaiting
  // this stays a no-op for them -- there is nothing for those call sites to wait on.
  public filtersRestored: Promise<void> = Promise.resolve()
  private resolveFiltersRestored: (() => void) | undefined

  // 永続化不要なプロパティ
  battleTypeFilter?: number[] = undefined // undefined = all, array = specific battleTypes
  tableSizeFilter?: TableSizeLayer[] = undefined // undefined = all layers (no filtering), array = selected layers (C案)
  handLimitFilter?: number = undefined // undefined = all hands, number = limit to recent N hands
  statDisplayConfigs?: StatDisplayConfig[] = undefined // Custom stat display configuration
  handLogConfig?: HandLogConfig = undefined // Hand log display configuration
  batchMode: boolean = false // Batch mode flag for bulk operations

  static readonly POKER_CHASE_SERVICE_EVENT = POKER_CHASE_SERVICE_EVENT
  static readonly POKER_CHASE_ORIGIN = POKER_CHASE_ORIGIN
  static readonly STORAGE_KEY = STORAGE_KEY

  // Getter/Setter for automatic persistence.
  // どちらも同じ persistState()（500msデバウンス）を呼ぶ一本道。
  get playerId(): number | undefined {
    return this._playerId
  }

  set playerId(value: number | undefined) {
    this._playerId = value
    this.persistState()
  }

  // 意味論: 「ヒーロー在籍」の文脈（永続化対象）。呼び出し元は必ずPlayerが
  // 存在するdeal（aggregate-events-stream.ts、findLatestPlayerDealEvent()経由の
  // import-export.ts/auto-sync-service.ts/recalculateAllStats()）だけをここに
  // 代入すること -- 呼び出し元側で保証されている前提（このsetter自体はPlayerの
  // 有無を検証しない）。
  get latestEvtDeal(): ApiEvent<ApiType.EVT_DEAL> | undefined {
    return this._latestEvtDeal
  }

  set latestEvtDeal(value: ApiEvent<ApiType.EVT_DEAL> | undefined) {
    this._latestEvtDeal = value
    // ヒーロー在籍dealへの再アンカーは、ライブ配信文脈（liveEvtDeal）も同時に
    // 同期する（codex #177 3巡目レビューP2「Use restored deal context for
    // batch broadcasts」で判明）。理由: import/rebuild/auto-sync復元の各経路
    // （import-export.ts, auto-sync-service.ts）は「service.latestEvtDealだけ
    // 更新してからstatsOutputStream.write()で再ブロードキャストする」という
    // パターンを繰り返し使っている。ports.tsのライブブロードキャストは常に
    // service.liveEvtDealを座席文脈として同梱するため、このsetterが
    // liveEvtDealを追従させないと、SW起動後すでに何らかのEVT_DEAL（観戦モード
    // 含む）を1件でも見ていた場合（_liveEvtDealが既にセット済みでgetterの
    // `??`フォールバックが効かない場合）、直前の（観戦テーブルなど無関係な）
    // liveEvtDealが取り残されたままimport/rebuild後の再計算結果とペアリング
    // されてしまい、App.tsxが誤った席インデックスで回転してしまう。
    // ヒーロー在籍dealへの再アンカーは常に「今表示すべき最新の文脈」でもある
    // ため、liveEvtDealを上書きするのが正しい。
    this._liveEvtDeal = value
    this.persistState()
  }

  // liveEvtDeal: 意図的に永続化しない（persistState()を呼ばない）。
  //
  // 意味論: 「今まさに配信中の席」の文脈（非永続・一時的）。
  // 更新元は2種類:
  //   (1) aggregate-events-stream.ts の EVT_DEAL ケース -- Player の有無に
  //       関わらず毎回このsetterを直接呼ぶ（観戦モードdealでも追従させる
  //       ことで、ports.tsのライブブロードキャストが正しい座席文脈を持つ。
  //       codex #177 1巡目レビュー）。
  //   (2) latestEvtDeal のsetterからの同期代入 -- ヒーロー在籍dealへの
  //       再アンカー（フィルター変更時のrecalculateStats()、バッチモード
  //       終了時のrecalculateAllStats()、import/rebuild/auto-sync復元）が
  //       起きた瞬間は、それが「今表示すべき最新の文脈」でもあるため
  //       （codex #177 3巡目レビューP2、下記参照）。
  //
  // 未設定（SW起動直後でまだ一度もEVT_DEALを見ていない）の間は latestEvtDeal
  // （ヒーロー在籍・永続化済みの直近deal）にフォールバックする。
  get liveEvtDeal(): ApiEvent<ApiType.EVT_DEAL> | undefined {
    return this._liveEvtDeal ?? this._latestEvtDeal
  }

  set liveEvtDeal(value: ApiEvent<ApiType.EVT_DEAL> | undefined) {
    this._liveEvtDeal = value
    // 意図的にpersistState()を呼ばない -- ライブ配信専用の一時的な文脈のため、
    // chrome.storage.localへの永続化対象（actualPersistState()のstate）にも含めない。
  }

  /**
   * 現在のセッション。ミューテーションは SessionState の明示的なメソッド
   * （setId/setBattleType/setName/setPlayer/reset）を経由すること。
   * players は ReadonlyMap として公開されるため `session.players.set(...)`
   * は型エラーになる。
   */
  get session(): SessionState {
    return this._sessionData
  }

  // Check if service is ready
  get isReady(): boolean {
    return this._isInitialized && !this._initializationError
  }

  /** Reset session and clear player data */
  readonly resetSession = () => {
    this._sessionData.reset()
  }

  /**
   * background.ts calls this synchronously, before it kicks off its startup
   * loadOptions() call, to arm the `filtersRestored` gate (replacing the
   * default already-resolved promise with a pending one). Pairs with
   * markFiltersRestored().
   */
  readonly beginFiltersRestore = () => {
    this.filtersRestored = new Promise(resolve => { this.resolveFiltersRestored = resolve })
  }

  /**
   * background.ts calls this once, after its startup loadOptions() call
   * settles (both the saved-options and default-filters success branches,
   * and the error branch -- see background.ts) once battleTypeFilter/
   * tableSizeFilter/handLimitFilter/statDisplayConfigs have all been
   * assigned. Resolves `filtersRestored`. No-op if beginFiltersRestore()
   * was never called (nothing to resolve).
   */
  readonly markFiltersRestored = () => {
    this.resolveFiltersRestored?.()
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
    const state = {
      playerId: this._playerId,
      latestEvtDeal: this._latestEvtDeal,
      session: this._sessionData.toJSON(),
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
      const result = await chrome.storage.local.get(PokerChaseService.STORAGE_KEY) as Record<string, any>
      const state = result[PokerChaseService.STORAGE_KEY]

      if (state) {
        // Don't use setters during restoration to avoid triggering persistence
        this._playerId = state.playerId
        this._latestEvtDeal = state.latestEvtDeal

        if (state.session) {
          // hydrate() applies the fields directly without calling notifyChange()
          this._sessionData.hydrate(state.session)
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
  // Persists hand entities to DB; 'data' fires exactly once per genuinely-completed
  // AND successfully-persisted hand (write-entity-stream.ts's `this.push(hand.
  // seatUserIds)`, reached only via the live pipeline below -- chimera hands return
  // early without pushing). Exposed (rather than kept as a local constructor
  // variable) specifically so ports.ts/positional-stats-service.ts/
  // recent-hands-service.ts can subscribe to this as the one true "hand completion"
  // signal -- unlike statsOutputStream's 'data', which also fires for the hand-start
  // warmup broadcast and filter-change/import/auto-sync-restore rebroadcasts (audit
  // finding 11 follow-up, P2; see ports.ts's handCompletionEpoch doc comment for the
  // full enumeration of those other call sites).
  readonly writeEntityStream: WriteEntityStream
  readonly statsOutputStream: ReadEntityStream             // Calculates and outputs stats
  readonly handLogStream: HandLogStream                    // Real-time hand log display
  readonly realTimeStatsStream: RealTimeStatsStream        // Real-time stats for hero only
  constructor({ db, playerId }: { db: PokerChaseDB, playerId?: number }) {
    this._playerId = playerId
    this._sessionData = new SessionState(this.persistState)
    this.db = db

    // Initialize the ready promise
    this.ready = this.restoreState()

    // Create streams
    this.handAggregateStream = new AggregateEventsStream(this)
    this.statsOutputStream = new ReadEntityStream(this)
    this.handLogStream = new HandLogStream(this)
    this.realTimeStatsStream = new RealTimeStatsStream()

    // Main pipeline for stats calculation
    this.writeEntityStream = new WriteEntityStream(this)
    this.handAggregateStream
      .pipe<WriteEntityStream>(this.writeEntityStream)
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

    // Set table-size (players-dealt) filter (C案). Missing tableSize (older
    // storage values / callers) falls back to the default (all layers = no filter).
    this.tableSizeFilter = selectedTableSizeLayers(filterOptions.tableSize ?? DEFAULT_TABLE_SIZE_FILTER)

    // Set hand limit filter
    this.handLimitFilter = filterOptions.handLimit

    // Set stat display configuration
    // 保存済みのstatDisplayConfigsをデフォルトとマージしてから設定する（background.tsの
    // 起動時ロードと同じ理由。呼び出し元のfilterOptionsが、マージ処理を経ていない
    // 古いstorage値や外部由来のメッセージであっても、新しい統計が欠落しないようにする）
    this.statDisplayConfigs = mergeStatDisplayConfigs(
      filterOptions.statDisplayConfigs,
      defaultStatDisplayConfigs
    )

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
      // ここは latestEvtDeal（永続化済み・ヒーロー在籍の文脈）を"読むだけ"で
      // 再代入しないパスなので、latestEvtDealのsetterが持つliveEvtDeal同期
      // ロジックが自動では効かない。observing-while-batchなどでliveEvtDealが
      // 既に別の（観戦）dealを指したまま取り残されていると、直後の
      // statsOutputStream.write()がports.tsで誤った座席文脈とペアリングされる
      // （codex #177 3巡目レビューP2）。ここで明示的に同期する。
      this.liveEvtDeal = this.latestEvtDeal
      const playerIds = this.latestEvtDeal.SeatUserIds.filter(id => id !== -1)
      if (playerIds.length > 0) {
        this.statsOutputStream.write(playerIds)
      }
    } else {
      // latestEvtDealが無い場合は、最新のEVT_DEALをDBから取得
      const latestDealEvent = await findLatestPlayerDealEvent(this.db)

      if (latestDealEvent && latestDealEvent.SeatUserIds) {
        this.latestEvtDeal = latestDealEvent

        // プレイヤーIDも更新
        if (latestDealEvent.Player?.SeatIndex !== undefined) {
          this.playerId = latestDealEvent.SeatUserIds[latestDealEvent.Player.SeatIndex]
        }

        const playerIds = latestDealEvent.SeatUserIds.filter((id: number) => id !== -1)
        if (playerIds.length > 0) {
          this.statsOutputStream.write(playerIds)
        }
      }
    }
  }

  readonly exportHandHistory = async (
    handIds?: number[],
    onProgress?: (processed: number, total: number) => void
  ): Promise<string> => {
    const { HandLogExporter } = await import('../utils/hand-log-exporter')

    if (!handIds) {
      // Export all recent hands (no session filter)
      return HandLogExporter.exportRecentHands(this.db, undefined, undefined, onProgress)
    }

    if (handIds.length === 0) {
      console.warn('No hands found to export')
      return ''
    }

    return HandLogExporter.exportMultipleHands(this.db, handIds, onProgress)
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
