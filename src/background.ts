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

/** 拡張更新時: データ再構築 */
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === chrome.runtime.OnInstalledReason.UPDATE)
    service.refreshDatabase()
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
    width: 250,
    height: 200,
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
    // 行で分割し、空行をフィルタリング
    const lines = jsonlData.split('\n').filter(line => line.trim())

    // メモリ問題を避けるためチャンク単位で処理
    let processed = 0
    let successCount = 0
    let duplicateCount = 0
    const errors: string[] = []

    for (let i = 0; i < lines.length; i += IMPORT_CHUNK_SIZE) {
      const chunkLines = lines.slice(i, i + IMPORT_CHUNK_SIZE)
      const events: ApiEvent[] = []

      // チャンク内の各行をパース
      for (let j = 0; j < chunkLines.length; j++) {
        const lineNumber = i + j + 1
        const line = chunkLines[j]
        if (!line) continue

        try {
          const event = JSON.parse(line)
          if (event.ApiTypeId && event.timestamp) {
            events.push(event)
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

      // イベントをデータベースに保存
      if (events.length > 0) {
        try {
          await db.transaction('rw', [db.apiEvents], async () => {
            for (const event of events) {
              // Check for existing event with same timestamp and ApiTypeId
              const existing = await db.apiEvents.get([event.timestamp, event.ApiTypeId])
              if (!existing) {
                await db.apiEvents.add(event)
                successCount++
              } else {
                // Event already exists, skip
                duplicateCount++
              }
            }
          })
        } catch (dbError) {
          console.error(`Error storing chunk ${Math.floor(i / IMPORT_CHUNK_SIZE) + 1}:`, dbError)
          errors.push(`Chunk ${Math.floor(i / IMPORT_CHUNK_SIZE) + 1}: ${dbError}`)
        }
      }

      processed += chunkLines.length

      // Send progress update
      const progress = Math.round((processed / lines.length) * 100)
      chrome.runtime.sendMessage<ImportProgressMessage>({
        action: 'importProgress',
        progress: progress,
        processed: processed,
        total: lines.length
      })

      // Log progress every 10% or every 10000 lines
      if (progress % 10 === 0 || processed % 10000 === 0) {
      }

      // Allow browser to breathe between chunks
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    if (errors.length > 0) {
      console.warn(`Failed to import ${errors.length} lines (${((errors.length / lines.length) * 100).toFixed(2)}%)`)
      console.warn('First 10 errors:', errors.slice(0, 10))
    }

    // Refresh database after import
    service.refreshDatabase()

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

