import Dexie, { type Table } from 'dexie'
import type {
  ApiEvent,
  Hand,
  Phase,
  Action,
  ImportMeta
} from '../types'

/**
 * PokerChase HUD用IndexedDBクラス
 *
 * ポーカーゲームのデータ永続化を担当する。
 * - APIイベントの生ログを保存
 * - 処理済みのハンド、フェーズ、アクションデータを構造化して保存
 * - 統計計算のための効率的なインデックスを提供
 */
export class PokerChaseDB extends Dexie {
  apiEvents!: Table<ApiEvent, number>
  hands!: Table<Hand, number>
  phases!: Table<Phase, number>
  actions!: Table<Action, number>
  meta!: Table<ImportMeta, string>
  constructor(indexedDB: IDBFactory, iDBKeyRange: typeof IDBKeyRange) {
    super('PokerChaseDB', { indexedDB, IDBKeyRange: iDBKeyRange })
    this.version(1).stores({
      apiEvents: '[timestamp+ApiTypeId],timestamp,ApiTypeId',
      hands: 'id,*seatUserIds,*winningPlayerIds',
      phases: '[handId+phase],handId,*seatUserIds,phase',
      actions: '[handId+index],handId,playerId,phase,actionType,*actionDetails',
    })
    // メタデータテーブルを追加（増分処理用）
    this.version(2).stores({
      apiEvents: '[timestamp+ApiTypeId],timestamp,ApiTypeId',
      hands: 'id,*seatUserIds,*winningPlayerIds',
      phases: '[handId+phase],handId,*seatUserIds,phase',
      actions: '[handId+index],handId,playerId,phase,actionType,*actionDetails',
      meta: 'id'
    })
  }
}