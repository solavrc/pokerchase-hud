/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
import PokerChaseService, { PokerChaseDB } from '../app'
import { DEFAULT_UI_CONFIG } from '../types/hand-log'
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
import { getLastKnownStats, setLastKnownStats, getLiveBroadcastSequenceForTab } from './ports'
import { resolveAdvisory } from './rebuild-advisory'
import { getUndecodedEventStats, resetUndecodedEventStats } from './undecoded-event-tracker'
import { applyUpdateNow } from './update-manager'
import { acknowledgeWhatsNew } from './whats-new-badge'
import { evaluateReviewPromptVisibility, resolveReviewPrompt } from './review-prompt'
import {
  HAND_LOG_LAYOUT_STORAGE_KEY,
  HUD_POSITION_STORAGE_KEYS,
  hudPositionStorageKey,
  isValidHandLogLayout,
  isValidHudPosition,
  isValidHudPositionId,
  isValidUIScale,
  LEGACY_SYNC_UI_SCALE_KEY,
  persistSyncedUIConfig,
  persistSyncedUIConfigPatch,
  resolveLocalUIScale,
  UI_SCALE_STORAGE_KEY,
} from '../utils/ui-config-storage'
import {
  IMPORT_RESULT_STORAGE_KEY,
  type ImportResultRecord,
} from '../constants/import-page'
import {
  createImportExportHandlers,
  getCurrentImportSession,
  startImportSession,
  addImportChunk,
  clearImportSession
} from './import-export'
import {
  enqueuePendingStorageWrite,
  getPendingStorageWriteTail,
  hasPendingStorageWrites,
} from './pending-storage-writes'

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

const publishImportResult = async (
  status: ImportResultRecord['status'],
  message: string
): Promise<void> => {
  const result: ImportResultRecord = {
    status,
    message,
    completedAt: Date.now(),
  }
  try {
    await chrome.storage.local.set({ [IMPORT_RESULT_STORAGE_KEY]: result })
  } catch (error) {
    console.warn('[importData] Failed to persist import result:', error)
  }
  chrome.runtime.sendMessage<ImportStatusMessage>({
    action: 'importStatus',
    status: message,
  }).catch(() => {})
}

/**
 * データエクスポート機能
 * `chrome.runtime.onMessage`のディスパッチを登録する。
 */
export const registerMessageRouter = (service: PokerChaseService, db: PokerChaseDB, gameUrlPattern: string): void => {
  const { exportData, importData, deleteAllData, getLatestSessionStats, rebuildAllData } = createImportExportHandlers(service, db, gameUrlPattern)
  let deviceScaleWriteGeneration = 0
  let handLogLayoutWriteGeneration = 0
  let pendingHandLogLayoutWriteCount = 0
  const pendingHandLogLayoutReads: Array<() => void> = []

  const broadcastToGameTabs = (
    message: ChromeMessage,
    complete: () => void
  ): void => {
    chrome.tabs.query({ url: gameUrlPattern }, tabs => {
      void chrome.runtime.lastError
      const deliveries: Array<Promise<unknown>> = []
      for (const tab of tabs ?? []) {
        if (!tab.id) continue
        deliveries.push(
          chrome.tabs.sendMessage(tab.id, message).catch(() => {
            // Matching tabs can navigate between query and delivery. Persisted
            // layout remains authoritative for the next mount.
          })
        )
      }
      void Promise.all(deliveries).then(complete)
    })
  }

  const flushPendingHandLogLayoutReads = (): void => {
    if (pendingHandLogLayoutWriteCount > 0) return
    const pendingReads = pendingHandLogLayoutReads.splice(0)
    pendingReads.forEach(read => read())
  }

  /**
   * `operation` signals completion by invoking its callback. It MAY pass an
   * error explicitly; otherwise `chrome.runtime.lastError` is read at that
   * moment. The explicit form exists for multi-write operations that must
   * publish their own state before reporting: any chrome API call in between
   * (a broadcast, a follow-up write) overwrites `lastError`, so an operation
   * that does more than one thing has to carry its own error forward.
   */
  const enqueueHandLogLayoutWrite = (
    operation: (callback: (explicitError?: chrome.runtime.LastError) => void) => void,
    sendResponse: (response: MessageResponse) => void,
    failureMessage: string,
    afterSuccessfulWrite?: (complete: () => void) => void
  ): void => {
    handLogLayoutWriteGeneration += 1
    const generation = handLogLayoutWriteGeneration
    pendingHandLogLayoutWriteCount += 1

    void enqueuePendingStorageWrite(() =>
      new Promise<chrome.runtime.LastError | undefined>((resolve) => {
        operation((explicitError) => {
          const error = explicitError ?? chrome.runtime.lastError
          if (error || !afterSuccessfulWrite) {
            resolve(error)
            return
          }
          // Publish every successfully persisted state in FIFO order. A newer
          // success will overwrite this delivery, while a newer failure leaves
          // the last durable state visible instead of stranding the HUD on a
          // value that was never saved.
          afterSuccessfulWrite(() => resolve(undefined))
        })
      })
    ).then(error => {
      const superseded = generation !== handLogLayoutWriteGeneration
      sendResponse(
        error
          ? { success: false, error: error.message ?? failureMessage }
          : superseded
            ? { success: false, error: 'Superseded by newer hand log layout' }
            : { success: true }
      )
    }, error => {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : failureMessage,
      })
    }).finally(() => {
      pendingHandLogLayoutWriteCount -= 1
      flushPendingHandLogLayoutReads()
    })
  }

  const enqueueHandLogLayoutRead = (read: () => void): void => {
    if (pendingHandLogLayoutWriteCount > 0) {
      pendingHandLogLayoutReads.push(read)
      return
    }
    read()
  }

  const enqueueDeviceScaleWrite = (
    scale: number,
    complete: (error: chrome.runtime.LastError | undefined) => void
  ): void => {
    void enqueuePendingStorageWrite(() =>
      new Promise<chrome.runtime.LastError | undefined>((resolve) => {
        chrome.storage.local.set({ [UI_SCALE_STORAGE_KEY]: scale }, () => {
          const error = chrome.runtime.lastError
          if (error) {
            resolve(error)
            return
          }
          // Dispatch from the persistent background before this queue entry
          // settles; popup teardown cannot suppress the live HUD update, and
          // forced reload cannot overtake the tabs.query handoff.
          broadcastToGameTabs({
            action: 'updateDeviceUIScale',
            scale,
          }, () => resolve(undefined))
        })
      })
    ).then(complete, error => {
      complete({
        message: error instanceof Error
          ? error.message
          : 'Failed to save UI scale',
      })
    })
  }

  const rejectIfOperationBusy = (action: string, sendResponse: (response: MessageResponse) => void): boolean => {
    if (isOperationIdle()) return false

    console.warn(`[${action}] Blocked: operation already in progress (${getOperationState().type})`)
    sendResponse({ success: false, error: '別の処理が実行中です' })
    return true
  }

  chrome.runtime.onMessage.addListener((request: ChromeMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: MessageResponse) => void) => {
    if (request.action === 'setSyncedUIConfig') {
      const persist = (complete: (success: boolean) => void) => {
        if (request.patch) {
          persistSyncedUIConfigPatch(request.patch, complete)
        } else {
          persistSyncedUIConfig(request.config, complete)
        }
      }
      void enqueuePendingStorageWrite(() =>
        new Promise<boolean>(resolve => persist(resolve))
      ).then(success => {
        sendResponse(success
          ? { success: true }
          : { success: false, error: 'Failed to save synchronized UI config' })
      }, () => {
        sendResponse({ success: false, error: 'Failed to save synchronized UI config' })
      })
      return true
    } else if (request.action === 'getDeviceUILayout') {
      if (request.seatIndex !== undefined && !isValidHudPositionId(request.seatIndex)) {
        sendResponse({ success: false, error: 'Invalid HUD seat index' })
        return true
      }
      const positionKey = request.seatIndex === undefined
        ? undefined
        : hudPositionStorageKey(request.seatIndex)
      // A write queued before this read may not have reached chrome.storage
      // yet. Capture the generation before waiting so later user writes still
      // invalidate migration, while earlier writes become visible to the read.
      const scaleMigrationGeneration = deviceScaleWriteGeneration
      const readDeviceLayout = () => {
        chrome.storage.local.get(
          positionKey ? [UI_SCALE_STORAGE_KEY, positionKey] : UI_SCALE_STORAGE_KEY,
          (localResult: Record<string, unknown>) => {
          const localReadError = chrome.runtime.lastError
          if (localReadError) {
            sendResponse({
              success: false,
              error: localReadError.message ?? 'Failed to read device layout',
            })
            return
          }
          const localScale = localResult[UI_SCALE_STORAGE_KEY]
          const localPosition = positionKey && isValidHudPosition(localResult[positionKey])
            ? localResult[positionKey]
            : undefined
          const needsScaleMigration = !isValidUIScale(localScale)

          const respond = (
            scale: number,
            position: typeof localPosition
          ) => {
            sendResponse({
              success: true,
              scale,
              ...(position ? { position } : {}),
            })
          }

          if (!needsScaleMigration) {
            respond(resolveLocalUIScale(localScale), localPosition)
            return
          }

          chrome.storage.sync.get(
            [LEGACY_SYNC_UI_SCALE_KEY, 'uiConfig'],
            (syncResult: Record<string, unknown>) => {
              const syncReadError = chrome.runtime.lastError
              if (syncReadError) {
                sendResponse({
                  success: false,
                  error: syncReadError.message ?? 'Failed to migrate device layout',
                })
                return
              }
              const legacyUIConfig = syncResult.uiConfig as
                | { scale?: unknown }
                | undefined
              const preservedLegacyScale = syncResult[LEGACY_SYNC_UI_SCALE_KEY]
              const liveLegacyScale = isValidUIScale(legacyUIConfig?.scale)
                ? legacyUIConfig.scale
                : undefined
              const migratedScale = liveLegacyScale
                ?? (isValidUIScale(preservedLegacyScale)
                  ? preservedLegacyScale
                  : undefined
                )
              const scale = resolveLocalUIScale(
                isValidUIScale(localScale) ? localScale : migratedScale
              )

              // Keep the pre-local-storage value in the migration snapshot as
              // well as the mixed-version compatibility field in uiConfig.
              // New local scale edits never update either synchronized value.
              if (
                needsScaleMigration &&
                migratedScale !== undefined &&
                preservedLegacyScale !== migratedScale
              ) {
                chrome.storage.sync.set({
                  [LEGACY_SYNC_UI_SCALE_KEY]: migratedScale,
                }, () => {
                  void chrome.runtime.lastError
                })
              }

              const scaleWriteIsCurrent =
                deviceScaleWriteGeneration === scaleMigrationGeneration

              const respondWithLatestLayout = () => {
                chrome.storage.local.get(
                  positionKey
                    ? [UI_SCALE_STORAGE_KEY, positionKey]
                    : UI_SCALE_STORAGE_KEY,
                  (latestResult: Record<string, unknown>) => {
                    void chrome.runtime.lastError
                    const latestPosition = positionKey &&
                      isValidHudPosition(latestResult[positionKey])
                      ? latestResult[positionKey]
                      : localPosition
                    const latestScale = latestResult[UI_SCALE_STORAGE_KEY]
                    respond(
                      isValidUIScale(latestScale) ? latestScale : scale,
                      latestPosition
                    )
                  }
                )
              }

              if (!scaleWriteIsCurrent) {
                // A newer user-selected scale is already represented by the
                // shared FIFO tail, but may not have reached chrome.storage
                // yet. Read only after it settles so this older migration
                // response cannot briefly publish the stale legacy value.
                void getPendingStorageWriteTail().then(respondWithLatestLayout)
                return
              }

              if (migratedScale === undefined) {
                respondWithLatestLayout()
                return
              }

              enqueueDeviceScaleWrite(migratedScale, () => {
                // Migration is best-effort for persistence. Returning the
                // valid legacy values still preserves this session's layout.
                respondWithLatestLayout()
              })
            }
          )
          }
        )
      }
      if (hasPendingStorageWrites()) {
        void getPendingStorageWriteTail().then(readDeviceLayout)
      } else {
        readDeviceLayout()
      }
      return true
    } else if (request.action === 'setDeviceUIScale') {
      if (!isValidUIScale(request.scale)) {
        sendResponse({ success: false, error: 'Invalid UI scale' })
        return true
      }
      deviceScaleWriteGeneration += 1
      enqueueDeviceScaleWrite(request.scale, error => {
        sendResponse(error
          ? { success: false, error: error.message ?? 'Failed to save UI scale' }
          : { success: true })
      })
      return true
    } else if (request.action === 'setDeviceHudPosition') {
      if (!isValidHudPositionId(request.seatIndex) || !isValidHudPosition(request.position)) {
        sendResponse({ success: false, error: 'Invalid HUD position' })
        return true
      }
      void enqueuePendingStorageWrite(() =>
        new Promise<chrome.runtime.LastError | undefined>(resolve => {
          chrome.storage.local.set({
            [hudPositionStorageKey(request.seatIndex)]: request.position,
          }, () => resolve(chrome.runtime.lastError))
        })
      ).then(error => {
        sendResponse(error
          ? { success: false, error: error.message ?? 'Failed to save HUD position' }
          : { success: true })
      }, error => {
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to save HUD position',
        })
      })
      return true
    } else if (request.action === 'getDeviceHandLogLayout') {
      enqueueHandLogLayoutRead(() => {
        chrome.storage.local.get(
          HAND_LOG_LAYOUT_STORAGE_KEY,
          (result: Record<string, unknown>) => {
            const error = chrome.runtime.lastError
            if (error) {
              sendResponse({
                success: false,
                error: error.message ?? 'Failed to read hand log layout',
              })
              return
            }
            const layout = result[HAND_LOG_LAYOUT_STORAGE_KEY]
            sendResponse({
              success: true,
              ...(isValidHandLogLayout(layout) ? { layout } : {}),
            })
          }
        )
      })
      return true
    } else if (request.action === 'setDeviceHandLogLayout') {
      if (!isValidHandLogLayout(request.layout)) {
        sendResponse({ success: false, error: 'Invalid hand log layout' })
        return true
      }
      enqueueHandLogLayoutWrite(
        callback => chrome.storage.local.set({
          [HAND_LOG_LAYOUT_STORAGE_KEY]: request.layout,
        }, callback),
        sendResponse,
        'Failed to save hand log layout',
        complete => broadcastToGameTabs(
          {
            action: 'updateHandLogLayout',
            layout: request.layout,
          },
          complete
        )
      )
      return true
    } else if (request.action === 'resetDeviceUILayout') {
      // ハンドログ・HUDパネル位置・倍率を1回のremoveでまとめて消す。片方だけ
      // 成功して片方が残る中間状態を作らないため、キーを分けて複数回呼ばない。
      // 倍率も対象なのは、このボタンが「既定の見た目へ戻す」操作だから（sola）。
      // 倍率を残すと、大きい倍率のままパネルが既定位置へ戻り、既定位置が前提と
      // する余白（ネームプレートの上など）に収まらない状態が残ってしまう。
      // ハンドログ用のキューに載せるのは、同時に走りうる
      // set/getDeviceHandLogLayoutと順序を保つため。
      // 倍率だけは remove ではなく既定値を明示的に書く。localのuiScale欠落は
      // 「端末ローカルへ未移行」を意味していて（getDeviceUILayoutの
      // needsScaleMigration）、消すと次の読み込みがsyncに残る互換用の旧倍率
      // から移行し直し、倍率だけリセット前へ復活してしまう。sync側の旧倍率は
      // 版が混在する端末のために残す必要があり、消して解決はできない。
      // 世代を上げるのは、この時点で読み込み中の移行（古い世代を掴んでいる）に
      // 書き戻させないため。
      deviceScaleWriteGeneration += 1
      // chrome.storageにremoveとsetをまとめて行う原子的な操作はない。到達
      // できるのは「成功したぶんは必ずタブへ配信し、storageと開いているタブが
      // 食い違わない」状態まで。操作全体は冪等なので、失敗を返せばユーザーの
      // 再実行で残りが揃う。
      // 倍率はresetUILayoutとは別経路で反映する。ゲームタブ側の倍率は
      // App.tsxがuiConfig.scaleとして持っており、既存のscale配信
      // （updateDeviceUIScale）がその唯一の更新経路だから。
      // resetUILayoutにscaleを相乗りさせると、HandLog/useDraggableの
      // リセットとscale更新が1つのメッセージに同居して責務が混ざる。
      enqueueHandLogLayoutWrite(
        callback => chrome.storage.local.remove(
          [HAND_LOG_LAYOUT_STORAGE_KEY, ...HUD_POSITION_STORAGE_KEYS],
          () => {
            // removeが失敗したときは何も書けていないので、配信もせずに抜ける。
            const removeError = chrome.runtime.lastError
            if (removeError) {
              callback(removeError)
              return
            }
            chrome.storage.local.set(
              { [UI_SCALE_STORAGE_KEY]: DEFAULT_UI_CONFIG.scale },
              () => {
                // 以降はchrome APIを呼ぶたびlastErrorが上書きされるので、
                // ここで捕まえてcallbackへ明示的に渡す。
                const scaleError = chrome.runtime.lastError
                // 配置の削除はもう永続化されている。倍率の書き込みが失敗した
                // 場合でも配置のリセットだけは配信する。配信しないと、storage
                // は既定なのに開いているタブは古い配置のまま、という食い違いが
                // 次のリロードまで残るため。
                broadcastToGameTabs({ action: 'resetUILayout' }, () => {
                  if (scaleError) {
                    callback(scaleError)
                    return
                  }
                  broadcastToGameTabs({
                    action: 'updateDeviceUIScale',
                    scale: DEFAULT_UI_CONFIG.scale,
                  }, () => callback())
                })
              }
            )
          }
        ),
        sendResponse,
        'Failed to reset UI layout'
        // afterSuccessfulWriteは使わない。この操作は部分的な成功も配信する
        // 必要があり、成功時だけ呼ばれるフックでは表現できない。
      )
      return true
    } else if (request.action === 'exportData') {
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
        .then(async (result) => {
          await publishImportResult(
            'completed',
            `インポートが完了しました (${result.successCount.toLocaleString()}件のログ${result.duplicateCount > 0 ? `, ${result.duplicateCount.toLocaleString()}件の重複をスキップ` : ''})`
          )
          sendResponse({ success: true })
        })
        .catch(async error => {
          console.error('Import error:', error)
          await publishImportResult('error', 'インポートに失敗しました: ' + error.message)
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
    } else if (request.action === 'importDataCancel') {
      // Idempotent transfer cleanup. Once processing begins,
      // importDataProcess has already detached the complete session, so a
      // late cancel cannot interrupt raw storage or its follow-up rebuild.
      if (getCurrentImportSession()) clearImportSession()
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
        .then(async (result) => {
          await publishImportResult(
            'completed',
            `インポートが完了しました (${result.successCount.toLocaleString()}件のログ${result.duplicateCount > 0 ? `, ${result.duplicateCount.toLocaleString()}件の重複をスキップ` : ''})`
          )
          sendResponse({ success: true })
        })
        .catch(async error => {
          console.error('Import error:', error)
          await publishImportResult('error', 'インポートに失敗しました: ' + error.message)
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

      // 新しいフィルターに基づいてHUD表示を強制更新
      const lastKnownStats = getLastKnownStats()
      if (lastKnownStats.length > 0) {
        // 上の service.setBattleTypeFilter() は内部で
        // ReadEntityStream.recalculateStats()（read-entity-stream.ts）を
        // 呼び、ヒーロー在籍dealの席文脈（service.latestEvtDeal）で
        // service.liveEvtDealを同期してから再計算・ブロードキャストする
        // （setBattleTypeFilterはasync関数で、その同期処理は最初のawaitに
        // 到達する前、つまりこの行に制御が戻る前に完了している）。
        //
        // この下のwrite()は歴史的に別経路で存在する「現在ブロードキャスト
        // 中の顔ぶれ」の強制再計算で、`lastKnownStats`（ports.tsの直近の
        // ライブブロードキャスト、ヒーロー敗退後は観戦テーブルの顔ぶれの
        // こともある）を使う。ヒーローが観戦中（lastKnownStatsの顔ぶれが
        // latestEvtDealのSeatUserIdsと一致しない）場合、この2つの再計算が
        // 競合すると、write()側のPromiseがrecalculateStats()側より後に
        // 解決した際、その時点で既にヒーロー在籍dealに向いたservice.
        // liveEvtDealと、observing側の（顔ぶれの異なる）statsがペアリング
        // されてブロードキャストされてしまう（App.tsxの座席回転がズレる/
        // 上書きされる。codex #177マージ後レビュー、2026-07-20指摘）。
        //
        // 対処: lastKnownStatsの顔ぶれがヒーロー在籍dealのSeatUserIdsと
        // 一致しないと判明している場合だけ、この追加リフレッシュを
        // スキップする（lineup-identityチェック）。setBattleTypeFilter()の
        // recalculateStats()が別途ヒーロー在籍の統計を正しく再計算・
        // ブロードキャストするため、スキップしても表示が欠けることはない
        // -- ただしそれは recalculateStats() が実際に走る場合に限る。
        // read-entity-stream.ts の recalculateStats() は
        // `!playerId || !latestEvtDeal` で早期returnするため、
        // service.latestEvtDealはあるがservice.playerIdがまだ不明な
        // （復元直後の破損/中間状態）場合、recalculateStats()は何も
        // ブロードキャストしない。そこでこの追加リフレッシュまでスキップ
        // すると、フィルター変更がHUDに一切反映されなくなってしまう
        // （codex #188レビュー、2026-07-20指摘）。そのため「スキップして
        // 良い」と判定するには、不一致に加えて service.playerId も
        // 存在する（＝recalculateStats()が実際に代替のブロードキャストを
        // 行える）ことを要求する。playerId未定義またはlatestEvtDeal未定義
        // （この関数のテストのように現実には起きない合成状態を含む）の
        // 場合は「不一致と確定できない／代替を保証できない」として従来通り
        // 実行する（デフォルトは安全側＝現状維持）。
        const lastKnownLineup = lastKnownStats.map(stat => stat.playerId)
        const heroSeatUserIds = service.latestEvtDeal?.SeatUserIds
        const heroAnchoredRecalcCanRun = service.playerId !== undefined && heroSeatUserIds !== undefined
        const lineupMismatchesHeroDeal = heroAnchoredRecalcCanRun && (
          lastKnownLineup.length !== heroSeatUserIds.length ||
          lastKnownLineup.some((playerId, index) => playerId !== heroSeatUserIds[index])
        )

        if (!lineupMismatchesHeroDeal) {
          // 現在の席ユーザーIDで計算を再トリガー
          service.statsOutputStream.write(lastKnownLineup)
        }
      }

      return true // 非同期レスポンスを示す
    } else if (request.action === 'requestLatestStats') {
      const preGame = request.preGame === true
      // プリゲーム・ヒーロースタッツのレース対策: getLatestSessionStats()は
      // service.ready/filtersRestoredを待ってからDBを読むため、その待機中に
      // 本物のEVT_DEALがこのタブのportを経由して処理され、ライブの完全な
      // 席順がACTIVE-port delivery（ports.ts）で先にこのタブへ届く可能性がある。
      // その場合、後から届くヒーロー単独のフォールバックを送ってしまうと、
      // 届いたばかりのライブ席順を上書きしてしまう。この一手リクエストを
      // 受け取った時点のこのタブ固有のlive delivery sequenceを控えておき、フォールバック
      // 計算が終わった時点で値が変わっていれば「待機中にこのタブへ本物の
      // ACTIVE配信が発生した」ということなので、送信せず静かに捨てる。
      // （`lastKnownStats.length > 0`のような単純な非空チェックでは代用
      // できない -- Service Workerの生存期間中はタブを跨いで残り続けるため、
      // このセッションで最初のハンドが終わった後は常に非空になってしまい、
      // 無関係な別タブのマウントでもフォールバックが永久に抑制されてしまう）
      const requestingTabId = sender.tab?.id
      const liveBroadcastSequenceAtRequest = getLiveBroadcastSequenceForTab(requestingTabId)
      getLatestSessionStats(preGame)
        .then(stats => {
          if (preGame &&
            getLiveBroadcastSequenceForTab(requestingTabId) !== liveBroadcastSequenceAtRequest) {
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
      getPositionalStats(db, service, request.playerId)
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
      getRecentHands(db, service, request.playerId, request.limit, request.participationOnly)
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
      // Popupヘッダーに実行中バージョンとReleaseリンクが表示された時点の既読化
      acknowledgeWhatsNew()
        .then(() => sendResponse({ success: true }))
        .catch(error => {
          console.error('[acknowledgeWhatsNew] Error:', error)
          sendResponse({ success: false, error: error.message })
        })
      return true
    } else if (request.action === 'getReviewPrompt') {
      // Popup起動時: 累計ハンド数・スヌーズ・決着からレビュー依頼の表示可否を判定
      evaluateReviewPromptVisibility(db)
        .then(visible => sendResponse({ success: true, visible }))
        .catch(error => {
          console.error('[getReviewPrompt] Error:', error)
          sendResponse({ success: false, error: error.message })
        })
      return true
    } else if (request.action === 'resolveReviewPrompt') {
      // Popupの「評価する」「後で」「今後表示しない」操作を記録
      resolveReviewPrompt(request.choice)
        .then(() => sendResponse({ success: true }))
        .catch(error => {
          console.error('[resolveReviewPrompt] Error:', error)
          sendResponse({ success: false, error: error.message })
        })
      return true
    }
    return false
  })
}
