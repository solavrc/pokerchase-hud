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
