/**
 * Chrome runtime message type definitions for PokerChase HUD
 * Uses discriminated union pattern for type safety
 */

import { FilterOptions, PlayerStats } from '../app'
import { HandLogConfig, HandLogEvent, UIConfig } from './hand-log'

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
  // Filter
  UPDATE_BATTLE_TYPE_FILTER: 'updateBattleTypeFilter',
  // Stats
  REQUEST_LATEST_STATS: 'requestLatestStats',
  LATEST_STATS: 'latestStats',
  // Data management
  DELETE_ALL_DATA: 'deleteAllData',
  REBUILD_DATA: 'rebuildData',
  // Hand log
  HAND_LOG_EVENT: 'handLogEvent',
  UPDATE_HAND_LOG_CONFIG: 'updateHandLogConfig',
  // UI
  UPDATE_UI_CONFIG: 'updateUIConfig'
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

// Response types for messages that expect a response
export interface SuccessResponse {
  success: true
}

export interface ErrorResponse {
  success: false
  error: string
}

export type MessageResponse = SuccessResponse | ErrorResponse

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
  | HandLogEventMessage
  | UpdateHandLogConfigMessage
  | UpdateUIConfigMessage

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
