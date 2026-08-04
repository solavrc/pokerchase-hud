/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
import type PokerChaseService from '../services/poker-chase-service'
import type { ApiEvent, ApiType, PlayerStats } from '../app'
import type { AllPlayersRealTimeStats } from '../realtime-stats/realtime-stats-service'
import { RealTimeStatsStream } from '../streams/realtime-stats-stream'
import { ApiType as ApiTypeValue } from '../types'
import type { HandLogEvent } from '../types/hand-log'
import type { HandLogEventMessage } from '../types/messages'
import { formatHandLogEntries } from '../utils/hand-log-text'

const PING_INTERVAL_MS = 10 * 1000

let lastKnownStats: PlayerStats[] = []

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
 * `chrome.runtime.onConnect`で接続されたポートの集合
 * ストリームイベントをブロードキャストする際の送信先として利用する
 */
export const connectedPorts = new Set<chrome.runtime.Port>()

type PortRealTimeState = {
  stream: RealTimeStatsStream
  latestStats?: AllPlayersRealTimeStats
}

// SPR・ポットオッズ・進行中ハンドの状態はタブ固有。集計ストリームと違い、
// 別ポートの309/dealを混ぜてはならない（MUST NOT）。
const realTimeStateByPort = new WeakMap<chrome.runtime.Port, PortRealTimeState>()

type StatsMessage = {
  stats: PlayerStats[]
  evtDeal?: ApiEvent<ApiType.EVT_DEAL>
  realTimeStats?: AllPlayersRealTimeStats
  realTimeOnly?: boolean
  handEpoch?: number
}

const postMessageToPort = (port: chrome.runtime.Port, data: StatsMessage | string): void => {
  try {
    port.postMessage(data)
  } catch (error: unknown) {
    if (error instanceof Error) {
      if (error.message === 'Attempting to use a disconnected port object') {
        connectedPorts.delete(port)
        realTimeStateByPort.delete(port)
      } else {
        console.error(error)
      }
    }
  }
}

/** 現在ハンド専用ストリームを接続元ポートへ束縛する。 */
export const registerPortRealTimeStats = (port: chrome.runtime.Port): void => {
  if (realTimeStateByPort.has(port)) return

  const state: PortRealTimeState = { stream: new RealTimeStatsStream() }
  realTimeStateByPort.set(port, state)
  state.stream.on('data', data => {
    state.latestStats = data.stats
    if (lastKnownStats.length === 0) return
    postMessageToPort(port, {
      stats: lastKnownStats,
      realTimeStats: state.latestStats,
      realTimeOnly: true,
      handEpoch: handCompletionEpoch
    })
  })
}

/** APIイベントを発生元ポートの現在ハンド専用ストリームへ投入する。 */
export const writePortRealTimeStats = (port: chrome.runtime.Port, event: ApiEvent): void => {
  let state = realTimeStateByPort.get(port)
  if (!state) {
    registerPortRealTimeStats(port)
    state = realTimeStateByPort.get(port)!
  }

  if (event.ApiTypeId === ApiTypeValue.EVT_SESSION_RESULTS) {
    // 発生元content scriptが同じ309を直接観測して表示を消す。次の集計再配信で
    // 終了済み値を復活させないため、ポート固有キャッシュだけを空にする。
    state.latestStats = undefined
  }
  state.stream.write(event)
}

export const releasePortRealTimeStats = (port: chrome.runtime.Port): void => {
  realTimeStateByPort.get(port)?.stream.reset()
  realTimeStateByPort.delete(port)
}

/** 完了済みハンドだけをHUDと同じPokerStars形式でService Worker consoleへ出す。 */
export const logCompletedHandToConsole = (event: HandLogEvent): void => {
  if (event.type === 'update' && event.entries && event.entries.length > 0) {
    console.info(formatHandLogEntries(event.entries))
  }
}

/**
 * 接続中の全ポートにメッセージをブロードキャストする
 * 切断済みポートを検出した場合は`connectedPorts`から取り除く
 */
export const broadcastMessage = (data: StatsMessage | string) => {
  connectedPorts.forEach(port => {
    postMessageToPort(port, data)
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
  service.statsOutputStream.on('data', async (hand: PlayerStats[]) => {
    lastKnownStats = hand // Store for later use
    liveBroadcastSequence++ // A real live lineup broadcast just went out -- see getLiveBroadcastSequence()'s doc comment

    // 集計lineup/deal文脈の既存ブロードキャストは維持する一方、現在ハンド専用値は
    // 発生元ポートのキャッシュだけを同梱する（MUST）。
    connectedPorts.forEach(port => {
      const state = realTimeStateByPort.get(port)
      postMessageToPort(port, {
        stats: hand,
        evtDeal: service.liveEvtDeal,
        realTimeStats: state?.latestStats,
        // NOT bumped here -- this handler also fires for the hand-start warmup and
        // filter/import/auto-sync rebroadcasts (see handCompletionEpoch's doc comment),
        // so it just stamps whatever handCompletionEpoch currently holds. Only a real
        // completion (the writeEntityStream subscription below) advances it.
        handEpoch: handCompletionEpoch
      })
    })
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
