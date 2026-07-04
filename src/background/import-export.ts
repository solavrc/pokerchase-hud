/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
import PokerChaseService, {
  ApiType,
  PokerChaseDB,
  ApiEvent,
  PlayerStats,
  isApiEventType,
  parseApiEvent,
  validateApiEvent,
  getValidationError,
  isApplicationApiEvent
} from '../app'
import { EntityConverter } from '../entity-converter'
import { saveEntities, findLatestPlayerDealEvent } from '../utils/database-utils'
import { DATABASE_CONSTANTS } from '../constants/database'
import type {
  ExportProgressMessage,
  ImportProgressMessage,
  RebuildProgressMessage
} from '../types/messages'
import { setOperationState } from './operation-state'

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

      // 直接エンティティ生成用のイベントを収集
      const allNewEvents: ApiEvent[] = []

      // メモリ問題を避けるためチャンク単位で処理
      let processed = 0
      let successCount = 0
      let duplicateCount = 0
      const errors: string[] = []

      for (let i = 0; i < lines.length; i += IMPORT_CHUNK_SIZE) {
        const chunkLines = lines.slice(i, i + IMPORT_CHUNK_SIZE)
        const newEvents: ApiEvent[] = []

        // チャンク内の各行をパース
        for (let j = 0; j < chunkLines.length; j++) {
          const lineNumber = i + j + 1
          const line = chunkLines[j]
          if (!line) continue

          try {
            const parsed = JSON.parse(line)

            // タイムスタンプチェック（インポートでは必須）
            if (!('timestamp' in parsed && parsed.timestamp)) {
              errors.push(`Line ${lineNumber}: Missing timestamp`)
              continue
            }

            // Zodスキーマ検証
            const event = parseApiEvent(parsed)
            if (!event) {
              const result = validateApiEvent(parsed)
              const errorDetails = result.error ? getValidationError(result.error)[0] : null
              errors.push(`Line ${lineNumber}: ${errorDetails?.message || 'Validation failed'}`)
              continue
            }

            // アプリケーション用のイベントかチェック
            if (!isApplicationApiEvent(event)) {
              // アプリケーションで使用しないApiTypeIdのイベントをスキップ
              continue
            }

            const key = `${event.timestamp}-${event.ApiTypeId}`

            // メモリ内で重複チェック（最適化ポイント2）
            if (!existingKeys.has(key)) {
              newEvents.push(event)
              existingKeys.add(key) // 次の重複チェック用
            } else {
              duplicateCount++
            }
          } catch (parseError) {
            // 無効なJSON行をスキップ
            if (line.trim()) {
              errors.push(`Line ${lineNumber}: Invalid JSON`)
            }
          }
        }

        // 新規イベントをbulkAddで一括保存（最適化ポイント3）
        if (newEvents.length > 0) {
          try {
            await db.apiEvents.bulkAdd(newEvents)
            successCount += newEvents.length
            allNewEvents.push(...newEvents)
          } catch (dbError) {
            // 部分的な失敗の場合、個別に保存を試みる
            console.warn(`Bulk add failed for chunk ${Math.floor(i / IMPORT_CHUNK_SIZE) + 1}, falling back to individual adds:`, dbError)

            for (const event of newEvents) {
              try {
                await db.apiEvents.add(event)
                successCount++
                allNewEvents.push(event)
              } catch (individualError) {
                // 個別エラーは重複以外の場合のみログ
                const errorMessage = individualError instanceof Error ? individualError.message : String(individualError)
                if (!errorMessage.includes('Key already exists')) {
                  errors.push(`Event at timestamp ${event.timestamp}: ${errorMessage}`)
                } else {
                  duplicateCount++
                  successCount-- // 重複の場合は成功数から除外
                }
              }
            }
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

      // バッチモードを無効化
      service.setBatchMode(false)

      // インポート後に統計を強制的に更新
      // 最新のEVT_DEALを取得して統計計算をトリガー
      const latestDealEvent = await findLatestPlayerDealEvent(db)

      if (latestDealEvent && isApiEventType(latestDealEvent, ApiType.EVT_DEAL)) {
        // latestEvtDealを更新
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

      setOperationState({ type: 'idle' })
      return { successCount, totalLines: lines.length, duplicateCount }

    } catch (error) {
      setOperationState({ type: 'idle' })
      console.error('Import error:', error)
      throw error
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

      // Direct chunked export using primary key cursor to avoid Dexie Collection offset issues
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

      // データベースの新しいインスタンスを確保するために拡張機能をリロード
      chrome.runtime.reload()
    } catch (error) {
      console.error('Error deleting data:', error)
      throw error
    }
  }

  /**
   * Get the latest session stats from the last known data or database
   */
  const getLatestSessionStats = async (): Promise<PlayerStats[]> => {
    // Return empty array - stats will be calculated when game starts
    // This avoids showing stale data and ensures EVT_DEAL is available for seat mapping
    return []
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

        // Load all events and convert in one pass
        // (EntityConverter tracks hand state internally, so chunked conversion loses cross-chunk hands)
        console.log(`[rebuildAllData] Loading all events...`)
        const allEvents = await db.apiEvents.orderBy('[timestamp+ApiTypeId]').toArray()
        console.log(`[rebuildAllData] Loaded ${allEvents.length} events, converting to entities...`)

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

        // Trigger stats recalculation once at the end
        if (service.latestEvtDeal && service.latestEvtDeal.SeatUserIds) {
          const playerIds = service.latestEvtDeal.SeatUserIds.filter(id => id !== -1)
          if (playerIds.length > 0) {
            console.log('[rebuildAllData] Triggering stats recalculation...')
            service.statsOutputStream.write(service.latestEvtDeal.SeatUserIds)
          }
        }

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
 * 長時間のバッチ処理中は chrome.offscreen API でオフスクリーン
 * ドキュメントを作成して Worker を維持する。
 *
 * offscreen ドキュメントが存在する間、Worker は停止されない。
 * @returns クリーンアップ関数
 */
const startKeepAlive = async (): Promise<() => void> => {
  // offscreen API が利用可能な場合はそれを使用（Chrome 109+）
  if (chrome.offscreen) {
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: 'Keep service worker alive during batch export'
      })
    } catch (e) {
      // 既に存在する場合は無視
    }
    return () => {
      chrome.offscreen.closeDocument().catch(() => {})
    }
  }

  // フォールバック: setInterval + getPlatformInfo
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
