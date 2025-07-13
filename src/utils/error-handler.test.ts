import { ErrorHandler } from './error-handler'
import { ErrorType, ErrorSeverity } from '../types/errors'
import Dexie from 'dexie'

describe('ErrorHandler', () => {
  // Mock console methods
  const originalConsole = {
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error
  }
  
  beforeEach(() => {
    console.debug = jest.fn()
    console.info = jest.fn()
    console.warn = jest.fn()
    console.error = jest.fn()
  })
  
  afterEach(() => {
    console.debug = originalConsole.debug
    console.info = originalConsole.info
    console.warn = originalConsole.warn
    console.error = originalConsole.error
  })

  describe('createError', () => {
    it('should create AppError from Error instance', () => {
      const originalError = new Error('Test error')
      const appError = ErrorHandler.createError(originalError, ErrorType.STREAM_TRANSFORM, {
        streamName: 'TestStream'
      })
      
      expect(appError.message).toBe('Test error')
      expect(appError.type).toBe(ErrorType.STREAM_TRANSFORM)
      expect(appError.severity).toBe(ErrorSeverity.ERROR)
      expect(appError.context).toEqual({ streamName: 'TestStream' })
      expect(appError.timestamp).toBeDefined()
      expect(appError.isRetryable).toBe(true)
    })
    
    it('should create AppError from string', () => {
      const appError = ErrorHandler.createError('String error', ErrorType.VALIDATION)
      
      expect(appError.message).toBe('String error')
      expect(appError.type).toBe(ErrorType.VALIDATION)
    })
    
    it('should create AppError from unknown type', () => {
      const appError = ErrorHandler.createError({ foo: 'bar' }, ErrorType.UNKNOWN)
      
      expect(appError.message).toBe('{"foo":"bar"}')
      expect(appError.type).toBe(ErrorType.UNKNOWN)
    })
  })

  describe('handleDbError', () => {
    it('should handle Dexie ConstraintError', () => {
      const dexieError = new Dexie.DexieError('ConstraintError')
      dexieError.name = 'ConstraintError'
      
      const appError = ErrorHandler.handleDbError(dexieError, { operation: 'insert' })
      
      expect(appError.type).toBe(ErrorType.DB_CONSTRAINT)
      expect(appError.severity).toBe(ErrorSeverity.DEBUG)
      expect(appError.context?.isDuplicate).toBe(true)
    })
    
    it('should handle Dexie TransactionInactiveError', () => {
      const dexieError = new Dexie.DexieError('TransactionInactiveError')
      dexieError.name = 'TransactionInactiveError'
      
      const appError = ErrorHandler.handleDbError(dexieError)
      
      expect(appError.type).toBe(ErrorType.DB_TRANSACTION)
      expect(appError.severity).toBe(ErrorSeverity.WARNING)
      expect(appError.isRetryable).toBe(true)
    })
    
    it('should handle generic database error', () => {
      const error = new Error('Database query failed')
      const appError = ErrorHandler.handleDbError(error)
      
      expect(appError.type).toBe(ErrorType.DB_QUERY)
      expect(appError.severity).toBe(ErrorSeverity.ERROR)
    })
  })

  describe('logError', () => {
    it('should log debug level errors', () => {
      const error = ErrorHandler.createError('Debug message', ErrorType.DB_CONSTRAINT)
      ErrorHandler.logError(error, 'TestStream')
      
      expect(console.debug).toHaveBeenCalled()
      expect(console.error).not.toHaveBeenCalled()
    })
    
    it('should log error level errors', () => {
      const error = ErrorHandler.createError('Error message', ErrorType.STREAM_SEQUENCE)
      ErrorHandler.logError(error, 'TestStream')
      
      expect(console.error).toHaveBeenCalled()
      expect(console.debug).not.toHaveBeenCalled()
    })
    
    it('should include stream name in log message', () => {
      const error = new Error('Test error')
      ErrorHandler.logError(error, 'TestStream')
      
      const logCall = (console.error as jest.Mock).mock.calls[0][0]
      expect(logCall).toContain('[TestStream]')
    })
  })

  describe('createStreamErrorCallback', () => {
    it('should create a callback that handles errors', () => {
      const mockCallback = jest.fn()
      const errorCallback = ErrorHandler.createStreamErrorCallback(
        mockCallback,
        'TestStream',
        { testContext: 'value' }
      )
      
      const testError = new Error('Stream error')
      errorCallback(testError)
      
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Stream error',
          type: ErrorType.STREAM_TRANSFORM,
          context: expect.objectContaining({
            streamName: 'TestStream',
            testContext: 'value'
          })
        })
      )
    })
  })

  describe('error severity determination', () => {
    it('should mark DB_CONNECTION as FATAL', () => {
      const error = ErrorHandler.createError('Connection failed', ErrorType.DB_CONNECTION)
      expect(error.severity).toBe(ErrorSeverity.FATAL)
    })
    
    it('should mark DB_CONSTRAINT as DEBUG', () => {
      const error = ErrorHandler.createError('Duplicate key', ErrorType.DB_CONSTRAINT)
      expect(error.severity).toBe(ErrorSeverity.DEBUG)
    })
    
    it('should mark STREAM_SEQUENCE as ERROR', () => {
      const error = ErrorHandler.createError('Out of sequence', ErrorType.STREAM_SEQUENCE)
      expect(error.severity).toBe(ErrorSeverity.ERROR)
    })
  })

  describe('retryable errors', () => {
    it('should mark transaction errors as retryable', () => {
      const error = ErrorHandler.createError('Transaction failed', ErrorType.DB_TRANSACTION)
      expect(error.isRetryable).toBe(true)
    })
    
    it('should mark stream transform errors as retryable', () => {
      const error = ErrorHandler.createError('Transform failed', ErrorType.STREAM_TRANSFORM)
      expect(error.isRetryable).toBe(true)
    })
    
    it('should mark constraint errors as not retryable', () => {
      const error = ErrorHandler.createError('Duplicate', ErrorType.DB_CONSTRAINT)
      expect(error.isRetryable).toBe(false)
    })
  })
})