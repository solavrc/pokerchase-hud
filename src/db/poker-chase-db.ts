import Dexie, { type Table } from 'dexie'
import type {
  ApiEvent,
  Hand,
  Phase,
  Action,
  MetaRecord
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
  meta!: Table<MetaRecord, string>
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
    // パフォーマンス最適化のための追加インデックス
    this.version(3).stores({
      // ApiTypeIdとtimestampの複合インデックスを追加（特定イベントタイプの最新取得用）
      apiEvents: '[timestamp+ApiTypeId],timestamp,ApiTypeId,[ApiTypeId+timestamp]',
      // timestampインデックスを追加（最近のハンドのクエリ用）
      hands: 'id,*seatUserIds,*winningPlayerIds,approxTimestamp',
      // 既存のインデックスを維持
      phases: '[handId+phase],handId,*seatUserIds,phase',
      // プレイヤーごとのフェーズ別アクションとアクションタイプ別クエリ用の複合インデックスを追加
      actions: '[handId+index],handId,playerId,phase,actionType,*actionDetails,[playerId+phase],[playerId+actionType]',
      // メタテーブル（アプリケーション設定、キャッシュ、統計サマリー等の汎用ストレージ）
      meta: 'id,updatedAt'
    })
  }
}