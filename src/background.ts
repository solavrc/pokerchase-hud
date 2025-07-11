/**
 * service worker: ブラウザイベントを監視できる
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/background?hl=ja
 * @see https://developer.chrome.com/docs/extensions/reference/api/storage
 * @see https://zenn.dev/dotdotdot/articles/b123e67552fe3c
 */
import process from 'process'
import PokerChaseService, {
  ApiEvent,
  ApiType,
  BATTLE_TYPE_FILTERS,
  PlayerStats,
  PokerChaseDB
} from './app'
import { EntityConverter } from './entity-converter'
import type { Options } from './components/Popup'
import type { HandLogEvent } from './types/hand-log'
import type {
  ChromeMessage,
  HandLogEventMessage,
  ImportProgressMessage,
  ImportStatusMessage,
  LatestStatsMessage,
  MessageResponse
} from './types/messages'
import { content_scripts } from '../manifest.json'
/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */

const PING_INTERVAL_MS = 10 * 1000
const IMPORT_CHUNK_SIZE = 1000

// Get game URL pattern from manifest
const gameUrlPattern = content_scripts[0]!.matches[0]!

declare global {
  interface Window {
    db: PokerChaseDB
    service: PokerChaseService
  }
}

self.process = process

const db = new PokerChaseDB(self.indexedDB, self.IDBKeyRange)
const service = new PokerChaseService({ db })
self.db = db
self.service = service

interface ImportSession {
  chunks: string[]
  totalChunks: number
  fileName: string
}
let currentImportSession: ImportSession | null = null

let lastKnownStats: PlayerStats[] = []

/** 拡張更新時の処理 */
chrome.runtime.onInstalled.addListener(details => {
  // v1からv2への移行など、将来的な処理が必要な場合はここに追加
  // 通常の更新では自動的なデータ再構築は行わない
  console.log(`[onInstalled] Extension ${details.reason}: previousVersion=${details.previousVersion}`)
})

/** 拡張起動時: フィルター設定を復元（統計の再計算はしない） */
chrome.storage.sync.get('options', (result) => {
  const options = result.options || {}

  if (options.filterOptions) {
    service.battleTypeFilter = options.filterOptions.gameTypes.sng ||
      options.filterOptions.gameTypes.mtt ||
      options.filterOptions.gameTypes.ring
      ? [...new Set([
        ...(options.filterOptions.gameTypes.sng ? BATTLE_TYPE_FILTERS.SNG : []),
        ...(options.filterOptions.gameTypes.mtt ? BATTLE_TYPE_FILTERS.MTT : []),
        ...(options.filterOptions.gameTypes.ring ? BATTLE_TYPE_FILTERS.RING : [])
      ])]
      : undefined
    service.handLimitFilter = options.filterOptions.handLimit
    service.statDisplayConfigs = options.filterOptions.statDisplayConfigs
  } else {
    // デフォルトフィルターを設定（再計算をトリガーせずに）
    service.battleTypeFilter = undefined  // デフォルトではすべてのゲームタイプを表示
    service.handLimitFilter = 500
  }

  // テスト用にハンドログをデフォルトで有効化
  service.handLogConfig = {
    enabled: true,
    maxHands: 5,
    opacity: 0.8,
    fontSize: 8,
    position: 'bottom-right',
    width: 400,
    height: 100,
    autoScroll: true,
    showTimestamps: false
  }
})

/** 拡張起動時: 最新のセッション情報を復元 */
const restoreLatestSession = async () => {
  try {
    const latestHand = await db.hands.orderBy('id').reverse().limit(1).first()
    if (latestHand) {
      if (latestHand.session) {
        service.session.id = latestHand.session.id
        service.session.battleType = latestHand.session.battleType
        service.session.name = latestHand.session.name
      }
    }

    // 最新のEVT_DEALイベントからプレイヤーIDを復元
    const recentDealEvent = await db.apiEvents
      .where('ApiTypeId').equals(ApiType.EVT_DEAL)
      .reverse()
      .filter(event => (event as ApiEvent<ApiType.EVT_DEAL>).Player?.SeatIndex !== undefined)
      .first() as ApiEvent<ApiType.EVT_DEAL> | undefined

    if (recentDealEvent && recentDealEvent.Player?.SeatIndex !== undefined) {
      service.playerId = recentDealEvent.SeatUserIds[recentDealEvent.Player.SeatIndex]
    } else {
      // 起動時にPlayerを含むEVT_DEALが見つからない（おそらく観戦ゲームのみ）
    }

    // プレイヤー名は現在データベースのplayersテーブルに直接保存されている
  } catch (error) {
    console.error('Error restoring session:', error)
  }
}
restoreLatestSession()

/**
 * データエクスポート機能
 */
chrome.runtime.onMessage.addListener((request: ChromeMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: MessageResponse) => void) => {
  if (request.action === 'exportData') {
    exportData(request.format)
      .then(() => sendResponse({ success: true }))
      .catch(error => {
        console.error('Export error:', error)
        sendResponse({ success: false, error: error.message })
      })
    return true // 非同期レスポンスを示す
  } else if (request.action === 'importData') {
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
    currentImportSession = {
      chunks: [],
      totalChunks: request.totalChunks,
      fileName: request.fileName
    }
    sendResponse({ success: true })
    return true
  } else if (request.action === 'importDataChunk') {
    if (!currentImportSession) {
      sendResponse({ success: false, error: 'No import session active' })
      return true
    }

    currentImportSession.chunks[request.chunkIndex] = request.chunkData

    sendResponse({ success: true })
    return true
  } else if (request.action === 'importDataProcess') {
    if (!currentImportSession || currentImportSession.chunks.length !== currentImportSession.totalChunks) {
      sendResponse({ success: false, error: 'Import session incomplete' })
      return true
    }

    // すべてのチャンクを結合
    const completeData = currentImportSession.chunks.join('')
    currentImportSession = null // セッションをクリア

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
      .catch(error => {
        console.error('[background.ts] Filter update error:', error)
        sendResponse({ success: false, error: error.message })
      })

    // ストレージに保存
    const storageUpdate: Partial<Options> = {
      filterOptions: request.filterOptions
    }
    chrome.storage.sync.set({ options: storageUpdate })

    // コンテンツスクリプトにメッセージを転送
    chrome.tabs.query({ url: gameUrlPattern }, tabs => {
      tabs.forEach(tab => tab.id && chrome.tabs.sendMessage(tab.id, request))
    })

    // 新しいフィルターに基づいてHUD表示を強制更新
    if (lastKnownStats.length > 0) {
      // 現在の席ユーザーIDで計算を再トリガー
      service.statsOutputStream.write(lastKnownStats.map(stat => stat.playerId))
    }

    return true // 非同期レスポンスを示す
  } else if (request.action === 'requestLatestStats') {
    getLatestSessionStats()
      .then(stats => {
        if (sender.tab?.id) {
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
        lastKnownStats = []
      })
      .catch(error => {
        console.error('Error deleting data:', error)
        sendResponse({ success: false, error: error.message })
      })
    return true
  } else if (request.action === 'rebuildData') {
    // 手動でのデータ再構築
    console.log('[rebuildData] Starting manual data rebuild...')
    
    // メタデータをクリアして全データを再処理
    db.meta.delete('lastProcessed')
      .then(() => {
        // refreshDatabaseは増分処理なので、メタデータ削除後は全データを処理する
        return service.refreshDatabase()
      })
      .then(() => {
        console.log('[rebuildData] Data rebuild completed')
        sendResponse({ success: true })
      })
      .catch(error => {
        console.error('[rebuildData] Error rebuilding data:', error)
        sendResponse({ success: false, error: error.message })
      })
    return true
  }
  return false
})

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
          const event = JSON.parse(line)
          if (event.ApiTypeId && event.timestamp) {
            const key = `${event.timestamp}-${event.ApiTypeId}`
            
            // メモリ内で重複チェック（最適化ポイント2）
            if (!existingKeys.has(key)) {
              newEvents.push(event)
              existingKeys.add(key) // 次の重複チェック用
            } else {
              duplicateCount++
            }
          } else {
            errors.push(`Line ${lineNumber}: Missing required fields`)
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
          // 直接エンティティ生成用に収集
          allNewEvents.push(...newEvents)
        } catch (dbError: any) {
          // 部分的な失敗の場合、個別に保存を試みる
          console.warn(`Bulk add failed for chunk ${Math.floor(i / IMPORT_CHUNK_SIZE) + 1}, falling back to individual adds:`, dbError)
          
          for (const event of newEvents) {
            try {
              await db.apiEvents.add(event)
              successCount++
              // 直接エンティティ生成用に収集
              allNewEvents.push(event)
            } catch (individualError: any) {
              // 個別エラーは重複以外の場合のみログ
              if (!individualError.message?.includes('Key already exists')) {
                errors.push(`Event at timestamp ${event.timestamp}: ${individualError.message}`)
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
        
        // トランザクション内で一括保存（metaテーブルも含める）
        await db.transaction('rw', [db.hands, db.phases, db.actions, db.meta], async () => {
          // 一括保存（bulkPutを使用して既存データを上書き）
          // 重複チェックは不要 - bulkPutが自動的に処理
          if (entities.hands.length > 0) {
            await db.hands.bulkPut(entities.hands)
            console.log(`[importData] Saved/updated ${entities.hands.length} hands`)
          }
          
          if (entities.phases.length > 0) {
            await db.phases.bulkPut(entities.phases)
            console.log(`[importData] Saved/updated ${entities.phases.length} phases`)
          }
          
          if (entities.actions.length > 0) {
            await db.actions.bulkPut(entities.actions)
            console.log(`[importData] Saved/updated ${entities.actions.length} actions`)
          }
          
          // メタデータもトランザクション内で更新
          // Math.maxでスプレッド演算子を使うとスタックオーバーフローになるため、reduceを使用
          const lastTimestamp = allNewEvents.reduce((max, event) => {
            const timestamp = event.timestamp || 0
            return timestamp > max ? timestamp : max
          }, 0)
          
          await db.meta.put({
            id: 'lastProcessed',
            lastProcessedTimestamp: lastTimestamp,
            lastProcessedEventCount: allNewEvents.length,
            lastImportDate: new Date()
          })
          console.log(`[importData] Updated metadata - lastTimestamp: ${lastTimestamp}`)
        })
        
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

    return { successCount, totalLines: lines.length, duplicateCount }

  } catch (error) {
    console.error('Import error:', error)
    throw error
  }
}

const exportJsonData = async (db: PokerChaseDB) => {
  const apiEvents = await db.apiEvents.toArray()

  // Convert to JSONL format (one JSON object per line)
  const jsonlContent = apiEvents
    .map(event => JSON.stringify(event))
    .join('\n')

  downloadFile(
    jsonlContent,
    'pokerchase_raw_data.ndjson',
    'application/x-ndjson'
  )
}

const exportPokerStarsData = async () => {
  try {
    // Get the last session's hand history
    const handHistory = await service.exportHandHistory()

    if (!handHistory) {
      console.error('No hands found to export')
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
  } catch (error) {
    console.error('Error exporting PokerStars format:', error)
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

  const getDataUrl = () => {
    if (contentType.includes('json') || contentType.includes('text') || contentType.includes('ndjson')) {
      // Modern replacement for deprecated unescape
      const base64Content = btoa(encodeURIComponent(content).replace(/%([0-9A-F]{2})/g, (_match, p1) => String.fromCharCode(parseInt(p1, 16))))
      return `data:${contentType};base64,${base64Content}`
    }
    console.error('Binary content not supported in this context')
    return ''
  }

  const dataUrl = getDataUrl()
  if (!dataUrl) return

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


/**
 * from `content_script.ts`
 * @see https://developer.chrome.com/docs/extensions/develop/concepts/messaging?hl=ja#port-lifetime
 * @see https://medium.com/@bhuvan.gandhi/chrome-extension-v3-mitigate-service-worker-timeout-issue-in-the-easiest-way-fccc01877abd
 */
chrome.runtime.onConnect.addListener(port => {
  if (port.name === PokerChaseService.POKER_CHASE_SERVICE_EVENT) {
    port.onMessage.addListener((message: ApiEvent) => {
      service.handAggregateStream.write(message)
    })
    const postMessage = (data: { stats: PlayerStats[], evtDeal?: ApiEvent<ApiType.EVT_DEAL> } | string) => {
      try {
        port.postMessage(data)
      } catch (error: unknown) {
        if (error instanceof Error) {
          /** when `content_script` is inactive */
          if (error.message === 'Attempting to use a disconnected port object')
            clearInterval(intervalId)
          else
            console.error(error)
        }
      }
    }
    const intervalId = setInterval(() => { postMessage(`[PING] ${new Date().toISOString()}`) }, PING_INTERVAL_MS)
    service.statsOutputStream.on('data', (hand: PlayerStats[]) => {
      lastKnownStats = hand // Store for later use
      postMessage({
        stats: hand,
        evtDeal: service.latestEvtDeal  // Include EVT_DEAL for seat mapping
      })
    })

    // Handle hand log events
    service.handLogStream.on('data', (event: HandLogEvent) => {
      // Send to all tabs with the game
      chrome.tabs.query({ url: gameUrlPattern }, tabs => {
        tabs.forEach(tab => {
          if (tab.id) {
            chrome.tabs.sendMessage<HandLogEventMessage>(tab.id, {
              action: 'handLogEvent',
              event: event
            })
          }
        })
      })
    })

    // Clean up when port disconnects
    port.onDisconnect.addListener(() => {
      // Keep lastKnownStats for page reloads - only clear interval
      clearInterval(intervalId)
    })
  }
})

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

