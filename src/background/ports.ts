/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
import type PokerChaseService from '../services/poker-chase-service'
import type { ApiEvent, ApiType, PlayerStats } from '../app'
import type { AllPlayersRealTimeStats } from '../realtime-stats/realtime-stats-service'
import type { HandLogEvent } from '../types/hand-log'
import type { HandLogEventMessage } from '../types/messages'

const PING_INTERVAL_MS = 10 * 1000

let lastKnownStats: PlayerStats[] = []

// Store latest real-time stats (module scope: shared across all port connections)
let latestRealTimeStats: AllPlayersRealTimeStats | undefined

export const getLastKnownStats = (): PlayerStats[] => lastKnownStats

export const setLastKnownStats = (stats: PlayerStats[]): void => {
  lastKnownStats = stats
}

// Monotonic counter bumped every time the live pipeline (statsOutputStream, driven by a
// real EVT_DEAL) broadcasts a fresh lineup -- see registerStreamSubscriptions() below.
// message-router.ts's `requestLatestStats` handler snapshots this before computing the
// pre-game hero-only fallback (getLatestSessionStats) and compares it again once that
// (async) computation resolves: a changed value means a real live broadcast landed while
// the fallback was in flight, so the now-stale fallback must be dropped rather than sent
// -- otherwise it would overwrite the live lineup the tab already received via the port
// channel (broadcastMessage, below). A plain "is lastKnownStats non-empty" check can't
// substitute for this: lastKnownStats survives across tab reloads for the life of the
// Service Worker, so it is very often already non-empty by the time an unrelated tab
// mounts, which would wrongly suppress the fallback forever after the first hand ever
// played in that Service Worker's lifetime.
let liveBroadcastSequence = 0

export const getLiveBroadcastSequence = (): number => liveBroadcastSequence

export const getLatestRealTimeStats = (): AllPlayersRealTimeStats | undefined => latestRealTimeStats

/**
 * `chrome.runtime.onConnect`で接続されたポートの集合
 * ストリームイベントをブロードキャストする際の送信先として利用する
 */
export const connectedPorts = new Set<chrome.runtime.Port>()

/**
 * 接続中の全ポートにメッセージをブロードキャストする
 * 切断済みポートを検出した場合は`connectedPorts`から取り除く
 */
export const broadcastMessage = (data: { stats: PlayerStats[], evtDeal?: ApiEvent<ApiType.EVT_DEAL>, realTimeStats?: AllPlayersRealTimeStats } | string) => {
  connectedPorts.forEach(port => {
    try {
      port.postMessage(data)
    } catch (error: unknown) {
      if (error instanceof Error) {
        /** when `content_script` is inactive */
        if (error.message === 'Attempting to use a disconnected port object')
          connectedPorts.delete(port)
        else
          console.error(error)
      }
    }
  })
}

/**
 * PINGは自ポートにのみ送信する（ブロードキャストしない）
 * `chrome.runtime.onConnect`のポート接続時に呼び出し、クリーンアップ関数を受け取る
 */
export const startPortPing = (port: chrome.runtime.Port): () => void => {
  const pingPort = (data: string) => {
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
  const intervalId = setInterval(() => { pingPort(`[PING] ${new Date().toISOString()}`) }, PING_INTERVAL_MS)
  return () => clearInterval(intervalId)
}

/**
 * from `content_script.ts`
 * @see https://developer.chrome.com/docs/extensions/develop/concepts/messaging?hl=ja#port-lifetime
 * @see https://medium.com/@bhuvan.gandhi/chrome-extension-v3-mitigate-service-worker-timeout-issue-in-the-easiest-way-fccc01877abd
 *
 * メッセージの型保証:
 * 1. web_accessible_resource.ts: ApiTypeIdを持つメッセージのみ送信
 * 2. content_script.ts: ApiMessage型として受信・転送
 * 3. background.ts: ApiMessage型として受信し、完全な検証を実施
 */
// 以下の3つのストリームリスナーは、Service Workerのライフタイム中に一度だけ登録する
// （`onConnect`のたびに登録すると、ページリロード/再接続のたびにリスナーが積み重なり、
// 特に`handLogStream`のハンドラーはNタブ分`chrome.tabs.sendMessage`を重複送信してしまう）
export const registerStreamSubscriptions = (service: PokerChaseService, gameUrlPattern: string): void => {
  // Listen for real-time stats from dedicated stream
  service.realTimeStatsStream.on('data', (data: { handId?: number, stats: AllPlayersRealTimeStats, timestamp: number }) => {
    latestRealTimeStats = data.stats

    // Send update with real-time stats only
    if (lastKnownStats && lastKnownStats.length > 0) {
      broadcastMessage({
        stats: lastKnownStats,
        // liveEvtDeal (not latestEvtDeal): this pairing drives App.tsx's seat
        // rotation for whatever table is *currently* being broadcast (which
        // may be a spectator-mode table after the hero busts). latestEvtDeal
        // stays pinned to the hero's own most recent seated deal (used by
        // recalculateStats()/recalculateAllStats() to rebuild hero-context
        // stats on filter changes / batch-mode end) -- see the getter/setter
        // doc comments on PokerChaseService and aggregate-events-stream.ts's
        // EVT_DEAL case for the full rationale (codex #177).
        evtDeal: service.liveEvtDeal,
        realTimeStats: latestRealTimeStats
      })
    }
  })
  service.statsOutputStream.on('data', async (hand: PlayerStats[]) => {
    lastKnownStats = hand // Store for later use
    liveBroadcastSequence++ // A real live lineup broadcast just went out -- see getLiveBroadcastSequence()'s doc comment

    // Real-time stats are now handled by RealTimeStatsStream
    broadcastMessage({
      stats: hand,
      evtDeal: service.liveEvtDeal,  // Include EVT_DEAL for seat mapping (live context, not the persisted hero-anchored one -- see above)
      realTimeStats: latestRealTimeStats  // Include latest real-time stats from stream
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
}
