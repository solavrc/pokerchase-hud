/**
 * Chrome runtime message type definitions for PokerChase HUD
 * Uses discriminated union pattern for type safety
 */

import type { FilterOptions, PlayerStats, PositionalStatsResult, RecentHandsResult } from './index'
import { HandLogConfig, HandLogEvent, UIConfig } from './hand-log'
import type { SyncState } from '../services/auto-sync-service'
import type { UndecodedEventStats } from '../background/undecoded-event-tracker'

// Message action constants
export const MESSAGE_ACTIONS = {
  // Import/Export
  IMPORT_STATUS: 'importStatus',
  IMPORT_PROGRESS: 'importProgress',
  EXPORT_DATA: 'exportData',
  IMPORT_DATA: 'importData',
  IMPORT_DATA_INIT: 'importDataInit',
  IMPORT_DATA_CHUNK: 'importDataChunk',
  IMPORT_DATA_PROCESS: 'importDataProcess',
  // Firebase Backup
  FIREBASE_AUTH_STATUS: 'firebaseAuthStatus',
  FIREBASE_SIGN_IN: 'firebaseSignIn',
  FIREBASE_SIGN_OUT: 'firebaseSignOut',
  FIREBASE_BACKUP_UPLOAD: 'firebaseBackupUpload',
  FIREBASE_BACKUP_LIST: 'firebaseBackupList',
  FIREBASE_BACKUP_DOWNLOAD: 'firebaseBackupDownload',
  FIREBASE_BACKUP_DELETE: 'firebaseBackupDelete',
  FIREBASE_BACKUP_PROGRESS: 'firebaseBackupProgress',
  // Manual Sync
  MANUAL_SYNC_UPLOAD: 'manualSyncUpload',
  MANUAL_SYNC_DOWNLOAD: 'manualSyncDownload',
  GET_SYNC_STATE: 'getSyncState',
  GET_UNSYNCED_COUNT: 'getUnsyncedCount',
  // Filter
  UPDATE_BATTLE_TYPE_FILTER: 'updateBattleTypeFilter',
  // Stats
  REQUEST_LATEST_STATS: 'requestLatestStats',
  LATEST_STATS: 'latestStats',
  // Data management
  DELETE_ALL_DATA: 'deleteAllData',
  REBUILD_DATA: 'rebuildData',
  // Export/Rebuild progress
  EXPORT_PROGRESS: 'exportProgress',
  REBUILD_PROGRESS: 'rebuildProgress',
  // Hand log
  HAND_LOG_EVENT: 'handLogEvent',
  UPDATE_HAND_LOG_CONFIG: 'updateHandLogConfig',
  // UI
  UPDATE_UI_CONFIG: 'updateUIConfig',
  // Operation state
  GET_OPERATION_STATE: 'getOperationState',
  // Rebuild advisory
  ACKNOWLEDGE_REBUILD_ADVISORY: 'acknowledgeRebuildAdvisory',
  // Positional drill-down
  GET_POSITIONAL_STATS: 'getPositionalStats',
  // Recent hands drill-down
  GET_RECENT_HANDS: 'getRecentHands',
  // Undecoded event (drop) visibility
  GET_UNDECODED_EVENT_STATS: 'getUndecodedEventStats',
  ACKNOWLEDGE_UNDECODED_EVENT_STATS: 'acknowledgeUndecodedEventStats',
  // Forced update (auto-apply)
  APPLY_PENDING_UPDATE: 'applyPendingUpdate',
  // What's New (per-version release notes)
  ACKNOWLEDGE_WHATS_NEW: 'acknowledgeWhatsNew',
} as const

// Import/Export related messages
export interface ImportStatusMessage {
  action: 'importStatus'
  status: string
}

export interface ImportProgressMessage {
  action: 'importProgress'
  progress: number
  processed: number
  total: number
  duplicates?: number
  imported?: number
}

export interface ExportDataMessage {
  action: 'exportData'
  format: 'json' | 'pokerstars'
}

export interface ImportDataMessage {
  action: 'importData'
  data: string
}

export interface ImportDataInitMessage {
  action: 'importDataInit'
  totalChunks: number
  fileName: string
}

export interface ImportDataChunkMessage {
  action: 'importDataChunk'
  chunkIndex: number
  chunkData: string
}

export interface ImportDataProcessMessage {
  action: 'importDataProcess'
}

// Filter related messages
export interface UpdateBattleTypeFilterMessage {
  action: 'updateBattleTypeFilter'
  filterOptions: FilterOptions
}

// Stats related messages
export interface RequestLatestStatsMessage {
  action: 'requestLatestStats'
  /**
   * true only for the request content_script.ts's mountApp() fires right at
   * HUD mount. Distinguishes it from the pre-existing post-import
   * refreshStats round-trip (same action, preGame omitted/false), which
   * must keep its original "always return []" semantics -- import
   * completion already triggers a real recompute+broadcast
   * (statsOutputStream.write) moments before refreshStats fires, so
   * enabling the pre-game hero-only fallback for that call site risks a
   * stale hero-only response clobbering the fresher full lineup if it
   * arrives second. See getLatestSessionStats() in
   * background/import-export.ts.
   */
  preGame?: boolean
}

export interface LatestStatsMessage {
  action: 'latestStats'
  stats: PlayerStats[]
}

// Data management messages
export interface DeleteAllDataMessage {
  action: 'deleteAllData'
}

export interface RebuildDataMessage {
  action: 'rebuildData'
}

export interface ExportProgressMessage {
  action: 'exportProgress'
  state: 'started' | 'processing' | 'completed' | 'error'
  format?: 'json' | 'pokerstars'
  progress?: number // 0-100
  processed?: number
  total?: number
  message?: string
}

export interface RebuildProgressMessage {
  action: 'rebuildProgress'
  state: 'started' | 'processing' | 'completed' | 'error'
  progress?: number // 0-100
  message?: string
}

// Hand log messages
export interface HandLogEventMessage {
  action: 'handLogEvent'
  event: HandLogEvent
}

export interface UpdateHandLogConfigMessage {
  action: 'updateHandLogConfig'
  config: HandLogConfig
}

// UI config messages
export interface UpdateUIConfigMessage {
  action: 'updateUIConfig'
  config: UIConfig
}

// Firebase backup messages
export interface FirebaseAuthStatusMessage {
  action: 'firebaseAuthStatus'
  /** Present on background-to-popup status updates; omitted on status requests. */
  isSignedIn?: boolean
  userInfo?: {
    email: string | null
    displayName: string | null
    photoURL: string | null
    uid?: string
  } | null
}

export interface FirebaseSignInMessage {
  action: 'firebaseSignIn'
}

export interface FirebaseSignOutMessage {
  action: 'firebaseSignOut'
}

export interface FirebaseBackupUploadMessage {
  action: 'firebaseBackupUpload'
}

export interface FirebaseBackupListMessage {
  action: 'firebaseBackupList'
}

export interface FirebaseBackupDownloadMessage {
  action: 'firebaseBackupDownload'
  backupId: string
}

export interface FirebaseBackupDeleteMessage {
  action: 'firebaseBackupDelete'
  backupId: string
}

export interface FirebaseSyncToCloudMessage {
  action: 'firebaseSyncToCloud'
}

export interface FirebaseSyncFromCloudMessage {
  action: 'firebaseSyncFromCloud'
}

export interface GetSyncStateMessage {
  action: 'getSyncState'
}

export interface GetUnsyncedCountMessage {
  action: 'getUnsyncedCount'
}

export interface GetSyncInfoMessage {
  action: 'getSyncInfo'
}

export interface SyncStateUpdateMessage {
  action: 'SYNC_STATE_UPDATE'
  state: SyncState
}

export interface ManualSyncUploadMessage {
  action: 'manualSyncUpload'
}

export interface ManualSyncDownloadMessage {
  action: 'manualSyncDownload'
}

export interface GetOperationStateMessage {
  action: 'getOperationState'
}

// Rebuild advisory messages
export interface AcknowledgeRebuildAdvisoryMessage {
  action: 'acknowledgeRebuildAdvisory'
}

// Positional drill-down messages
export interface GetPositionalStatsMessage {
  action: 'getPositionalStats'
  playerId: number
}

// Recent hands drill-down messages
export interface GetRecentHandsMessage {
  action: 'getRecentHands'
  playerId: number
  /** Defaults to DEFAULT_RECENT_HANDS_LIMIT (10) in recent-hands-service.ts when omitted. */
  limit?: number
}

// Undecoded event (drop) visibility messages
export interface GetUndecodedEventStatsMessage {
  action: 'getUndecodedEventStats'
}

export interface AcknowledgeUndecodedEventStatsMessage {
  action: 'acknowledgeUndecodedEventStats'
}

// Forced update (auto-apply) messages
export interface ApplyPendingUpdateMessage {
  action: 'applyPendingUpdate'
}

// What's New (per-version release notes) messages
export interface AcknowledgeWhatsNewMessage {
  action: 'acknowledgeWhatsNew'
}

export interface FirebaseBackupProgressMessage {
  action: 'firebaseBackupProgress'
  progress: number
  state: 'running' | 'paused' | 'success' | 'canceled' | 'error'
}

// Response types for messages that expect a response
export interface SuccessResponse {
  success: true
}

export interface ErrorResponse {
  success: false
  error: string
}

// Extended response types for Firebase backup
export interface BackupListResponse extends SuccessResponse {
  backups: Array<{
    id: string
    fileName: string
    timestamp: string
    size: number
  }>
}

export interface BackupDownloadResponse extends SuccessResponse {
  data: string
}

export interface AuthStatusResponse extends SuccessResponse {
  isSignedIn: boolean
  userInfo: {
    email: string | null
    displayName: string | null
    photoURL: string | null
    uid?: string
  } | null
}

export interface SyncStateResponse extends SuccessResponse {
  syncState: SyncState
}

export interface UnsyncedCountResponse extends SuccessResponse {
  count: number
}

export interface SyncInfoResponse extends SuccessResponse {
  syncInfo: {
    localLastTimestamp?: number
    cloudLastTimestamp?: number
    uploadPendingCount: number
  }
}

export interface OperationStateResponse extends SuccessResponse {
  operationState: {
    type: 'idle' | 'export' | 'import' | 'rebuild' | 'sync' | 'delete'
    format?: 'json' | 'pokerstars'
    progress?: number
    processed?: number
    total?: number
    message?: string
  }
}

export interface PositionalStatsResponse extends SuccessResponse {
  positionalStats: PositionalStatsResult
}

export interface RecentHandsResponse extends SuccessResponse {
  recentHands: RecentHandsResult
}

export interface UndecodedEventStatsResponse extends SuccessResponse {
  undecodedEventStats: UndecodedEventStats
}

export interface ApplyUpdateResponse extends SuccessResponse {
  applied: boolean
  reason?: string
}

export type MessageResponse = SuccessResponse | ErrorResponse | BackupListResponse | BackupDownloadResponse | AuthStatusResponse | SyncStateResponse | UnsyncedCountResponse | SyncInfoResponse | OperationStateResponse | PositionalStatsResponse | RecentHandsResponse | UndecodedEventStatsResponse | ApplyUpdateResponse

// Union type of all possible messages
export type ChromeMessage =
  | ImportStatusMessage
  | ImportProgressMessage
  | ExportDataMessage
  | ImportDataMessage
  | ImportDataInitMessage
  | ImportDataChunkMessage
  | ImportDataProcessMessage
  | UpdateBattleTypeFilterMessage
  | RequestLatestStatsMessage
  | LatestStatsMessage
  | DeleteAllDataMessage
  | RebuildDataMessage
  | ExportProgressMessage
  | RebuildProgressMessage
  | HandLogEventMessage
  | UpdateHandLogConfigMessage
  | UpdateUIConfigMessage
  | FirebaseAuthStatusMessage
  | FirebaseSignInMessage
  | FirebaseSignOutMessage
  | FirebaseBackupUploadMessage
  | FirebaseBackupListMessage
  | FirebaseBackupDownloadMessage
  | FirebaseBackupDeleteMessage
  | FirebaseBackupProgressMessage
  | FirebaseSyncToCloudMessage
  | FirebaseSyncFromCloudMessage
  | GetSyncStateMessage
  | GetUnsyncedCountMessage
  | GetSyncInfoMessage
  | SyncStateUpdateMessage
  | ManualSyncUploadMessage
  | ManualSyncDownloadMessage
  | GetOperationStateMessage
  | AcknowledgeRebuildAdvisoryMessage
  | GetPositionalStatsMessage
  | GetRecentHandsMessage
  | GetUndecodedEventStatsMessage
  | AcknowledgeUndecodedEventStatsMessage
  | ApplyPendingUpdateMessage
  | AcknowledgeWhatsNewMessage

// Helper function for type guard implementation
const isMessageWithAction = (msg: unknown, action: string): msg is { action: string } =>
  typeof msg === 'object' && msg !== null && 'action' in msg && (msg as any).action === action

// Type guards for type narrowing
export const isImportStatusMessage = (msg: unknown): msg is ImportStatusMessage =>
  isMessageWithAction(msg, 'importStatus')

export const isImportProgressMessage = (msg: unknown): msg is ImportProgressMessage =>
  isMessageWithAction(msg, 'importProgress')

export const isExportDataMessage = (msg: unknown): msg is ExportDataMessage =>
  isMessageWithAction(msg, 'exportData')

export const isImportDataMessage = (msg: unknown): msg is ImportDataMessage =>
  isMessageWithAction(msg, 'importData')

export const isImportDataInitMessage = (msg: unknown): msg is ImportDataInitMessage =>
  isMessageWithAction(msg, 'importDataInit')

export const isImportDataChunkMessage = (msg: unknown): msg is ImportDataChunkMessage =>
  isMessageWithAction(msg, 'importDataChunk')

export const isImportDataProcessMessage = (msg: unknown): msg is ImportDataProcessMessage =>
  isMessageWithAction(msg, 'importDataProcess')

export const isUpdateBattleTypeFilterMessage = (msg: unknown): msg is UpdateBattleTypeFilterMessage =>
  isMessageWithAction(msg, 'updateBattleTypeFilter')

export const isRequestLatestStatsMessage = (msg: unknown): msg is RequestLatestStatsMessage =>
  isMessageWithAction(msg, 'requestLatestStats')

export const isLatestStatsMessage = (msg: unknown): msg is LatestStatsMessage =>
  isMessageWithAction(msg, 'latestStats')

export const isDeleteAllDataMessage = (msg: unknown): msg is DeleteAllDataMessage =>
  isMessageWithAction(msg, 'deleteAllData')

export const isRebuildDataMessage = (msg: unknown): msg is RebuildDataMessage =>
  isMessageWithAction(msg, 'rebuildData')

export const isHandLogEventMessage = (msg: unknown): msg is HandLogEventMessage =>
  isMessageWithAction(msg, 'handLogEvent')

export const isUpdateHandLogConfigMessage = (msg: unknown): msg is UpdateHandLogConfigMessage =>
  isMessageWithAction(msg, 'updateHandLogConfig')

export const isUpdateUIConfigMessage = (msg: unknown): msg is UpdateUIConfigMessage =>
  isMessageWithAction(msg, 'updateUIConfig')

export const isFirebaseAuthStatusMessage = (msg: unknown): msg is FirebaseAuthStatusMessage =>
  isMessageWithAction(msg, 'firebaseAuthStatus')

export const isFirebaseSignInMessage = (msg: unknown): msg is FirebaseSignInMessage =>
  isMessageWithAction(msg, 'firebaseSignIn')

export const isFirebaseSignOutMessage = (msg: unknown): msg is FirebaseSignOutMessage =>
  isMessageWithAction(msg, 'firebaseSignOut')

export const isFirebaseBackupUploadMessage = (msg: unknown): msg is FirebaseBackupUploadMessage =>
  isMessageWithAction(msg, 'firebaseBackupUpload')

export const isFirebaseBackupListMessage = (msg: unknown): msg is FirebaseBackupListMessage =>
  isMessageWithAction(msg, 'firebaseBackupList')

export const isFirebaseBackupDownloadMessage = (msg: unknown): msg is FirebaseBackupDownloadMessage =>
  isMessageWithAction(msg, 'firebaseBackupDownload')

export const isFirebaseBackupDeleteMessage = (msg: unknown): msg is FirebaseBackupDeleteMessage =>
  isMessageWithAction(msg, 'firebaseBackupDelete')

export const isFirebaseBackupProgressMessage = (msg: unknown): msg is FirebaseBackupProgressMessage =>
  isMessageWithAction(msg, 'firebaseBackupProgress')

export const isExportProgressMessage = (msg: unknown): msg is ExportProgressMessage =>
  isMessageWithAction(msg, 'exportProgress')

export const isRebuildProgressMessage = (msg: unknown): msg is RebuildProgressMessage =>
  isMessageWithAction(msg, 'rebuildProgress')

export const isGetOperationStateMessage = (msg: unknown): msg is GetOperationStateMessage =>
  isMessageWithAction(msg, 'getOperationState')

export const isAcknowledgeRebuildAdvisoryMessage = (msg: unknown): msg is AcknowledgeRebuildAdvisoryMessage =>
  isMessageWithAction(msg, 'acknowledgeRebuildAdvisory')

export const isGetPositionalStatsMessage = (msg: unknown): msg is GetPositionalStatsMessage =>
  isMessageWithAction(msg, 'getPositionalStats')

export const isGetRecentHandsMessage = (msg: unknown): msg is GetRecentHandsMessage =>
  isMessageWithAction(msg, 'getRecentHands')

export const isGetUndecodedEventStatsMessage = (msg: unknown): msg is GetUndecodedEventStatsMessage =>
  isMessageWithAction(msg, 'getUndecodedEventStats')

export const isAcknowledgeUndecodedEventStatsMessage = (msg: unknown): msg is AcknowledgeUndecodedEventStatsMessage =>
  isMessageWithAction(msg, 'acknowledgeUndecodedEventStats')

export const isApplyPendingUpdateMessage = (msg: unknown): msg is ApplyPendingUpdateMessage =>
  isMessageWithAction(msg, 'applyPendingUpdate')

export const isAcknowledgeWhatsNewMessage = (msg: unknown): msg is AcknowledgeWhatsNewMessage =>
  isMessageWithAction(msg, 'acknowledgeWhatsNew')
