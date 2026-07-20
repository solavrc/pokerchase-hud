/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
import PokerChaseService, { PokerChaseDB } from '../app'
import type {
  ChromeMessage,
  ImportStatusMessage,
  LatestStatsMessage,
  MessageResponse
} from '../types/messages'
import { getPositionalStats } from '../services/positional-stats-service'
import { firebaseAuthService } from '../services/firebase-auth-service'
import { autoSyncService } from '../services/auto-sync-service'
import { getOperationState, isOperationIdle } from './operation-state'
import { getLastKnownStats, setLastKnownStats } from './ports'
import { resolveAdvisory } from './rebuild-advisory'
import { getUndecodedEventStats, resetUndecodedEventStats } from './undecoded-event-tracker'
import { applyUpdateNow } from './update-manager'
import {
  createImportExportHandlers,
  getCurrentImportSession,
  startImportSession,
  addImportChunk,
  clearImportSession
} from './import-export'

/**
 * Firebase Auth Handlers
 */
const handleFirebaseSignIn = async (): Promise<void> => {
  try {
    const user = await firebaseAuthService.signInWithGoogle()
    console.log('[Firebase] User signed in:', user.email)

    // Initialize auto sync after sign in
    await autoSyncService.onAuthStateChanged(user)
  } catch (error) {
    console.error('[Firebase] Sign in error:', error)
    throw error
  }
}

const handleFirebaseSignOut = async (): Promise<void> => {
  try {
    await firebaseAuthService.signOut()
    console.log('[Firebase] User signed out')

    // Update sync state
    await autoSyncService.onAuthStateChanged(null)
  } catch (error) {
    console.error('[Firebase] Sign out error:', error)
    throw error
  }
}

/**
 * データエクスポート機能
 * `chrome.runtime.onMessage`のディスパッチを登録する。
 */
export const registerMessageRouter = (service: PokerChaseService, db: PokerChaseDB, gameUrlPattern: string): void => {
  const { exportData, importData, deleteAllData, getLatestSessionStats, rebuildAllData } = createImportExportHandlers(service, db, gameUrlPattern)

  const rejectIfOperationBusy = (action: string, sendResponse: (response: MessageResponse) => void): boolean => {
    if (isOperationIdle()) return false

    console.warn(`[${action}] Blocked: operation already in progress (${getOperationState().type})`)
    sendResponse({ success: false, error: '別の処理が実行中です' })
    return true
  }

  chrome.runtime.onMessage.addListener((request: ChromeMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: MessageResponse) => void) => {
    if (request.action === 'exportData') {
      // Block concurrent operations
      if (rejectIfOperationBusy('exportData', sendResponse)) return true
      exportData(request.format)
        .then(() => sendResponse({ success: true }))
        .catch(error => {
          console.error('Export error:', error)
          sendResponse({ success: false, error: error.message })
        })
      return true // 非同期レスポンスを示す
    } else if (request.action === 'importData') {
      if (rejectIfOperationBusy('importData', sendResponse)) return true
      importData(request.data)
        .then((result) => {
          chrome.runtime.sendMessage<ImportStatusMessage>({
            action: 'importStatus',
            status: `インポートが完了しました (${result.successCount.toLocaleString()}件のログ${result.duplicateCount > 0 ? `, ${result.duplicateCount.toLocaleString()}件の重複をスキップ` : ''})`
          })
          sendResponse({ success: true })
        })
        .catch(error => {
          console.error('Import error:', error)
          chrome.runtime.sendMessage<ImportStatusMessage>({
            action: 'importStatus',
            status: 'インポートに失敗しました: ' + error.message
          })
          sendResponse({ success: false, error: error.message })
        })
      return true // 非同期レスポンスを示す
    } else if (request.action === 'importDataInit') {
      if (rejectIfOperationBusy('importDataInit', sendResponse)) return true
      startImportSession(request.totalChunks, request.fileName)
      sendResponse({ success: true })
      return true
    } else if (request.action === 'importDataChunk') {
      if (!getCurrentImportSession()) {
        sendResponse({ success: false, error: 'No import session active' })
        return true
      }

      addImportChunk(request.chunkIndex, request.chunkData)

      sendResponse({ success: true })
      return true
    } else if (request.action === 'importDataProcess') {
      const currentImportSession = getCurrentImportSession()
      if (!currentImportSession || currentImportSession.chunks.length !== currentImportSession.totalChunks) {
        sendResponse({ success: false, error: 'Import session incomplete' })
        return true
      }

      if (rejectIfOperationBusy('importDataProcess', sendResponse)) return true

      // すべてのチャンクを結合
      const completeData = currentImportSession.chunks.join('')
      clearImportSession() // セッションをクリア

      // データを処理
      importData(completeData)
        .then((result) => {
          chrome.runtime.sendMessage<ImportStatusMessage>({
            action: 'importStatus',
            status: `インポートが完了しました (${result.successCount.toLocaleString()}件のログ${result.duplicateCount > 0 ? `, ${result.duplicateCount.toLocaleString()}件の重複をスキップ` : ''})`
          })
          sendResponse({ success: true })
        })
        .catch(error => {
          console.error('Import error:', error)
          chrome.runtime.sendMessage<ImportStatusMessage>({
            action: 'importStatus',
            status: 'インポートに失敗しました: ' + error.message
          })
          sendResponse({ success: false, error: error.message })
        })
      return true
    } else if (request.action === 'updateBattleTypeFilter') {
      // フィルター値がundefinedかチェック
      if (!request.filterOptions) {
        sendResponse({ success: false, error: 'No filter options provided' })
        return true
      }

      // サービス内のフィルターを更新
      service.setBattleTypeFilter(request.filterOptions)
        .then(() => {
          sendResponse({ success: true })
        })
        .catch((error: Error) => {
          console.error('[background.ts] Filter update error:', error)
          sendResponse({ success: false, error: error.message })
        })

      // 永続化はPopup側（saveOptions）が行う。ここで部分オブジェクトを
      // 書き戻すとsendUserData等を落としたoptionsで上書きしてしまう

      // コンテンツスクリプトにメッセージを転送
      chrome.tabs.query({ url: gameUrlPattern }, tabs => {
        tabs.forEach(tab => tab.id && chrome.tabs.sendMessage(tab.id, request))
      })

      // 新しいフィルターに基づいてHUD表示を強制更新
      const lastKnownStats = getLastKnownStats()
      if (lastKnownStats.length > 0) {
        // 現在の席ユーザーIDで計算を再トリガー
        service.statsOutputStream.write(lastKnownStats.map(stat => stat.playerId))
      }

      return true // 非同期レスポンスを示す
    } else if (request.action === 'requestLatestStats') {
      getLatestSessionStats(request.preGame === true)
        .then(stats => {
          // 空配列は「送るものが無い」の意味（プリゲーム・ヒーロースタッツの
          // フォールバック条件を満たさない場合など、import-export.ts参照）。
          // ここで stats:[] を送ってしまうと、呼び出し側（App.tsx）の
          // 既存state（EMPTY_SEATS初期値やライブパイプラインの現在値）を
          // 空配列で上書きしてHUD全体を一瞬ブランクにしてしまうため送らない。
          if (sender.tab?.id && stats.length > 0) {
            chrome.tabs.sendMessage<LatestStatsMessage>(sender.tab.id, {
              action: 'latestStats',
              stats: stats
            })
          }
          sendResponse({ success: true })
        })
        .catch(error => {
          console.error('Error getting latest stats:', error)
          sendResponse({ success: false, error: error.message })
        })
      return true
    } else if (request.action === 'deleteAllData') {
      // ログと設定を含むすべてのデータを削除
      deleteAllData()
        .then(() => {
          sendResponse({ success: true })
          // キャッシュされた統計をクリア
          setLastKnownStats([])
        })
        .catch(error => {
          console.error('Error deleting data:', error)
          sendResponse({ success: false, error: error.message })
        })
      return true
    } else if (request.action === 'firebaseAuthStatus') {
      // Check current auth status
      const isSignedIn = firebaseAuthService.isSignedIn()
      const userInfo = firebaseAuthService.getUserInfo()

      sendResponse({ success: true, isSignedIn, userInfo })
      return true
    } else if (request.action === 'firebaseSignIn') {
      // Firebase sign in
      handleFirebaseSignIn()
        .then(() => sendResponse({ success: true }))
        .catch(error => {
          console.error('Firebase sign in error:', error)
          sendResponse({ success: false, error: error.message })
        })
      return true
    } else if (request.action === 'firebaseSignOut') {
      // Firebase sign out
      handleFirebaseSignOut()
        .then(() => sendResponse({ success: true }))
        .catch(error => {
          console.error('Firebase sign out error:', error)
          sendResponse({ success: false, error: error.message })
        })
      return true
    } else if (request.action === 'firebaseSyncToCloud' || request.action === 'firebaseSyncFromCloud') {
      // Manual sync now uses auto sync service
      autoSyncService.performSync()
        .then(() => sendResponse({ success: true }))
        .catch(error => {
          console.error('Manual sync error:', error)
          sendResponse({ success: false, error: error.message })
        })
      return true
    } else if (request.action === 'manualSyncUpload') {
      // Manual upload to cloud
      autoSyncService.performSync('upload')
        .then(() => sendResponse({ success: true }))
        .catch(error => {
          console.error('Manual upload error:', error)
          sendResponse({ success: false, error: error.message })
        })
      return true
    } else if (request.action === 'manualSyncDownload') {
      // Manual download from cloud
      autoSyncService.performSync('download')
        .then(() => sendResponse({ success: true }))
        .catch(error => {
          console.error('Manual download error:', error)
          sendResponse({ success: false, error: error.message })
        })
      return true
    } else if (request.action === 'getSyncState') {
      // Get current sync state
      const state = autoSyncService.getSyncState()
      sendResponse({ success: true, syncState: state })
      return false
    } else if (request.action === 'getUnsyncedCount') {
      // Get unsynced event count
      autoSyncService.getUnsyncedEventCount()
        .then(count => {
          sendResponse({ success: true, count })
        })
        .catch(error => {
          console.error('Error getting unsynced count:', error)
          sendResponse({ success: false, error: error.message })
        })
      return true
    } else if (request.action === 'getSyncInfo') {
      // Get detailed sync information
      autoSyncService.getSyncInfo()
        .then(info => {
          sendResponse({ success: true, syncInfo: info })
        })
        .catch(error => {
          console.error('Error getting sync info:', error)
          sendResponse({ success: false, error: error.message })
        })
      return true
    } else if (request.action === 'rebuildData') {
      // Block concurrent operations
      if (!isOperationIdle()) {
        console.warn(`[rebuildData] Blocked: operation already in progress (${getOperationState().type})`)
        sendResponse({ success: false, error: '別の処理が実行中です' })
        return true
      }
      // 手動でのデータ再構築
      console.log('[rebuildData] Starting manual data rebuild...')

      // バッチモードで全データを再構築（ダウンロード同期と同じ処理）
      rebuildAllData()
        .then(() => {
          console.log('[rebuildData] Data rebuild completed')
          sendResponse({ success: true })
        })
        .catch(error => {
          console.error('[rebuildData] Error rebuilding data:', error)
          sendResponse({ success: false, error: error.message })
        })
      return true
    } else if (request.action === 'getOperationState') {
      console.log('[getOperationState]', JSON.stringify(getOperationState()))
      sendResponse({ success: true, operationState: getOperationState() })
      return true
    } else if (request.action === 'acknowledgeRebuildAdvisory') {
      // Popupのバナー「閉じる」によるアドバイザリの手動解消
      resolveAdvisory()
        .then(() => sendResponse({ success: true }))
        .catch(error => {
          console.error('[acknowledgeRebuildAdvisory] Error:', error)
          sendResponse({ success: false, error: error.message })
        })
      return true
    } else if (request.action === 'getPositionalStats') {
      // ポジション別スタッツ・ドリルダウン
      getPositionalStats(db, service, request.playerId)
        .then(positionalStats => {
          sendResponse({ success: true, positionalStats })
        })
        .catch(error => {
          console.error('[getPositionalStats] Error:', error)
          sendResponse({ success: false, error: error.message })
        })
      return true
    } else if (request.action === 'getUndecodedEventStats') {
      // drop可視化: 未解釈イベントの集計値を取得
      getUndecodedEventStats(db)
        .then(undecodedEventStats => {
          sendResponse({ success: true, undecodedEventStats })
        })
        .catch(error => {
          console.error('[getUndecodedEventStats] Error:', error)
          sendResponse({ success: false, error: error.message })
        })
      return true
    } else if (request.action === 'acknowledgeUndecodedEventStats') {
      // Popupの「確認済みにする」操作: カウンタをリセット
      resetUndecodedEventStats(db)
        .then(() => sendResponse({ success: true }))
        .catch(error => {
          console.error('[acknowledgeUndecodedEventStats] Error:', error)
          sendResponse({ success: false, error: error.message })
        })
      return true
    } else if (request.action === 'applyPendingUpdate') {
      // Popupの「今すぐ適用」操作: 安全性を再チェックしてから適用（unsafeなら理由を返す）
      applyUpdateNow()
        .then(result => sendResponse({ success: true, applied: result.applied, reason: result.reason }))
        .catch(error => {
          console.error('[applyPendingUpdate] Error:', error)
          sendResponse({ success: false, error: error.message })
        })
      return true
    }
    return false
  })
}
