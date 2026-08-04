/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */

/**
 * ゲームイベントを最後に届けたポートが唯一のACTIVEポートになる。
 *
 * PokerChaseは同時に複数テーブルを配信しないため、他の接続は表示を保持した
 * relicとして扱い、その状態を判定へ混ぜてはならない（MUST NOT）。別ポートから
 * イベントが来れば
 * 即座にtokenを移し、activityは不明から再判定する。
 */

type ActivePortActivity = 'unknown' | 'active' | 'inactive'

interface ActivePortToken {
  port: chrome.runtime.Port
  activity: ActivePortActivity
  playerId?: number
  lastGameEventAt: number
}

interface PortIdentity {
  tabId: number
  documentId?: string
}

interface ReconnectCandidate {
  identity: PortIdentity
  activity: ActivePortActivity
  playerId?: number
  lastGameEventAt: number
  disconnectedAt: number
  successor?: chrome.runtime.Port
}

export type ActivePortClaim = 'same-port' | 'same-tab-reconnect' | 'handover'
export type ActivePortRelease = 'relic' | 'reconnect-pending' | 'released'

/** 同時配信の兆候を検出するだけの窓。挙動は常に最新port優先のまま変えない。 */
export const ACTIVE_PORT_VIOLATION_WINDOW_MS = 10_000
/** RuntimePortManagerの500ms再接続だけを同一content script世代として認める窓。 */
export const ACTIVE_PORT_RECONNECT_WINDOW_MS = 2_000

let activeToken: ActivePortToken | undefined
let reconnectCandidate: ReconnectCandidate | undefined

// relicの状態は判定に使ってはならない（MUST NOT）。旧portが後からtokenを
// 取り戻した瞬間に、そのportで既に観測済みのaccountだけを復元する最小キャッシュ。
let playerIdByPort = new WeakMap<chrome.runtime.Port, number>()

const readPortIdentity = (port: chrome.runtime.Port): PortIdentity | undefined => {
  const tabId = port.sender?.tab?.id
  if (tabId === undefined) return undefined
  return { tabId, documentId: port.sender?.documentId }
}

const isSamePortIdentity = (left: PortIdentity, right: PortIdentity): boolean => {
  if (left.tabId !== right.tabId) return false
  // documentIdが両側で得られるChromeでは、reload後の新documentを同一世代と
  // 見なしてはならない（MUST NOT）。未提供環境だけtabIdへfallbackする。
  if (left.documentId !== undefined && right.documentId !== undefined) {
    return left.documentId === right.documentId
  }
  return true
}

/** onConnect時点で、直前に切れた同一content scriptの後継portを控える。 */
export const registerActivePortConnection = (
  port: chrome.runtime.Port,
  connectedAt: number = Date.now()
): boolean => {
  if (!reconnectCandidate) return false
  const identity = readPortIdentity(port)
  const gapMs = connectedAt - reconnectCandidate.disconnectedAt
  if (
    !identity ||
    gapMs < 0 ||
    gapMs > ACTIVE_PORT_RECONNECT_WINDOW_MS ||
    !isSamePortIdentity(identity, reconnectCandidate.identity)
  ) {
    return false
  }
  reconnectCandidate.successor = port
  if (reconnectCandidate.playerId !== undefined) {
    playerIdByPort.set(port, reconnectCandidate.playerId)
  }
  return true
}

/**
 * ゲームイベントの到着元へtokenを移し、移譲種別を返す。
 *
 * `deliveredAt`はserialized queueへ積む直前の到着時刻。DB書き込み待ちの長さを
 * sentinelの時間差へ混ぜない。
 */
export const claimActivePort = (
  port: chrome.runtime.Port,
  deliveredAt: number = Date.now()
): ActivePortClaim => {
  if (activeToken?.port === port) {
    activeToken.lastGameEventAt = deliveredAt
    return 'same-port'
  }

  if (reconnectCandidate?.successor === port) {
    activeToken = {
      port,
      activity: reconnectCandidate.activity,
      playerId: reconnectCandidate.playerId,
      lastGameEventAt: deliveredAt
    }
    reconnectCandidate = undefined
    return 'same-tab-reconnect'
  }

  const previousLastGameEventAt = activeToken?.lastGameEventAt
    ?? reconnectCandidate?.lastGameEventAt
  if (previousLastGameEventAt !== undefined) {
    const gapMs = deliveredAt - previousLastGameEventAt
    if (gapMs >= 0 && gapMs < ACTIVE_PORT_VIOLATION_WINDOW_MS) {
      // payload・tab ID・account IDは出さない。これはaxiom違反の検出だけで、
      // 複数sessionを支える分岐にはしない。
      console.warn(
        '[background] Active-port axiom sentinel: different ports delivered game events within 10 seconds'
      )
    }
  }

  reconnectCandidate = undefined
  activeToken = {
    port,
    activity: 'unknown',
    playerId: playerIdByPort.get(port),
    lastGameEventAt: deliveredAt
  }
  return 'handover'
}

export const getActivePort = (): chrome.runtime.Port | undefined =>
  activeToken?.port

export const getActivePortActivity = (): ActivePortActivity | undefined =>
  activeToken?.activity

export const markActivePortSessionActive = (port: chrome.runtime.Port): void => {
  if (activeToken?.port === port) activeToken.activity = 'active'
}

export const markActivePortSessionInactive = (port: chrome.runtime.Port): void => {
  if (activeToken?.port === port) activeToken.activity = 'inactive'
}

export const markActivePortPlayerId = (
  port: chrome.runtime.Port,
  playerId: number
): void => {
  if (activeToken?.port !== port) return
  playerIdByPort.set(port, playerId)
  activeToken.playerId = playerId
}

export const readActivePortPlayerId = (): number | undefined =>
  activeToken?.playerId

/**
 * リプレイ取得のfairness gate。
 *
 * ACTIVEポートが無ければsessionも無い。tokenが在る場合は明示的なinactiveだけを
 * 許可し、unknownは対局中として扱う。
 */
export const isActivePortOutsideSession = (): boolean =>
  activeToken === undefined || activeToken.activity === 'inactive'

/** キューに記録したaccountと現在のACTIVEポートが一致するときだけ返す。 */
export const findActivePortForPlayer = (
  playerId: number | undefined
): chrome.runtime.Port | undefined => {
  if (!activeToken || activeToken.playerId === undefined) return undefined
  if (playerId !== undefined && activeToken.playerId !== playerId) return undefined
  return activeToken.port
}

/**
 * 切断したtoken holderを空にする。同一documentの短時間再接続だけは、次portが
 * tokenを再取得するまでactivity/accountを候補として保持する。
 */
export const releaseActivePort = (
  port: chrome.runtime.Port,
  disconnectedAt: number = Date.now()
): ActivePortRelease => {
  if (activeToken?.port !== port) {
    playerIdByPort.delete(port)
    return 'relic'
  }
  const playerId = playerIdByPort.get(port) ?? activeToken.playerId
  playerIdByPort.delete(port)
  const identity = readPortIdentity(port)
  if (identity) {
    reconnectCandidate = {
      identity,
      activity: activeToken.activity,
      playerId,
      lastGameEventAt: activeToken.lastGameEventAt,
      disconnectedAt
    }
  } else {
    reconnectCandidate = undefined
  }
  activeToken = undefined
  return identity ? 'reconnect-pending' : 'released'
}

/** テスト用。ACTIVE tokenとaccountキャッシュを捨てる。 */
export const __resetActivePortStateForTests = (): void => {
  activeToken = undefined
  reconnectCandidate = undefined
  playerIdByPort = new WeakMap<chrome.runtime.Port, number>()
}
