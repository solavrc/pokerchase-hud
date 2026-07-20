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
export const STORAGE_KEY = 'pokerChaseServiceState'
/**
 * content_script.ts が生の EVT_SESSION_RESULTS（309）をページの window.postMessage
 * から直接観測した際に dispatch する window CustomEvent。App.tsx はこれを購読し、
 * hero（席0）以外の HUD パネル（bust後の薄暗い表示を含む）をクリアする（sola仕様、
 * 「セッション終了後はhero以外のstatsはクリアしてOK」）。
 *
 * 新しいchrome runtimeメッセージチャネルは追加しない -- content_script.ts は
 * background へ転送する前に既に309を生イベントとして見ているので、その場で
 * ローカルにdispatchするだけで background 側（poker-chase-service.ts /
 * event-ingestion.ts）に一切手を入れずに済む。
 */
export const POKER_CHASE_SESSION_END_EVENT = 'PokerChaseSessionEndEvent'
