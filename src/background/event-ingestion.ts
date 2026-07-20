/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
import PokerChaseService, {
  ApiType,
  ApiMessage,
  validateMessage,
  validateApiEvent,
  parseApiEvent,
  getValidationError,
  isApplicationApiEvent
} from '../app'
import type { ApiEvent } from '../app'
import { autoSyncService } from '../services/auto-sync-service'
import { connectedPorts, startPortPing, setLastKnownStats } from './ports'
import { recordUndecodedEvent } from './undecoded-event-tracker'
import { markSessionActive, markSessionInactive, recheckPendingUpdate } from './update-manager'

/**
 * `chrome.runtime.onConnect`のハンドラーを登録する。
 * content_scriptからのポート接続を受け取り、APIイベントの検証・DB保存・
 * 各ストリームへの書き込み・自動同期トリガーを行う。
 */
export const registerEventIngestion = (service: PokerChaseService): void => {
  chrome.runtime.onConnect.addListener(port => {
    if (port.name === PokerChaseService.POKER_CHASE_SERVICE_EVENT) {
      connectedPorts.add(port)
      port.onMessage.addListener(async (message: ApiMessage | { type: string }) => {
        // キープアライブメッセージの処理
        if (typeof message === 'object' && 'type' in message && message.type === 'keepalive') {
          return // キープアライブは処理のみで、それ以上何もしない
        }

        // Ensure service is ready before processing messages
        try {
          await service.ready
        } catch (err) {
          console.error('[background] Service not ready:', err)
          return
        }

        // Raw Event Lake（docs/architecture.md参照）: timestamp/ApiTypeIdが数値である
        // 限り、Zodパースの成否・アプリケーションイベントか否かに関わらず生のまま
        // 保存する。バリデーションは後続のリアルタイム処理パイプライン（ストリーム）
        // への投入可否のみを左右し、保存の可否は左右しない。これにより将来
        // PokerChase側のペイロード変更でスキーマ検証が壊れても、修正後のデータ
        // 再構築で復旧可能になる（2026年シーズン3のEVT_SESSION_RESULTS破壊的変更で
        // 実際にデータが失われた反省による）。
        if (validateMessage(message).success) {
          // Dexieの型はApiEvent（既知スキーマ）を想定しているが、Lakeとして未検証・
          // 未知のApiTypeIdの生イベントも意図的に保存するためアサーションが必要
          service.db.apiEvents.add(message as ApiEvent)
            .catch(err => console.error('[background] Failed to save event:', err))
        } else {
          // timestamp/ApiTypeIdが数値でない = キーとして使えないため保存不可
          console.warn('[background] Event missing numeric timestamp/ApiTypeId, cannot store:', message)
        }

        // Forced-update安全性述語（update-manager.ts）のセッション状態追跡:
        // content_script.tsのkeepaliveゲート（isGameActive）と同じ境界イベントを
        // Service Worker側で独立に追跡する（SW再起動でリセットされるため
        // content_script側の状態と厳密に同期している必要はない -- 保守的に
        // 「unknown = unsafe」から始まり、実イベント観測で確定させるだけでよい）。
        // 意図的にパース成功後のdata.ApiTypeIdではなく、ここで生メッセージの
        // 数値ApiTypeIdだけを見て判定する: PokerChase側の309ペイロード破壊的
        // 変更でparseApiEvent()がnullを返すようになっても、308で一度activeに
        // なったセッション状態が永久にinactiveへ戻らず、まさにその変更を
        // 修正する更新の安全性判定がずっとunsafeのまま詰まる、という事態を
        // 避けるため（codexレビュー指摘）
        const rawApiTypeId = (message as { ApiTypeId?: unknown }).ApiTypeId
        if (rawApiTypeId === ApiType.EVT_SESSION_DETAILS) {
          markSessionActive()
        } else if (rawApiTypeId === ApiType.EVT_SESSION_RESULTS) {
          markSessionInactive()
          // #179 round3指摘: セッション終了(EVT_SESSION_RESULTS)によるHUDクリアは
          // App.tsx側のReact stateだけで完結しており、background(ports.ts)の
          // `lastKnownStats`はセッションをまたいで残り続ける。この状態で
          // Popupのバトルタイプフィルターが変更されると、message-router.tsの
          // `updateBattleTypeFilter`ハンドラーが`getLastKnownStats()`（終了済み
          // lineupのまま）を使って`service.statsOutputStream.write(...)`を
          // 再トリガーし、ブロードキャストで終了済みlineupが復活してApp.tsxの
          // クリア済みパネルへ再度流し込まれてしまう。上と同じ「パース成功後の
          // data.ApiTypeIdではなく生メッセージの数値ApiTypeIdだけを見る」
          // raw-firstパターンで（309のペイロード破壊的変更に影響されないよう）
          // ここでlastKnownStatsを空にしておけば、以降のフィルター変更は
          // `lastKnownStats.length > 0`のガードに引っかからずセッション開始前と
          // 同じ「何もブロードキャストしない」挙動になる。プリゲーム・ヒーロー
          // スタッツの復元（#158, `requestLatestStats`→`getLatestSessionStats`）
          // はDBを読む別経路でありlastKnownStatsを参照しないため、この変更の
          // 影響を受けない。
          setLastKnownStats([])
        }

        // 通常のAPIメッセージ処理
        // Zodスキーマでパース（passthrough: 未知プロパティは保持）
        const data = parseApiEvent(message as ApiMessage)

        if (!data) {
          // パース失敗 = 必須プロパティ欠損など破壊的変更の可能性。生ログは上で
          // 既に保存済みなので、ここではリアルタイムパイプラインへの投入のみ諦める
          const validationResult = validateApiEvent(message as ApiMessage)
          const errorDetails = validationResult.error ? getValidationError(validationResult.error) : null
          console.warn(`[background] Schema validation failed (stored raw, pipeline skipped):\n  Errors: ${JSON.stringify(errorDetails, null, 2)}\n  Event: ${JSON.stringify(message, null, 2)}`)

          // drop可視化（docs/postmortems/2026-07-session-results-drop.md 再発防止#2）:
          // 検証失敗イベントの件数をApiTypeIdごとに集計してmetaテーブルへ永続化し、
          // Popupから可視化できるようにする。309インシデントは半年間これが
          // console.warnの中にしか無かったために気づけなかった
          if (typeof rawApiTypeId === 'number') {
            const rawTimestamp = (message as { timestamp?: unknown }).timestamp
            const eventTimestamp = typeof rawTimestamp === 'number' ? rawTimestamp : Date.now()
            recordUndecodedEvent(service.db, rawApiTypeId, eventTimestamp).catch(err =>
              console.error('[background] Failed to record undecoded event stats:', err)
            )
          }
          return
        }

        // アプリケーション用のイベントかチェック
        if (!isApplicationApiEvent(data)) {
          // アプリケーションで使用しないApiTypeIdのイベントはパイプラインに投入しないが
          // 内容は記録（生ログとしては上で既に保存済み）
          console.info(`[background] Non-application event (${data.ApiTypeId}): ${JSON.stringify(data)}`)
          return
        }

        // ここでdataはApiEvent型（isApplicationApiEventで保証済み）
        service.eventLogger(data, 'info')

        // ストリーム処理（DB保存は上で完了済み）
        service.handLogStream.write(data)
        service.handAggregateStream.write(data)
        service.realTimeStatsStream.write(data)

        // Handle game session end for auto sync
        // （セッション状態[markSessionActive/Inactive]は上の生メッセージ判定で
        // 追跡済み。ここはパース成功時のみ動く同期トリガー）
        if (data.ApiTypeId === ApiType.EVT_SESSION_RESULTS) {
          // セッション終了は保留中アップデートの安全性再チェック地点の1つ
          // （src/background/update-manager.ts参照）。recheckPendingUpdate()は
          // onGameSessionEnd()のPromiseが完了(成功/失敗いずれか)してから
          // 必ずチェーンして呼ぶ -- 両方を並列で撃つと、performSync()が
          // `_isSyncing`を立てる前の非同期区間（min-versionゲートのawait等）を
          // recheckPendingUpdate()がすり抜けて安全と誤判定し、直近セッションの
          // クラウドバックアップがまだ始まってもいないうちに
          // chrome.runtime.reload()でService Workerを巻き込んでしまう恐れが
          // あるため（codexレビュー指摘, P1）
          autoSyncService.onGameSessionEnd()
            .catch(err => console.error('[background] Auto sync on game end failed:', err))
            .finally(() => {
              recheckPendingUpdate().catch(err =>
                console.error('[background] Pending update recheck on session end failed:', err)
              )
            })
        } else if (data.ApiTypeId === ApiType.EVT_ENTRY_QUEUED || data.ApiTypeId === ApiType.EVT_SESSION_DETAILS) {
          // フォールバックトリガー（docs/postmortems/2026-07-session-results-drop.md
          // 再発防止#3）: 309単一トリガーのSPOF対策。新セッション開始時点は
          // 進行中ハンドが存在しない安全なタイミングなので、ここでも同じ閾値判定
          // でuploadを起動する（309が正常なら直前で既にバックログが閾値未満に
          // なっているため二重発火しない）
          autoSyncService.onNewSessionStart().catch(err =>
            console.error('[background] Auto sync on new session start failed:', err)
          )
        }
      })
      const stopPing = startPortPing(port)

      // Clean up when port disconnects
      port.onDisconnect.addListener(() => {
        // Keep lastKnownStats for page reloads - only clear interval
        stopPing()
        connectedPorts.delete(port)
      })
    }
  })
}
