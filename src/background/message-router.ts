/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
import PokerChaseService, { PokerChaseDB } from '../app'
import type {
  ChromeMessage,
  ImportStatusMessage,
  LatestStatsMessage,
  MessageResponse
} from '../types/messages'
import { getPositionalStats } from '../services/positional-stats-service'
import { getRecentHands } from '../services/recent-hands-service'
import { firebaseAuthService } from '../services/firebase-auth-service'
import { autoSyncService } from '../services/auto-sync-service'
import { getOperationState, isOperationIdle } from './operation-state'
import { getLastKnownStats, setLastKnownStats, getLiveBroadcastSequence } from './ports'
import { resolveAdvisory } from './rebuild-advisory'
import { getUndecodedEventStats, resetUndecodedEventStats } from './undecoded-event-tracker'
import { applyUpdateNow } from './update-manager'
import { acknowledgeWhatsNew } from './whats-new-badge'
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

    // A newer sign-in may have waited for this sign-out and published its
    // account as soon as the auth operation settled. Do not let this older
    // message continuation overwrite that account's freshly initialized sync
    // state with a stale signed-out reset.
    if (!firebaseAuthService.getCurrentUser()) {
      await autoSyncService.onAuthStateChanged(null)
    }
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
          }).catch(() => {})
          sendResponse({ success: true })
        })
        .catch(error => {
          console.error('Import error:', error)
          chrome.runtime.sendMessage<ImportStatusMessage>({
            action: 'importStatus',
            status: 'インポートに失敗しました: ' + error.message
          }).catch(() => {})
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
      if (getOperationState().type !== 'import') {
        console.warn(`[importDataChunk] Blocked: operation already in progress (${getOperationState().type})`)
        sendResponse({ success: false, error: '別の処理が実行中です' })
        return true
      }

      if (!addImportChunk(request.chunkIndex, request.chunkData)) {
        sendResponse({ success: false, error: 'Invalid import chunk index' })
        return true
      }

      sendResponse({ success: true })
      return true
    } else if (request.action === 'importDataProcess') {
      const currentImportSession = getCurrentImportSession()
      if (!currentImportSession || currentImportSession.receivedChunks !== currentImportSession.totalChunks) {
        sendResponse({ success: false, error: 'Import session incomplete' })
        return true
      }

      // importDataInit already owns this slot. Any other type here means
      // state was externally replaced; preserve the complete session so it
      // can be retried after that operation finishes.
      if (getOperationState().type !== 'import') {
        console.warn(`[importDataProcess] Blocked: operation already in progress (${getOperationState().type})`)
        sendResponse({ success: false, error: '別の処理が実行中です' })
        return true
      }

      // すべてのチャンクを結合
      const completeData = currentImportSession.chunks.join('')
      clearImportSession(false) // importData()が同じslotを引き継ぐ

      // データを処理
      importData(completeData)
        .then((result) => {
          chrome.runtime.sendMessage<ImportStatusMessage>({
            action: 'importStatus',
            status: `インポートが完了しました (${result.successCount.toLocaleString()}件のログ${result.duplicateCount > 0 ? `, ${result.duplicateCount.toLocaleString()}件の重複をスキップ` : ''})`
          }).catch(() => {})
          sendResponse({ success: true })
        })
        .catch(error => {
          console.error('Import error:', error)
          chrome.runtime.sendMessage<ImportStatusMessage>({
            action: 'importStatus',
            status: 'インポートに失敗しました: ' + error.message
          }).catch(() => {})
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
        tabs.forEach(tab => {
          if (!tab.id) return
          chrome.tabs.sendMessage(tab.id, request).catch(error => {
            // This is a one-way update: the content script intentionally does
            // not respond, and it can also disappear during navigation.
            const message = error instanceof Error ? error.message : ''
            if (!message.includes('Receiving end does not exist') &&
                !message.includes('message port closed before a response was received')) {
              console.warn(`[background] Failed to forward filter update to tab ${tab.id}:`, error)
            }
          })
        })
      })

      // setBattleTypeFilter() already starts the authoritative, hero-anchored
      // recalculateStats() path. Re-triggering the same stats stream from a
      // freshly mapped lastKnownStats lineup loses its WeakMap-bound session
      // scope/originating DEAL and can race the authoritative calculation.
      // Retain the historical fallback only for incomplete restored states in
      // which recalculateStats() cannot emit anything by itself.
      const lastKnownStats = getLastKnownStats()
      const sessionOnlyEmptyRefreshWillRun =
        service.sessionOnlyFilter && !service.isSessionDisplayDealAvailable()
      const heroAnchoredRefreshWillRun =
        service.playerId !== undefined && service.latestEvtDeal !== undefined
      if (
        lastKnownStats.length > 0 &&
        !sessionOnlyEmptyRefreshWillRun &&
        !heroAnchoredRefreshWillRun
      ) {
        const lastKnownLineup = lastKnownStats.map(stat => stat.playerId)
        service.statsOutputStream.write(lastKnownLineup)
      }

      return true // 非同期レスポンスを示す
    } else if (request.action === 'requestLatestStats') {
      const preGame = request.preGame === true
      // プリゲーム・ヒーロースタッツのレース対策: getLatestSessionStats()は
      // service.ready/filtersRestoredを待ってからDBを読むため、その待機中に
      // 本物のEVT_DEALがこのタブのportを経由して処理され、ライブの完全な
      // 席順がbroadcastMessage（ports.ts）で先にこのタブへ届く可能性がある。
      // その場合、後から届くヒーロー単独のフォールバックを送ってしまうと、
      // 届いたばかりのライブ席順を上書きしてしまう。この一手リクエストを
      // 受け取った時点のliveBroadcastSequenceを控えておき、フォールバック
      // 計算が終わった時点で値が変わっていれば「待機中に本物のブロード
      // キャストが発生した」ということなので、送信せず静かに捨てる。
      // （`lastKnownStats.length > 0`のような単純な非空チェックでは代用
      // できない -- Service Workerの生存期間中はタブを跨いで残り続けるため、
      // このセッションで最初のハンドが終わった後は常に非空になってしまい、
      // 無関係な別タブのマウントでもフォールバックが永久に抑制されてしまう）
      const liveBroadcastSequenceAtRequest = getLiveBroadcastSequence()
      getLatestSessionStats(preGame)
        .then(stats => {
          if (preGame && getLiveBroadcastSequence() !== liveBroadcastSequenceAtRequest) {
            sendResponse({ success: true })
            return
          }
          // 空配列は「送るものが無い」の意味（プリゲーム・ヒーロースタッツの
          // フォールバック条件を満たさない場合など、import-export.ts参照）。
          // ここで stats:[] を送ってしまうと、呼び出し側（App.tsx）の
          // 既存state（EMPTY_SEATS初期値やライブパイプラインの現在値）を
          // 空配列で上書きしてHUD全体を一瞬ブランクにしてしまうため送らない。
          if (sender.tab?.id && stats.length > 0) {
            chrome.tabs.sendMessage<LatestStatsMessage>(sender.tab.id, {
              action: 'latestStats',
              stats: stats
            }).catch(error => {
              // The requesting content script can disappear while the DB-backed
              // fallback is being calculated (navigation, reload, or extension
              // update). Delivery is best-effort once that receiver is gone.
              if (!(error instanceof Error) || !error.message.includes('Receiving end does not exist')) {
                console.warn(`[background] Failed to deliver latest stats to tab ${sender.tab?.id}:`, error)
              }
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
      if (rejectIfOperationBusy('deleteAllData', sendResponse)) return true
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
      // Auth restore starts independently when the Service Worker module is
      // loaded. Do not answer from the initial in-memory `null` before the
      // persisted state has finished restoring.
      firebaseAuthService.ready()
        .then(() => {
          const isSignedIn = firebaseAuthService.isSignedIn()
          const userInfo = firebaseAuthService.getUserInfo()
          sendResponse({ success: true, isSignedIn, userInfo })
        })
        .catch(error => {
          console.error('Firebase auth status error:', error)
          sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) })
        })
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
      // Manual sync now uses auto sync service.
      // performSync() never rejects on an internal sync failure (see its own
      // never-throw contract, relied on by initialize()/
      // syncIfBacklogExceedsThreshold()) -- it reports failure via the
      // resolved SyncOutcome instead (min-version gate block, Firestore
      // error, etc.). Forwarding `.then(() => sendResponse({success:true}))`
      // unconditionally here used to report success even when the sync
      // itself failed (independent release-audit finding #12) -- the
      // resolved outcome must be inspected, not just its resolution.
      autoSyncService.performSync()
        .then(result => sendResponse(result.success ? { success: true } : { success: false, error: result.error }))
        .catch(error => {
          console.error('Manual sync error:', error)
          sendResponse({ success: false, error: error.message })
        })
      return true
    } else if (request.action === 'manualSyncUpload') {
      // Manual upload to cloud (see the truthful-outcome note above)
      autoSyncService.performSync('upload')
        .then(result => sendResponse(result.success ? { success: true } : { success: false, error: result.error }))
        .catch(error => {
          console.error('Manual upload error:', error)
          sendResponse({ success: false, error: error.message })
        })
      return true
    } else if (request.action === 'manualSyncDownload') {
      // Manual download from cloud (see the truthful-outcome note above)
      autoSyncService.performSync('download')
        .then(result => sendResponse(result.success ? { success: true } : { success: false, error: result.error }))
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
      getPositionalStats(db, service, request.playerId, request.sessionScopeKey)
        .then(positionalStats => {
          sendResponse({ success: true, positionalStats })
        })
        .catch(error => {
          console.error('[getPositionalStats] Error:', error)
          sendResponse({ success: false, error: error.message })
        })
      return true
    } else if (request.action === 'getRecentHands') {
      // 直近ハンド・ドリルダウン
      getRecentHands(db, service, request.playerId, request.limit, request.sessionScopeKey)
        .then(recentHands => {
          sendResponse({ success: true, recentHands })
        })
        .catch(error => {
          console.error('[getRecentHands] Error:', error)
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
    } else if (request.action === 'acknowledgeWhatsNew') {
      // Popupの更新情報セクション（WhatsNewSection）マウント時の既読化
      acknowledgeWhatsNew()
        .then(() => sendResponse({ success: true }))
        .catch(error => {
          console.error('[acknowledgeWhatsNew] Error:', error)
          sendResponse({ success: false, error: error.message })
        })
      return true
    }
    return false
  })
}
