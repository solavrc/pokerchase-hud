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
import { connectedPorts, startPortPing } from './ports'
import { recordUndecodedEvent } from './undecoded-event-tracker'

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
          const rawApiTypeId = (message as { ApiTypeId?: unknown }).ApiTypeId
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
        if (data.ApiTypeId === ApiType.EVT_SESSION_RESULTS) {
          autoSyncService.onGameSessionEnd().catch(err =>
            console.error('[background] Auto sync on game end failed:', err)
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
