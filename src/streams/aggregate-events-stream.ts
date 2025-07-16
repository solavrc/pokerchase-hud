import { Transform } from 'stream'
import type PokerChaseService from '../services/poker-chase-service'
import { ApiType } from '../types'
import type { ApiEvent, ApiHandEvent, Progress } from '../types'
import { ErrorHandler } from '../utils/error-handler'
import { setHandImprovementHeroHoleCards } from '../realtime-stats'

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
export class AggregateEventsStream extends Transform {
  private service: PokerChaseService
  private events: ApiHandEvent[] = []
  private progress?: Progress
  private lastTimestamp = 0

  constructor(service: PokerChaseService) {
    super({ objectMode: true })
    this.service = service
  }
  _transform(event: ApiEvent, _: string, callback: TransformCallback<ApiEvent[]>) {
    try {
      /** 順序整合性チェック */
      if (this.lastTimestamp > event.timestamp!)
        this.events = []
      this.lastTimestamp = event.timestamp!

      switch (event.ApiTypeId) {
        case ApiType.EVT_ENTRY_QUEUED:
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

          // Capture hero's hole cards for hand improvement calculations (only in real-time play)
          if (!this.service.batchMode && event.Player?.HoleCards && event.Player.HoleCards.length === 2 && this.service.playerId) {
            // Use timestamp as temporary hand ID until we get the real one from EVT_HAND_RESULTS
            // This is fine since we only need it for the current hand
            const tempHandId = `temp_${Date.now()}`
            setHandImprovementHeroHoleCards(tempHandId, this.service.playerId.toString(), event.Player.HoleCards)
          }

          // 新しいハンド開始時に統計を計算（既存データがあるプレイヤーの統計を表示）
          // ただし、すでにDBにハンドが存在する場合のみ（リングゲーム途中参加など）
          if (!this.service.batchMode && this.service.session.id && event.SeatUserIds) {
            // 非同期でDBチェックを行うが、結果を待たずに処理を続行
            this.service.db.hands.count().then(count => {
              if (count > 0) {
                // 全てのSeatUserIds（-1を含む）を渡して席の順序を保持
                this.service.statsOutputStream.write(event.SeatUserIds)
              }
            }).catch(err => {
              console.error('[AggregateEventsStream] Error checking hand count:', err)
            })
          }

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

  private handleError(error: unknown, callback: TransformCallback<ApiEvent[]>) {
    const errorCallback = ErrorHandler.createStreamErrorCallback(
      callback,
      'AggregateEventsStream',
      { lastTimestamp: this.lastTimestamp, eventsCount: this.events.length }
    )
    errorCallback(error)
  }
}
