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

/** 同時配信の兆候を検出するだけの窓。挙動は常に最新port優先のまま変えない。 */
export const ACTIVE_PORT_VIOLATION_WINDOW_MS = 10_000

let activeToken: ActivePortToken | undefined

// relicの状態は判定に使ってはならない（MUST NOT）。旧portが後からtokenを
// 取り戻した瞬間に、そのportで既に観測済みのaccountだけを復元する最小キャッシュ。
let playerIdByPort = new WeakMap<chrome.runtime.Port, number>()

/**
 * ゲームイベントの到着元へtokenを移す。handoverならtrueを返す。
 *
 * `deliveredAt`はserialized queueへ積む直前の到着時刻。DB書き込み待ちの長さを
 * sentinelの時間差へ混ぜない。
 */
export const claimActivePort = (
  port: chrome.runtime.Port,
  deliveredAt: number = Date.now()
): boolean => {
  if (activeToken?.port === port) {
    activeToken.lastGameEventAt = deliveredAt
    return false
  }

  if (activeToken) {
    const gapMs = deliveredAt - activeToken.lastGameEventAt
    if (gapMs >= 0 && gapMs < ACTIVE_PORT_VIOLATION_WINDOW_MS) {
      // payload・tab ID・account IDは出さない。これはaxiom違反の検出だけで、
      // 複数sessionを支える分岐にはしない。
      console.warn(
        '[background] Active-port axiom sentinel: different ports delivered game events within 10 seconds'
      )
    }
  }

  activeToken = {
    port,
    activity: 'unknown',
    playerId: playerIdByPort.get(port),
    lastGameEventAt: deliveredAt
  }
  return true
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

/** 切断したportがtoken holderならACTIVEを空にする。 */
export const releaseActivePort = (port: chrome.runtime.Port): boolean => {
  playerIdByPort.delete(port)
  if (activeToken?.port !== port) return false
  activeToken = undefined
  return true
}

/** テスト用。ACTIVE tokenとaccountキャッシュを捨てる。 */
export const __resetActivePortStateForTests = (): void => {
  activeToken = undefined
  playerIdByPort = new WeakMap<chrome.runtime.Port, number>()
}
