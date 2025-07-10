/**
 * Error handling types and utilities
 */

/**
 * Error types that can occur in the application
 */
export enum ErrorType {
  // Database errors
  DB_CONNECTION = 'DB_CONNECTION',
  DB_CONSTRAINT = 'DB_CONSTRAINT',
  DB_TRANSACTION = 'DB_TRANSACTION',
  DB_QUERY = 'DB_QUERY',
  
  // Stream processing errors
  STREAM_TRANSFORM = 'STREAM_TRANSFORM',
  STREAM_INVALID_DATA = 'STREAM_INVALID_DATA',
  STREAM_SEQUENCE = 'STREAM_SEQUENCE',
  
  // API event errors
  API_EVENT_INVALID = 'API_EVENT_INVALID',
  API_EVENT_MISSING_DATA = 'API_EVENT_MISSING_DATA',
  
  // General errors
  UNKNOWN = 'UNKNOWN',
  VALIDATION = 'VALIDATION',
  RUNTIME = 'RUNTIME'
}

/**
 * Error severity levels
 */
export enum ErrorSeverity {
  DEBUG = 'DEBUG',     // Development only
  INFO = 'INFO',       // Informational
  WARNING = 'WARNING', // Recoverable issues
  ERROR = 'ERROR',     // Errors that need attention
  FATAL = 'FATAL'      // Application-breaking errors
}

/**
 * Extended error information
 */
export interface AppError extends Error {
  type: ErrorType
  severity: ErrorSeverity
  context?: Record<string, any>
  timestamp: number
  isRetryable?: boolean
}

/**
 * Error context for logging
 */
export interface ErrorContext {
  streamName?: string
  eventType?: number
  playerId?: number
  handId?: number
  [key: string]: any
}