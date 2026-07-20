/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
import PokerChaseService, {
  ApiType,
  PokerChaseDB,
  ApiEvent,
  PlayerStats,
  isApiEventType,
  parseApiEvent,
  validateApiEvent,
  validateMessage,
  getValidationError,
  isApplicationApiEvent
} from '../app'
import { EntityConverter } from '../entity-converter'
import { saveEntities, findLatestPlayerDealEvent, filterValidApplicationEvents } from '../utils/database-utils'
import { DATABASE_CONSTANTS } from '../constants/database'
import type {
  ExportProgressMessage,
  ImportProgressMessage,
  RebuildProgressMessage
} from '../types/messages'
import { setOperationState } from './operation-state'
import { resolveAdvisory } from './rebuild-advisory'

const IMPORT_CHUNK_SIZE = DATABASE_CONSTANTS.IMPORT_CHUNK_SIZE

interface ImportSession {
  chunks: string[]
  totalChunks: number
  fileName: string
}
let currentImportSession: ImportSession | null = null

export const getCurrentImportSession = (): ImportSession | null => currentImportSession

export const startImportSession = (totalChunks: number, fileName: string): void => {
  currentImportSession = {
    chunks: [],
    totalChunks,
    fileName
  }
}

export const addImportChunk = (chunkIndex: number, chunkData: string): void => {
  if (!currentImportSession) return
  currentImportSession.chunks[chunkIndex] = chunkData
}

export const clearImportSession = (): void => {
  currentImportSession = null
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
      console.log('[importData] Starting optimized import process with direct entity generation')
      const startTime = performance.now()

      // 既存キーを一括取得（最適化ポイント1）
      console.log('[importData] Loading existing keys...')
      const existingKeys = new Set<string>()
      await db.apiEvents
        .orderBy('[timestamp+ApiTypeId]')
        .keys(keys => {
          keys.forEach(key => {
            if (Array.isArray(key) && key.length === 2) {
              existingKeys.add(`${key[0]}-${key[1]}`)
            }
          })
        })
      console.log(`[importData] Loaded ${existingKeys.size} existing keys`)

      // 行で分割し、空行をフィルタリング
      const lines = jsonlData.split('\n').filter(line => line.trim())
      console.log(`[importData] Processing ${lines.length} lines`)

      // バッチモードを有効化
      service.setBatchMode(true)
      batchModeEnabled = true

      // 直接エンティティ生成用のイベントを収集
      const allNewEvents: ApiEvent[] = []

      // メモリ問題を避けるためチャンク単位で処理
      let processed = 0
      let successCount = 0
      let duplicateCount = 0
      const errors: string[] = []

      for (let i = 0; i < lines.length; i += IMPORT_CHUNK_SIZE) {
        const chunkLines = lines.slice(i, i + IMPORT_CHUNK_SIZE)
        // Raw Event Lake: 保存対象は「timestamp/ApiTypeIdが数値」の行すべて
        // （Zod検証の成否・アプリケーションイベントか否かは問わない）
        const rawEventsToStore: Array<Record<string, unknown> & { timestamp: number, ApiTypeId: number }> = []
        // エンティティ生成対象（検証済みアプリケーションイベントのみ）。
        // key（`${timestamp}-${ApiTypeId}`）で対応するrawEventsToStoreの要素と紐付ける
        const validAppEventsByKey = new Map<string, ApiEvent>()

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

            const key = `${parsed.timestamp}-${parsed.ApiTypeId}`

            // メモリ内で重複チェック（最適化ポイント2）
            if (existingKeys.has(key)) {
              duplicateCount++
              continue
            }

            rawEventsToStore.push(parsed)
            existingKeys.add(key) // 次の重複チェック用

            // Zodスキーマ検証（エンティティ生成対象かどうかの判定のみ。保存は上で確定済み）
            const event = parseApiEvent(parsed)
            if (!event) {
              const result = validateApiEvent(parsed)
              const errorDetails = result.error ? getValidationError(result.error)[0] : null
              errors.push(`Line ${lineNumber}: ${errorDetails?.message || 'Validation failed'} (保存済み・エンティティ生成対象外)`)
              continue
            }

            // アプリケーション用のイベントかチェック
            if (!isApplicationApiEvent(event)) {
              // 非アプリケーションイベント: 生ログとしては保存対象だがエンティティ生成対象外
              continue
            }

            validAppEventsByKey.set(key, event)
          } catch (parseError) {
            // 無効なJSON行をスキップ
            if (line.trim()) {
              errors.push(`Line ${lineNumber}: Invalid JSON`)
            }
          }
        }

        // 生イベントをbulkAddで一括保存（最適化ポイント3。検証可否に関わらず全件保存）
        if (rawEventsToStore.length > 0) {
          const storedKeys = new Set<string>()

          try {
            // apiEvents is the raw Lake (see docs/architecture.md): rows may not
            // conform to the ApiEvent union (non-application types, unknown
            // ApiTypeIds, or app-type payloads that fail the current schema) —
            // the assertion is intentional, mirroring the same pattern used in
            // event-ingestion.ts's real-time storage path.
            await db.apiEvents.bulkAdd(rawEventsToStore as ApiEvent[])
            successCount += rawEventsToStore.length
            rawEventsToStore.forEach(raw => storedKeys.add(`${raw.timestamp}-${raw.ApiTypeId}`))
          } catch (dbError) {
            // 部分的な失敗の場合、個別に保存を試みる
            console.warn(`Bulk add failed for chunk ${Math.floor(i / IMPORT_CHUNK_SIZE) + 1}, falling back to individual adds:`, dbError)

            for (const raw of rawEventsToStore) {
              const key = `${raw.timestamp}-${raw.ApiTypeId}`
              try {
                await db.apiEvents.add(raw as ApiEvent)
                successCount++
                storedKeys.add(key)
              } catch (individualError) {
                // 個別エラーは重複以外の場合のみログ
                const errorMessage = individualError instanceof Error ? individualError.message : String(individualError)
                if (!errorMessage.includes('Key already exists')) {
                  errors.push(`Event at timestamp ${raw.timestamp}: ${errorMessage}`)
                } else {
                  duplicateCount++
                  successCount-- // 重複の場合は成功数から除外
                }
              }
            }
          }

          // エンティティ生成には、実際に保存が確認できたアプリケーションイベントのみを渡す
          for (const [key, event] of validAppEventsByKey) {
            if (storedKeys.has(key)) allNewEvents.push(event)
          }
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

      // 直接エンティティ生成（Phase 2最適化）
      if (allNewEvents.length > 0) {
        console.log(`[importData] Generating entities from ${allNewEvents.length} new events...`)
        const entityStartTime = performance.now()

        try {
          // EntityConverterを使用してエンティティを生成
          const converter = new EntityConverter(service.session)
          const entities = converter.convertEventsToEntities(allNewEvents)

          console.log(`[importData] Generated entities - Hands: ${entities.hands.length}, Phases: ${entities.phases.length}, Actions: ${entities.actions.length}`)

          // Save entities using common utility
          await saveEntities(db, entities, {
            onProgress: (counts) => {
              console.log(`[importData] Saved/updated ${counts.hands} hands, ${counts.phases} phases, ${counts.actions} actions`)
            }
          })

          // Update metadata separately
          // Math.maxでスプレッド演算子を使うとスタックオーバーフローになるため、reduceを使用
          const lastTimestamp = allNewEvents.reduce((max, event) => {
            const timestamp = event.timestamp || 0
            return timestamp > max ? timestamp : max
          }, 0)

          await db.meta.put({
            id: 'importStatus',
            value: {
              lastProcessedTimestamp: lastTimestamp,
              lastProcessedEventCount: allNewEvents.length,
              lastImportDate: new Date().toISOString()
            },
            updatedAt: Date.now()
          })
          console.log(`[importData] Updated metadata - lastTimestamp: ${lastTimestamp}`)

          const entityTime = ((performance.now() - entityStartTime) / 1000).toFixed(2)
          console.log(`[importData] Entity generation completed in ${entityTime}s`)

        } catch (entityError) {
          console.error('[importData] Entity generation error:', entityError)
          // エラーの詳細をログに記録するが、処理は継続
          // refreshDatabaseへのフォールバックは削除（トランザクション競合を避けるため）
          const errorMessage = entityError instanceof Error ? entityError.message : String(entityError)
          throw new Error(`Entity generation failed: ${errorMessage}`)
        }
      } else {
        // 新規イベントがない場合は増分処理も不要
        console.log('[importData] No new events to process')
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
                })
              }
            })
          })
        }
      }

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
    const stopKeepAlive = await startKeepAlive()
    try {
      setOperationState({ type: 'export', format: 'json', progress: 0 })
      chrome.runtime.sendMessage<ExportProgressMessage>({
        action: 'exportProgress',
        state: 'started',
        format: 'json',
        message: 'NDJSONエクスポート開始...'
      }).catch(() => {})

      const totalCount = await db.apiEvents.count()
      console.log(`[Export] Exporting ${totalCount} events...`)

      // Direct chunked export using primary key cursor to avoid Dexie Collection offset issues.
      // Dumps the full apiEvents Lake verbatim (raw fidelity, "a line is a line") — no
      // filtering by validity or application-type here; this is what feeds the warehouse
      // and offline schema-diff tooling (see docs/architecture.md "Raw Event Lake").
      const chunks: string[] = []
      let processedCount = 0
      let lastKey: any = undefined
      const chunkSize = DATABASE_CONSTANTS.EXPORT_CHUNK_SIZE

      while (true) {
        // Build fresh query each iteration using primary key range
        const chunk = lastKey !== undefined
          ? await db.apiEvents.where('[timestamp+ApiTypeId]').above(lastKey).limit(chunkSize).toArray()
          : await db.apiEvents.orderBy('[timestamp+ApiTypeId]').limit(chunkSize).toArray()

        if (chunk.length === 0) break

        chunks.push(chunk.map(event => JSON.stringify(event)).join('\n'))
        processedCount += chunk.length

        // Track last key for next iteration
        const lastEvent = chunk[chunk.length - 1]!
        lastKey = [lastEvent.timestamp, lastEvent.ApiTypeId]

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

        if (chunk.length < chunkSize) break // Last chunk
      }

      const jsonlContent = chunks.join('\n')

      downloadFile(
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
    const stopKeepAlive = await startKeepAlive()
    try {
      setOperationState({ type: 'export', format: 'pokerstars', progress: 0 })
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
        chrome.notifications.create({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon_48px.png'),
          title: 'エクスポートエラー',
          message: 'エクスポートするハンドが見つかりませんでした。ゲームをプレイしてから再度お試しください。'
        })
        return
      }

      downloadFile(
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
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon_48px.png'),
        title: 'エクスポートエラー',
        message: 'ハンドヒストリーのエクスポート中にエラーが発生しました。'
      })
      throw error
    }
  }

  const downloadFile = (content: string, filename: string, contentType: string) => {
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
    chrome.tabs.query({ url: gameUrlPattern }, async tabs => {
      const tab = tabs.find(t => t.id)
      if (tab?.id) {
        const sizeMB = content.length / 1024 / 1024
        const MAX_CHUNK_MB = 50 // Under Chrome's 64MiB message limit
        const maxChunkSize = MAX_CHUNK_MB * 1024 * 1024

        if (content.length <= maxChunkSize) {
          chrome.tabs.sendMessage(tab.id, { action: 'downloadFile', content, filename: finalFilename, contentType })
        } else {
          // Split into chunks for large files
          const totalChunks = Math.ceil(content.length / maxChunkSize)
          console.log(`[Export] Splitting ${sizeMB.toFixed(1)}MB into ${totalChunks} chunks...`)
          chrome.tabs.sendMessage(tab.id, { action: 'downloadFileInit', filename: finalFilename, contentType, totalChunks })
          for (let i = 0; i < totalChunks; i++) {
            const chunk = content.slice(i * maxChunkSize, (i + 1) * maxChunkSize)
            chrome.tabs.sendMessage(tab.id, { action: 'downloadFileChunk', chunkIndex: i, chunk, totalChunks })
          }
          chrome.tabs.sendMessage(tab.id, { action: 'downloadFileFinish', filename: finalFilename, contentType })
        }
        console.log(`[Export] Download initiated via content script: ${finalFilename} (${sizeMB.toFixed(1)}MB)`)
        return
      }
      // Fallback: data URL (may fail for large files >2MB)
      console.warn('[Export] No game tab found, falling back to data URL download')
      downloadViaDataUrl(content, finalFilename, contentType)
    })
  }

  /**
   * Delete all data (logs only, not configuration)
   */
  const deleteAllData = async (): Promise<void> => {
    try {
      // データベースを完全に削除
      await db.delete()

      // データが無くなったので再構築アドバイザリも解消する（reloadより前に行う）
      await resolveAdvisory()

      // データベースの新しいインスタンスを確保するために拡張機能をリロード
      chrome.runtime.reload()
    } catch (error) {
      console.error('Error deleting data:', error)
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
   * Also returns [] (send nothing, don't touch the caller's current state)
   * when hero identity isn't known yet (fresh install / never played --
   * behavior stays unchanged for that case) or an import/rebuild batch
   * operation is in flight (`service.batchMode` -- don't fight that
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
    if (!service.playerId) return []

    const heroStats = await service.statsOutputStream.calcStats([service.playerId])
    const heroStat = heroStats[0] ?? { playerId: service.playerId, statResults: [] }
    const emptySeats: PlayerStats[] = Array.from({ length: 5 }, () => ({ playerId: -1 }))
    return [heroStat, ...emptySeats]
  }

  /**
   * Rebuild all data from apiEvents using batch processing
   * Similar to download sync processing to avoid multiple HUD updates
   */
  const rebuildAllData = async (): Promise<void> => {
    try {
      console.log('[rebuildAllData] Starting batch rebuild of all data...')
      const startTime = performance.now()

      setOperationState({ type: 'rebuild', progress: 0, message: 'データ再構築開始...' })
      chrome.runtime.sendMessage<RebuildProgressMessage>({
        action: 'rebuildProgress',
        state: 'started',
        message: 'データ再構築開始...'
      }).catch(() => {})

      // Clear all entity tables first
      await db.transaction('rw', [db.hands, db.phases, db.actions, db.meta], async () => {
        await db.hands.clear()
        await db.phases.clear()
        await db.actions.clear()
        await db.meta.delete('lastProcessed')
      })

      setOperationState({ type: 'rebuild', progress: 10, message: 'テーブルクリア完了、イベント読み込み中...' })
      chrome.runtime.sendMessage<RebuildProgressMessage>({
        action: 'rebuildProgress',
        state: 'processing',
        progress: 10,
        message: 'テーブルクリア完了、イベント読み込み中...'
      }).catch(() => {})

      // Get total event count
      const totalCount = await db.apiEvents.count()
      console.log(`[rebuildAllData] Processing ${totalCount} events...`)

      if (totalCount === 0) {
        console.log('[rebuildAllData] No events to process')
        // 対象イベントが無い＝再構築の必要が無いため、保留中のアドバイザリも解消する
        await resolveAdvisory()
        setOperationState({ type: 'idle' })
        chrome.runtime.sendMessage<RebuildProgressMessage>({
          action: 'rebuildProgress',
          state: 'completed',
          progress: 100,
          message: '処理対象のイベントがありません'
        }).catch(() => {})
        return
      }

      // Enable batch mode to prevent real-time updates
      service.setBatchMode(true)

      try {
        // Process in chunks to avoid memory issues
        let totalHands = 0
        let totalPhases = 0
        let totalActions = 0

        // Initialize EntityConverter
        const defaultSession = {
          id: undefined,
          battleType: undefined,
          name: undefined,
          players: new Map(),
          reset: () => { }
        }
        const converter = new EntityConverter(defaultSession)

        // Load all raw events and convert in one pass
        // (EntityConverter tracks hand state internally, so chunked conversion loses cross-chunk hands)
        console.log(`[rebuildAllData] Loading all events...`)
        const rawEvents = await db.apiEvents.orderBy('[timestamp+ApiTypeId]').toArray()

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
        const allEvents = await filterValidApplicationEvents(rawEvents)
        const skippedCount = rawEvents.length - allEvents.length
        console.log(`[rebuildAllData] Loaded ${rawEvents.length} raw events, ${allEvents.length} valid application events after re-validation${skippedCount > 0 ? ` (${skippedCount} non-application/unparseable rows skipped)` : ''}`)

        setOperationState({ type: 'rebuild', progress: 40, message: `${allEvents.length.toLocaleString()}件のイベントを変換中...` })
        chrome.runtime.sendMessage<RebuildProgressMessage>({
          action: 'rebuildProgress',
          state: 'processing',
          progress: 40,
          message: `${allEvents.length.toLocaleString()}件のイベントを変換中...`
        }).catch(() => {})

        const entities = converter.convertEventsToEntities(allEvents)

        setOperationState({ type: 'rebuild', progress: 70, message: 'エンティティ保存中...' })
        chrome.runtime.sendMessage<RebuildProgressMessage>({
          action: 'rebuildProgress',
          state: 'processing',
          progress: 70,
          message: 'エンティティ保存中...'
        }).catch(() => {})

        const counts = await saveEntities(db, entities)
        totalHands += counts.hands
        totalPhases += counts.phases
        totalActions += counts.actions

        console.log(`[rebuildAllData] Generated entities - Hands: ${totalHands}, Phases: ${totalPhases}, Actions: ${totalActions}`)

        // Restore service state from latest events
        // (codex #177 3巡目レビューP2: このsetterはservice.liveEvtDealも同時に
        // 同期するため、下のsetBatchMode(false)がトリガーするrecalculateAllStats()
        // の再ブロードキャストは、再構築前のliveEvtDeal（観戦中に取り残された
        // 可能性がある）ではなく、この復元されたヒーロー在籍dealの座席文脈を使う)
        const latestDealEvent = await findLatestPlayerDealEvent(db)

        if (latestDealEvent && isApiEventType(latestDealEvent, ApiType.EVT_DEAL)) {
          service.latestEvtDeal = latestDealEvent
          if (latestDealEvent.Player?.SeatIndex !== undefined) {
            service.playerId = latestDealEvent.SeatUserIds[latestDealEvent.Player.SeatIndex]
          }
        }

        // Update metadata with rebuild info
        await db.meta.put({
          id: 'rebuildStatus',
          value: {
            lastRebuildDate: new Date().toISOString(),
            totalEvents: totalCount,
            totalHands: totalHands,
            totalPhases: totalPhases,
            totalActions: totalActions
          },
          updatedAt: Date.now()
        })

        const rebuildTime = ((performance.now() - startTime) / 1000).toFixed(2)
        console.log(`[rebuildAllData] Rebuild completed in ${rebuildTime}s`)

        setOperationState({ type: 'rebuild', progress: 90, message: '統計情報を再計算中...' })
        chrome.runtime.sendMessage<RebuildProgressMessage>({
          action: 'rebuildProgress',
          state: 'processing',
          progress: 90,
          message: '統計情報を再計算中...'
        }).catch(() => {})

        // Trigger stats recalculation once at the end. NOTE: batchMode is still
        // true here (disabled in the `finally` block below via
        // service.setBatchMode(false)), so ReadEntityStream.transform() no-ops
        // this particular write() -- the real broadcast is the one
        // setBatchMode(false) triggers via PokerChaseService.recalculateAllStats(),
        // which reads the already-restored (hero-anchored) service.latestEvtDeal
        // above and keeps calling this again mostly harmless/redundant.
        if (service.latestEvtDeal && service.latestEvtDeal.SeatUserIds) {
          const playerIds = service.latestEvtDeal.SeatUserIds.filter(id => id !== -1)
          if (playerIds.length > 0) {
            console.log('[rebuildAllData] Triggering stats recalculation...')
            service.statsOutputStream.write(service.latestEvtDeal.SeatUserIds)
          }
        }

        // 再構築が完了したので、保留中の再構築アドバイザリがあれば解消する
        await resolveAdvisory()

        setOperationState({ type: 'idle' })
        chrome.runtime.sendMessage<RebuildProgressMessage>({
          action: 'rebuildProgress',
          state: 'completed',
          progress: 100,
          message: `データ再構築完了 (${rebuildTime}秒) - ハンド: ${totalHands.toLocaleString()}, フェーズ: ${totalPhases.toLocaleString()}, アクション: ${totalActions.toLocaleString()}`
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
 * タイマーをリセットする。manifestのminimum_chrome_versionは120。
 * @returns クリーンアップ関数
 */
export const startKeepAlive = async (): Promise<() => void> => {
  const id = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {})
  }, 25000)
  return () => clearInterval(id)
}

const downloadViaDataUrl = (content: string, finalFilename: string, contentType: string) => {
  const base64Content = btoa(encodeURIComponent(content).replace(/%([0-9A-F]{2})/g, (_match, p1) => String.fromCharCode(parseInt(p1, 16))))
  const dataUrl = `data:${contentType};base64,${base64Content}`

  chrome.downloads.download({
    url: dataUrl,
    filename: finalFilename,
    saveAs: true
  }, () => {
    if (chrome.runtime.lastError) {
      console.error('Download error:', chrome.runtime.lastError)
    }
  })
}
