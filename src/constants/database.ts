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
  FIRESTORE_PARALLEL_BATCHES: 3, // Number of parallel Firestore batches
  FIRESTORE_BATCH_DELAY_MS: 500, // Delay between batch groups
  FIRESTORE_DOWNLOAD_PAGE_SIZE: 1000, // Maximum documents per Firestore download response
  
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
 * インクリメントすると、拡張機能の更新後に既存ユーザーへ一度だけ
 * 「データ再構築」の実行を促すアドバイソリーが表示される
 * （`src/background/rebuild-advisory.ts`参照）。単なるUI変更やバグ修正でも
 * 書き込み時の導出結果に影響しないものはバンプ不要。
 */
export const REBUILD_ADVISORY_VERSION = 1
