import { SimpleTransform } from './simple-transform'
import type PokerChaseService from '../services/poker-chase-service'
import { ApiType } from '../types'
import type { ApiEvent, ApiHandEvent, Progress } from '../types'
import { ErrorHandler } from '../utils/error-handler'
import { setHandImprovementHeroHoleCards } from '../realtime-stats'

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
export class AggregateEventsStream extends SimpleTransform<ApiEvent, ApiEvent[]> {
  private service: PokerChaseService
  private events: ApiHandEvent[] = []
  private progress?: Progress
  private lastTimestamp = 0

  constructor(service: PokerChaseService) {
    super()
    this.service = service
  }
  protected async transform(event: ApiEvent): Promise<void> {
    try {
      /** 順序整合性チェック */
      if (this.lastTimestamp > event.timestamp!)
        this.events = []
      this.lastTimestamp = event.timestamp!

      switch (event.ApiTypeId) {
        case ApiType.EVT_ENTRY_QUEUED:
          // セッション境界: MTTではテーブル移動ごとに再発行されるため、進行中のハンド
          // （EVT_DEAL〜EVT_HAND_RESULTSの間）に割り込むことがある。テーブル移動後も
          // 同じハンドの残りのアクションは新しい席番号で配信され続けるため、
          // this.events（ハンドバッファ）はクリアしてはいけない
          // （クリアすると移動を挟むハンドが丸ごと失われる）。
          // 一方 this.progress（移動前の席番号を基準にしたNextActionSeat）は移動後には
          // 無効なので、ここでリセットしないと直後のEVT_ACTIONが席不一致とみなされ、
          // 誤ってバッファがクリアされてしまう
          // （実データで933件中785件の不一致がこのケース、ハンド損失2.9%の主因）。
          this.service.resetSession()
          this.service.session.setId(event.Id)
          this.service.session.setBattleType(event.BattleType)
          this.progress = undefined
          break
        case ApiType.EVT_SESSION_DETAILS:
          this.service.session.setName(event.Name)
          break
        case ApiType.EVT_PLAYER_SEAT_ASSIGNED:
          // プレイヤー名とランクをセッションに保存
          if (event.TableUsers) {
            event.TableUsers.forEach(tableUser => {
              this.service.session.setPlayer(tableUser.UserId, {
                name: tableUser.UserName,
                rank: tableUser.Rank.RankId
              })
            })
          }
          break
        case ApiType.EVT_PLAYER_JOIN:
          // 途中参加者のプレイヤー名とランクをセッションに保存
          if (event.JoinUser) {
            this.service.session.setPlayer(event.JoinUser.UserId, {
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
          // 【注意: このチェックを「安全のため」復活させないこと】
          // 従来はここで this.progress.NextActionSeat !== event.SeatIndex の不一致を
          // 検出するとバッファ（this.events）を丸ごとクリアしていたが、この不一致は
          // ライブ配信下では正常系（ドキュメント化済み）でも高頻度に発生することが判明した。
          // docs/api-events.md「EVT_ACTION: 送信されないケース」記載の通り、
          // タイムアウト/切断時は明示的なFOLDが送信されず（該当プレイヤーはEVT_HAND_RESULTS.
          // Resultsにも現れない）、次アクターのSeatIndexがNextActionSeatと食い違う。
          // 実データ（393,830イベント）でのアジャッジ結果: セッション境界外で発生した
          // 不一致80件のうち71件がこのタイムアウト/切断シグネチャ、9件がオールイン絡みの
          // 順序変化で、原因不明は0件だった。つまりこの不一致は異常の兆候ではなく、
          // サーバーの正常な省略仕様そのものであり、それを理由にハンド全体を破棄すると
          // 正当なハンドがライブ集計から失われる（バッチ再構築のEntityConverterには
          // 同種のチェックが存在せず、この非対称性がライブ/バッチ間の乖離の根本原因だった）。
          // このチェックが本来担っていたセッション境界（テーブル移動によるキメラハンド）の
          // 防御は、#96（EVT_ENTRY_QUEUEDでのprogressリセット）、#100（EC/WES双方の
          // SeatIndex未解決アクションのスキップ）、#106（hasResultsOutsideDealtLineupに
          // よるキメラハンド棄却、EC/WES双方に実装）で既に別レイヤーとしてカバー済み。
          // 観測用にログのみ残し、バッファはクリアしない。
          if (this.progress && this.progress.NextActionSeat !== event.SeatIndex) {
            console.debug(
              `[AggregateEventsStream] NextActionSeat mismatch (expected=${this.progress.NextActionSeat}, actual=${event.SeatIndex}); ` +
              'buffer retained — see docs/api-events.md "EVT_ACTION: 送信されないケース"'
            )
          }
          this.progress = event.Progress
          this.events.push(event)
          break
        case ApiType.EVT_HAND_RESULTS:
          this.events.push(event)
          if (this.events.length > 0 && this.events[0]?.ApiTypeId === ApiType.EVT_DEAL) {
            this.push(this.events)
          }
          // ハンド確定後はバッファを必ず空にする。以前はこの明示的なクリアが無く、
          // 直後に本来来るはずのEVT_DEALが（生データの欠落等により）来なかった場合、
          // this.events[0]が古いEVT_DEALのまま無限に伸び続け、以降毎回のEVT_HAND_RESULTSで
          // 同じ（肥大化した）バッファが再送出され続けるバグがあった
          // （上のNextActionSeat不一致チェックがバッファを丸ごとクリアする副作用で
          // 偶然隠蔽されていた）。実データで1件、EVT_DEALが欠落しHandId=259403865の
          // バッファが26回・長さ156まで肥大化して再送出される事例を確認した。
          this.events = []
          break
      }
    } catch (error: unknown) {
      this.handleError(error)
    }
  }

  protected override handleError(error: unknown): void {
    const appError = ErrorHandler.handleStreamError(
      error,
      'AggregateEventsStream',
      { lastTimestamp: this.lastTimestamp, eventsCount: this.events.length }
    )
    if (this.listenerCount('error') > 0) {
      this.emit('error', appError)
    }
  }
}
