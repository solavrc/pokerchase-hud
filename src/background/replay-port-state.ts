/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
/**
 * ポート（＝ゲームタブ）ごとのセッション状態とアカウント。
 *
 * `update-manager.ts` の `sessionActivity` は**全ポートを畳んだ1つの値**で、
 * 最後に届いたイベントしか表さない。forced update の安全性判定はそれで足りる
 * （どのタブでも対局中ならreloadしない、という向きにしか使わない）が、
 * リプレイ取得の不変条件には足りない: タブAで対局中でも、タブBの309が
 * `inactive` へ倒すと取得が始まってしまう。
 *
 * 共有の述語は触らない（forced update と共有していて影響範囲が広い）。
 * 代わりに**取得側の判定点だけ**を厳しくする ―― 接続中の全ポートが
 * `inactive` であることを要求し、状態の分からないポートは `active` 扱いに
 * する。畳んだ値と論理積を取るので、判定は元より緩くならない。
 *
 * アカウントも同じ理由でポートごとに持つ。取得はページ側が捕獲した認証
 * エンベロープで飛ぶので、キューに積んだアカウントと違うタブへ依頼すると
 * `2302` が返り、再試行不能として永久に捨ててしまう。
 */
import { connectedPorts } from './ports'

type PortActivity = 'unknown' | 'active' | 'inactive'

interface PortState {
  activity: PortActivity
  /** そのタブで観測したヒーローのUserId。 */
  playerId?: number
}

/**
 * ポートは切断で捨てられるので `WeakMap` で持つ。`connectedPorts` が
 * 生存集合の正で、こちらは付随情報。
 */
const portStates = new WeakMap<chrome.runtime.Port, PortState>()

const stateOf = (port: chrome.runtime.Port): PortState => {
  const existing = portStates.get(port)
  if (existing) return existing
  const created: PortState = { activity: 'unknown' }
  portStates.set(port, created)
  return created
}

export const markPortSessionActive = (port: chrome.runtime.Port): void => {
  stateOf(port).activity = 'active'
}

export const markPortSessionInactive = (port: chrome.runtime.Port): void => {
  stateOf(port).activity = 'inactive'
}

/** そのポートで観測したヒーローのUserId を控える。 */
export const markPortPlayerId = (port: chrome.runtime.Port, playerId: number): void => {
  stateOf(port).playerId = playerId
}

/**
 * 接続中の**全**ポートがセッション外か。
 *
 * - 1つでも `active` / `unknown` があれば偽（分からないものは対局中扱い）
 * - 接続が1つも無ければ偽 ―― 取得はページ経由なので、そもそも撃てない
 */
export const allConnectedPortsInactive = (): boolean => {
  if (connectedPorts.size === 0) return false
  for (const port of connectedPorts) {
    if (stateOf(port).activity !== 'inactive') return false
  }
  return true
}

/**
 * `playerId` のハンドを依頼してよいポートを返す。
 *
 * - そのアカウントを観測したポートだけを選ぶ。見つからなければ `undefined`
 *   （呼び出し元はそのHandIdを撃たずにキューへ残す ―― 別アカウントのタブへ
 *   投げると `2302` で永久に捨てられる）
 * - `playerId` が分からないキュー（旧版で積んだもの）は、アカウントを1つしか
 *   観測していないときに限り、その唯一のポートを使う。複数アカウントが
 *   繋がっているときは選ばない
 */
export const findPortForPlayer = (
  playerId: number | undefined
): chrome.runtime.Port | undefined => {
  const ports = [...connectedPorts]
  if (playerId !== undefined) {
    return ports.find(port => stateOf(port).playerId === playerId)
  }
  const identified = ports.filter(port => stateOf(port).playerId !== undefined)
  const distinct = new Set(identified.map(port => stateOf(port).playerId))
  if (distinct.size === 1) return identified[0]
  // 誰のタブか分からない状態で撃つと、外れたときに永久に捨てる側へ倒れる。
  // 1つも識別できていないなら、単一接続に限って許す（従来の挙動）。
  return identified.length === 0 && ports.length === 1 ? ports[0] : undefined
}

/** テスト用。ポート状態を捨てる。 */
export const __resetReplayPortStateForTests = (): void => {
  for (const port of connectedPorts) portStates.delete(port)
}
