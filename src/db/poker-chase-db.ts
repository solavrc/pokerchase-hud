import Dexie, { type Table } from 'dexie'
import type {
  ApiEvent,
  Hand,
  Phase,
  Action,
  MetaRecord
} from '../types'
import { API_EVENT_PRIMARY_KEY } from '../utils/api-event-key'

const API_EVENT_MIGRATION_TABLE = '_apiEventsSequenceMigration'
const API_EVENT_MIGRATION_CHUNK_SIZE = 5000

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
 * 旧フィルタリングフックを撤廃し、元々の「生ログは常に保存する」設計に復元した。
 */
export class PokerChaseDB extends Dexie {
  apiEvents!: Table<ApiEvent, [number, number, number]>
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

    // IndexedDB/Dexie cannot change an existing object store's primary key
    // in place (`UpgradeError: Not yet support for changing primary key`).
    // Use a transactionally-upgraded staging store instead:
    //   v4 copies every old row and assigns sequence=0 (the old key already
    //      guaranteed one row per timestamp+ApiTypeId),
    //   v5 removes the old apiEvents store,
    //   v6 recreates it with the sequence key, copies the staged rows back,
    //      then removes the staging store.
    // All three logical versions run inside IndexedDB's single versionchange
    // transaction when a v3 install opens v6, so a failure rolls the database
    // back intact rather than exposing a half-migrated Lake.
    this.version(4).stores({
      apiEvents: '[timestamp+ApiTypeId],timestamp,ApiTypeId,[ApiTypeId+timestamp]',
      hands: 'id,*seatUserIds,*winningPlayerIds,approxTimestamp',
      phases: '[handId+phase],handId,*seatUserIds,phase',
      actions: '[handId+index],handId,playerId,phase,actionType,*actionDetails,[playerId+phase],[playerId+actionType]',
      meta: 'id,updatedAt',
      [API_EVENT_MIGRATION_TABLE]: API_EVENT_PRIMARY_KEY
    }).upgrade(async transaction => {
      const source = transaction.table('apiEvents')
      const staging = transaction.table(API_EVENT_MIGRATION_TABLE)
      let cursor: [number, number] | undefined
      while (true) {
        const oldRows = await (cursor
          ? source.where('[timestamp+ApiTypeId]').above(cursor)
          : source.orderBy('[timestamp+ApiTypeId]'))
          .limit(API_EVENT_MIGRATION_CHUNK_SIZE)
          .toArray() as Array<Record<string, unknown> & { timestamp: number, ApiTypeId: number }>
        if (oldRows.length === 0) break
        await staging.bulkAdd(
          oldRows.map(row => ({ ...row, sequence: 0 }))
        )
        const last = oldRows[oldRows.length - 1]!
        cursor = [last.timestamp, last.ApiTypeId]
      }
    })

    this.version(5).stores({
      apiEvents: null,
      hands: 'id,*seatUserIds,*winningPlayerIds,approxTimestamp',
      phases: '[handId+phase],handId,*seatUserIds,phase',
      actions: '[handId+index],handId,playerId,phase,actionType,*actionDetails,[playerId+phase],[playerId+actionType]',
      meta: 'id,updatedAt',
      [API_EVENT_MIGRATION_TABLE]: API_EVENT_PRIMARY_KEY
    })

    this.version(6).stores({
      apiEvents: `${API_EVENT_PRIMARY_KEY},timestamp,ApiTypeId,[timestamp+ApiTypeId],[ApiTypeId+timestamp]`,
      hands: 'id,*seatUserIds,*winningPlayerIds,approxTimestamp',
      phases: '[handId+phase],handId,*seatUserIds,phase',
      actions: '[handId+index],handId,playerId,phase,actionType,*actionDetails,[playerId+phase],[playerId+actionType]',
      meta: 'id,updatedAt',
      [API_EVENT_MIGRATION_TABLE]: null
    }).upgrade(async transaction => {
      const staging = transaction.table(API_EVENT_MIGRATION_TABLE)
      const destination = transaction.table('apiEvents')
      let cursor: [number, number, number] | undefined
      while (true) {
        const stagedRows = await (cursor
          ? staging.where(API_EVENT_PRIMARY_KEY).above(cursor)
          : staging.orderBy(API_EVENT_PRIMARY_KEY))
          .limit(API_EVENT_MIGRATION_CHUNK_SIZE)
          .toArray() as Array<Record<string, unknown> & { timestamp: number, ApiTypeId: number, sequence: number }>
        if (stagedRows.length === 0) break
        await destination.bulkAdd(stagedRows)
        const last = stagedRows[stagedRows.length - 1]!
        cursor = [last.timestamp, last.ApiTypeId, last.sequence]
      }
    })

    // Backward-compatible default for existing internal/test callers that
    // insert a single legacy-shaped row directly. Collision-sensitive
    // production writers use mergeApiEvents(), which performs indexed
    // content deduplication and atomic next-sequence allocation.
    this.apiEvents.hook('creating', (_primaryKey, object) => {
      const raw = object as ApiEvent & { sequence?: unknown }
      if (typeof raw.sequence !== 'number' || !Number.isSafeInteger(raw.sequence) || raw.sequence < 0) {
        raw.sequence = 0
      }
    })
  }
}
