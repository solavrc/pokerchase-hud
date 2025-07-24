/**
 * Unit tests for database utility functions
 */

import { saveEntities, processInChunks, findLatestPlayerDealEvent, withTransaction } from './database-utils'
import { PokerChaseDB } from '../db/poker-chase-db'
import type { EntityBundle } from '../entity-converter'
import { ApiType } from '../types'

// Mock Dexie
jest.mock('dexie')

// Mock the dynamic import
jest.mock('../types/api', () => ({
  ApiType: {
    EVT_DEAL: 303
  },
  isApiEventType: jest.fn((event, type) => event && event.ApiTypeId === type)
}))

describe('database-utils', () => {
  let mockDb: jest.Mocked<PokerChaseDB>
  
  beforeEach(() => {
    // Create mock database
    mockDb = {
      hands: {
        bulkPut: jest.fn()
      },
      phases: {
        bulkPut: jest.fn()
      },
      actions: {
        bulkPut: jest.fn()
      },
      meta: {
        bulkPut: jest.fn()
      },
      apiEvents: {
        where: jest.fn(),
        orderBy: jest.fn()
      },
      transaction: jest.fn()
    } as any
  })

  describe('saveEntities', () => {
    it('should save entities in a transaction', async () => {
      const entities: EntityBundle = {
        hands: [{ id: 1 }] as any,
        phases: [{ handId: 1, phase: 'preflop' }] as any,
        actions: [{ handId: 1, index: 0 }] as any
      }

      const mockProgress = jest.fn()
      
      // Mock transaction to execute callback and return its result
      mockDb.transaction.mockImplementation((_mode: any, _tables: any, callback: any) => {
        return callback()
      })

      const result = await saveEntities(mockDb, entities, {
        onProgress: mockProgress
      })

      expect(mockDb.transaction).toHaveBeenCalledWith(
        'rw',
        [mockDb.hands, mockDb.phases, mockDb.actions],
        expect.any(Function)
      )
      
      expect(mockDb.hands.bulkPut).toHaveBeenCalledWith(entities.hands)
      expect(mockDb.phases.bulkPut).toHaveBeenCalledWith(entities.phases)
      expect(mockDb.actions.bulkPut).toHaveBeenCalledWith(entities.actions)
      
      expect(mockProgress).toHaveBeenCalledWith({
        hands: 1,
        phases: 1,
        actions: 1
      })
      
      expect(result).toEqual({
        hands: 1,
        phases: 1,
        actions: 1
      })
    })

    it('should include meta table when includesMeta is true', async () => {
      const entities: EntityBundle = {
        hands: [],
        phases: [],
        actions: []
      }

      mockDb.transaction.mockImplementation((_mode: any, _tables: any, callback: any) => {
        return callback()
      })

      await saveEntities(mockDb, entities, {
        includesMeta: true
      })

      expect(mockDb.transaction).toHaveBeenCalledWith(
        'rw',
        [mockDb.hands, mockDb.phases, mockDb.actions, mockDb.meta],
        expect.any(Function)
      )
    })

    it('should handle empty entities', async () => {
      const entities: EntityBundle = {
        hands: [],
        phases: [],
        actions: []
      }

      mockDb.transaction.mockImplementation((_mode: any, _tables: any, callback: any) => {
        return callback()
      })

      const result = await saveEntities(mockDb, entities)

      expect(mockDb.hands.bulkPut).not.toHaveBeenCalled()
      expect(mockDb.phases.bulkPut).not.toHaveBeenCalled()
      expect(mockDb.actions.bulkPut).not.toHaveBeenCalled()
      
      expect(result).toEqual({
        hands: 0,
        phases: 0,
        actions: 0
      })
    })
  })

  describe('processInChunks', () => {
    it('should process data in chunks', async () => {
      const mockData = Array.from({ length: 25 }, (_, i) => ({ id: i }))
      const chunkSize = 10
      
      const mockCollection = {
        count: jest.fn().mockResolvedValue(mockData.length),
        offset: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        toArray: jest.fn()
      } as any

      // Mock toArray to return chunks
      mockCollection.toArray
        .mockResolvedValueOnce(mockData.slice(0, 10))
        .mockResolvedValueOnce(mockData.slice(10, 20))
        .mockResolvedValueOnce(mockData.slice(20, 25))
        .mockResolvedValue([])

      const chunks: any[][] = []
      for await (const chunk of processInChunks(mockCollection, chunkSize)) {
        chunks.push(chunk)
      }

      expect(chunks).toHaveLength(3)
      expect(chunks[0]).toHaveLength(10)
      expect(chunks[1]).toHaveLength(10)
      expect(chunks[2]).toHaveLength(5)
      
      expect(mockCollection.offset).toHaveBeenCalledWith(0)
      expect(mockCollection.offset).toHaveBeenCalledWith(10)
      expect(mockCollection.offset).toHaveBeenCalledWith(20)
    })

    it('should call progress callback', async () => {
      const mockCollection = {
        count: jest.fn().mockResolvedValue(20),
        offset: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        toArray: jest.fn()
      } as any

      mockCollection.toArray
        .mockResolvedValueOnce(Array(10).fill({ id: 1 }))
        .mockResolvedValueOnce(Array(10).fill({ id: 2 }))
        .mockResolvedValue([])

      const onProgress = jest.fn()
      
      const chunks: any[][] = []
      for await (const chunk of processInChunks(mockCollection, 10, { onProgress })) {
        chunks.push(chunk)
      }

      expect(onProgress).toHaveBeenCalledWith(10, 20)
      expect(onProgress).toHaveBeenCalledWith(20, 20)
    })

    it('should handle empty collection', async () => {
      const mockCollection = {
        count: jest.fn().mockResolvedValue(0),
        offset: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([])
      } as any

      const chunks: any[][] = []
      for await (const chunk of processInChunks(mockCollection, 10)) {
        chunks.push(chunk)
      }

      expect(chunks).toHaveLength(0)
    })
  })

  describe('findLatestPlayerDealEvent', () => {
    beforeEach(() => {
      jest.clearAllMocks()
    })
    
    it('should find the latest EVT_DEAL event with Player.SeatIndex', async () => {
      const mockDealEvent = {
        ApiTypeId: ApiType.EVT_DEAL,
        Player: { SeatIndex: 2 },
        SeatUserIds: [1, 2, 3, 4]
      }

      // Create a chain mock object
      const mockChain: any = {
        equals: jest.fn(),
        reverse: jest.fn(),
        offset: jest.fn(),
        limit: jest.fn(),
        toArray: jest.fn().mockResolvedValue([mockDealEvent])
      }
      
      // Make each method return the chain
      mockChain.equals.mockReturnValue(mockChain)
      mockChain.reverse.mockReturnValue(mockChain)
      mockChain.offset.mockReturnValue(mockChain)
      mockChain.limit.mockReturnValue(mockChain)

      ;(mockDb.apiEvents.where as jest.Mock).mockReturnValue(mockChain)

      const result = await findLatestPlayerDealEvent(mockDb)

      expect(result).toEqual(mockDealEvent)
      expect(mockDb.apiEvents.where).toHaveBeenCalledWith('ApiTypeId')
      expect(mockChain.equals).toHaveBeenCalledWith(ApiType.EVT_DEAL)
      expect(mockChain.reverse).toHaveBeenCalled()
    })

    it('should skip events without Player.SeatIndex', async () => {
      const mockEvents = [
        { ApiTypeId: ApiType.EVT_DEAL }, // No Player field
        { ApiTypeId: ApiType.EVT_DEAL, Player: {} }, // No SeatIndex
        { ApiTypeId: ApiType.EVT_DEAL, Player: { SeatIndex: 1 } } // Valid
      ]

      const mockChain: any = {
        equals: jest.fn(),
        reverse: jest.fn(),
        offset: jest.fn(),
        limit: jest.fn(),
        toArray: jest.fn()
          .mockResolvedValueOnce(mockEvents.slice(0, 2))
          .mockResolvedValueOnce([mockEvents[2]])
      }
      
      // Make each method return the chain
      mockChain.equals.mockReturnValue(mockChain)
      mockChain.reverse.mockReturnValue(mockChain)
      mockChain.offset.mockReturnValue(mockChain)
      mockChain.limit.mockReturnValue(mockChain)

      ;(mockDb.apiEvents.where as jest.Mock).mockReturnValue(mockChain)

      const result = await findLatestPlayerDealEvent(mockDb, 2, 10)

      expect(result).toEqual(mockEvents[2])
      expect(mockChain.toArray).toHaveBeenCalledTimes(2)
    })

    it('should return undefined when no valid event found', async () => {
      const mockChain: any = {
        equals: jest.fn(),
        reverse: jest.fn(),
        offset: jest.fn(),
        limit: jest.fn(),
        toArray: jest.fn().mockResolvedValue([])
      }
      
      // Make each method return the chain
      mockChain.equals.mockReturnValue(mockChain)
      mockChain.reverse.mockReturnValue(mockChain)
      mockChain.offset.mockReturnValue(mockChain)
      mockChain.limit.mockReturnValue(mockChain)

      ;(mockDb.apiEvents.where as jest.Mock).mockReturnValue(mockChain)

      const result = await findLatestPlayerDealEvent(mockDb)

      expect(result).toBeUndefined()
    })

    it('should respect maxAttempts limit', async () => {
      const mockChain: any = {
        equals: jest.fn(),
        reverse: jest.fn(),
        offset: jest.fn(),
        limit: jest.fn(),
        toArray: jest.fn().mockResolvedValue([{ ApiTypeId: ApiType.EVT_DEAL }]) // No Player.SeatIndex
      }
      
      // Make each method return the chain
      mockChain.equals.mockReturnValue(mockChain)
      mockChain.reverse.mockReturnValue(mockChain)
      mockChain.offset.mockReturnValue(mockChain)
      mockChain.limit.mockReturnValue(mockChain)

      ;(mockDb.apiEvents.where as jest.Mock).mockReturnValue(mockChain)

      const result = await findLatestPlayerDealEvent(mockDb, 5, 20)

      expect(result).toBeUndefined()
      expect(mockChain.toArray).toHaveBeenCalledTimes(4) // 20 / 5 = 4 attempts
    })
  })

  describe('withTransaction', () => {
    it('should execute operation within transaction', async () => {
      const mockResult = { success: true }
      const mockOperation = jest.fn().mockResolvedValue(mockResult)
      const mockTables = [mockDb.hands, mockDb.phases]

      mockDb.transaction.mockImplementation((_mode: any, _tables: any, callback: any) => {
        return callback()
      })

      const result = await withTransaction(
        mockDb,
        'rw',
        mockTables,
        mockOperation,
        'TestContext'
      )

      expect(result).toEqual(mockResult)
      expect(mockDb.transaction).toHaveBeenCalledWith('rw', mockTables, mockOperation)
      expect(mockOperation).toHaveBeenCalled()
    })

    it('should handle QuotaExceededError', async () => {
      const quotaError = new Error('Storage quota exceeded')
      quotaError.name = 'QuotaExceededError'
      
      mockDb.transaction.mockRejectedValue(quotaError)

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation()

      await expect(
        withTransaction(mockDb, 'r', [], jest.fn(), 'TestContext')
      ).rejects.toThrow(quotaError)

      expect(consoleErrorSpy).toHaveBeenCalledWith('[TestContext] Transaction failed:', quotaError)
      expect(consoleErrorSpy).toHaveBeenCalledWith('[TestContext] Storage quota exceeded')

      consoleErrorSpy.mockRestore()
    })

    it('should handle ConstraintError', async () => {
      const constraintError = new Error('Constraint violation')
      constraintError.name = 'ConstraintError'
      
      mockDb.transaction.mockRejectedValue(constraintError)

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation()

      await expect(
        withTransaction(mockDb, 'rw', [], jest.fn(), 'TestContext')
      ).rejects.toThrow(constraintError)

      expect(consoleErrorSpy).toHaveBeenCalledWith('[TestContext] Database constraint violation')

      consoleErrorSpy.mockRestore()
    })

    it('should handle generic errors', async () => {
      const genericError = new Error('Something went wrong')
      
      mockDb.transaction.mockRejectedValue(genericError)

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation()

      await expect(
        withTransaction(mockDb, 'rw', [], jest.fn(), 'TestContext')
      ).rejects.toThrow(genericError)

      expect(consoleErrorSpy).toHaveBeenCalledWith('[TestContext] Transaction failed:', genericError)

      consoleErrorSpy.mockRestore()
    })
  })
})