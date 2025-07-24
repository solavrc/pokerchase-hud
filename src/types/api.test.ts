import { 
  ApiType, 
  validateMessage, 
  isApplicationApiEvent, 
  validateApiEvent, 
  isApiEventType,
  getEventSchema,
  getAvailableEventTypes,
  getEventFields,
  parseEventWithSchema,
  apiEventSchemas,
  seatIndexSchema,
  playerBaseSchema
} from './api'

describe('API Validation Functions', () => {
  describe('validateMessage', () => {
    it('should return true for objects with ApiTypeId and timestamp', () => {
      expect(validateMessage({ ApiTypeId: 201, timestamp: 123456 }).success).toBe(true)
      expect(validateMessage({ ApiTypeId: 999, timestamp: 123456, data: 'test' }).success).toBe(true)
    })

    it('should return false for objects without ApiTypeId', () => {
      expect(validateMessage({}).success).toBe(false)
      expect(validateMessage({ id: 201 }).success).toBe(false)
      expect(validateMessage(null).success).toBe(false)
      expect(validateMessage(undefined).success).toBe(false)
      expect(validateMessage('string').success).toBe(false)
      expect(validateMessage(123).success).toBe(false)
    })

    it('should return false for objects with non-number ApiTypeId', () => {
      expect(validateMessage({ ApiTypeId: '201', timestamp: 123456 }).success).toBe(false)
      expect(validateMessage({ ApiTypeId: null, timestamp: 123456 }).success).toBe(false)
      expect(validateMessage({ ApiTypeId: undefined, timestamp: 123456 }).success).toBe(false)
    })

    it('should return false for objects without timestamp', () => {
      expect(validateMessage({ ApiTypeId: 201 }).success).toBe(false)
    })
  })

  describe('validateApiEvent (known events)', () => {
    it('should return true for known event types', () => {
      // 最小限の有効なイベント構造を作成
      const entryEvent = {
        ApiTypeId: 201,
        BattleType: 0,
        Code: 0,
        Id: 'test',
        IsRetire: false
      }

      expect(validateApiEvent(entryEvent).success).toBe(true)
    })

    it('should return false for unknown event types', () => {
      expect(validateApiEvent({ ApiTypeId: 9999 }).success).toBe(false)
      expect(validateApiEvent({ ApiTypeId: 0 }).success).toBe(false)
      expect(validateApiEvent({ ApiTypeId: -1 }).success).toBe(false)
    })
  })

  describe('isApplicationApiEvent', () => {
    it('should return true for application events', () => {
      // 完全なイベント構造を作成
      const entryEvent = {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        BattleType: 0,
        Code: 0,
        Id: 'test',
        IsRetire: false
      }

      const dealEvent = {
        ApiTypeId: ApiType.EVT_DEAL,
        SeatUserIds: [1, 2, 3, 4],
        Game: {
          CurrentBlindLv: 1,
          NextBlindUnixSeconds: 123456,
          Ante: 50,
          SmallBlind: 100,
          BigBlind: 200,
          ButtonSeat: 0,
          SmallBlindSeat: 1,
          BigBlindSeat: 2
        },
        Player: {
          SeatIndex: 0,
          BetStatus: 1,
          HoleCards: [1, 2],
          Chip: 1000,
          BetChip: 0
        },
        OtherPlayers: [
          {
            SeatIndex: 1,
            Status: 0,
            BetStatus: 1,
            Chip: 1000,
            BetChip: 0
          }
        ],
        Progress: {
          Phase: 0,
          NextActionSeat: 0,
          NextActionTypes: [0],
          NextExtraLimitSeconds: 1,
          MinRaise: 200,
          Pot: 300,
          SidePot: []
        }
      }

      const actionEvent = {
        ApiTypeId: ApiType.EVT_ACTION,
        SeatIndex: 0,
        ActionType: 0,
        Chip: 1000,
        BetChip: 100,
        Progress: {
          Phase: 0,
          NextActionSeat: 1,
          NextActionTypes: [0],
          NextExtraLimitSeconds: 1,
          MinRaise: 200,
          Pot: 400,
          SidePot: []
        }
      }

      // デバッグ用：validateApiEventの結果を確認
      const entryResult = validateApiEvent(entryEvent)
      const dealResult = validateApiEvent(dealEvent)
      const actionResult = validateApiEvent(actionEvent)

      if (!entryResult.success) console.log('Entry validation error:', entryResult.error.issues)
      if (!dealResult.success) console.log('Deal validation error:', dealResult.error.issues)
      if (!actionResult.success) console.log('Action validation error:', actionResult.error.issues)

      expect(isApplicationApiEvent(entryEvent)).toBe(true)
      expect(isApplicationApiEvent(dealEvent)).toBe(true)
      expect(isApplicationApiEvent(actionEvent)).toBe(true)
    })

    it('should return false for non-application events', () => {
      const nonAppEvent1 = { ApiTypeId: 202, Code: 0 } as any // Known but not in ApiType enum

      expect(isApplicationApiEvent(nonAppEvent1)).toBe(false)
      // isApplicationApiEvent requires KnownApiEvent, so unknown events cannot be tested directly
    })
  })

  describe('validateApiEvent', () => {
    it('should successfully validate a valid EVT_DEAL event', () => {
      const validEvent = {
        ApiTypeId: ApiType.EVT_DEAL,
        timestamp: 1234567890,
        SeatUserIds: [123, 456, 789, -1],
        Game: {
          CurrentBlindLv: 1,
          NextBlindUnixSeconds: 1234567890,
          Ante: 50,
          SmallBlind: 100,
          BigBlind: 200,
          ButtonSeat: 0,
          SmallBlindSeat: 1,
          BigBlindSeat: 2
        },
        Player: {
          SeatIndex: 0,
          BetStatus: 1,
          HoleCards: [0, 1],
          Chip: 10000,
          BetChip: 0
        },
        OtherPlayers: [
          {
            SeatIndex: 1,
            Status: 0,
            BetStatus: 1,
            Chip: 10000,
            BetChip: 100
          }
        ],
        Progress: {
          Phase: 0,
          NextActionSeat: 2,
          NextActionTypes: [2, 3, 4],
          NextExtraLimitSeconds: 1,
          MinRaise: 200,
          Pot: 300,
          SidePot: []
        }
      }

      const result = validateApiEvent(validEvent)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.ApiTypeId).toBe(ApiType.EVT_DEAL)
      }
    })

    it('should fail validation for invalid event structure', () => {
      const invalidEvent = {
        ApiTypeId: ApiType.EVT_DEAL,
        // Missing required fields
      }

      const result = validateApiEvent(invalidEvent)
      expect(result.success).toBe(false)
    })

    it('should fail validation for unknown event type', () => {
      const unknownEvent = {
        ApiTypeId: 9999,
        data: 'test'
      }

      const result = validateApiEvent(unknownEvent)
      expect(result.success).toBe(false)
    })
  })

  describe('isApiEventType', () => {
    it('should correctly identify event types', () => {
      // 実際のイベント構造を作成（最小限のフィールドで）
      const dealEvent = {
        ApiTypeId: ApiType.EVT_DEAL,
        SeatUserIds: [1, 2, 3, 4],
        Game: {
          CurrentBlindLv: 1,
          NextBlindUnixSeconds: 123456,
          Ante: 50,
          SmallBlind: 100,
          BigBlind: 200,
          ButtonSeat: 0,
          SmallBlindSeat: 1,
          BigBlindSeat: 2
        },
        Player: {
          SeatIndex: 0,
          BetStatus: 1,
          HoleCards: [1, 2],
          Chip: 1000,
          BetChip: 0
        },
        OtherPlayers: [
          {
            SeatIndex: 1,
            Status: 0,
            BetStatus: 1,
            Chip: 1000,
            BetChip: 0
          }
        ],
        Progress: {
          Phase: 0,
          NextActionSeat: 0,
          NextActionTypes: [0],
          NextExtraLimitSeconds: 1,
          MinRaise: 200,
          Pot: 300,
          SidePot: []
        }
      }

      const actionEvent = {
        ApiTypeId: ApiType.EVT_ACTION,
        SeatIndex: 0,
        ActionType: 0,
        Chip: 1000,
        BetChip: 100,
        Progress: {
          Phase: 0,
          NextActionSeat: 1,
          NextActionTypes: [0],
          NextExtraLimitSeconds: 1,
          MinRaise: 200,
          Pot: 400,
          SidePot: []
        }
      }

      expect(isApiEventType(dealEvent, ApiType.EVT_DEAL)).toBe(true)
      expect(isApiEventType(actionEvent, ApiType.EVT_ACTION)).toBe(true)
    })

    it('should return false for mismatched types', () => {
      const dealEvent = {
        ApiTypeId: ApiType.EVT_DEAL,
        SeatUserIds: [],
        Game: {} as any,
        Player: {} as any,
        OtherPlayers: [
          {
            SeatIndex: 1,
            Status: 0,
            BetStatus: 1,
            Chip: 1000,
            BetChip: 0
          }
        ],
        Progress: {} as any
      }

      expect(isApiEventType(dealEvent, ApiType.EVT_ACTION)).toBe(false)
      expect(isApiEventType({ ApiTypeId: 999 }, ApiType.EVT_DEAL)).toBe(false)
    })
  })

  describe('getEventSchema', () => {
    it('should return schema for known event types', () => {
      const dealSchema = getEventSchema(ApiType.EVT_DEAL)
      expect(dealSchema).toBeDefined()
      expect(dealSchema).toBe(apiEventSchemas[ApiType.EVT_DEAL])
    })

    it('should return undefined for unknown event types', () => {
      const unknownSchema = getEventSchema(9999)
      expect(unknownSchema).toBeUndefined()
    })
  })

  describe('getAvailableEventTypes', () => {
    it('should return array of numeric event types', () => {
      const types = getAvailableEventTypes()
      expect(Array.isArray(types)).toBe(true)
      expect(types.length).toBeGreaterThan(0)
      expect(types).toContain(ApiType.EVT_DEAL)
      expect(types).toContain(ApiType.EVT_ACTION)
      expect(types.every(t => typeof t === 'number')).toBe(true)
    })
  })

  describe('getEventFields', () => {
    it('should return field names for known event types', () => {
      const fields = getEventFields(ApiType.EVT_ENTRY_QUEUED)
      expect(Array.isArray(fields)).toBe(true)
      // EVT_ENTRY_QUEUEDのフィールド確認（最低限timestampを含む）
      expect(fields).toContain('ApiTypeId')
      expect(fields).toContain('BattleType')
      expect(fields).toContain('Code')
    })

    it('should return empty array for unknown event types', () => {
      const fields = getEventFields(9999)
      expect(fields).toEqual([])
    })
  })

  describe('parseEventWithSchema', () => {
    it('should successfully parse valid event', () => {
      const validDealEvent = {
        ApiTypeId: ApiType.EVT_DEAL,
        SeatUserIds: [1, 2, 3, 4],
        Game: {
          CurrentBlindLv: 1,
          NextBlindUnixSeconds: 123456,
          Ante: 50,
          SmallBlind: 100,
          BigBlind: 200,
          ButtonSeat: 0,
          SmallBlindSeat: 1,
          BigBlindSeat: 2
        },
        Player: {
          SeatIndex: 0,
          BetStatus: 1,
          HoleCards: [1, 2],
          Chip: 1000,
          BetChip: 0
        },
        OtherPlayers: [
          {
            SeatIndex: 1,
            Status: 0,
            BetStatus: 1,
            Chip: 1000,
            BetChip: 0
          }
        ],
        Progress: {
          Phase: 0,
          NextActionSeat: 0,
          NextActionTypes: [0],
          NextExtraLimitSeconds: 1,
          MinRaise: 200,
          Pot: 300,
          SidePot: []
        }
      }

      const result = parseEventWithSchema(ApiType.EVT_DEAL, validDealEvent)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.ApiTypeId).toBe(ApiType.EVT_DEAL)
      }
    })

    it('should fail parsing invalid event', () => {
      const invalidEvent = {
        ApiTypeId: ApiType.EVT_DEAL,
        // Missing required fields
      }

      const result = parseEventWithSchema(ApiType.EVT_DEAL, invalidEvent)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBeDefined()
      }
    })

    it('should return error for unknown event type', () => {
      const result = parseEventWithSchema(9999 as ApiType, { test: 'data' })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBeDefined()
        expect(result.error.message).toContain('No schema found')
      }
    })
  })

  describe('Common Sub-Schemas', () => {
    it('should validate seat index correctly', () => {
      expect(seatIndexSchema.safeParse(0).success).toBe(true)
      expect(seatIndexSchema.safeParse(5).success).toBe(true)
      expect(seatIndexSchema.safeParse(6).success).toBe(false)
      expect(seatIndexSchema.safeParse(-1).success).toBe(false)
    })

    it('should validate player base schema', () => {
      const validPlayer = {
        SeatIndex: 0,
        BetStatus: 1,
        Chip: 1000,
        BetChip: 100
      }
      
      const result = playerBaseSchema.safeParse(validPlayer)
      expect(result.success).toBe(true)
    })
  })
})
