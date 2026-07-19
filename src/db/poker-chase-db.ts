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
 * - APIイベントの生ログを保存（"Raw Event Lake" — 検証可否・アプリケーション種別に
 *   関わらず、数値のtimestamp+ApiTypeIdを持つ受信イベントは全て保存する。バリデー
 *   ションはリアルタイム処理パイプラインへの投入可否のみを左右し、保存そのものを
 *   左右しない。詳細はdocs/architecture.md「Raw Event Lake」参照）
 * - 処理済みのハンド、フェーズ、アクションデータを構造化して保存
 * - 統計計算のための効率的なインデックスを提供
 *
 * 設計変遷: 2024年の初期実装（コミット5f7d60c/fce0343）は生ログ全件保存だったが、
 * 2025-07-24のリファクタ（a6480ff）でapiEventsのcreating/readingフックにより
 * アプリケーションイベント以外を実質的に不可視化していた（creatingフックは
 * `this.onsuccess = null`のみで実際の書き込み自体は防げておらず、reading側の
 * フックだけが読み取り結果からnullとして除外していた）。この結果、スキーマ変更で
 * Zodパースに失敗したイベント（2026年シーズン3のEVT_SESSION_RESULTS等）は保存
 * すらされず、リビルドでも復旧不能なデータ損失が発生した。本バージョンで
 * フックを撤廃し、元々の「生ログは常に保存する」設計に復元した。
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

    // v4以降へのバンプは不要: [timestamp+ApiTypeId]キーは検証可否・ApiTypeIdの
    // 既知/未知に関わらずどんな生イベントにも適用できるため、フック撤廃だけなら
    // インデックス変更は発生しない（意図的にバンプしていない。CLAUDE.md参照）。
    //
    // 旧: apiEventsのcreating/readingフックで非アプリケーションイベントを自動
    // フィルタリングしていたが撤廃した（setupApiEventHooks削除）。フィルタリングは
    // 各読み取り箇所（EntityConverter/HandLogProcessorへ渡す直前）で明示的に行う。
    // 理由: (1) creatingフックは実際には書き込みを止められておらず有名無実だった
    // （`this.onsuccess = null`はDexieの完了コールバックを止めるだけで、配下の
    // IDBObjectStore.add()自体は既に発行済み）、(2) readingフックがあると
    // apiEvents.toArray()等で「生ログの全件保存」という本来の目的を果たせない
    // （エクスポート/インポート/リビルドが常に部分集合しか見えなくなる）。
  }
}
