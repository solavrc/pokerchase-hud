/**
 * Simple structured logger for PokerChase HUD
 * Provides consistent logging format across the application
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LoggerOptions {
  level?: LogLevel
  timestamp?: boolean
  isDevelopment?: boolean
}

export class Logger {
  private readonly context: string
  private readonly options: Required<LoggerOptions>
  
  constructor(context: string, options: LoggerOptions = {}) {
    this.context = context
    this.options = {
      level: options.level ?? 'info',
      timestamp: options.timestamp ?? true,
      isDevelopment: options.isDevelopment ?? (process.env.NODE_ENV === 'development')
    }
  }
  
  private formatMessage(message: string): string {
    const timestamp = this.options.timestamp 
      ? new Date().toISOString().slice(11, 23) + ' '
      : ''
    return `${timestamp}[${this.context}] ${message}`
  }
  
  debug(message: string, data?: any): void {
    if (this.options.isDevelopment) {
      console.debug(this.formatMessage(message), data)
    }
  }
  
  log(message: string, data?: any): void {
    console.log(this.formatMessage(message), data)
  }
  
  info(message: string, data?: any): void {
    this.log(message, data)
  }
  
  warn(message: string, data?: any): void {
    console.warn(this.formatMessage(message), data)
  }
  
  error(message: string, error?: any): void {
    console.error(this.formatMessage(message), error)
    
    // Log stack trace in development
    if (this.options.isDevelopment && error instanceof Error && error.stack) {
      console.error('Stack trace:', error.stack)
    }
  }
  
  /**
   * Log performance metrics
   */
  performance(operation: string, durationMs: number, metadata?: any): void {
    const message = `${operation} completed in ${durationMs.toFixed(2)}ms`
    if (durationMs > 1000) {
      this.warn(message, metadata)
    } else {
      this.debug(message, metadata)
    }
  }
  
  /**
   * Create a child logger with additional context
   */
  child(subContext: string): Logger {
    return new Logger(`${this.context}:${subContext}`, this.options)
  }
}

// Factory function for creating loggers
export function createLogger(context: string, options?: LoggerOptions): Logger {
  return new Logger(context, options)
}

// Pre-configured loggers for common contexts
export const Loggers = {
  Database: createLogger('Database'),
  Sync: createLogger('Sync'),
  Import: createLogger('Import'),
  Export: createLogger('Export'),
  Service: createLogger('Service'),
  Stream: createLogger('Stream'),
  Firebase: createLogger('Firebase'),
} as const