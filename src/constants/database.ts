/**
 * Database-related constants for PokerChase HUD
 * Centralizes configuration values used across the application
 */

export const DATABASE_CONSTANTS = {
  // Chunk sizes for data processing
  IMPORT_CHUNK_SIZE: 10000,      // Used in background.ts for import operations
  SYNC_CHUNK_SIZE: 5000,         // Used in auto-sync-service.ts
  EXPORT_CHUNK_SIZE: 10000,      // Used for JSON export
  
  // Search and batch limits
  DEAL_SEARCH_LIMIT: 10,         // Batch size for finding latest EVT_DEAL
  MAX_SEARCH_ATTEMPTS: 100,      // Maximum iterations for searches
  
  // Firestore sync
  FIRESTORE_BATCH_SIZE: 300,     // Firestore write batch size
  FIRESTORE_DELETE_BATCH: 500,   // Firestore delete batch size
  FIRESTORE_BATCH_DELAY_MS: 500, // Delay between batch groups
  FIRESTORE_DOWNLOAD_PAGE_SIZE: 1000, // Maximum documents per Firestore download response
  FIRESTORE_REQUEST_TIMEOUT_MS: 30000,   // Per-request AbortController timeout (a stalled fetch must not hold isSyncing forever)
  FIRESTORE_TRANSIENT_RETRIES: 2,        // Extra attempts after the first, for transient failures only (network error/timeout/5xx/429)
  FIRESTORE_RETRY_BASE_DELAY_MS: 500,    // Backoff base: 500ms, then 1000ms (doubles per retry)

  // Cache durations
  PLAYER_CACHE_DURATION_MS: 60000,     // 1 minute
  STATS_CACHE_DURATION_MS: 5000,       // 5 seconds
  CLOUD_TIMESTAMP_CACHE_MS: 60000,     // 1 minute
  
  // Progress reporting
  PROGRESS_REPORT_INTERVAL: 100,       // Report progress every N items
  LARGE_PROGRESS_INTERVAL: 50000,      // Log progress every N items for large datasets
  
  // Service Worker
  KEEPALIVE_INTERVAL_MS: 25000,        // 25 seconds (under 30s timeout)
  SERVICE_WORKER_TIMEOUT_MS: 30000,    // Chrome's 30 second timeout
  
  // Storage management
  STORAGE_CLEANUP_PREFIX: ['temp_', 'old_'],  // Prefixes for cleanup
  PERSIST_STATE_DEBOUNCE_MS: 500,             // Debounce for state persistence
  
  // Hand log
  DEFAULT_MAX_HANDS: 100,              // Default hand log limit
  HAND_TIME_BUFFER_MS: 300000,         // 5 minutes buffer for hand events
  POST_HAND_BUFFER_MS: 30000,          // 30 seconds after hand completion
} as const

// Type-safe chunk size options
export type ChunkSize = 1000 | 5000 | 10000
export type BatchSize = 10 | 100 | 300 | 500

// Database operation modes
export type DbTransactionMode = 'r' | 'rw'
export type DbOperationType = 'import' | 'export' | 'sync' | 'rebuild'

/**
 * データ再構築アドバイザリのバージョン。
 *
 * `detectActionDetails`（ActionDetailフラグ）、ポジション算出、ショーダウン
 * フェーズ判定など、書き込み時に確定させるエンティティ導出ロジックを変更し、
 * 既存に記録済みのハンドを再評価すると異なる結果になる場合はこの値をインクリ
 * メントすること（例: #94–#97, #100–#101 の修正 = version 1）。
 *
 * version 2: プリフロップ全員オールインでEVT_DEAL_ROUNDが一切送信されない
 * ハンド（docs/api-events.md）でFLOPフェーズが合成されず、WTSD/WWSFの
 * 「flops seen」分母から漏れていたバグを修正（entity-converter.ts /
 * write-entity-stream.ts、PR #115未解決コメントのsola監査分）。
 *
 * version 3: 独立監査finding #7（PR #207, plan C）。既存データがある状態
 * への追加インポートが既存行とハンド境界をまたいでオーバーラップする
 * ケース（例: DEAL/RESULTSは既存・中間ACTIONsが今回のインポートで到着）
 * で、旧実装（インクリメンタルなEntityConverter直接変換）は新規イベント
 * だけでは正しいハンドを作れず、hands/phases/actionsが古いまま
 * サイレントに残っていた。修正後のimportData()は新規行が1件でもあれば
 * full rebuildを行うため今後のインポートは正しく直るが、**既にこの
 * バグを踏んだユーザー**の生イベント自体は既に完全（apiEventsは常に
 * 全件保存されるため）で、その後の再インポートは全行重複となり
 * rebuildが起動しない ―― 派生データの修復にはこのアドバイザリで
 * 明示的な「データ再構築」実行を促す必要がある。
 *
 * DB v6のapiEvents sequence-key移行は既存raw行へ`sequence: 0`を付ける
 * 機械的な主キー移行で、hands/phases/actionsのキー・導出ロジック・内容を
 * 変更しないため、このアドバイザリはバンプしない。
 *
 * version 4: `Hand.approxTimestamp`をEVT_HAND_RESULTSの到着時刻から
 * EVT_DEALの到着時刻へ修正。既存の派生handには終了時刻が保存されて
 * おり、PokerStars形式エクスポートの開始時刻にもその値が使われるため、
 * Raw Event Lakeからの再構築で既存行を修復する。
 *
 * version 5: Recent Handsの結果を`RewardChip`（gross payout）から、
 * DEAL/RESULTSの開始・終了スタックで検証したsigned net chipsへ変更。
 * `Hand.playerChipAccounting`は書き込み時に導出するため、既存handにも
 * Raw Event Lakeからの再構築が必要。
 *
 * インクリメントすると、拡張機能の更新後に既存ユーザーへ一度だけ
 * 「データ再構築」の実行を促すアドバイソリーが表示される
 * （`src/background/rebuild-advisory.ts`参照）。単なるUI変更やバグ修正でも
 * 書き込み時の導出結果に影響しないものはバンプ不要。
 */
export const REBUILD_ADVISORY_VERSION = 5
