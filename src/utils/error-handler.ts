/**
 * Centralized error handling utilities
 */

import Dexie from 'dexie'
import { AppError, ErrorContext, ErrorSeverity, ErrorType } from '../types/errors'

/**
 * Error handler class for consistent error processing
 */
export class ErrorHandler {
  private static readonly LOG_PREFIX = '[PokerChaseHUD]'
  /**
   * Create an AppError from various error types
   */
  static createError(
    error: unknown,
    type: ErrorType = ErrorType.UNKNOWN,
    context?: ErrorContext
  ): AppError {
    let message: string
    let originalError: Error | undefined
    if (error instanceof Error) {
      message = error.message
      originalError = error
    } else if (typeof error === 'string') {
      message = error
    } else {
      message = JSON.stringify(error)
    }
    const appError = new Error(message) as AppError
    appError.type = type
    appError.severity = this.determineSeverity(type, originalError)
    appError.context = context
    appError.timestamp = Date.now()
    appError.isRetryable = this.isRetryable(type, originalError)
    // Preserve stack trace
    if (originalError?.stack) {
      appError.stack = originalError.stack
    }
    return appError
  }
  /**
   * Log error with consistent format
   */
  static logError(error: AppError | Error, streamName?: string): void {
    const isAppError = 'type' in error && 'severity' in error
    const severity = isAppError ? (error as AppError).severity : ErrorSeverity.ERROR
    const context = isAppError ? (error as AppError).context : {}
    const logMessage = this.formatErrorMessage(error, streamName)
    switch (severity) {
      case ErrorSeverity.DEBUG:
        console.debug(logMessage, context)
        break
      case ErrorSeverity.INFO:
        console.info(logMessage, context)
        break
      case ErrorSeverity.WARNING:
        console.warn(logMessage, context)
        break
      case ErrorSeverity.ERROR:
      case ErrorSeverity.FATAL:
        console.error(logMessage, context)
        break
    }
  }
  /**
   * Handle database-specific errors
   */
  static handleDbError(error: unknown, context?: ErrorContext): AppError {
    if (error instanceof Dexie.DexieError) {
      // Handle specific Dexie errors
      switch (error.name) {
        case 'ConstraintError':
          return this.createError(error, ErrorType.DB_CONSTRAINT, {
            ...context,
            isDuplicate: true
          })
        case 'TransactionInactiveError':
          return this.createError(error, ErrorType.DB_TRANSACTION, context)
        case 'OpenFailedError':
          return this.createError(error, ErrorType.DB_CONNECTION, context)
        default:
          return this.createError(error, ErrorType.DB_QUERY, context)
      }
    }
    return this.createError(error, ErrorType.DB_QUERY, context)
  }
  /**
   * Handle stream transform errors
   */
  static handleStreamError(
    error: unknown,
    streamName: string,
    context?: ErrorContext
  ): AppError {
    const appError = this.createError(
      error,
      ErrorType.STREAM_TRANSFORM,
      { ...context, streamName }
    )
    this.logError(appError, streamName)
    return appError
  }
  /**
   * Determine error severity based on type and error details
   */
  private static determineSeverity(
    type: ErrorType,
    _error?: Error
  ): ErrorSeverity {
    // Constraint errors are usually duplicates - not severe
    if (type === ErrorType.DB_CONSTRAINT) {
      return ErrorSeverity.DEBUG
    }
    // Connection errors are fatal
    if (type === ErrorType.DB_CONNECTION) {
      return ErrorSeverity.FATAL
    }
    // Transaction errors might be retryable
    if (type === ErrorType.DB_TRANSACTION) {
      return ErrorSeverity.WARNING
    }
    // Stream sequence errors indicate data integrity issues
    if (type === ErrorType.STREAM_SEQUENCE) {
      return ErrorSeverity.ERROR
    }
    // Default to ERROR
    return ErrorSeverity.ERROR
  }
  /**
   * Determine if an error is retryable
   */
  private static isRetryable(type: ErrorType, error?: Error): boolean {
    const retryableTypes = [
      ErrorType.DB_TRANSACTION,
      ErrorType.STREAM_TRANSFORM,
    ]
    if (retryableTypes.includes(type)) {
      return true
    }
    // Dexie transaction errors are often retryable
    if (error instanceof Dexie.DexieError) {
      return error.name === 'TransactionInactiveError' ||
        error.name === 'AbortError'
    }
    return false
  }
  /**
   * Format error message for logging
   */
  private static formatErrorMessage(error: Error, streamName?: string): string {
    const timestamp = new Date().toISOString()
    const stream = streamName ? `[${streamName}]` : ''
    const isAppError = 'type' in error
    const type = isAppError ? `[${(error as AppError).type}]` : ''
    return `${this.LOG_PREFIX}${stream}${type} ${timestamp} - ${error.message}`
  }
  /**
   * Create a standardized error callback for streams
   */
  static createStreamErrorCallback<T>(
    callback: (error?: Error | null, data?: T) => void,
    streamName: string,
    context?: ErrorContext
  ) {
    return (error: unknown) => {
      const appError = this.handleStreamError(error, streamName, context)
      callback(appError)
    }
  }
}
