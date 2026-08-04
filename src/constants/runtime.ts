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
 * 現在ハンド専用のリアルタイム統計だけをクリアする。集計HUDとドリルダウンは
 * セッション終了後のレビュー用に保持する。
 *
 * 新しいchrome runtimeメッセージチャネルは追加しない -- content_script.ts は
 * background へ転送する前に既に309を生イベントとして見ているので、その場で
 * ローカルにdispatchするため、破損した309がZod検証を通らない場合も通知できる。
 */
export const POKER_CHASE_SESSION_END_EVENT = 'PokerChaseSessionEndEvent'
