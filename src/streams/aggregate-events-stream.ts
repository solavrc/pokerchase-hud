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
          // プレイヤーIDの割り当て。
          //
          // 【根本原因メモ】event.Player は「観戦モード」（ヒーローが着席していない
          // EVT_DEAL — 例: トーナメント敗退後もクライアントが他プレイヤーのテーブルを
          // 受信し続けるケース。docs/api-events.md「EVT_DEAL: Playerフィールドの欠落」
          // 「観戦モード: Playerフィールド自体がundefined」参照）では undefined になる。
          // 以前はここで無条件に `this.service.playerId = undefined` を代入していたため、
          // 既に確定していたヒーローの playerId が観戦モードの deal 1件だけで消え、
          // 500msデバウンス後に chrome.storage.local へ undefined が永続化されていた。
          // セッション終盤（ヒーロー敗退後の観戦・テーブル終了間際）にこの種の deal が
          // 起きやすく、「初手でplayerId確定→セッション終了後リロードでundefinedに
          // 戻る」という実地報告（sola 2026-07-20）と一致する。クラウドDL後の明示的な
          // 再構築（rebuildAllData/importData）で復旧してリロードを跨いで生存するのは、
          // それらが findLatestPlayerDealEvent()（database-utils.ts）で
          // Player.SeatIndexが存在する直近dealだけを見て再設定するため — 同じ生イベント列
          // に対してここ（ライブ経路）とそちら（再構築経路）とで挙動が非対称だったのが
          // 本質。
          //
          // 修正（スコープをplayerIdのみに限定）: playerId は Player が存在する deal
          // （＝ヒーローとして着席している）のときだけ更新する。観戦モードの deal は
          // 無視して直前の値を保持する。別アカウントへのログイン切り替えは、次に
          // Player が存在する EVT_DEAL が来た時点で正しく上書きされるため、この変更後も
          // 追従する（意図的に維持する挙動）。
          //
          // 一方 latestEvtDeal は Player の有無に関わらず毎回更新する（修正前の挙動に
          // 戻す）。理由: 下のブロック（117行目付近）は Player の有無を問わず、DBに
          // ハンドが1件でもあれば毎 EVT_DEAL で
          // `this.service.statsOutputStream.write(event.SeatUserIds)` を呼び、観戦中の
          // 別テーブルの新しい顔ぶれで統計を再計算・ブロードキャストする
          // （ports.ts registerStreamSubscriptions の statsOutputStream 購読）。
          // その際 broadcastMessage は `evtDeal: service.latestEvtDeal` を同梱し、
          // App.tsx の handleStatsMessage は `evtDeal.Player?.SeatIndex` が存在する
          // ときだけヒーロー基準に座席を回転させる（存在しなければ回転せず生の席順で
          // 表示）。latestEvtDeal も一緒にガードして直前のヒーロー在籍dealのまま
          // 固定してしまうと、新しい観戦テーブルの統計（新SeatUserIds）が古いヒーロー
          // 席インデックスで誤って回転され、パネルが実際の座席とズレる
          // （codex #177 P2指摘）。latestEvtDeal を Player の有無に関わらず追従させれば、
          // 観戦モードでは evtDeal.Player が undefined になるため回転自体が発生せず、
          // 新しい観戦テーブルの統計と一致する。
          //
          // このガード分離がplayerId消失を再導入しないことの確認: chrome.storage.local
          // からの復元（restoreState(), poker-chase-service.ts:302-305）は保存済みの
          // `state.playerId` を直接 `_playerId` に代入するだけで、`state.latestEvtDeal`
          // から playerId を再導出する経路は存在しない。したがって Player 不在の
          // latestEvtDeal が永続化されていても、playerId 自体は影響を受けない
          // （poker-chase-service.test.ts の3件の観戦モード回帰テストで検証済み）。
          if (event.Player?.SeatIndex !== undefined) {
            this.service.playerId = event.SeatUserIds[event.Player.SeatIndex]
          }
          // 席マッピング用に最新のEVT_DEALを保存（Player有無に関わらず毎回更新）
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
