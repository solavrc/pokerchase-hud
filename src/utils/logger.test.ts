/**
 * Unit tests for Logger utility
 */

import { Logger } from './logger'

describe('Logger', () => {
  let consoleLogSpy: jest.SpyInstance
  let consoleInfoSpy: jest.SpyInstance
  let consoleWarnSpy: jest.SpyInstance
  let consoleErrorSpy: jest.SpyInstance
  let consoleDebugSpy: jest.SpyInstance
  
  beforeEach(() => {
    // Mock console methods
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation()
    consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation()
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation()
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation()
    consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation()
    
    // Mock Date constructor for consistent timestamps
    const mockDate = new Date('2009-02-13T23:31:30.123Z')
    jest.spyOn(global, 'Date').mockImplementation(() => mockDate as any)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('constructor', () => {
    it('should create logger with context', () => {
      const logger = new Logger('TestContext')
      logger.log('test message')
      
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '23:31:30.123 [TestContext] test message',
        undefined
      )
    })

    it('should create logger with options', () => {
      const logger = new Logger('TestContext', { timestamp: false })
      logger.log('test message')
      
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[TestContext] test message',
        undefined
      )
    })
  })

  describe('log levels', () => {
    let logger: Logger
    
    beforeEach(() => {
      logger = new Logger('TestLogger')
    })

    it('should handle log level', () => {
      logger.log('log message')
      
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '23:31:30.123 [TestLogger] log message',
        undefined
      )
      expect(consoleInfoSpy).not.toHaveBeenCalled()
    })

    it('should handle info level', () => {
      logger.info('info message')
      
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '23:31:30.123 [TestLogger] info message',
        undefined
      )
      expect(consoleInfoSpy).not.toHaveBeenCalled()
    })

    it('should handle warn level', () => {
      logger.warn('warning message')
      
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '23:31:30.123 [TestLogger] warning message',
        undefined
      )
    })

    it('should handle error level', () => {
      logger.error('error message')
      
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '23:31:30.123 [TestLogger] error message',
        undefined
      )
    })

    it('should handle debug level', () => {
      // Need to create logger with isDevelopment: true for debug to work
      const devLogger = new Logger('TestLogger', { isDevelopment: true })
      devLogger.debug('debug message')
      
      expect(consoleDebugSpy).toHaveBeenCalledWith(
        '23:31:30.123 [TestLogger] debug message',
        undefined
      )
    })
  })

  describe('message formatting', () => {
    it('should handle data parameter', () => {
      const logger = new Logger('MultiArg')
      logger.log('message', { data: 'test' })
      
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '23:31:30.123 [MultiArg] message',
        { data: 'test' }
      )
    })

    it('should handle empty message', () => {
      const logger = new Logger('Empty')
      logger.log('')
      
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '23:31:30.123 [Empty] ',
        undefined
      )
    })

    it('should handle undefined data', () => {
      const logger = new Logger('NoData')
      logger.log('message')
      
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '23:31:30.123 [NoData] message',
        undefined
      )
    })
  })

  describe('child logger', () => {
    it('should create child logger with additional context', () => {
      const parentLogger = new Logger('Parent')
      const childLogger = parentLogger.child('Child')
      
      childLogger.log('test message')
      
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '23:31:30.123 [Parent:Child] test message',
        undefined
      )
    })

    it('should handle multiple context levels', () => {
      const logger = new Logger('Level1')
        .child('Level2')
        .child('Level3')
      
      logger.log('nested message')
      
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '23:31:30.123 [Level1:Level2:Level3] nested message',
        undefined
      )
    })

    it('should inherit options from parent', () => {
      const parentLogger = new Logger('Parent', { timestamp: false })
      const childLogger = parentLogger.child('Child')
      
      childLogger.log('test message')
      
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[Parent:Child] test message',
        undefined
      )
    })
  })

  describe('error handling', () => {
    it('should handle Error objects', () => {
      const logger = new Logger('ErrorTest')
      const error = new Error('Test error')
      
      logger.error('An error occurred:', error)
      
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '23:31:30.123 [ErrorTest] An error occurred:',
        error
      )
    })

    it('should handle string errors', () => {
      const logger = new Logger('StringError')
      
      logger.error('Error:', 'Something went wrong')
      
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '23:31:30.123 [StringError] Error:',
        'Something went wrong'
      )
    })
  })

  describe('performance method', () => {
    it('should log performance metrics', () => {
      const logger = new Logger('Performance', { isDevelopment: true })
      
      logger.performance('Database query', 150.5, { query: 'SELECT * FROM users' })
      
      expect(consoleDebugSpy).toHaveBeenCalledWith(
        '23:31:30.123 [Performance] Database query completed in 150.50ms',
        { query: 'SELECT * FROM users' }
      )
    })

    it('should warn for slow operations', () => {
      const logger = new Logger('Performance')
      
      logger.performance('Slow operation', 1500)
      
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '23:31:30.123 [Performance] Slow operation completed in 1500.00ms',
        undefined
      )
    })
  })

  describe('debug logging', () => {
    it('should only log debug in development mode', () => {
      const devLogger = new Logger('Dev', { isDevelopment: true })
      const prodLogger = new Logger('Prod', { isDevelopment: false })
      
      devLogger.debug('debug message')
      prodLogger.debug('should not appear')
      
      expect(consoleDebugSpy).toHaveBeenCalledTimes(1)
      expect(consoleDebugSpy).toHaveBeenCalledWith(
        '23:31:30.123 [Dev] debug message',
        undefined
      )
    })
  })
})