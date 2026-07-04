/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
import PokerChaseService, {
  ApiType,
  ApiMessage,
  validateApiEvent,
  parseApiEvent,
  getValidationError,
  isApplicationApiEvent
} from '../app'
import { autoSyncService } from '../services/auto-sync-service'
import { connectedPorts, startPortPing } from './ports'

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

        // 通常のAPIメッセージ処理
        // Zodスキーマでパース（passthrough: 未知プロパティは保持）
        const data = parseApiEvent(message as ApiMessage)

        if (!data) {
          // パース失敗 = 必須プロパティ欠損など破壊的変更の可能性
          const validationResult = validateApiEvent(message as ApiMessage)
          const errorDetails = validationResult.error ? getValidationError(validationResult.error) : null
          console.warn(`[background] Schema validation failed (event dropped):\n  Errors: ${JSON.stringify(errorDetails, null, 2)}\n  Event: ${JSON.stringify(message, null, 2)}`)
          return
        }

        // アプリケーション用のイベントかチェック
        if (!isApplicationApiEvent(data)) {
          // アプリケーションで使用しないApiTypeIdのイベントはDB保存しないが内容は記録
          console.info(`[background] Non-application event (${data.ApiTypeId}): ${JSON.stringify(data)}`)
          return
        }

        // ここでdataはApiEvent型（isApplicationApiEventで保証済み）
        service.eventLogger(data, 'info')

        // DB保存とストリーム処理
        service.db.apiEvents.add(data)
          .catch(err => console.error('[background] Failed to save event:', err))
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
