/**
 * ランタイム定数: サービスクラス本体（Dexie/Streams/統計レジストリ等）に依存せず、
 * background / content_script / web_accessible_resource のいずれからも安全にインポートできる。
 *
 * !!! poker-chase-service.ts 以外からはこのファイルを直接参照すること !!!
 * (PokerChaseService の静的プロパティ経由でのインポートは依存グラフ全体をバンドルしてしまうため避ける)
 */
import { content_scripts } from '../../manifest.json'

export const POKER_CHASE_SERVICE_EVENT = 'PokerChaseServiceEvent'
export const POKER_CHASE_ORIGIN = new URL(content_scripts[0]!.matches[0]!).origin
/** Page-world bridge envelope used only when an API payload lacks a numeric ID. */
export const POKER_CHASE_INVALID_API_EVENT = 'PokerChaseInvalidApiEvent'
export const STORAGE_KEY = 'pokerChaseServiceState'
/**
 * content_script.ts が生の EVT_SESSION_RESULTS（309）をページの window.postMessage
 * から直接観測した際に dispatch する window CustomEvent。App.tsx はこれを購読し、
 * hero（席0）以外の HUD パネル（bust後の薄暗い表示を含む）をクリアする（sola仕様、
 * 「セッション終了後はhero以外のstatsはクリアしてOK」）。
 *
 * content_script.ts はbackgroundへ転送する前に309を見て、まず即時dispatch
 * する。backgroundは旧統計計算をdrainした後、下のsettlementメッセージで
 * 同じイベントを再dispatchさせ、永続化待ち中の旧broadcastを最終的に消す。
 */
export const POKER_CHASE_SESSION_END_EVENT = 'PokerChaseSessionEndEvent'

/**
 * Background sends this port control message after every accepted terminal
 * 309 has drained older stats work. Content dispatches the same local
 * session-end event again so a calculation that finished during raw
 * durability/source checks cannot remain visible after settlement.
 */
export const POKER_CHASE_SESSION_END_SETTLED_MESSAGE =
  'PokerChaseSessionEndSettled'

/**
 * Revision-only background -> content port message. Unlike a stats payload,
 * this must not carry an old lineup merely to notify open drill-down panels
 * that the automatic battle-type category changed before the first DEAL.
 */
export const AUTO_BATTLE_TYPE_FILTER_REVISION_MESSAGE =
  'autoBattleTypeFilterRevision'
