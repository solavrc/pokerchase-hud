/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
import PokerChaseService, {
  ApiType,
  PokerChaseDB,
  PlayerStats,
  isApiEventType,
  parseApiEvent,
  validateApiEvent,
  validateMessage,
  getValidationError
} from '../app'
import { EntityConverter, type EntityBundle } from '../entity-converter'
import {
  findLatestPlayerDealEvent,
  orderAndFilterApplicationEventsForReplay,
  processInReplayChunks
} from '../utils/database-utils'
import { DATABASE_CONSTANTS } from '../constants/database'
import type {
  ExportProgressMessage,
  ImportProgressMessage,
  RebuildProgressMessage
} from '../types/messages'
import { getOperationState, setOperationState } from './operation-state'
import { resolveAdvisory, markAdvisoryPending } from './rebuild-advisory'
import {
  API_EVENT_PRIMARY_KEY,
  mergeApiEvents,
  type ApiEventKey,
  type RawApiEvent
} from '../utils/api-event-key'
import { HandLogExporter } from '../utils/hand-log-exporter'
import { awaitIngestionDrain } from './update-manager'
import { runBestEffortChromeUi } from './best-effort-chrome-api'

const IMPORT_CHUNK_SIZE = DATABASE_CONSTANTS.IMPORT_CHUNK_SIZE

interface ImportSession {
  chunks: string[]
  receivedChunks: number
  totalChunks: number
  fileName: string
}
let currentImportSession: ImportSession | null = null
let importSessionTimeout: ReturnType<typeof setTimeout> | undefined
const IMPORT_SESSION_TIMEOUT_MS = 5 * 60 * 1000

const armImportSessionTimeout = (): void => {
  clearTimeout(importSessionTimeout)
  importSessionTimeout = setTimeout(() => {
    console.warn('[importData] Abandoned chunk transfer timed out; releasing operation slot')
    clearImportSession()
  }, IMPORT_SESSION_TIMEOUT_MS)
}

export const getCurrentImportSession = (): ImportSession | null => currentImportSession

export const startImportSession = (totalChunks: number, fileName: string): void => {
  currentImportSession = {
    chunks: [],
    receivedChunks: 0,
    totalChunks,
    fileName
  }
  // Own the shared operation slot for the whole file transfer, not only the
  // later parse/rebuild phase. A pending extension update or another data
  // operation must not reload/delete the worker while chunks live in memory.
  setOperationState({ type: 'import', progress: 0, processed: 0, total: totalChunks, message: 'インポートファイル転送中...' })
  armImportSessionTimeout()
}

export const addImportChunk = (chunkIndex: number, chunkData: string): boolean => {
  if (!currentImportSession || !Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= currentImportSession.totalChunks) return false
  if (currentImportSession.chunks[chunkIndex] === undefined) currentImportSession.receivedChunks++
  currentImportSession.chunks[chunkIndex] = chunkData
  setOperationState({
    type: 'import',
    progress: Math.round((currentImportSession.receivedChunks / currentImportSession.totalChunks) * 100),
    processed: currentImportSession.receivedChunks,
    total: currentImportSession.totalChunks,
    message: 'インポートファイル転送中...'
  })
  armImportSessionTimeout()
  return true
}

export const clearImportSession = (releaseOperation = true): void => {
  clearTimeout(importSessionTimeout)
  importSessionTimeout = undefined
  currentImportSession = null
  if (releaseOperation && getOperationState().type === 'import') {
    setOperationState({ type: 'idle' })
  }
}

/**
 * Import/Export/Rebuild関連のハンドラー群を初期化する。
 * `service`/`db`/`gameUrlPattern`をクロージャで捕捉し、message-router.tsから
 * 呼び出せる関数群を返す。
 */
export const createImportExportHandlers = (service: PokerChaseService, db: PokerChaseDB, gameUrlPattern: string) => {
  const exportData = async (format: string) => {
    if (format === 'json') {
      await exportJsonData(db)
    } else if (format === 'pokerstars') {
      await exportPokerStarsData()
    }
  }

  /**
   * Import data from JSONL file
   * @param jsonlData JSONL string containing API events (one JSON object per line)
   * @returns Object containing import statistics
   */
  const importData = async (jsonlData: string): Promise<{ successCount: number, totalLines: number, duplicateCount: number }> => {
    let batchModeEnabled = false
    try {
      setOperationState({ type: 'import', progress: 0 })
      console.log('[importData] Starting import process with canonical entity rebuild')
      const startTime = performance.now()

      // 行で分割し、空行をフィルタリング
      const lines = jsonlData.split('\n').filter(line => line.trim())
      console.log(`[importData] Processing ${lines.length} lines`)

      // バッチモードを有効化
      service.setBatchMode(true)
      batchModeEnabled = true

      // メモリ問題を避けるためチャンク単位で処理
      let processed = 0
      let successCount = 0
      let duplicateCount = 0
      const errors: string[] = []

      for (let i = 0; i < lines.length; i += IMPORT_CHUNK_SIZE) {
        const chunkLines = lines.slice(i, i + IMPORT_CHUNK_SIZE)
        // Raw Event Lake: 保存対象は「timestamp/ApiTypeIdが数値」の行すべて
        // （Zod検証の成否・アプリケーションイベントか否かは問わない）
        const rawEventsToStore: RawApiEvent[] = []

        // チャンク内の各行をパース
        for (let j = 0; j < chunkLines.length; j++) {
          const lineNumber = i + j + 1
          const line = chunkLines[j]
          if (!line) continue

          try {
            const parsed = JSON.parse(line)

            // 保存条件のチェック（インポートでは必須）: timestamp/ApiTypeIdが数値であること
            if (!validateMessage(parsed).success) {
              errors.push(`Line ${lineNumber}: Missing/invalid timestamp or ApiTypeId`)
              continue
            }

            rawEventsToStore.push(parsed)

            // Zodスキーマ検証（エンティティ生成対象かどうかの判定のみ。保存は上で確定済み）
            const event = parseApiEvent(parsed)
            if (!event) {
              const result = validateApiEvent(parsed)
              const errorDetails = result.error ? getValidationError(result.error)[0] : null
              errors.push(`Line ${lineNumber}: ${errorDetails?.message || 'Validation failed'} (保存済み・エンティティ生成対象外)`)
              continue
            }

            // Application/non-application classification is repeated on the
            // actually-added rows below; sequence assignment is storage
            // metadata and does not change parseability.
          } catch (parseError) {
            // 無効なJSON行をスキップ
            if (line.trim()) {
              errors.push(`Line ${lineNumber}: Invalid JSON`)
            }
          }
        }

        // Content identity, not the old timestamp+ApiTypeId key, defines an
        // import duplicate. Legacy exports have no sequence; mergeApiEvents
        // assigns one atomically. New-format rows preserve their sequence
        // when free, and a conflicting slot is safely reallocated.
        if (rawEventsToStore.length > 0) {
          const merge = await mergeApiEvents(db, rawEventsToStore, {
            protectAddedApplicationEventsFromCloudWatermark: true
          })
          successCount += merge.added.length
          duplicateCount += merge.duplicates
        }

        processed += chunkLines.length

        // Send progress update
        const progress = Math.round((processed / lines.length) * 100)
        setOperationState({ type: 'import', progress, processed, total: lines.length })
        chrome.runtime.sendMessage<ImportProgressMessage>({
          action: 'importProgress',
          progress: progress,
          processed: processed,
          total: lines.length,
          duplicates: duplicateCount,
          imported: successCount
        }).catch(() => {
          // Popup may close while import continues; progress delivery is
          // best-effort and must not become an unhandled SW rejection.
        })

        // Log progress every 10%
        if (progress % 10 === 0) {
          console.log(`[importData] Progress: ${progress}% (${processed}/${lines.length} lines)`)
        }

        // Allow browser to breathe between chunks
        await new Promise(resolve => setTimeout(resolve, 5))
      }

      if (errors.length > 0) {
        console.warn(`[importData] Failed to import ${errors.length} lines (${((errors.length / lines.length) * 100).toFixed(2)}%)`)
        if (errors.length <= 10) {
          console.warn('Errors:', errors)
        } else {
          console.warn('First 10 errors:', errors.slice(0, 10))
        }
      }

      const importTime = ((performance.now() - startTime) / 1000).toFixed(2)
      console.log(`[importData] Import completed in ${importTime}s - Success: ${successCount}, Duplicates: ${duplicateCount}`)

      if (successCount > 0) {
        // 新規raw rowを1件以上保存したインポート（監査finding #7 / plan C）:
        //
        // Lakeと新規行にハンドがまたがるケース（例: 既存にDEAL/RESULTSは
        // あるが中間のACTIONsが欠けている「キメラ」状態で保存されており、
        // 今回のインポートで欠けていたACTIONsが到着する）では、新規イベント
        // だけをEntityConverterに渡す増分変換では対応できない
        // ―― EntityConverterは呼び出し単位でハンド境界をローカル変数管理
        // しており（CLAUDE.md「EntityConverter state」参照）、ハンドの前半が
        // 「今回のインポート対象外（重複扱いで除外済み）」だと後半の
        // イベントだけを渡しても正しいエンティティは作れず、派生データ
        // （hands/phases/actions、およびそこから計算される統計）が
        // サイレントに古いまま残ってしまう。
        //
        // PR #203はこれを「オーバーラップした範囲だけ再構築する」サージカル
        // 修復で解決しようとしたが、11巡のレビューでも収束せず
        // （結局フルリビルドと同等の意味論を部分的に再実装することになる）、
        // オーナー判断でこの経路自体を廃止した（plan C）。代わりに、新規行が
        // 1件でも実際に保存された場合は、インポート開始時のDB空判定に依存せず、
        // 「データ再構築」ボタンと同じフルリビルド（`performFullRebuild`）を
        // apiEvents Lake全体に対して実行する。ユーザーから見て
        // 「インポート後にデータ再構築を押したのと同じ結果」になることを
        // 保証する、単純で
        // レビューしやすいコード。
        //
        // 「開始時に0件なら直接変換」という旧分岐はlive ingestionとの競合に
        // 弱い。count()が0を返した直後、既にqueue済みのlive rowがcommitして
        // import tailと同じLakeへ入ると、直接変換にはimport側の新規rowしか渡らず、
        // 完全なLakeから生成できるhand/actionが欠落する。performFullRebuildは
        // snapshot後の追記もtransaction内で再確認するため、この競合も含めて
        // canonicalな派生データへ収束する。
        console.log(`[importData] Stored ${successCount} new raw row(s) - running canonical full rebuild`)

        // 再構築フェーズの進捗は、rebuildAllData（データ再構築ボタン）と
        // 同じ`rebuildProgress`メッセージ経路で報告する。popup
        // （ImportExportSection.tsx）は既にこのメッセージ種別を購読して
        // 専用の再構築プログレスバーを表示するため、ここから流すだけで
        // 「今どのフェーズか」がそのままpopupに反映される
        // （読み手向けメモ: importProgressの0-100%は生ログ保存フェーズの
        // 進捗で完結しており、この後に続くrebuildProgressの0-100%は
        // 別フェーズとして独立に表示される）
        chrome.runtime.sendMessage<RebuildProgressMessage>({
          action: 'rebuildProgress',
          state: 'started',
          message: 'インポートにより新規データを検出、データを再構築中...'
        }).catch(() => {})

        try {
          const rebuildResult = await performFullRebuild((progress, message) => {
            setOperationState({ type: 'rebuild', progress, message })
            chrome.runtime.sendMessage<RebuildProgressMessage>({
              action: 'rebuildProgress',
              state: 'processing',
              progress,
              message
            }).catch(() => {})
          })

          console.log(`[importData] Post-import rebuild completed - Hands: ${rebuildResult.totalHands}, Phases: ${rebuildResult.totalPhases}, Actions: ${rebuildResult.totalActions}`)

          chrome.runtime.sendMessage<RebuildProgressMessage>({
            action: 'rebuildProgress',
            state: 'completed',
            progress: 100,
            message: `インポート後の再構築完了 - ハンド: ${rebuildResult.totalHands.toLocaleString()}, フェーズ: ${rebuildResult.totalPhases.toLocaleString()}, アクション: ${rebuildResult.totalActions.toLocaleString()}`
          }).catch(() => {})
        } catch (rebuildError) {
          // ここに来た時点で、生イベントは既にapiEvents（Lake）へ確定
          // 保存済み（上のraw保存ループ参照）―― 失敗したのは派生データ
          // （hands/phases/actions）の再構築のみ。#202が確立した
          // 「再構築失敗はサイレントな成功にしない」契約を、インポートに
          // 統合したこの経路でも維持する: ここでthrowし、下のouter
          // catchブロック経由でインポート全体をエラー状態として呼び出し元
          // （message-router.ts）へ伝播させる。raw dataはロールバックせず
          // 保存されたまま残す。
          console.error('[importData] Post-import rebuild failed:', rebuildError)
          chrome.runtime.sendMessage<RebuildProgressMessage>({
            action: 'rebuildProgress',
            state: 'error',
            message: `インポート後の再構築に失敗しました: ${rebuildError}`
          }).catch(() => {})

          // 再構築アドバイザリを保留にする（codexレビュー指摘, PR #207
          // pass-4 finding 3「Retry rebuild after failed import instead
          // of skipping duplicates」）: このまま何もしないと、生イベント
          // は既に確定保存済みのため、同じファイルを再インポートしても
          // 今度は全行重複となり（successCount === 0）、下の「純粋な
          // 重複インポート」分岐に入って再構築が二度と走らなくなる ――
          // 派生データは古いまま永久に取り残される。アドバイザリを保留
          // にしておけば、popupのバナー/バッジが「データ再構築」ボタンの
          // 実行を促し続け、それが唯一かつ確実な復旧手段として常に
          // 提示される（成功時にresolveAdvisory()で自動的に解消する）。
          // rebuildAllData自身の失敗（ボタン経由）はこのマーキングをしない
          // ――失敗はrebuildProgressのerror状態で既にユーザーへ即座に
          // 見えており、ボタンを再度押すだけで再試行できるため、
          // インポートのように「再試行が別経路(重複判定)に吸収されて
          // 再構築が起動しなくなる」問題が構造的に起きない。
          await markAdvisoryPending()

          const errorMessage = rebuildError instanceof Error ? rebuildError.message : String(rebuildError)
          throw new Error(`Post-import rebuild failed (raw data was stored successfully): ${errorMessage}`)
        }
      } else {
        // 純粋な重複/保存対象なし: Lakeに変化がないため再構築不要
        console.log('[importData] No new raw rows stored - skipping rebuild')
      }

      // インポート後に統計を強制的に更新
      // 最新のEVT_DEALを取得して統計計算をトリガー
      const latestDealEvent = await findLatestPlayerDealEvent(db)

      if (latestDealEvent && isApiEventType(latestDealEvent, ApiType.EVT_DEAL)) {
        // latestEvtDealを更新（findLatestPlayerDealEvent()はPlayer.SeatIndexが
        // 存在するdealだけを返すため、常にヒーロー在籍の文脈）。このsetterは
        // service.liveEvtDeal（ライブ配信文脈）も同時に同期する
        // （poker-chase-service.ts参照）ため、直後のwrite()による再
        // ブロードキャストが、インポート前に観戦モードで取り残されていたかも
        // しれない古いliveEvtDealではなく、この復元されたヒーロー在籍dealと
        // 正しくペアリングされる（codex #177 3巡目レビューP2）。
        service.latestEvtDeal = latestDealEvent

        // プレイヤーIDも更新（インポートデータからヒーローを特定）
        if (latestDealEvent.Player?.SeatIndex !== undefined) {
          service.playerId = latestDealEvent.SeatUserIds[latestDealEvent.Player.SeatIndex]
          console.log(`[importData] Updated playerId: ${service.playerId}`)
        }

        // 統計の再計算をトリガー
        const playerIds = latestDealEvent.SeatUserIds.filter(id => id !== -1)
        if (playerIds.length > 0) {
          console.log('[importData] Triggering stats recalculation for imported data')
          service.statsOutputStream.write(playerIds)

          // 現在開いているゲームタブに対しても統計更新を通知
          chrome.tabs.query({ url: gameUrlPattern }, tabs => {
            tabs.forEach(tab => {
              if (tab.id) {
                chrome.tabs.sendMessage(tab.id, {
                  action: 'refreshStats'
                }).catch(() => {
                  // A matching tab can be navigating or awaiting content
                  // script reinjection. The durable import already succeeded.
                })
              }
            })
          })
        }
      }

      // HandLogExporter normally advances its name cache with an exact
      // raw-event key. Imports can backfill older 301/313 events below that
      // cursor, so a successful history merge must force the next export to
      // rebuild the map from the full Lake. Do this only after the complete
      // import path succeeds; duplicate-only and failed imports leave the
      // existing cache untouched.
      if (successCount > 0) HandLogExporter.clearCache()

      return { successCount, totalLines: lines.length, duplicateCount }

    } catch (error) {
      console.error('Import error:', error)
      throw error
    } finally {
      // Every exit path must restore live processing before advertising idle.
      if (batchModeEnabled) service.setBatchMode(false)
      setOperationState({ type: 'idle' })
    }
  }

  const exportJsonData = async (db: PokerChaseDB) => {
    // Claim the shared slot before the first await. Otherwise two messages in
    // the same task can both observe idle while startKeepAlive() yields.
    setOperationState({ type: 'export', format: 'json', progress: 0 })
    let stopKeepAlive = () => {}
    try {
      stopKeepAlive = await startKeepAlive()
      chrome.runtime.sendMessage<ExportProgressMessage>({
        action: 'exportProgress',
        state: 'started',
        format: 'json',
        message: 'NDJSONエクスポート開始...'
      }).catch(() => {})

      // Cursor by stable primary key, but hold/resolve each equal-timestamp group
      // before emitting it so the NDJSON preserves the proven causal order.
      // Dumps the full apiEvents Lake verbatim (raw fidelity, "a line is a line") — no
      // filtering by validity or application-type here; this is what feeds the warehouse
      // and offline schema-diff tooling (see docs/architecture.md "Raw Event Lake").
      let totalCount = 0
      let processedCount = 0
      const chunkSize = DATABASE_CONSTANTS.EXPORT_CHUNK_SIZE
      // Capture only the ordered primary keys in a short read transaction, then
      // release the store before fetching/stringifying the full rows. Exact keys
      // exclude every later insert, including an equal-ms row whose ApiTypeId
      // sorts below the start-time maximum; unlike a transaction held for the
      // complete export, live ingestion is blocked only for this lightweight
      // key scan.
      const snapshotKeys = await db.transaction('r', db.apiEvents, async () =>
        await db.apiEvents.orderBy(API_EVENT_PRIMARY_KEY).primaryKeys() as ApiEventKey[]
      )
      totalCount = snapshotKeys.length
      console.log(`[Export] Exporting ${totalCount} events...`)
      const chunks: string[] = []

      for await (const chunk of processInReplayChunks(db.apiEvents, chunkSize, { snapshotKeys })) {
        chunks.push(chunk.map(event => JSON.stringify(event)).join('\n'))
        processedCount += chunk.length

        const progress = Math.round((processedCount / totalCount) * 100)
        const progressMessage = `エクスポート中... ${processedCount.toLocaleString()}/${totalCount.toLocaleString()} (${progress}%)`
        setOperationState({ type: 'export', format: 'json', progress, processed: processedCount, total: totalCount, message: progressMessage })
        chrome.runtime.sendMessage<ExportProgressMessage>({
          action: 'exportProgress',
          state: 'processing',
          format: 'json',
          progress,
          processed: processedCount,
          total: totalCount,
          message: progressMessage
        }).catch(() => {})

        if (processedCount % 50000 === 0 || processedCount >= totalCount) {
          console.log(`[Export] Processed ${processedCount}/${totalCount} events`)
        }

      }

      const jsonlContent = chunks.join('\n')

      // ハンドオフ（chrome.tabs.query/sendMessage）の発行完了を待ってから
      // `setOperationState({ type: 'idle' })`を呼ぶ（codexレビュー指摘,
      // PR #150監査#2: 待たずに呼ぶとupdate-managerのoperation-idle
      // recheckがハンドオフ未発行のままchrome.runtime.reload()し、
      // ダウンロードが失われるレースがあった -- downloadFile()のコメント参照）
      await downloadFile(
        jsonlContent,
        'pokerchase_raw_data.ndjson',
        'application/x-ndjson'
      )

      console.log(`[Export] Export completed: ${processedCount} events (${(jsonlContent.length / 1024 / 1024).toFixed(1)}MB)`)

      setOperationState({ type: 'idle' })
      chrome.runtime.sendMessage<ExportProgressMessage>({
        action: 'exportProgress',
        state: 'completed',
        format: 'json',
        progress: 100,
        processed: processedCount,
        total: totalCount,
        message: `NDJSONエクスポート完了: ${processedCount.toLocaleString()}件`
      }).catch(() => {})
      stopKeepAlive()
    } catch (error) {
      stopKeepAlive()
      console.error('[Export] Export failed:', error)
      setOperationState({ type: 'idle' })
      chrome.runtime.sendMessage<ExportProgressMessage>({
        action: 'exportProgress',
        state: 'error',
        format: 'json',
        message: `NDJSONエクスポート失敗: ${error}`
      }).catch(() => {})
      throw error
    }
  }

  const exportPokerStarsData = async () => {
    // Claim the shared slot before the first await; see exportJsonData().
    setOperationState({ type: 'export', format: 'pokerstars', progress: 0 })
    let stopKeepAlive = () => {}
    try {
      stopKeepAlive = await startKeepAlive()
      chrome.runtime.sendMessage<ExportProgressMessage>({
        action: 'exportProgress',
        state: 'started',
        format: 'pokerstars',
        message: 'PokerStarsエクスポート開始...'
      }).catch(() => {})

      // Get the last session's hand history
      const handHistory = await service.exportHandHistory(undefined, (processed, total) => {
        const progress = Math.round((processed / total) * 100)
        chrome.runtime.sendMessage<ExportProgressMessage>({
          action: 'exportProgress',
          state: 'processing',
          format: 'pokerstars',
          progress,
          processed,
          total,
          message: `ハンドヒストリー変換中... ${processed.toLocaleString()}/${total.toLocaleString()} (${progress}%)`
        }).catch(() => {})
        setOperationState({ type: 'export', format: 'pokerstars', progress, processed, total, message: `ハンドヒストリー変換中... ${processed}/${total} (${progress}%)` })
      })

      if (!handHistory) {
        console.error('No hands found to export')
        stopKeepAlive()
        setOperationState({ type: 'idle' })
        chrome.runtime.sendMessage<ExportProgressMessage>({
          action: 'exportProgress',
          state: 'error',
          format: 'pokerstars',
          message: 'エクスポートするハンドが見つかりませんでした'
        }).catch(() => {})
        // Show notification to user
        if (chrome.notifications?.create) {
          runBestEffortChromeUi('export-pokerstars/no-hands-notification', () =>
            chrome.notifications.create({
              type: 'basic',
              iconUrl: chrome.runtime.getURL('icons/icon_48px.png'),
              title: 'エクスポートエラー',
              message: 'エクスポートするハンドが見つかりませんでした。ゲームをプレイしてから再度お試しください。'
            }))
        }
        return
      }

      // ハンドオフ発行完了を待ってからidleに戻す（上のexportJsonData内
      // downloadFile()呼び出しのコメント参照、codexレビュー指摘 PR #150監査#2）
      await downloadFile(
        handHistory,
        'pokerchase_hand_history.txt',
        'text/plain'
      )

      stopKeepAlive()
      setOperationState({ type: 'idle' })
      chrome.runtime.sendMessage<ExportProgressMessage>({
        action: 'exportProgress',
        state: 'completed',
        format: 'pokerstars',
        message: 'PokerStarsハンドヒストリーエクスポート完了'
      }).catch(() => {})
    } catch (error) {
      stopKeepAlive()
      console.error('Error exporting PokerStars format:', error)
      setOperationState({ type: 'idle' })
      chrome.runtime.sendMessage<ExportProgressMessage>({
        action: 'exportProgress',
        state: 'error',
        format: 'pokerstars',
        message: `PokerStarsエクスポート失敗: ${error}`
      }).catch(() => {})
      // Show error notification
      if (chrome.notifications?.create) {
        runBestEffortChromeUi('export-pokerstars/error-notification', () =>
          chrome.notifications.create({
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon_48px.png'),
            title: 'エクスポートエラー',
            message: 'ハンドヒストリーのエクスポート中にエラーが発生しました。'
          }))
      }
      throw error
    }
  }

  /**
   * `chrome.tabs.sendMessage()`をコールバック形式で呼び、
   * `chrome.runtime.lastError`を確認してから解決/拒否するPromiseに包む
   * （codexレビュー指摘、監査finding #10）。
   *
   * `chrome.tabs.sendMessage(tabId, message)`（コールバック省略）はfire-and-
   * forgetで、コンテンツスクリプト不在・メッセージ拒否・受信側エラーの
   * いずれもここでは観測できない。コールバックを渡すことで
   * `chrome.runtime.lastError`（例: "Receiving end does not exist" ―
   * コンテンツスクリプト未注入、拡張機能リロード直後のタブなど）を検出し、
   * 呼び出し元（downloadFile）へ失敗として伝播できるようにする。
   *
   * 受信側（content_script.ts）は4種のdownload*メッセージ全てで明示的に
   * `sendResponse({ success: true/false })`を返す（PR #199レビュー指摘、
   * finding #1）ようになっている ―― Chromeのメッセージングは、受信側が
   * sendResponse()を呼ばず`true`もreturnしない場合、リスナーがreturnした
   * 時点でポートを閉じ、送信側コールバックに`chrome.runtime.lastError =
   * "message port closed before a response was received"`をセットする。
   * これは受信側の処理が実際に成功していても発生するため、修正前は
   * 正常に配信されたエクスポートまで失敗と誤判定していた。明示的なackが
   * 返るようになった今は、`lastError`（配信自体の失敗）に加えて
   * レスポンスの`success:false`（受信側で処理中に例外が起きた場合）も
   * 確認し、どちらの失敗も呼び出し元へ伝播する。
   */
  const sendTabMessageAsync = (tabId: number, message: Record<string, unknown>): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response?: { success?: boolean, error?: string }) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
        } else if (response && response.success === false) {
          reject(new Error(response.error || 'content script reported a download handoff failure'))
        } else {
          resolve()
        }
      })
    })
  }

  /**
   * コンテンツスクリプトへのダウンロードハンドオフ（chrome.tabs.query→
   * chrome.tabs.sendMessage、大容量ファイルの場合は複数チャンク）の
   * 全チャンクが受信側に確実に届いたことを確認してから解決する
   * （codexレビュー指摘, PR #150監査#2 / 監査finding #10）。
   *
   * PR #150監査#2の修正では`chrome.tabs.query`のコールバックが実行される
   * までは待てるようになったが、その内側の`chrome.tabs.sendMessage()`自体は
   * 依然fire-and-forget（チャンクごとに投げっぱなし）で、`chrome.downloads`
   * フォールバックもコールバック/`downloads.lastError`を見る前に解決して
   * いた。コンテンツスクリプト不在・メッセージ拒否・64MiB境界超過・
   * downloads側のエラーのいずれが起きても`downloadFile()`は成功したかの
   * ように解決し、呼び出し元（exportJsonData/exportPokerStarsData）が直後に
   * `setOperationState({ type: 'idle' })`を呼んでしまう ――
   * `operation-state.ts`の`onOperationBecameIdle`購読経由で
   * `update-manager.ts`の`recheckPendingUpdate()`が発火し、保留中アップデート
   * が安全と誤判定されて`chrome.runtime.reload()`が先行し得るうえ、
   * ユーザーには「エクスポート完了」と表示されるのに実際のファイルは
   * 一切届かない。
   *
   * ここでは各ハンドオフ（単発送信・チャンク送信の全て）を`await`し、
   * いずれかが失敗（拒否）したら`downloadFile()`自体もreject、
   * `chrome.downloads`フォールバックも`downloads.lastError`を確認して
   * からでなければ解決しないようにする。呼び出し元は`await downloadFile()`
   * が投げた例外を既存のcatchブロックでそのまま処理する ―― `state: 'error'`
   * をpopupへ通知し、`idle`への遷移は「完了成功」としてではなく単に
   * 操作終了として行われる。
   */
  const downloadFile = (content: string, filename: string, contentType: string): Promise<void> => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')

    const extensionMatch = filename.match(/\.[^.]+$/)
    const extension = extensionMatch ? extensionMatch[0] : ''

    const baseFilename = extension ? filename.slice(0, -extension.length) : filename

    const getFinalFilename = () => {
      if (contentType.includes('ndjson') || filename.endsWith('.jsonl') || filename.endsWith('.ndjson')) {
        return `${baseFilename}_${timestamp}.ndjson`
      } else if (contentType.includes('json')) {
        return `${baseFilename}_${timestamp}.json`
      } else if (contentType.includes('text')) {
        return `${baseFilename}_${timestamp}.txt`
      } else {
        return `${baseFilename}_${timestamp}${extension || '.dat'}`
      }
    }

    const finalFilename = getFinalFilename()

    // Send to content script for Blob-based download (avoids data URL size limits)
    return new Promise<void>((resolve, reject) => {
      chrome.tabs.query({ url: gameUrlPattern }, async tabs => {
        const queryError = chrome.runtime.lastError
        if (queryError) {
          reject(new Error(queryError.message || 'Failed to query game tabs'))
          return
        }
        if (!Array.isArray(tabs)) {
          reject(new Error('Failed to query game tabs: no result returned'))
          return
        }

        const tab = tabs.find(t => t.id)
        if (tab?.id) {
          const tabId = tab.id
          try {
            const sizeMB = content.length / 1024 / 1024
            const MAX_CHUNK_MB = 50 // Under Chrome's 64MiB message limit
            const maxChunkSize = MAX_CHUNK_MB * 1024 * 1024

            if (content.length <= maxChunkSize) {
              await sendTabMessageAsync(tabId, { action: 'downloadFile', content, filename: finalFilename, contentType })
            } else {
              // Split into chunks for large files
              const totalChunks = Math.ceil(content.length / maxChunkSize)
              console.log(`[Export] Splitting ${sizeMB.toFixed(1)}MB into ${totalChunks} chunks...`)
              await sendTabMessageAsync(tabId, { action: 'downloadFileInit', filename: finalFilename, contentType, totalChunks })
              for (let i = 0; i < totalChunks; i++) {
                const chunk = content.slice(i * maxChunkSize, (i + 1) * maxChunkSize)
                await sendTabMessageAsync(tabId, { action: 'downloadFileChunk', chunkIndex: i, chunk, totalChunks })
              }
              await sendTabMessageAsync(tabId, { action: 'downloadFileFinish', filename: finalFilename, contentType })
            }
            console.log(`[Export] Download initiated via content script: ${finalFilename} (${sizeMB.toFixed(1)}MB)`)
            resolve()
          } catch (error) {
            console.error('[Export] Content script download handoff failed:', error)
            reject(error instanceof Error ? error : new Error(String(error)))
          }
          return
        }
        // Fallback: data URL via chrome.downloads (may fail for large files >2MB)
        console.warn('[Export] No game tab found, falling back to data URL download')
        try {
          await downloadViaDataUrl(content, finalFilename, contentType)
          resolve()
        } catch (error) {
          console.error('[Export] chrome.downloads fallback failed:', error)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
  }

  /**
   * Delete all data (logs only, not configuration)
   */
  const deleteAllData = async (): Promise<void> => {
    // Deleting the database is mutually exclusive with every reader/writer.
    // Keep the slot claimed until runtime.reload() replaces this worker.
    setOperationState({ type: 'delete' })
    try {
      // Events already queued before the synchronous claim above must finish
      // first. event-ingestion rejects later arrivals while type=delete, so
      // once this drain stabilizes nothing can recreate the database between
      // delete() and runtime.reload().
      await awaitIngestionDrain()

      // processEvent() only enqueues work into the live transform pipeline.
      // Its promise can settle before WriteEntityStream's async Dexie writes
      // have completed, so drain the full piped chain before deleting the DB.
      await service.handAggregateStream.whenIdle()

      // データベースを完全に削除
      await db.delete()

      // The database deletion is the commit point. Advisory cleanup is
      // best-effort after it: a chrome.storage failure must not strand this
      // worker with a closed database and advertise idle to later callers.
      try {
        await resolveAdvisory()
      } catch (advisoryError) {
        console.warn('[deleteAllData] Database deleted, but rebuild advisory cleanup failed; reloading anyway:', advisoryError)
      }

      // データベースの新しいインスタンスを確保するために拡張機能をリロード
      chrome.runtime.reload()
    } catch (error) {
      console.error('Error deleting data:', error)
      setOperationState({ type: 'idle' })
      throw error
    }
  }

  /**
   * Get the latest session stats from the last known data or database.
   *
   * Pre-game hero stats fallback (`preGame: true`, sent only by
   * content_script.ts's mountApp() right at HUD mount): before the first
   * EVT_DEAL of a browser session establishes a live seat lineup, there is
   * nothing for the live pipeline (ReadEntityStream.transform, driven by
   * statsOutputStream.write) to compute yet -- the HUD would otherwise sit
   * on "Waiting for Hand..." for every seat, including the hero's own,
   * until the first hand is dealt. If the hero's identity is already known
   * (persisted `service.playerId`), compute the hero's stats via the exact
   * same `calcStats()` the live pipeline uses (respecting the service's
   * active battleType/tableSize/handLimit filters) for a hero-only lineup
   * of one, and pad the remaining 5 seats with the same empty-seat
   * sentinel (`{ playerId: -1 }`) App.tsx's `EMPTY_SEATS` default uses --
   * this keeps the returned array the same 6-element shape callers already
   * render (App.tsx keys HUD panels by seat index 0-5), so non-hero seats
   * keep showing "Waiting for Hand..." exactly as before, and the eventual
   * real EVT_DEAL swap-in reuses the same seat-0 key for the hero panel
   * (seamless takeover, no remount).
   *
   * `preGame: false/omitted` (the pre-existing post-import `refreshStats`
   * round-trip, see content_script.ts) keeps the original "always return
   * []" stub behavior verbatim -- import completion already triggers a
   * real recompute+broadcast (`service.statsOutputStream.write(playerIds)`)
   * moments before `refreshStats` is sent, so enabling the hero-only
   * fallback on that call site too would risk a stale hero-only response
   * arriving *after* that fresher full lineup and clobbering it back down
   * to one seat. Restricting the fallback to the mount-only `preGame: true`
   * request sidesteps that race entirely: a fresh mount can't already have
   * a fresher in-tab lineup to clobber.
   *
   * If hero identity isn't known in memory yet (`service.playerId` unset --
   * e.g. a freshly-loaded unpacked extension instance whose in-memory
   * service state starts empty, or a persisted state restored before any
   * live EVT_DEAL ever arrived this browser session), fall back to
   * `findLatestPlayerDealEvent(db)` before giving up: a cloud download or
   * NDJSON import may already have populated the local DB with hero deal
   * events, and there's no reason to sit dark until the next live EVT_DEAL
   * re-derives it. This mirrors the DB-recovery path
   * `PokerChaseService.recalculateAllStats()` already uses on batch-mode
   * exit (see poker-chase-service.ts) -- same `Player?.SeatIndex !==
   * undefined` derivation, same lack of extra re-validation beyond what
   * `findLatestPlayerDealEvent()` already does internally (it re-validates
   * each candidate row against the current Zod schema via
   * `isApiEventType()`, consistent with the Raw Event Lake rules in
   * docs/architecture.md). The derived id is assigned through the
   * `service.playerId` setter, so it persists via the service's normal
   * 500ms-debounced `chrome.storage.local` save and is visible to every
   * later feature exactly as if it had come from a live EVT_DEAL. Still
   * returns [] (send nothing, don't touch the caller's current state) if
   * the DB has no hero deal event either (true fresh install / never
   * played -- behavior stays unchanged for that case) or an import/rebuild
   * batch operation is in flight (`service.batchMode` -- don't fight that
   * refresh storm; it recomputes and broadcasts the real lineup itself
   * once the batch completes, see `importData`/`rebuildAllData` below).
   *
   * Also awaits `service.filtersRestored`: `service.ready` only covers
   * chrome.storage.local's playerId/session restore -- battleTypeFilter/
   * tableSizeFilter/handLimitFilter/statDisplayConfigs are restored
   * separately by background.ts's startup `loadOptions().then(...)`
   * (see beginFiltersRestore()/markFiltersRestored() on the service).
   * On a cold MV3 Service Worker start triggered by this very
   * `requestLatestStats` message, `calcStats()` below could otherwise run
   * before those saved filters are applied, computing an unfiltered
   * pre-game hero panel for users with non-default filters.
   */
  const getLatestSessionStats = async (preGame: boolean): Promise<PlayerStats[]> => {
    if (!preGame) return []

    await service.ready // guards the SW-just-woke-up race: playerId/session are only valid after restoreState() resolves
    await service.filtersRestored // guards the same race for battleType/tableSize/handLimit filters (see background.ts)

    if (service.batchMode) return []

    if (!service.playerId) {
      // In-memory hero identity is unknown -- see if the DB already knows it
      // (cloud download / NDJSON import ahead of the first live EVT_DEAL).
      const latestDealEvent = await findLatestPlayerDealEvent(db)
      // A live EVT_DEAL may have set service.playerId while the lookup above
      // was in flight -- that's fresher than anything the DB can tell us, so
      // don't clobber it with the (now possibly stale) DB-derived value.
      if (!service.playerId && latestDealEvent && latestDealEvent.Player?.SeatIndex !== undefined) {
        service.playerId = latestDealEvent.SeatUserIds[latestDealEvent.Player.SeatIndex] // setter persists via the normal debounced save
      }
    }
    if (!service.playerId) return []

    const heroStats = await service.statsOutputStream.calcStats([service.playerId])
    const heroStat = heroStats[0] ?? { playerId: service.playerId, statResults: [] }
    const emptySeats: PlayerStats[] = Array.from({ length: 5 }, () => ({ playerId: -1 }))
    return [heroStat, ...emptySeats]
  }

  /**
   * apiEvents Lake全体から派生データ（hands/phases/actions）を再構成する
   * コア処理。以下2つの呼び出し元から共有される:
   *   - `rebuildAllData`（popupの「データ再構築」ボタン）
   *   - `importData`（既存データがある状態への追加インポートで新規行が
   *     実際に保存された場合。監査finding #7、PR #203のsurgical repairを
   *     置き換えるplan Cの中心 — import-export.ts先頭のコメント参照）
   *
   * operationState/バッチモードの管理・進捗メッセージの送信先は呼び出し元
   * ごとに異なる（rebuildAllDataは`rebuildProgress`の`started`/`completed`/
   * `error`まで含めて自分の操作として報告し、importDataは自分の`import`
   * 操作の一部としてラップする）ため、それらは呼び出し元に委ね、ここでは
   * 実際の再読み込み→変換→クリア＋保存（1トランザクション）→サービス
   * 状態復元のみを行う。
   *
   * **失敗時に既存の派生データを失わない不変条件**（codexレビュー指摘、
   * PR #207 P2）: 以前の実装はまず`hands`/`phases`/`actions`をクリアして
   * から、その後でイベント読み込み→変換→保存を行っていた。大きな既存
   * 履歴での変換例外やQuotaExceededError（保存側のbulkPut失敗）が
   * クリアの*後*に起きると、importData/rebuildAllDataは失敗を報告する
   * ものの、その時点で古い（動いていた）派生データは既に消えており、
   * 「インポート前よりHUD統計/ハンド履歴が悪化する」―― インポート前の
   * 単なる古さ（監査finding #7）より明確に悪い結果になっていた。
   * ここでは変換（`convertEventsToEntities`、例外を投げ得る）を先に
   * メモリ上だけで完了させ、実際のテーブル書き込み（クリア＋bulkPut＋
   * メタ更新）は全て単一の`db.transaction('rw', ...)`にまとめる。
   * Dexieのトランザクションは、スコープ内のいずれかの操作が例外を
   * 投げると、そのトランザクション開始以降の全書き込み（クリアを含む）
   * をロールバックする ―― これにより「クリアはコミット済みだが保存は
   * 失敗した」という中間状態が構造的に起こり得なくなる。変換自体が
   * 例外を投げた場合はテーブルへは一切触れていないため、そもそも
   * ロールバックの必要すらない。いずれの失敗経路でも、生イベントは
   * apiEvents（Raw Event Lake）に確定保存されたまま残るため、
   * 「データ再構築」ボタンでいつでもやり直せる ―― 強制すべき不変条件は
   * 「インポート/再構築は、見つけたときより派生データを悪化させない」
   * ことであり、apiEventsさえ無事なら回復可能性は常に保たれる。
   *
   * **SW keepalive**（codexレビュー指摘、PR #207 P2 3巡目）: 大規模履歴では
   * 読み込み→変換→書き込みの全体がChrome MV3の30秒アイドルタイムアウトを
   * 超え得る。エクスポート系（`exportJsonData`/`exportPokerStarsData`）が
   * 既にやっているのと同じ`startKeepAlive()`をここで一括して掛けることで、
   * `rebuildAllData`（ボタン）・`importData`の再構築分岐の両方が保護される。
   *
   * **ライブ中に完了したハンドの保護**（codexレビュー指摘、PR #207 P2
   * 3巡目・4巡目）: 上のraw読み込み（スナップショット）～変換の間にライブ
   * プレイ中のハンドが1つ完了すると、`WriteEntityStream`
   * （write-entity-stream.ts）は`service.batchMode`を見ずに無条件で
   * hands/phases/actionsへ書き込む（#196のライブ取り込みパイプラインは
   * このリビルドと無関係に動き続ける ―― event-ingestion.tsは変更しない）。
   * その書き込みが下の最終トランザクション開始より前に確定していた場合、
   * スナップショットから導出した`entities`はそのハンドの元イベントを
   * 含んでおらず、clear()で消すとbulkPut(entities)では復元できない。
   *
   * 最終トランザクションのスコープに`apiEvents`も含めているため、IDBの
   * トランザクション分離により、他のreadwriteトランザクション
   * （WriteEntityStreamのhands/phases/actions書き込み、event-ingestion.ts
   * のapiEvents書き込み）はこのトランザクションの開始からコミットまでの
   * 間は割り込めない（同じテーブルへのreadwriteトランザクションはIDBが
   * 直列化する）。したがって、トランザクション内でスナップショット取得後に
   * apiEventsが変化していないか一度だけ再確認すれば十分 ―― トランザクション
   * が開いている間は誰も新しい行をapiEventsへ追加できないため、この再確認は
   * 高々1回で収束する。
   *
   * 再確認は**件数比較**で行う（`db.apiEvents.count()`とスナップショット
   * 時点の行数を比較する）―― コンパウンドキーの
   * 大小関係には一切依存しない（codexレビュー指摘、PR #207 pass-4
   * 「Merge live rows that do not sort after the snapshot」: 以前は
   * 当時の主キー`.where('[timestamp+ApiTypeId]').above(snapshotUpperBound)`で新着行を
   * 検出していたが、クロックスキューや同一ミリ秒での到着順によっては
   * 新着行がスナップショット末尾より小さいキーを持つことがあり、その
   * ケースを取りこぼしていた）。件数が変わっていれば、rawEvents全体を
   * 破棄してapiEventsをもう一度フルスキャンし、そこから作り直す ―― 差分
   * だけを合流させるのではなくスキャン自体をやり直すことで、キーの大小に
   * 一切依存しない正しさを得る。apiEventsは追記のみで行が減ることは
   * ない（DB全削除はdeleteAllData経由の拡張機能reloadを伴い、
   * この関数と並行実行され得ない）ため、件数一致は行集合一致を意味する。
   *
   * この再確認は「rawEvents=0件（対象イベントなし）」の場合にも同じ
   * トランザクション内でそのまま行われる（同上pass-4「Recheck apiEvents
   * before clearing the zero-count path」対応）―― 以前は`totalCount===0`
   * を個別の早期returnとして扱い、この再確認をスキップして無条件に
   * クリアしていたため、`count()`が0を返した直後・クリアより前に最初の
   * ライブハンドが書き込まれるレースでその派生データを消してしまい得た。
   * 今は「空だと思って始める」ことと「実際に書き込み前に再確認する」ことが
   * 同じコードパスになったため、この特別扱いが構造的に消えている。
   * @param onProgress 各フェーズの`(progress, message)`。呼び出し元はこれを
   *   使って自分のoperationState/メッセージ経路へ橋渡しする
   */
  const performFullRebuild = async (
    onProgress: (progress: number, message: string) => void
  ): Promise<{ totalCount: number, totalHands: number, totalPhases: number, totalActions: number }> => {
    console.log('[performFullRebuild] Starting full rebuild of derived data...')

    // 大規模履歴では以下全体（読み込み→変換→書き込み）がMV3の30秒アイドル
    // タイムアウトを超え得るため、エクスポート系と同じキープアライブを
    // 操作全体に掛ける（上のJSDoc「SW keepalive」参照）
    const stopKeepAlive = await startKeepAlive()
    try {
      const defaultSession = {
        id: undefined,
        battleType: undefined,
        name: undefined,
        players: new Map(),
        reset: () => { }
      }

      // 初期見積もり（最適化のみ）: ここで0件なら下の重い読み込み/変換を
      // 省略する。これは権威あるチェックではない ―― 最終的な正しさは下の
      // トランザクション内の再確認が保証する（上のJSDoc参照）。
      const totalCountEstimate = await db.apiEvents.count()
      console.log(`[performFullRebuild] Processing ${totalCountEstimate} events...`)

      onProgress(10, 'イベント読み込み中...')

      let rawEvents: RawApiEvent[] = []
      let entities: EntityBundle = { hands: [], phases: [], actions: [] }

      if (totalCountEstimate > 0) {
        // Load all raw events and convert in one pass
        // (EntityConverter tracks hand state internally, so chunked conversion loses cross-chunk hands)
        console.log(`[performFullRebuild] Loading all events...`)
        rawEvents = await db.apiEvents.orderBy(API_EVENT_PRIMARY_KEY).toArray() as unknown as RawApiEvent[]

        // apiEvents is the raw Lake: it may contain non-application noise (202/205
        // keepalive/timer events), ApiTypeIds unknown to the current schema, or
        // application-type events whose payload doesn't match the current Zod schema
        // (either not-yet-fixed, or already fixed since the row was first stored).
        // Re-validating here — rather than trusting raw rows — is what makes this the
        // recovery path: any row a schema fix now makes parseable is automatically
        // picked up, no separate promotion mechanism required (docs/architecture.md
        // "Raw Event Lake"). It's also what keeps EntityConverter (which reads
        // required fields like EVT_DEAL.Game.SmallBlind without guards) from
        // throwing on a still-malformed row.
        const allEvents = await orderAndFilterApplicationEventsForReplay(rawEvents)
        const skippedCount = rawEvents.length - allEvents.length
        console.log(`[performFullRebuild] Loaded ${rawEvents.length} raw events, ${allEvents.length} valid application events after re-validation${skippedCount > 0 ? ` (${skippedCount} non-application/unparseable rows skipped)` : ''}`)

        onProgress(40, `${allEvents.length.toLocaleString()}件のイベントを変換中...`)

        // 変換はメモリ上のみの処理で、この時点ではまだテーブルに一切触れて
        // いない ―― ここで例外が起きても（例: 未知の形状での変換失敗）既存の
        // 派生データはそのまま残る
        entities = new EntityConverter(defaultSession).convertEventsToEntities(allEvents)
      }

      onProgress(70, 'テーブルを更新中...')

      // クリアと保存を単一トランザクションにまとめる（上のJSDoc参照）:
      // bulkPutがQuotaExceededError等で失敗した場合、Dexieがこのトランザクション
      // 全体（クリアを含む）をロールバックし、失敗前の派生データがそのまま残る。
      // `apiEvents`もスコープに含めているのは、上のJSDoc「ライブ中に完了した
      // ハンドの保護」の通り、トランザクション内での再確認とIDBの直列化を
      // 成立させるため。
      const counts = await db.transaction('rw', [db.apiEvents, db.hands, db.phases, db.actions, db.meta], async () => {
        const currentCount = await db.apiEvents.count()

        let finalEntities = entities
        let finalTotalEvents = rawEvents.length

        if (currentCount !== rawEvents.length) {
          // apiEventsがスナップショット取得後に変化した（このトランザクション
          // が開くまでの間の話 -- 開いた後は上のJSDoc通りIDBの直列化により
          // 誰も追加できない）。キーの大小に依存しないよう、差分合流ではなく
          // フルスキャンをやり直して完全な結果を作り直す。
          console.log(`[performFullRebuild] apiEvents changed since the snapshot (${rawEvents.length} -> ${currentCount} rows; live play or another writer during rebuild) -- re-deriving from a fresh read`)
          const freshRaw = await db.apiEvents.orderBy(API_EVENT_PRIMARY_KEY).toArray() as unknown as RawApiEvent[]
          const freshValidEvents = await orderAndFilterApplicationEventsForReplay(freshRaw)
          finalEntities = new EntityConverter(defaultSession).convertEventsToEntities(freshValidEvents)
          finalTotalEvents = freshRaw.length
        }

        await db.hands.clear()
        await db.phases.clear()
        await db.actions.clear()
        await db.meta.delete('lastProcessed')

        const c = { hands: 0, phases: 0, actions: 0 }
        if (finalEntities.hands.length > 0) {
          await db.hands.bulkPut(finalEntities.hands)
          c.hands = finalEntities.hands.length
        }
        if (finalEntities.phases.length > 0) {
          await db.phases.bulkPut(finalEntities.phases)
          c.phases = finalEntities.phases.length
        }
        if (finalEntities.actions.length > 0) {
          await db.actions.bulkPut(finalEntities.actions)
          c.actions = finalEntities.actions.length
        }

        // Update metadata with rebuild info (同じトランザクション内 -- 派生
        // データとメタデータが不整合な状態でコミットされることがない)
        await db.meta.put({
          id: 'rebuildStatus',
          value: {
            lastRebuildDate: new Date().toISOString(),
            totalEvents: finalTotalEvents,
            totalHands: c.hands,
            totalPhases: c.phases,
            totalActions: c.actions
          },
          updatedAt: Date.now()
        })

        return { ...c, totalEvents: finalTotalEvents }
      })

      console.log(`[performFullRebuild] Generated entities - Hands: ${counts.hands}, Phases: ${counts.phases}, Actions: ${counts.actions}`)

      if (counts.totalEvents === 0) {
        console.log('[performFullRebuild] No events to process')
        // 対象イベントが無い＝再構築の必要が無いため、保留中のアドバイザリも解消する
        await resolveAdvisory()
        return { totalCount: 0, totalHands: 0, totalPhases: 0, totalActions: 0 }
      }

      // Restore service state from latest events
      // (codex #177 3巡目レビューP2: このsetterはservice.liveEvtDealも同時に
      // 同期するため、呼び出し元のsetBatchMode(false)がトリガーする
      // recalculateAllStats()の再ブロードキャストは、再構築前のliveEvtDeal
      // （観戦中に取り残された可能性がある）ではなく、この復元された
      // ヒーロー在籍dealの座席文脈を使う)
      const latestDealEvent = await findLatestPlayerDealEvent(db)

      if (latestDealEvent && isApiEventType(latestDealEvent, ApiType.EVT_DEAL)) {
        service.latestEvtDeal = latestDealEvent
        if (latestDealEvent.Player?.SeatIndex !== undefined) {
          service.playerId = latestDealEvent.SeatUserIds[latestDealEvent.Player.SeatIndex]
        }
      }

      onProgress(90, '統計情報を再計算中...')

      // Trigger stats recalculation once at the end. Whether this write() gets
      // broadcast immediately or is a no-op depends on the caller's batch-mode
      // state (see ReadEntityStream.transform()) -- the caller's own
      // setBatchMode(false) is what triggers the real broadcast via
      // PokerChaseService.recalculateAllStats(), which reads the
      // already-restored (hero-anchored) service.latestEvtDeal above, making
      // this call mostly harmless/redundant in that case.
      if (service.latestEvtDeal && service.latestEvtDeal.SeatUserIds) {
        const playerIds = service.latestEvtDeal.SeatUserIds.filter(id => id !== -1)
        if (playerIds.length > 0) {
          console.log('[performFullRebuild] Triggering stats recalculation...')
          service.statsOutputStream.write(service.latestEvtDeal.SeatUserIds)
        }
      }

      // 再構築が完了したので、保留中の再構築アドバイザリがあれば解消する
      await resolveAdvisory()

      return { totalCount: counts.totalEvents, totalHands: counts.hands, totalPhases: counts.phases, totalActions: counts.actions }
    } finally {
      stopKeepAlive()
    }
  }

  /**
   * Rebuild all data from apiEvents using batch processing
   * Similar to download sync processing to avoid multiple HUD updates
   */
  const rebuildAllData = async (): Promise<void> => {
    const startTime = performance.now()
    try {
      console.log('[rebuildAllData] Starting batch rebuild of all data...')

      setOperationState({ type: 'rebuild', progress: 0, message: 'データ再構築開始...' })
      chrome.runtime.sendMessage<RebuildProgressMessage>({
        action: 'rebuildProgress',
        state: 'started',
        message: 'データ再構築開始...'
      }).catch(() => {})

      // Enable batch mode to prevent real-time updates
      service.setBatchMode(true)

      try {
        const result = await performFullRebuild((progress, message) => {
          setOperationState({ type: 'rebuild', progress, message })
          chrome.runtime.sendMessage<RebuildProgressMessage>({
            action: 'rebuildProgress',
            state: 'processing',
            progress,
            message
          }).catch(() => {})
        })

        // Manual full rebuild is the recovery boundary for raw history that
        // an earlier import stored before entity generation failed. Rebuild
        // the exporter name map from the same Raw Lake on its next use, even
        // when the Lake is empty (where this is a harmless cache reset).
        HandLogExporter.clearCache()

        if (result.totalCount === 0) {
          setOperationState({ type: 'idle' })
          chrome.runtime.sendMessage<RebuildProgressMessage>({
            action: 'rebuildProgress',
            state: 'completed',
            progress: 100,
            message: '処理対象のイベントがありません'
          }).catch(() => {})
          return
        }

        const rebuildTime = ((performance.now() - startTime) / 1000).toFixed(2)
        console.log(`[rebuildAllData] Rebuild completed in ${rebuildTime}s`)

        setOperationState({ type: 'idle' })
        chrome.runtime.sendMessage<RebuildProgressMessage>({
          action: 'rebuildProgress',
          state: 'completed',
          progress: 100,
          message: `データ再構築完了 (${rebuildTime}秒) - ハンド: ${result.totalHands.toLocaleString()}, フェーズ: ${result.totalPhases.toLocaleString()}, アクション: ${result.totalActions.toLocaleString()}`
        }).catch(() => {})

      } finally {
        // Disable batch mode
        service.setBatchMode(false)
      }

    } catch (error) {
      console.error('[rebuildAllData] Error:', error)
      setOperationState({ type: 'idle' })
      chrome.runtime.sendMessage<RebuildProgressMessage>({
        action: 'rebuildProgress',
        state: 'error',
        message: `データ再構築失敗: ${error}`
      }).catch(() => {})
      throw error
    }
  }

  return {
    exportData,
    importData,
    deleteAllData,
    getLatestSessionStats,
    rebuildAllData
  }
}

/**
 * Service Worker のアイドル停止を防止するキープアライブを開始する。
 * Chrome MV3 では 30 秒のアイドル後に Worker が停止されるため、
 * 長時間のバッチ処理中は30秒未満の間隔でExtension APIを呼び出す。
 * Chrome 110以降はExtension API呼び出しがService Workerのアイドル
 * タイマーをリセットする。manifestのminimum_chrome_versionは140。
 * @returns クリーンアップ関数
 */
export const startKeepAlive = async (): Promise<() => void> => {
  const id = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {})
  }, 25000)
  return () => clearInterval(id)
}

/**
 * `chrome.downloads.download()`のコールバック（および`downloads.lastError`）
 * を確認してから解決/拒否するPromiseを返す（codexレビュー指摘、監査
 * finding #10）。修正前はコールバック内で`lastError`をログするだけで
 * 呼び出し元（downloadFile）は待たずに解決していたため、ダウンロード自体が
 * 失敗（例: ユーザーがsaveAsダイアログをキャンセル、ディスク容量不足）
 * してもエクスポートは「完了」として扱われていた。
 */
const downloadViaDataUrl = (content: string, finalFilename: string, contentType: string): Promise<void> => {
  const base64Content = btoa(encodeURIComponent(content).replace(/%([0-9A-F]{2})/g, (_match, p1) => String.fromCharCode(parseInt(p1, 16))))
  const dataUrl = `data:${contentType};base64,${base64Content}`

  return new Promise<void>((resolve, reject) => {
    chrome.downloads.download({
      url: dataUrl,
      filename: finalFilename,
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
      } else if (downloadId === undefined) {
        reject(new Error('chrome.downloads.download failed: no downloadId returned'))
      } else {
        resolve()
      }
    })
  })
}
