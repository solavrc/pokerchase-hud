import Dexie, { type Table } from 'dexie'
import { Transform } from 'stream'
import { content_scripts } from '../manifest.json'
import { defaultRegistry } from './stats'
import { HandLogStream } from './streams/hand-log-stream'
import { ErrorType, type ErrorContext } from './types/errors'
import type { HandLogConfig } from './types/hand-log'
import type { StatCalculationContext } from './types/stats'
import { ErrorHandler } from './utils/error-handler'
import { formatCardsArray } from './utils/card-utils'

import {
  ActionDetail,
  ActionType,
  ApiType,
  BATTLE_TYPE_FILTERS,
  BattleType,
  BetStatusType,
  PhaseType,
  Position
} from './types'

import type {
  Action,
  ApiEvent,
  ApiHandEvent,
  ExistPlayerStats,
  FilterOptions,
  GameTypeFilter,
  Hand,
  HandState,
  ImportMeta,
  Phase,
  PlayerStats,
  Progress,
  Session,
  StatDisplayConfig
} from './types'
import type { ActionDetailContext } from './types/stats'

export {
  ActionType, ApiType, BATTLE_TYPE_FILTERS, BattleType,
  PhaseType,
  Position, type Action, type ApiEvent, type FilterOptions, type GameTypeFilter, type Hand,
  type Phase, type PlayerStats
}

/**
 * PokerChase HUD用IndexedDBクラス
 *
 * ポーカーゲームのデータ永続化を担当する。
 * - APIイベントの生ログを保存
 * - 処理済みのハンド、フェーズ、アクションデータを構造化して保存
 * - 統計計算のための効率的なインデックスを提供
 */
export class PokerChaseDB extends Dexie {
  apiEvents!: Table<ApiEvent, number>
  hands!: Table<Hand, number>
  phases!: Table<Phase, number>
  actions!: Table<Action, number>
  meta!: Table<ImportMeta, string>
  constructor(indexedDB: IDBFactory, iDBKeyRange: typeof IDBKeyRange) {
    super('PokerChaseDB', { indexedDB, IDBKeyRange: iDBKeyRange })
    this.version(1).stores({
      apiEvents: '[timestamp+ApiTypeId],timestamp,ApiTypeId',
      hands: 'id,*seatUserIds,*winningPlayerIds',
      phases: '[handId+phase],handId,*seatUserIds,phase',
      actions: '[handId+index],handId,playerId,phase,actionType,*actionDetails',
    })
    // メタデータテーブルを追加（増分処理用）
    this.version(2).stores({
      apiEvents: '[timestamp+ApiTypeId],timestamp,ApiTypeId',
      hands: 'id,*seatUserIds,*winningPlayerIds',
      phases: '[handId+phase],handId,*seatUserIds,phase',
      actions: '[handId+index],handId,playerId,phase,actionType,*actionDetails',
      meta: 'id'
    })
  }
}

type TransformCallback<T> = (error?: Error | null, data?: T) => void

/**
 * APIイベント集約処理Stream（パイプライン第1段階）
 *
 * PokerChase APIからのWebSocketイベントを受信し、以下の処理を行う：
 * - APIイベントをIndexedDBに永続化（Promise投げっぱなし、同期性重視）
 * - プレイヤー名とランク情報をセッションに保存
 * - セッション情報（ID、バトルタイプ、名前）の管理
 * - EVT_DEAL ~ EVT_HAND_RESULTSの1ハンド分のイベントを集約
 * - タイムスタンプとアクション順序の整合性チェック
 * - プレイヤーIDの設定とHUD表示制御
 *
 * 出力: 1ハンド分のApiHandEvent配列 → WriteEntityStream
 */
class AggregateEventsStream extends Transform {
  private service: PokerChaseService
  private events: ApiHandEvent[] = []
  private progress?: Progress
  private lastTimestamp = 0
  private replayMode: boolean = false  // refreshDatabase用のフラグ
  
  constructor(service: PokerChaseService, replayMode: boolean = false) {
    super({ objectMode: true })
    this.service = service
    this.replayMode = replayMode
  }
  _transform(event: ApiEvent, _: string, callback: TransformCallback<ApiEvent[]>) {
    try {
      // リプレイモードではDBへの書き込みをスキップ
      if (!this.replayMode) {
        this.service.db.apiEvents.add(event).catch(this.handleDbError)
        this.service.eventLogger(event)
      }
      
      /** 順序整合性チェック */
      if (this.lastTimestamp > event.timestamp!)
        this.events = []
      this.lastTimestamp = event.timestamp!

      // HandLogStreamにイベントを送信（リプレイモードでもスキップ）
      if (this.service.handLogStream && !this.replayMode) {
        this.service.handLogStream.write(event)
      }

      switch (event.ApiTypeId) {
        case ApiType.RES_ENTRY_QUEUED:
          this.service.resetSession()
          this.service.session.id = event.Id
          this.service.session.battleType = event.BattleType
          break
        case ApiType.EVT_SESSION_DETAILS:
          this.service.session.name = event.Name
          break
        case ApiType.EVT_PLAYER_SEAT_ASSIGNED:
          // プレイヤー名とランクをセッションに保存
          if (event.TableUsers) {
            event.TableUsers.forEach(tableUser => {
              this.service.session.players.set(tableUser.UserId, {
                name: tableUser.UserName,
                rank: tableUser.Rank.RankId
              })
            })
          }
          break
        case ApiType.EVT_PLAYER_JOIN:
          // 途中参加者のプレイヤー名とランクをセッションに保存
          if (event.JoinUser) {
            this.service.session.players.set(event.JoinUser.UserId, {
              name: event.JoinUser.UserName,
              rank: event.JoinUser.Rank.RankId
            })
          }
          break
        case ApiType.EVT_DEAL:
          // プレイヤーIDの割り当て
          this.service.playerId = event.Player?.SeatIndex !== undefined ? event.SeatUserIds[event.Player.SeatIndex] : undefined
          // 席マッピング用に最新のEVT_DEALを保存
          this.service.latestEvtDeal = event
          // ハンドの集約
          this.progress = event.Progress
          this.events = []
          this.events.push(event)
          break
        case ApiType.EVT_DEAL_ROUND:
          this.progress = event.Progress
          this.events.push(event)
          break
        case ApiType.EVT_ACTION:
          /** 順序整合性チェック */
          if (this.progress && this.progress.NextActionSeat !== event.SeatIndex) {
            this.events = []
          }
          this.progress = event.Progress
          this.events.push(event)
          break
        case ApiType.EVT_HAND_RESULTS:
          this.events.push(event)
          if (this.events.length > 0 && this.events[0]?.ApiTypeId === ApiType.EVT_DEAL) {
            this.push(this.events)
          }
          break
      }
      callback()
    } catch (error: unknown) {
      this.handleError(error, callback)
    }
  }

  private handleDbError = (dbError: unknown) => {
    const context: ErrorContext = {
      streamName: 'AggregateEventsStream',
      operation: 'apiEvents.add'
    }
    const appError = ErrorHandler.handleDbError(dbError, context)
    // 制約エラー（重複）は予想されるのでログを出さない
    if (appError.type !== ErrorType.DB_CONSTRAINT) {
      ErrorHandler.logError(appError, 'AggregateEventsStream')
    }
  }

  private handleError(error: unknown, callback: TransformCallback<ApiEvent[]>) {
    const errorCallback = ErrorHandler.createStreamErrorCallback(
      callback,
      'AggregateEventsStream',
      { lastTimestamp: this.lastTimestamp, eventsCount: this.events.length }
    )
    errorCallback(error)
  }
}

/**
 * エンティティ書き込みStream（パイプライン第2段階）
 *
 * 集約されたハンドイベントを構造化データに変換してDBに永続化する：
 * - ApiHandEvent配列をHand、Phase、Actionエンティティに分解
 * - ALL_INアクションをBET/RAISE/CALLに正規化
 * - 統計計算用のActionDetailフラグを各アクションに付与
 * - ポジション計算（相対的な座席位置）
 * - 統計モジュールからのActionDetail検出とHandState更新
 * - トランザクション内でhands、phases、actionsテーブルに一括書き込み
 *
 * 入力: 1ハンド分のApiHandEvent配列
 * 出力: プレイヤーIDの配列（seatUserIds） → ReadEntityStream
 */
class WriteEntityStream extends Transform {
  private service: PokerChaseService
  constructor(service: PokerChaseService) {
    super({ objectMode: true })
    this.service = service
  }
  async _transform(events: ApiHandEvent[], _: string, callback: TransformCallback<number[]>) {
    try {
      const { hand, actions, phases } = this.toHandState(events)
      await this.service.db.transaction('rw', [this.service.db.hands, this.service.db.phases, this.service.db.actions], async () => {
        return Promise.all([
          this.service.db.hands.put(hand),
          this.service.db.actions.bulkPut(actions),
          this.service.db.phases.bulkPut(phases)
        ])
      })
      callback(null, hand.seatUserIds)
    } catch (error: unknown) {
      const context: ErrorContext = {
        streamName: 'WriteEntityStream',
        handId: events.find(e => e.ApiTypeId === ApiType.EVT_HAND_RESULTS)?.HandId,
        eventsCount: events.length
      }
      const errorCallback = ErrorHandler.createStreamErrorCallback(
        callback,
        'WriteEntityStream',
        context
      )
      errorCallback(error)
    }
  }
  private toHandState = (events: ApiHandEvent[]): HandState => {
    const positionUserIds = []
    const handState: HandState = {
      hand: {
        session: {
          id: this.service.session.id,
          battleType: this.service.session.battleType,
          name: this.service.session.name
        },
        id: NaN,
        approxTimestamp: NaN,
        seatUserIds: [],
        winningPlayerIds: [],
        bigBlind: NaN,
        smallBlind: NaN,
        results: []
      },
      actions: [],
      phases: []
    }
    let progress: Progress | undefined
    for (const event of events) {
      switch (event.ApiTypeId) {
        case ApiType.EVT_DEAL:
          handState.hand.seatUserIds = event.SeatUserIds
          positionUserIds.push(...PokerChaseService.rotateElementFromIndex(event.SeatUserIds, event.Game.BigBlindSeat + 1).reverse())
          handState.phases.push({
            phase: event.Progress.Phase,
            seatUserIds: event.SeatUserIds,
            communityCards: [],
          })
          handState.hand.bigBlind = event.Game.BigBlind
          handState.hand.smallBlind = event.Game.SmallBlind
          progress = event.Progress
          break
        case ApiType.EVT_DEAL_ROUND:
          handState.phases.push({
            phase: event.Progress.Phase,
            seatUserIds: (event.Player ? [event.Player, ...event.OtherPlayers] : event.OtherPlayers)
              .filter(({ BetStatus }) => BetStatus === BetStatusType.BET_ABLE)
              .sort((a, b) => a.SeatIndex - b.SeatIndex)
              .map(({ SeatIndex }) => handState.hand.seatUserIds.at(SeatIndex)!),
            communityCards: [...handState.phases.at(-1)!.communityCards, ...event.CommunityCards],
          })
          progress = event.Progress
          break
        case ApiType.EVT_ACTION: {
          const actionDetails: ActionDetail[] = []
          /**
           * ALL_IN アクション変換ロジック
           *
           * ALL_INは「全チップを賭ける」という賭け金額の情報であり、
           * アクションタイプとしては文脈に応じてBET/RAISE/CALLのいずれかに分類される。
           *
           * 変換ルール:
           * 1. BETが可能な状況（誰もベットしていない） → BET
           * 2. CALLが可能な状況（相手がベット済み） → RAISE
           * 3. それ以外（相手がレイズ済み等） → CALL
           *
           * この変換により、統計計算（VPIP, PFR, AF, AFq等）で
           * ALL_INが適切なアクションとしてカウントされる。
           * ActionDetail.ALL_INフラグは保持され、必要に応じて参照可能。
           */
          const actionType: Exclude<ActionType, ActionType.ALL_IN> = (({ ActionType: actionType }: typeof event) => {
            if (actionType === ActionType.ALL_IN) {
              actionDetails.push(ActionDetail.ALL_IN)
              if (progress?.NextActionTypes.includes(ActionType.BET)) {
                return ActionType.BET
              } else if (progress?.NextActionTypes.includes(ActionType.CALL)) {
                return ActionType.RAISE
              } else {
                return ActionType.CALL
              }
            } else {
              return actionType
            }
          })(event)
          const playerId = handState.hand.seatUserIds[event.SeatIndex]
          const phase = handState.phases.at(-1)!.phase
          const phaseActions = handState.actions.filter(action => action.phase === phase)
          const phasePlayerActionIndex = phaseActions.filter(action => action.playerId === playerId).length
          const phasePrevBetCount = phaseActions.filter(action => [ActionType.BET, ActionType.RAISE].includes(action.actionType)).length + Number(phase === PhaseType.PREFLOP)
          // モジュールベース検出用のActionDetailContext
          const detectionContext: ActionDetailContext = {
            playerId: playerId ?? 0,
            actionType,
            phase,
            phasePlayerActionIndex,
            phasePrevBetCount,
            handState
          }

          // 統計モジュールからActionDetailsを収集
          for (const stat of defaultRegistry.getAll()) {
            if (stat.detectActionDetails) {
              const detectedDetails = stat.detectActionDetails(detectionContext)
              actionDetails.push(...detectedDetails)
            }
            // 必要に応じてhandStateを更新
            if (stat.updateHandState) {
              stat.updateHandState(detectionContext)
            }
          }
          handState.actions.push({
            playerId: playerId ?? 0,
            phase,
            index: handState.actions.length,
            actionType,
            bet: event.BetChip,
            pot: event.Progress.Pot,
            sidePot: event.Progress.SidePot,
            position: positionUserIds.indexOf(playerId ?? 0) - 2,
            actionDetails,
          })
          progress = event.Progress
        }
          break
        case ApiType.EVT_HAND_RESULTS:
          if (event.Results.length > 1) {
            handState.phases.push({
              phase: PhaseType.SHOWDOWN,
              communityCards: [...handState.phases.at(-1)!.communityCards, ...event.CommunityCards],
              seatUserIds: event.Results.map(({ UserId }) => UserId),
            })
          }
          handState.hand.id = event.HandId
          handState.hand.winningPlayerIds = event.Results.filter(({ HandRanking }) => HandRanking === 1).map(({ UserId }) => UserId)
          handState.hand.approxTimestamp = event.timestamp
          handState.hand.results = event.Results
          handState.actions = handState.actions.map(action => ({ ...action, handId: event.HandId }))
          handState.phases = handState.phases.map(phase => ({ ...phase, handId: event.HandId }))
          break
      }
    }
    return handState
  }
}

/**
 * 統計計算Stream（パイプライン第3段階）
 *
 * プレイヤーの統計情報を計算してHUDに送信する：
 * - バトルタイプフィルター（SNG/MTT/Ring）による絞り込み
 * - ハンド数制限フィルター（最新N手のみ）の適用
 * - 大量データに対応した効率的なDB クエリ（単一クエリで全データ取得）
 * - 統計モジュールシステムによる計算（VPIP、PFR、CBet等）
 * - 5秒間の統計計算結果キャッシュによる高速化
 * - 最大50エントリまでのキャッシュサイズ制御
 *
 * 入力: プレイヤーIDの配列（seatUserIds）
 * 出力: PlayerStats配列 → HUD（background.ts経由）
 */
class ReadEntityStream extends Transform {
  private service: PokerChaseService
  private statsCache: Map<string, { stats: PlayerStats[], timestamp: number }> = new Map()
  private readonly CACHE_DURATION_MS = 5000 // 5秒のキャッシュ
  private readonly MAX_CACHE_SIZE = 50 // キャッシュエントリの最大数

  constructor(service: PokerChaseService) {
    super({ objectMode: true })
    this.service = service
  }

  public async recalculateStats(): Promise<void> {
    // 新しい計算を保証するためキャッシュをクリア
    this.statsCache.clear()

    // seatUserIdsを取得するため最新のハンドを取得
    try {
      const recentHand = await this.service.db.hands.orderBy('id').reverse().limit(1).first()
      if (!recentHand) {
        return
      }

      const seatUserIds = recentHand.seatUserIds

      // playerIdがない場合、EVT_DEALから取得を試みる
      if (!this.service.playerId) {
        const recentDealEvent = await this.service.db.apiEvents
          .where('ApiTypeId').equals(ApiType.EVT_DEAL)
          .reverse()
          .filter((event: ApiEvent) => (event as ApiEvent<ApiType.EVT_DEAL>).Player?.SeatIndex !== undefined)
          .first() as ApiEvent<ApiType.EVT_DEAL> | undefined

        if (recentDealEvent && recentDealEvent.Player?.SeatIndex !== undefined) {
          this.service.playerId = recentDealEvent.SeatUserIds[recentDealEvent.Player.SeatIndex]
          this.service.latestEvtDeal = recentDealEvent  // 席マッピング用にEVT_DEALを保存
        }
      }

      // すべてのプレイヤーの統計を計算
      const stats = await this.calcStats(seatUserIds)
      this.push(stats)
    } catch (error) {
      const context: ErrorContext = {
        streamName: 'ReadEntityStream',
        operation: 'recalculateStats',
        playerId: this.service.playerId
      }
      const appError = ErrorHandler.handleStreamError(
        error,
        'ReadEntityStream',
        context
      )
      // バックグラウンド操作なのでエラーを投げずにログだけ
      ErrorHandler.logError(appError, 'ReadEntityStream')
    }
  }

  async _transform(seatUserIds: number[], _: string, callback: TransformCallback<PlayerStats[]>) {
    try {
      // バッチモード中は統計計算をスキップ
      if (this.service.batchMode) {
        callback()
        return
      }

      // seatUserIdsとフィルター設定に基づいてキャッシュキーを作成
      const cacheKey = `${seatUserIds.join(',')}_${this.service.battleTypeFilter?.join(',') || 'all'}`
      const now = Date.now()

      // まずキャッシュをチェック
      const cached = this.statsCache.get(cacheKey)
      if (cached && (now - cached.timestamp) < this.CACHE_DURATION_MS) {
        callback(null, cached.stats)
        return
      }

      /**
       * `rw!`, `rw?` は Service Worker で機能しない??
       * @see https://dexie.org/docs/Dexie/Dexie.transaction()
       */
      const stats = await this.service.db.transaction('r', [this.service.db.hands, this.service.db.phases, this.service.db.actions], async () => {
        // 生のseatUserIds順序で統計を計算（フロントエンドで表示位置を調整）
        return await this.calcStats(seatUserIds)
      })

      // キャッシュを更新
      this.statsCache.set(cacheKey, { stats, timestamp: now })

      // 古いキャッシュエントリをクリーンアップ
      if (this.statsCache.size > this.MAX_CACHE_SIZE) {
        const entriesToDelete: string[] = []
        for (const [key, value] of this.statsCache.entries()) {
          if (now - value.timestamp > this.CACHE_DURATION_MS) {
            entriesToDelete.push(key)
          }
        }
        entriesToDelete.forEach(key => this.statsCache.delete(key))
      }

      callback(null, stats)
    } catch (error: unknown) {
      const context: ErrorContext = {
        streamName: 'ReadEntityStream',
        playerIds: seatUserIds,
        cacheKey: `${seatUserIds.join(',')}_${this.service.battleTypeFilter?.join(',') || 'all'}`,
        battleTypeFilter: this.service.battleTypeFilter,
        handLimitFilter: this.service.handLimitFilter
      }
      const errorCallback = ErrorHandler.createStreamErrorCallback(
        callback,
        'ReadEntityStream',
        context
      )
      errorCallback(error)
    }
  }
  /** モジュラーレジストリシステムを使用して統計を計算 */
  private calcStats = async (seatUserIds: number[]): Promise<PlayerStats[]> => {
    return await Promise.all(seatUserIds.map(async playerId => {
      if (playerId === -1)
        return { playerId: -1 }

      // battleTypeフィルターとハンド制限に基づいてフィルタリングされたhandIdsを取得
      let filteredHandIds: number[] | undefined = undefined
      let filteredHandIdSet: Set<number> | undefined = undefined

      // まず、プレイヤーのすべてのハンドを取得
      let allPlayerHands = await this.service.db.hands
        .where({ seatUserIds: playerId })
        .toArray()

      // 指定されている場合、まずbattleTypeフィルターを適用
      if (this.service.battleTypeFilter) {
        const originalHandsCount = allPlayerHands.length
        allPlayerHands = allPlayerHands.filter((hand: Hand) =>
          this.service.battleTypeFilter!.includes(hand.session.battleType!)
        )

        // battleTypeフィルターに一致するハンドがない場合、このプレイヤーの空の統計を返す
        // ただし新規プレイヤー（originalHandsCount === 0）は0ハンドで表示を許可
        if (allPlayerHands.length === 0 && originalHandsCount > 0) {
          return {
            playerId,
            statResults: [] // 空の統計、プレースホルダーではない
          }
        }
      }

      // 次に指定されていればハンド制限フィルターを適用
      if (this.service.handLimitFilter !== undefined && this.service.handLimitFilter > 0) {
        // 最新のハンドを取得するためハンドIDでソート（降順）
        allPlayerHands.sort((a, b) => b.id - a.id)
        allPlayerHands = allPlayerHands.slice(0, this.service.handLimitFilter)
      }

      // アクションフィルタリング用のフィルタリングされたハンドIDを作成
      if (this.service.battleTypeFilter || this.service.handLimitFilter !== undefined) {
        filteredHandIds = allPlayerHands.map((h: Hand) => h.id)
        filteredHandIdSet = new Set(filteredHandIds)
      }

      // プレイヤーのすべてのアクションを1回のクエリで取得 - 大幅なパフォーマンス向上
      const allPlayerActions = await this.service.db.actions
        .where({ playerId })
        .toArray()

      // 必要に応じてhandIdでアクションをフィルタリング
      const relevantActions = filteredHandIdSet
        ? allPlayerActions.filter(a => filteredHandIdSet.has(a.handId!))
        : allPlayerActions

      // プレイヤーのすべてのフェーズを1回のクエリで取得
      const allPlayerPhases = await this.service.db.phases
        .where({ seatUserIds: playerId })
        .toArray()

      // 必要に応じてhandIdでフェーズをフィルタリング
      const relevantPhases = filteredHandIdSet
        ? allPlayerPhases.filter(p => p.handId !== undefined && filteredHandIdSet.has(p.handId))
        : allPlayerPhases

      // Get winning hands for WWSF and W$SD calculations
      const flopPhases = relevantPhases.filter(p => p.phase === PhaseType.FLOP)
      const showdownPhases = relevantPhases.filter(p => p.phase === PhaseType.SHOWDOWN)
      const phaseHandIds = [...new Set([...flopPhases, ...showdownPhases].map(p => p.handId!))]
      let winningHands: Hand[] = []

      if (phaseHandIds.length > 0) {
        winningHands = await this.service.db.hands
          .where('id')
          .anyOf(phaseHandIds)
          .and((hand: Hand) => hand.winningPlayerIds.includes(playerId))
          .toArray()
      }

      const winningHandIds = new Set(winningHands.map(h => h.id))

      // Create calculation context
      const context: StatCalculationContext = {
        playerId,
        actions: relevantActions,
        phases: relevantPhases,
        hands: allPlayerHands,
        allPlayerActions,
        allPlayerPhases,
        winningHandIds,
        session: this.service.session
      }

      // Calculate stats using the registry with custom configuration
      const statResults = await defaultRegistry.calculateWithConfig(context, this.service.statDisplayConfigs)

      // Return simple stat results format
      const stats: ExistPlayerStats = {
        playerId,
        statResults
      }

      return stats
    }))
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
  playerId?: number
  latestEvtDeal?: ApiEvent<ApiType.EVT_DEAL> // Latest EVT_DEAL event for seat mapping
  battleTypeFilter?: number[] = undefined // undefined = all, array = specific battleTypes
  handLimitFilter?: number = undefined // undefined = all hands, number = limit to recent N hands
  statDisplayConfigs?: StatDisplayConfig[] = undefined // Custom stat display configuration
  handLogConfig?: HandLogConfig = undefined // Hand log display configuration
  batchMode: boolean = false // Batch mode flag for bulk operations
  static readonly POKER_CHASE_SERVICE_EVENT = 'PokerChaseServiceEvent'
  static readonly POKER_CHASE_ORIGIN = new URL(content_scripts[0]!.matches[0]!).origin
  readonly session: Session = {
    id: undefined,
    battleType: undefined,
    name: undefined,
    players: new Map<number, { name: string, rank: string }>(),
    reset: function () {
      this.id = undefined
      this.battleType = undefined
      this.name = undefined
      this.players.clear()
    }
  }

  /** Reset session and clear player data */
  readonly resetSession = () => {
    this.session.reset()
  }
  readonly db
  readonly handAggregateStream = new AggregateEventsStream(this)     // Entry point for all events and groups events by hand
  readonly statsOutputStream = new ReadEntityStream(this)            // Calculates and outputs stats
  readonly handLogStream = new HandLogStream(this)                   // Real-time hand log display
  constructor({ db, playerId }: { db: PokerChaseDB, playerId?: number }) {
    this.playerId = playerId
    this.db = db
    this.handAggregateStream
      .pipe<WriteEntityStream>(new WriteEntityStream(this))
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
    }
  }

  readonly refreshDatabase = async () => {
    try {
      // メタデータを取得
      const meta = await this.db.meta.get('lastProcessed')
      const lastTimestamp = meta?.lastProcessedTimestamp || 0
      
      // 新規イベントのみを取得
      const newEventsCount = await this.db.apiEvents
        .where('timestamp')
        .above(lastTimestamp)
        .count()
      
      if (newEventsCount === 0) {
        console.log('[refreshDatabase] No new events to process')
        return
      }
      
      console.log(`[refreshDatabase] Processing ${newEventsCount} new events`)
      
      // バッチモードを有効化
      this.setBatchMode(true)
      
      // リプレイモードでAggregateEventsStreamを作成（DB書き込みをスキップ）
      const eventProcessor = new AggregateEventsStream(this, true)
      eventProcessor
        .pipe(new WriteEntityStream(this))
        .on('data', () => { }) /** /dev/null consumer */
      
      let processedCount = 0
      let lastProcessedTimestamp = lastTimestamp
      
      // 新規イベントのみを処理
      await this.db.apiEvents
        .where('timestamp')
        .above(lastTimestamp)
        .each((event: ApiEvent) => {
          eventProcessor.write(event)
          processedCount++
          lastProcessedTimestamp = Math.max(lastProcessedTimestamp, event.timestamp || 0)
        })
      
      // メタデータを更新
      await this.db.meta.put({
        id: 'lastProcessed',
        lastProcessedTimestamp,
        lastProcessedEventCount: processedCount,
        lastImportDate: new Date()
      })
      
      console.log(`[refreshDatabase] Processed ${processedCount} events`)
      
      // バッチモードを無効化（統計を再計算）
      this.setBatchMode(false)
      
    } catch (error) {
      const appError = ErrorHandler.handleDbError(error, {
        streamName: 'PokerChaseService',
        operation: 'refreshDatabase'
      })
      ErrorHandler.logError(appError, 'PokerChaseService')
      
      // エラー時もバッチモードを無効化
      this.setBatchMode(false)
    }
  }

  readonly exportHandHistory = async (handIds?: number[]): Promise<string> => {
    const { HandLogExporter } = await import('./utils/hand-log-exporter')

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
  eventLogger = (event: ApiEvent) => {
    const timestamp = event.timestamp
      ? new Date(event.timestamp).toISOString().slice(11, 22)
      : new Date().toISOString().slice(11, 22)
    ApiType[event.ApiTypeId]
      ? console.debug(`[${timestamp}]`, event.ApiTypeId, ApiType[event.ApiTypeId], JSON.stringify(event))
      : console.warn(`[${timestamp}]`, event.ApiTypeId, ApiType[event.ApiTypeId], JSON.stringify(event))
  }
  static readonly rotateElementFromIndex = <T>(elements: T[], index: number): T[] => {
    return [
      ...elements.slice(index, Infinity),
      ...elements.slice(0, index)
    ]
  }
  static readonly toCardStr = (cards: number[]) => formatCardsArray(cards)
}

export default PokerChaseService
export { HandLogExporter } from './utils/hand-log-exporter'
