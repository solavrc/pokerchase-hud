/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
import type PokerChaseService from '../services/poker-chase-service'
import type { ApiEvent, ApiType, PlayerStats } from '../app'
import type { AllPlayersRealTimeStats } from '../realtime-stats/realtime-stats-service'
import type { HandLogEvent } from '../types/hand-log'
import type { HandLogEventMessage } from '../types/messages'
import { formatHandLogEntries } from '../utils/hand-log-text'
import {
  claimActivePort,
  getActivePort,
  getActivePortGeneration,
  registerActivePortConnection,
  releaseActivePort
} from './active-port'
import {
  getStatsOutputContext,
  setDefaultStatsContextProvider,
  setStatsRequestContext
} from '../streams/stats-output-context'

const PING_INTERVAL_MS = 10 * 1000

let lastKnownStats: PlayerStats[] = []
let latestRealTimeStats: AllPlayersRealTimeStats | undefined
// service.liveEvtDealはbatch再計算時にもstatsと同じ文脈へ再アンカーされるため、
// 値自体は引き続き使う。ただし現在ACTIVE世代がDEALを1件も届けていない間は、
// 前世代から残った値を席回転へ使ってはならない（MUST NOT）。
let activeGenerationHasDeal = false

export const getLastKnownStats = (): PlayerStats[] => lastKnownStats

export const setLastKnownStats = (stats: PlayerStats[]): void => {
  lastKnownStats = stats
}

// Monotonic sequence assigned after each successful aggregate delivery. The per-tab map
// lets message-router.ts suppress a stale pre-game hero fallback only when that same tab
// received a live lineup while its DB computation was in flight. A global sequence would
// wrongly suppress the genuinely port-scoped fallback in a relic tab whenever the ACTIVE
// tab received an unrelated update.
let liveBroadcastSequence = 0
const liveBroadcastSequenceByTab = new Map<number, number>()

export const getLiveBroadcastSequenceForTab = (tabId: number | undefined): number =>
  tabId === undefined ? 0 : liveBroadcastSequenceByTab.get(tabId) ?? 0

// Monotonic counter for the wire-level "hand epoch" (audit finding 11 follow-up, P2:
// a first pass reused `liveBroadcastSequence` for this, but codex review correctly
// pointed out that counter -- and `statsOutputStream`'s 'data' event it's driven by --
// fires on more than genuine hand completions: it also fires for the hand-start
// "warmup" broadcast (aggregate-events-stream.ts's EVT_DEAL handler, when the DB
// already has hands for the newly-dealt lineup) and for filter-change/import/
// auto-sync-restore rebroadcasts (message-router.ts's `updateBattleTypeFilter`,
// recalculateStats()/recalculateAllStats(), import-export.ts, auto-sync-service.ts --
// all of which call `service.statsOutputStream.write()` directly). None of those are
// "a hand just completed", so bumping this epoch on them caused spurious refetches
// (and would have caused premature cache invalidation, see positional-stats-service.ts/
// recent-hands-service.ts's subscribeToHandCompletion) on an open drill-down panel.
//
// `service.writeEntityStream`'s 'data' event is the one true completion signal: it
// only fires from `write-entity-stream.ts`'s `this.push(hand.seatUserIds)`, reached
// exclusively via the live pipeline (`handAggregateStream.pipe(writeEntityStream)`,
// itself only fed by the real-time port in event-ingestion.ts) after a hand's events
// have actually been detected as complete (EVT_HAND_RESULTS) and successfully
// persisted (chimera hands return early without pushing, see that file). The
// hand-start warmup and filter/import/auto-sync rebroadcasts above all call
// `statsOutputStream.write()` *directly*, bypassing `writeEntityStream` entirely, so
// none of them touch this counter.
let handCompletionEpoch = 0

/**
 * `chrome.runtime.onConnect`で接続されたポートの集合。
 * lifecycleと明示的なport-scoped requestに使い、stats配信先の選択には使わない。
 */
export const connectedPorts = new Set<chrome.runtime.Port>()

type StatsMessage = {
  stats: PlayerStats[]
  evtDeal?: ApiEvent<ApiType.EVT_DEAL>
  realTimeStats?: AllPlayersRealTimeStats
  realTimeOnly?: boolean
  handEpoch?: number
}

const postMessageToPort = (port: chrome.runtime.Port, data: StatsMessage | string): boolean => {
  try {
    port.postMessage(data)
    return true
  } catch (error: unknown) {
    if (error instanceof Error) {
      if (error.message === 'Attempting to use a disconnected port object') {
        connectedPorts.delete(port)
        releaseActivePort(port)
      } else {
        console.error(error)
      }
    }
    return false
  }
}

/**
 * game eventの到着元へACTIVE tokenを移し、handover時は現在ハンドの状態を捨てる。
 * relic側へclear通知は送らない（MUST NOT）。
 */
export const claimActivePortForGameEvent = (
  service: PokerChaseService,
  port: chrome.runtime.Port,
  deliveredAt: number
): number => {
  const claim = claimActivePort(port, deliveredAt)
  const generation = getActivePortGeneration()!
  if (claim !== 'handover') return generation
  service.realTimeStatsStream.reset()
  latestRealTimeStats = undefined
  activeGenerationHasDeal = false
  // tokenを取得したtabには、relic時代に凍結していた現在ハンド表示を次の
  // stream出力まで残してはならない（MUST NOT）。aggregate lineupは触らない。
  postMessageToPort(port, {
    stats: lastKnownStats,
    realTimeStats: { heroStats: {}, playerStats: {} },
    realTimeOnly: true,
    handEpoch: handCompletionEpoch
  })
  return generation
}

export const registerActivePortForService = (port: chrome.runtime.Port): void => {
  registerActivePortConnection(port)
}

/** インポート等の明示一括更新を、ACTIVE有無に関係なく接続tabへ届ける。 */
export const writeConnectedStatsUpdate = (
  service: PokerChaseService,
  seatUserIds: number[]
): void => {
  setStatsRequestContext(seatUserIds, {
    delivery: 'connected',
    evtDeal: service.latestEvtDeal
  })
  service.statsOutputStream.write(seatUserIds)
}

/** パース済みDEALを、そのイベントを届けた現在tokenの席文脈として記録する。 */
export const recordActiveDealContext = (port: chrome.runtime.Port): void => {
  if (getActivePort() === port) activeGenerationHasDeal = true
}

/**
 * 309はaggregate lineupを保持し、現在ハンド専用stream/cacheだけを消す。
 * raw保存・重複排除後に呼ぶため、Zod結果には依存しない。
 */
export const clearActiveRealtimeForSessionEnd = (
  service: PokerChaseService,
  port: chrome.runtime.Port
): void => {
  if (getActivePort() !== port) return
  service.realTimeStatsStream.reset()
  latestRealTimeStats = undefined
}

export const releaseActivePortForService = (
  service: PokerChaseService,
  port: chrome.runtime.Port
): void => {
  const release = releaseActivePort(port)
  if (release === 'relic' || release === 'reconnect-pending') return
  service.realTimeStatsStream.reset()
  latestRealTimeStats = undefined
  activeGenerationHasDeal = false
}

/** 完了済みハンドだけをHUDと同じPokerStars形式でService Worker consoleへ出す。 */
export const logCompletedHandToConsole = (event: HandLogEvent): void => {
  if (event.type === 'update' && event.entries && event.entries.length > 0) {
    console.info(formatHandLogEntries(event.entries))
  }
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
  setDefaultStatsContextProvider(() => ({
    delivery: 'active',
    generation: getActivePortGeneration(),
    evtDeal: activeGenerationHasDeal ? service.liveEvtDeal : undefined
  }))
  service.realTimeStatsStream.on('data', data => {
    latestRealTimeStats = data.stats
    if (lastKnownStats.length === 0) return
    const activePort = getActivePort()
    if (!activePort) return
    postMessageToPort(activePort, {
      stats: lastKnownStats,
      realTimeStats: latestRealTimeStats,
      realTimeOnly: true,
      handEpoch: handCompletionEpoch
    })
  })

  service.statsOutputStream.on('data', async (hand: PlayerStats[]) => {
    const context = getStatsOutputContext(hand)
    const currentGeneration = getActivePortGeneration()
    // 旧ACTIVE世代の非同期計算結果は、現在世代へもlastKnownStatsへも混ぜては
    // ならない（MUST NOT）。後続のrealtime更新による復活も同時に防ぐ。
    if (
      context?.generation !== undefined &&
      context.generation !== currentGeneration
    ) return

    lastKnownStats = hand // Store for later use

    if (context?.delivery === 'connected') {
      for (const port of connectedPorts) {
        postMessageToPort(port, {
          stats: hand,
          evtDeal: context.evtDeal,
          handEpoch: handCompletionEpoch
        })
      }
      return
    }

    // stats/realtime更新は唯一のACTIVEポートにだけ送る（MUST）。relicは最後に
    // 描画した状態のまま凍結し、clearも新lineupも受け取らない。
    const activePort = getActivePort()
    if (!activePort) return
    const delivered = postMessageToPort(activePort, {
      stats: hand,
      evtDeal: context?.evtDeal
        ?? (activeGenerationHasDeal ? service.liveEvtDeal : undefined),
      realTimeStats: latestRealTimeStats,
      // NOT bumped here -- this handler also fires for the hand-start warmup and
      // filter/import/auto-sync rebroadcasts (see handCompletionEpoch's doc comment),
      // so it just stamps whatever handCompletionEpoch currently holds. Only a real
      // completion (the writeEntityStream subscription below) advances it.
      handEpoch: handCompletionEpoch
    })
    if (delivered) {
      liveBroadcastSequence++
      const tabId = activePort.sender?.tab?.id
      if (tabId !== undefined) liveBroadcastSequenceByTab.set(tabId, liveBroadcastSequence)
    }
  })
  // The one true "hand completed" signal -- see handCompletionEpoch's doc comment
  // above for why this must be writeEntityStream, not statsOutputStream.
  service.writeEntityStream.on('data', () => {
    handCompletionEpoch++
  })

  // Handle hand log events
  service.handLogStream.on('data', (event: HandLogEvent) => {
    // 進行中のaddイベントは出さず、1ハンドを1ログにまとめることで、
    // イベント単位の既存rawログから完成形を探す手間を省く。
    logCompletedHandToConsole(event)

    // Send to all tabs with the game
    chrome.tabs.query({ url: gameUrlPattern }, tabs => {
      tabs.forEach(tab => {
        if (tab.id) {
          chrome.tabs.sendMessage<HandLogEventMessage>(tab.id, {
            action: 'handLogEvent',
            event: event
          }).catch(error => {
            // A matching game tab can temporarily have no content-script
            // receiver (for example after an extension update until the tab
            // is reloaded, or while the tab is navigating). Hand-log delivery
            // is best-effort, so consume that expected Promise rejection
            // instead of surfacing one unhandled error for every log event.
            if (!(error instanceof Error) || !error.message.includes('Receiving end does not exist')) {
              console.warn(`[background] Failed to deliver hand log event to tab ${tab.id}:`, error)
            }
          })
        }
      })
    })
  })
}
