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
  generation: number
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
  generation: number
  activity: ActivePortActivity
  playerId?: number
  lastGameEventAt: number
  disconnectedAt: number
}

export type ActivePortClaim = 'same-generation' | 'handover'
export type ActivePortRelease = 'relic' | 'reconnect-pending' | 'released'

/** 同時配信の兆候を検出するだけの窓。挙動は常に最新port優先のまま変えない。 */
export const ACTIVE_PORT_VIOLATION_WINDOW_MS = 10_000
/** RuntimePortManagerの500ms再接続だけを同一content script世代として認める窓。 */
export const ACTIVE_PORT_RECONNECT_WINDOW_MS = 2_000

let activeToken: ActivePortToken | undefined
let reconnectCandidate: ReconnectCandidate | undefined
let nextGeneration = 0
// transportの接続世代と同一tab/documentの後継を、resolveGeneration()だけで
// 引けるようにする。game stateは持たず、relicの表示や判定へは使わない。
let generationByPort = new WeakMap<chrome.runtime.Port, number>()
let connectedPortByIdentity = new Map<string, chrome.runtime.Port>()

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

const portIdentityKey = (identity: PortIdentity): string =>
  `${identity.tabId}:${identity.documentId ?? '*'}`

const resolveConnectedTransport = (
  port: chrome.runtime.Port
): chrome.runtime.Port => {
  const identity = readPortIdentity(port)
  return identity
    ? connectedPortByIdentity.get(portIdentityKey(identity)) ?? port
    : port
}

/**
 * onConnect時点で、直前に切れた同一content scriptへtokenを即時継承する。
 * 次のgame eventを待つと、309後のホーム画面ではACTIVE不在のままになる。
 */
export const registerActivePortConnection = (
  port: chrome.runtime.Port,
  connectedAt: number = Date.now()
): boolean => {
  const identity = readPortIdentity(port)
  if (identity) connectedPortByIdentity.set(portIdentityKey(identity), port)
  if (!reconnectCandidate) return false
  const gapMs = connectedAt - reconnectCandidate.disconnectedAt
  if (
    !identity ||
    gapMs < 0 ||
    gapMs > ACTIVE_PORT_RECONNECT_WINDOW_MS ||
    !isSamePortIdentity(identity, reconnectCandidate.identity)
  ) {
    return false
  }
  const candidate = reconnectCandidate
  if (candidate.playerId !== undefined) {
    playerIdByPort.set(port, candidate.playerId)
  }
  generationByPort.set(port, candidate.generation)
  activeToken = {
    port,
    generation: candidate.generation,
    activity: candidate.activity,
    playerId: candidate.playerId,
    lastGameEventAt: candidate.lastGameEventAt
  }
  reconnectCandidate = undefined
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
  const currentGeneration = resolveGeneration()
  const eventPortGeneration = resolveGeneration(port)
  if (
    currentGeneration !== undefined &&
    eventPortGeneration === currentGeneration
  ) {
    if (activeToken?.generation === currentGeneration) {
      activeToken.lastGameEventAt = deliveredAt
    } else if (reconnectCandidate?.generation === currentGeneration) {
      reconnectCandidate.lastGameEventAt = deliveredAt
    }
    return 'same-generation'
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
  const activePort = resolveConnectedTransport(port)
  activeToken = {
    port: activePort,
    generation: ++nextGeneration,
    activity: 'unknown',
    playerId: playerIdByPort.get(port) ?? playerIdByPort.get(activePort),
    lastGameEventAt: deliveredAt
  }
  generationByPort.set(port, activeToken.generation)
  generationByPort.set(activePort, activeToken.generation)
  if (activeToken.playerId !== undefined) playerIdByPort.set(activePort, activeToken.playerId)
  return 'handover'
}

export const getActivePort = (): chrome.runtime.Port | undefined =>
  activeToken?.port

/** 現在のACTIVE token世代。別tab/documentへのhandover時だけ進む。 */
export const resolveGeneration = (
  port?: chrome.runtime.Port
): number | undefined => {
  if (port) {
    if (activeToken?.port === port) return activeToken.generation
    const directGeneration = generationByPort.get(port)
    if (directGeneration !== undefined) return directGeneration
    return generationByPort.get(resolveConnectedTransport(port))
  }
  return activeToken?.generation ?? reconnectCandidate?.generation
}

export const getActivePortActivity = (): ActivePortActivity | undefined =>
  activeToken?.activity

const findGenerationState = (
  generation: number
): ActivePortToken | ReconnectCandidate | undefined => {
  if (activeToken?.generation === generation) return activeToken
  if (reconnectCandidate?.generation === generation) return reconnectCandidate
  return undefined
}

export const markActivePortSessionActive = (generation: number): void => {
  const state = findGenerationState(generation)
  if (state) state.activity = 'active'
}

export const markActivePortSessionInactive = (generation: number): void => {
  const state = findGenerationState(generation)
  if (state) state.activity = 'inactive'
}

export const markActivePortPlayerId = (
  generation: number,
  playerId: number
): void => {
  const state = findGenerationState(generation)
  if (!state) return
  state.playerId = playerId
  if ('port' in state) playerIdByPort.set(state.port, playerId)
}

export const readActivePortPlayerId = (): number | undefined =>
  activeToken?.playerId ?? reconnectCandidate?.playerId

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
  const identity = readPortIdentity(port)
  if (identity && connectedPortByIdentity.get(portIdentityKey(identity)) === port) {
    connectedPortByIdentity.delete(portIdentityKey(identity))
  }
  if (activeToken?.port !== port) {
    playerIdByPort.delete(port)
    return 'relic'
  }
  const playerId = playerIdByPort.get(port) ?? activeToken.playerId
  playerIdByPort.delete(port)
  if (identity) {
    reconnectCandidate = {
      identity,
      generation: activeToken.generation,
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
  nextGeneration = 0
  generationByPort = new WeakMap<chrome.runtime.Port, number>()
  connectedPortByIdentity = new Map<string, chrome.runtime.Port>()
  playerIdByPort = new WeakMap<chrome.runtime.Port, number>()
}
