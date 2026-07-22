/**
 * コンテンツスクリプト: DOM にアクセスできる
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts?hl=ja
 * @see https://developer.mozilla.org/ja/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { web_accessible_resources } from '../manifest.json'
import { POKER_CHASE_SERVICE_EVENT, POKER_CHASE_ORIGIN, POKER_CHASE_SESSION_END_EVENT } from './constants/runtime'
import { ApiType } from './types'
import type { ApiEvent, PlayerStats } from './types'
import App from './components/App'
import type { ChromeMessage } from './types/messages'
import { MESSAGE_ACTIONS as EVENTS } from './types/messages'
import type { AllPlayersRealTimeStats } from './realtime-stats/realtime-stats-service'
import { setPendingStats } from './utils/pending-stats-cache'
import { RuntimePortManager } from './utils/runtime-port-manager'
import {
  EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY,
  REPLAY_BRIDGE_CONFIG,
  REPLAY_BRIDGE_FETCH,
  REPLAY_BRIDGE_RESULT,
  REPLAY_FETCH_BATCH_LIMIT,
  REPLAY_PORT_FETCH,
  REPLAY_PORT_RESULT,
  isPositiveHandId,
  type ReplayFetchRequest,
  type ReplayFetchResult
} from './replay/protocol'
/** !!! BACKGROUND、WEB_ACCESSIBLE_RESOURCES からインポートしないこと !!! */

const RECONNECT_DELAY_MS = 500
const KEEPALIVE_INTERVAL_MS = 25000 // 25秒（30秒タイムアウトより少し短く）

// ゲーム状態の管理
let isGameActive = false
let keepaliveTimer: ReturnType<typeof setInterval> | null = null
let replayBridgeReady = false
let replayImportEnabled = false
const pendingReplayRequests: ReplayFetchRequest[] = []

const postReplayConfig = () => {
  if (!replayBridgeReady) return
  window.postMessage({ type: REPLAY_BRIDGE_CONFIG, enabled: replayImportEnabled }, POKER_CHASE_ORIGIN)
}

const postReplayRequest = (message: ReplayFetchRequest) => {
  if (!replayBridgeReady || !replayImportEnabled) {
    pendingReplayRequests.push(message)
    return
  }
  window.postMessage({ ...message, type: REPLAY_BRIDGE_FETCH }, POKER_CHASE_ORIGIN)
}

const flushPendingReplayRequests = () => {
  if (!replayBridgeReady || !replayImportEnabled) return
  for (const message of pendingReplayRequests.splice(0)) postReplayRequest(message)
}

chrome.storage.local.get(EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY).then(stored => {
  replayImportEnabled = stored[EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY] === true
  postReplayConfig()
  flushPendingReplayRequests()
}).catch(() => undefined)

chrome.storage.onChanged.addListener((changes, areaName) => {
  const change = changes[EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY]
  if (areaName !== 'local' || !change) return
  replayImportEnabled = change.newValue === true
  postReplayConfig()
  if (replayImportEnabled) flushPendingReplayRequests()
  else pendingReplayRequests.splice(0)
})

export interface StatsData {
  stats: PlayerStats[]
  evtDeal?: ApiEvent<ApiType.EVT_DEAL>  // 席のマッピング用のEVT_DEALイベント
  realTimeStats?: AllPlayersRealTimeStats  // リアルタイム統計（全プレイヤー）
}

declare global {
  interface WindowEventMap {
    [POKER_CHASE_SERVICE_EVENT]: CustomEvent<StatsData>
    [POKER_CHASE_SESSION_END_EVENT]: CustomEvent<undefined>
  }
}

// キープアライブ管理
const startKeepalive = (port: chrome.runtime.Port | null) => {
  if (!port) return
  // 既存のタイマーをクリア
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer)
  }

  // ゲーム中のみキープアライブを送信
  if (isGameActive) {
    keepaliveTimer = setInterval(() => {
      try {
        port.postMessage({ type: 'keepalive' } as any)
      } catch (e) {
        // ポートが切断されている場合は静かに停止（エラー出力なし）
        stopKeepalive()
      }
    }, KEEPALIVE_INTERVAL_MS)
  }
}

const stopKeepalive = () => {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer)
    keepaliveTimer = null
  }
}

const portManager = new RuntimePortManager({
  connect: () => chrome.runtime.connect({ name: POKER_CHASE_SERVICE_EVENT }),
  reconnectDelayMs: RECONNECT_DELAY_MS,
  onConnected: port => {
    if (isGameActive) startKeepalive(port)
  },
  onDisconnected: stopKeepalive,
  onMessage: message => {
    if (typeof message === 'object' && message !== null &&
      'type' in message && message.type === REPLAY_PORT_FETCH) {
      const request = message as Partial<ReplayFetchRequest>
      if (typeof request.requestId === 'string' && Array.isArray(request.handIds) &&
        request.handIds.length <= REPLAY_FETCH_BATCH_LIMIT && request.handIds.every(isPositiveHandId)) {
        postReplayRequest(request as ReplayFetchRequest)
      }
      return
    }
    if (typeof message === 'object' && message !== null && 'stats' in message) {
      const statsMessage = message as {
        stats: PlayerStats[]
        evtDeal?: ApiEvent<ApiType.EVT_DEAL>
        realTimeStats?: AllPlayersRealTimeStats
      }
      console.time('[content_script] Dispatching stats event')
      window.dispatchEvent(new CustomEvent(POKER_CHASE_SERVICE_EVENT, { detail: statsMessage }))
      console.timeEnd('[content_script] Dispatching stats event')
      if (statsMessage.realTimeStats) {
        console.log('[content_script] Real-time stats received:', Object.keys(statsMessage.realTimeStats))
      }
    }
  },
  onSendError: error => {
    if (error instanceof Error && error.message === 'Extension context invalidated.') {
      window.location.reload()
    }
  }
})

portManager.connect()

// window.postMessageはさまざまなソースからのメッセージを受信する可能性がある
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window || event.origin !== POKER_CHASE_ORIGIN ||
    !event.data || typeof event.data !== 'object') return

  // The main-world bridge removes transport credentials before this message
  // crosses into the extension's isolated world.
  if ('type' in event.data && event.data.type === REPLAY_BRIDGE_RESULT) {
    const result = event.data as Partial<ReplayFetchResult>
    if (typeof result.requestId === 'string' && Array.isArray(result.results) &&
      result.results.length <= REPLAY_FETCH_BATCH_LIMIT) {
      portManager.send({ ...result, type: REPLAY_PORT_RESULT })
    }
    return
  }

  // PokerChase APIメッセージの型ガード: ApiTypeIdを持つことを確認
  if (
    !('ApiTypeId' in event.data) ||
    typeof event.data.ApiTypeId !== 'number'
  ) {
    return
  }

  // ゲーム状態の追跡
  //
  // ACTIVE化のトリガーはEVT_SESSION_DETAILS(308)単独に頼らない
  // （release-blocker監査 finding B。background/update-manager.tsの
  // `markSessionActive()`呼び出し箇所[background/event-ingestion.ts]と
  // 同じトリガー集合をここでミラーする -- background/content_script間は
  // import禁止のため、変更時は両ファイルを手動で揃えること）。
  // docs/api-events.md:99が明記する通り308の欠落は正常系のバリアント
  // （観測ギャップ）で、309の後に308無しで次の試合が201/303から始まる
  // ケースは普通に起こる。308だけを見ているとisGameActiveがfalseのまま
  // 固まり、keepaliveが起動せずService Workerがゲーム中にサスペンドされ
  // うる。保守的に、以下のいずれかを観測したら即active化する:
  //   - EVT_ENTRY_QUEUED(201): 着席（新セッション/新テーブルの入口）
  //   - EVT_DEAL(303, Player在席時のみ): ハンド進行中の最も強いシグナル
  //   - EVT_SESSION_DETAILS(308): 従来からのシグナル（来れば最速）
  const armSession = () => {
    if (!isGameActive) {
      isGameActive = true
      startKeepalive(portManager.port)
    }
  }

  // 参加取消申込（ApiTypeId 203）。`ApiType` enumには含まれないため生の
  // 数値リテラルを使う（background/event-ingestion.tsの
  // `EVT_ENTRY_CANCELLED_API_TYPE_ID`コメント参照）。参加(201)後・着席
  // (303/308)前にキャンセルするとハンドが一度も始まらず309も来ないため、
  // これも309と同じくkeepalive解除トリガーとして扱う（P2, codexレビュー
  // 指摘 2026-07-21, pass-3）。
  const EVT_ENTRY_CANCELLED_API_TYPE_ID = 203

  switch (event.data.ApiTypeId) {
    case ApiType.EVT_ENTRY_QUEUED:
    case ApiType.EVT_SESSION_DETAILS:
      armSession()
      break

    case ApiType.EVT_DEAL:
      // 観戦モード（ヒーロー未着席）のdealはACTIVEトリガーから除外する
      // （P2, codexレビュー指摘 2026-07-21）: docs/api-events.md「EVT_DEAL:
      // Playerフィールドの欠落」の通り、観戦モードでは`Player`フィールド
      // 自体が無い（undefined）。ここを除外しないと、ヒーローがバストして
      // 観戦中に届く303までkeepaliveを起動してしまい、以降309が来ない限り
      // isGameActiveがtrueに固まる（309が来るとは限らない -- 観戦を続けたまま
      // タブを閉じる等）。raw-firstパターンに従い、パース前の生フィールドの
      // 有無だけで判定する（background/event-ingestion.tsの
      // `applySessionActivity()`と同じ判定をミラー）。
      if ((event.data as { Player?: unknown }).Player != null) {
        armSession()
      }
      break

    case ApiType.EVT_SESSION_RESULTS:
      // セッション終了
      if (isGameActive) {
        isGameActive = false
        stopKeepalive()
      }
      // App.tsx へセッション終了を通知（bustしたプレイヤーの薄暗い表示を含む、
      // hero以外の全HUDパネルをクリアするため）。309はここで生イベントとして
      // 既に観測済みなので、background往復の新チャネルを追加せずその場でdispatchする。
      window.dispatchEvent(new CustomEvent(POKER_CHASE_SESSION_END_EVENT))
      break

    case EVT_ENTRY_CANCELLED_API_TYPE_ID:
      // 参加取消: ハンドが一度も始まっていないので、309と違いApp.tsxへの
      // セッション終了通知（POKER_CHASE_SESSION_END_EVENT）は不要
      // （そもそもクリアすべきライブHUDが存在しない）。keepaliveの解除
      // だけ行う。
      if (isGameActive) {
        isGameActive = false
        stopKeepalive()
      }
      break
  }

  portManager.send(event.data)
})

// Cleanup on window unload
window.addEventListener('beforeunload', () => {
  stopKeepalive()
  // Disconnect port gracefully
  if (portManager.port) {
    try {
      portManager.disconnect()
    } catch (e) {
      // ポートが既に切断されている可能性があるため、エラーは静かに無視
    }
  }
})

// Handle tab visibility changes
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Tab is hidden, stop keepalive to save resources
    stopKeepalive()
  } else if (isGameActive && portManager.port) {
    // Tab is visible again and game is active, restart keepalive
    startKeepalive(portManager.port)
  }
})

/**
 * バックグラウンドサービスワーカーに最新統計をリクエストする。
 * インポート後の`refreshStats`ラウンドトリップと、HUDマウント直後の
 * プリゲーム・ヒーロースタッツ取得（`mountApp()`参照）の両方で使う共通処理。
 * レスポンスは`messageHandlers.latestStats`が受け取る。
 *
 * `preGame`はマウント直後の呼び出しでのみtrueにする
 * （background/import-export.tsのgetLatestSessionStats参照）。
 * refreshStats経由の呼び出しはpreGame省略（=false相当）のまま、
 * 元々の「常に何もしない」挙動を保つ -- インポート完了時点で既に本物の
 * 再計算・ブロードキャストがトリガーされているため、そちらにまで
 * ヒーロー単独フォールバックを効かせると、後から届いた新鮮なフルの
 * 席順を古いヒーロー単独データで上書きしてしまうレースになりうる。
 */
const requestLatestStats = (preGame = false) => {
  try {
    chrome.runtime.sendMessage({ action: 'requestLatestStats', preGame })
  } catch (e) {
    // 拡張機能のコンテキストが無効な場合は静かに無視
  }
}

const messageHandlers: Record<string, (message: ChromeMessage) => void> = {
  updateBattleTypeFilter: (message) => {
    if ('filterOptions' in message) {
      window.dispatchEvent(new CustomEvent(EVENTS.UPDATE_BATTLE_TYPE_FILTER, {
        detail: message.filterOptions
      }))
    }
  },
  latestStats: (message) => {
    if ('stats' in message) {
      const data: StatsData = { stats: message.stats }
      // App's mount effect may not have registered its POKER_CHASE_SERVICE_EVENT
      // listener yet (warm SW + small local DB can resolve this before React's
      // effects flush) -- cache it so App can replay a pre-mount arrival instead
      // of silently losing it. See pending-stats-cache.ts for the full race.
      setPendingStats(data)
      window.dispatchEvent(new CustomEvent(POKER_CHASE_SERVICE_EVENT, { detail: data }))
    }
  },
  handLogEvent: (message) => {
    if ('event' in message) {
      window.dispatchEvent(new CustomEvent(EVENTS.HAND_LOG_EVENT, {
        detail: message.event
      }))
    }
  },
  updateHandLogConfig: (message) => {
    if ('config' in message) {
      window.dispatchEvent(new CustomEvent(EVENTS.UPDATE_HAND_LOG_CONFIG, {
        detail: message.config
      }))
    }
  },
  refreshStats: () => {
    // インポート後の統計更新をリクエスト
    // 最新の統計をバックグラウンドサービスから取得
    requestLatestStats()
  }
}

// downloadFile/downloadFileInit/downloadFileChunk/downloadFileFinishの4種は
// 必ずsendResponse()を呼ぶ（PR #199レビュー指摘、finding #1）。
//
// import-export.ts側のdownloadFile()は各ハンドオフをchrome.tabs.sendMessage()
// のコールバック経由でawaitし、chrome.runtime.lastErrorがあれば失敗として
// reject するようになった。ところがChromeのメッセージングAPIは、受信側の
// リスナーがsendResponse()を呼ばず`true`もreturnしない場合、リスナーが
// returnした時点でメッセージポートを閉じ、送信側のコールバックに
// `chrome.runtime.lastError = "The message port closed before a response was
// received"`をセットする ―― これは受信側の処理が実際に成功していても発生する。
// 修正前のこの4ハンドラーはBlobダウンロード処理をして`return`するだけだった
// ため、正常に配信されたエクスポートまで送信側から失敗と誤判定されていた
// （content scriptが実在しない・メッセージ拒否などの本物の配信失敗とは
// 区別できなかった）。
// ここで明示的に`sendResponse({ success: true/false })`を返すことで、
// 送信側は「本当に届いたか」を`chrome.runtime.lastError`だけでなく
// レスポンスの中身でも確認できる（import-export.tsのsendTabMessageAsync
// 参照）。sendResponse()はリスナー内で同期的に呼んでいるため、
// 非同期レスポンス用の`return true`は不要。
chrome.runtime.onMessage.addListener((message: ChromeMessage | { action: string, [key: string]: unknown }, _sender, sendResponse) => {
  // Blob-based file download (avoids Service Worker data URL size limits)
  if (message.action === 'downloadFile' && 'content' in message) {
    const m = message as any
    try {
      const blob = new Blob([m.content], { type: m.contentType })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = m.filename
      a.click()
      URL.revokeObjectURL(url)
      console.log(`[content_script] Download: ${m.filename} (${(m.content.length / 1024 / 1024).toFixed(1)}MB)`)
      sendResponse({ success: true })
    } catch (error) {
      console.error('[content_script] Download failed:', error)
      sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  // Chunked file download for large files (>50MB)
  if (message.action === 'downloadFileInit') {
    (window as any).__downloadChunks = []
    sendResponse({ success: true })
    return
  }
  if (message.action === 'downloadFileChunk' && 'chunk' in message) {
    const m = message as any
    if (!(window as any).__downloadChunks) (window as any).__downloadChunks = []
    ;(window as any).__downloadChunks.push(m.chunk)
    sendResponse({ success: true })
    return
  }
  if (message.action === 'downloadFileFinish' && 'filename' in message) {
    const m = message as any
    try {
      const chunks = (window as any).__downloadChunks || []
      const blob = new Blob(chunks, { type: m.contentType })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = m.filename
      a.click()
      URL.revokeObjectURL(url)
      console.log(`[content_script] Chunked download: ${m.filename} (${(blob.size / 1024 / 1024).toFixed(1)}MB, ${chunks.length} chunks)`)
      sendResponse({ success: true })
    } catch (error) {
      console.error('[content_script] Chunked download failed:', error)
      sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      ;(window as any).__downloadChunks = null
    }
    return
  }
  const handler = messageHandlers[message.action as keyof typeof messageHandlers]
  if (handler) {
    handler(message as ChromeMessage)
  }
})

const injectWebSocketHook = () => {
  const firstResource = web_accessible_resources[0]
  if (!firstResource?.resources[0]) return

  const script = document.createElement('script')
  script.type = 'text/javascript'
  script.src = chrome.runtime.getURL(firstResource.resources[0])
  script.addEventListener('load', () => {
    replayBridgeReady = true
    postReplayConfig()
    flushPendingReplayRequests()
  })
  document.body?.appendChild(script)
}
injectWebSocketHook()

const mountApp = () => {
  const unityContainer = document.querySelector('#unity-container')
  if (!unityContainer) return

  const appRoot = document.createElement('div')
  unityContainer.appendChild(appRoot)
  createRoot(appRoot).render(createElement(App))

  // プリゲーム・ヒーロースタッツ: 最初のEVT_DEALより前でも、既知のヒーローが
  // いればその場でHUDにスタッツを表示する。バックグラウンド側
  // （getLatestSessionStats, background/import-export.ts）がplayerId未知・
  // 既存のライブ席順・バッチモード中の場合は何も送り返さないので、それ以外の
  // ケース（フレッシュインストール等）は無変化。
  requestLatestStats(true)
}
mountApp()
