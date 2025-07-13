import {
  isVoluntaryAction,
  isFacing2Bet,
  isFacing3Bet,
  isAggressiveAction,
  isPassiveAction,
  wasPreflopRaiser,
  isCBetOpportunity,
  getStreetName,
  getBetLevel,
  ActionPatterns
} from './helpers'
import { ActionType, PhaseType } from '../types/game'
import type { ActionDetailContext } from '../types/stats'

describe('Statistics Helpers', () => {
  const createContext = (overrides: Partial<ActionDetailContext>): ActionDetailContext => ({
    playerId: 1,
    actionType: ActionType.CALL,
    phase: PhaseType.PREFLOP,
    phasePlayerActionIndex: 0,
    phasePrevBetCount: 1,
    ...overrides
  })

  describe('isVoluntaryAction', () => {
    it('should return true for non-forced preflop actions', () => {
      const context = createContext({ phasePlayerActionIndex: 1 })
      expect(isVoluntaryAction(context)).toBe(true)
    })

    it('should return false for forced bets (index 0)', () => {
      const context = createContext({ phasePlayerActionIndex: 0 })
      expect(isVoluntaryAction(context)).toBe(false)
    })

    it('should return false for postflop actions', () => {
      const context = createContext({ 
        phase: PhaseType.FLOP,
        phasePlayerActionIndex: 1 
      })
      expect(isVoluntaryAction(context)).toBe(false)
    })
  })

  describe('isFacing2Bet', () => {
    it('should return true when phasePrevBetCount is 2', () => {
      const context = createContext({ phasePrevBetCount: 2 })
      expect(isFacing2Bet(context)).toBe(true)
    })

    it('should return false for other bet counts', () => {
      expect(isFacing2Bet(createContext({ phasePrevBetCount: 1 }))).toBe(false)
      expect(isFacing2Bet(createContext({ phasePrevBetCount: 3 }))).toBe(false)
    })

    it('should return false postflop', () => {
      const context = createContext({ 
        phase: PhaseType.FLOP,
        phasePrevBetCount: 2 
      })
      expect(isFacing2Bet(context)).toBe(false)
    })
  })

  describe('isFacing3Bet', () => {
    it('should return true when phasePrevBetCount is 3', () => {
      const context = createContext({ phasePrevBetCount: 3 })
      expect(isFacing3Bet(context)).toBe(true)
    })

    it('should return false for other bet counts', () => {
      expect(isFacing3Bet(createContext({ phasePrevBetCount: 2 }))).toBe(false)
      expect(isFacing3Bet(createContext({ phasePrevBetCount: 4 }))).toBe(false)
    })
  })

  describe('isAggressiveAction', () => {
    it('should return true for BET and RAISE', () => {
      expect(isAggressiveAction(ActionType.BET)).toBe(true)
      expect(isAggressiveAction(ActionType.RAISE)).toBe(true)
    })

    it('should return false for passive actions', () => {
      expect(isAggressiveAction(ActionType.CALL)).toBe(false)
      expect(isAggressiveAction(ActionType.CHECK)).toBe(false)
      expect(isAggressiveAction(ActionType.FOLD)).toBe(false)
    })
  })

  describe('isPassiveAction', () => {
    it('should return true for CALL and CHECK', () => {
      expect(isPassiveAction(ActionType.CALL)).toBe(true)
      expect(isPassiveAction(ActionType.CHECK)).toBe(true)
    })

    it('should return false for aggressive actions', () => {
      expect(isPassiveAction(ActionType.BET)).toBe(false)
      expect(isPassiveAction(ActionType.RAISE)).toBe(false)
      expect(isPassiveAction(ActionType.FOLD)).toBe(false)
    })
  })

  describe('wasPreflopRaiser', () => {
    it('should return true when player was last aggressor', () => {
      const context = createContext({
        playerId: 123,
        handState: { lastAggressor: 123 }
      })
      expect(wasPreflopRaiser(context)).toBe(true)
    })

    it('should return false when player was not last aggressor', () => {
      const context = createContext({
        playerId: 123,
        handState: { lastAggressor: 456 }
      })
      expect(wasPreflopRaiser(context)).toBe(false)
    })

    it('should return false when no handState', () => {
      const context = createContext({ playerId: 123 })
      expect(wasPreflopRaiser(context)).toBe(false)
    })
  })

  describe('isCBetOpportunity', () => {
    it('should return true for first postflop action by PFR', () => {
      const context = createContext({
        phase: PhaseType.FLOP,
        phasePlayerActionIndex: 0,
        playerId: 123,
        handState: { lastAggressor: 123 }
      })
      expect(isCBetOpportunity(context)).toBe(true)
    })

    it('should return false preflop', () => {
      const context = createContext({
        phase: PhaseType.PREFLOP,
        phasePlayerActionIndex: 0,
        playerId: 123,
        handState: { lastAggressor: 123 }
      })
      expect(isCBetOpportunity(context)).toBe(false)
    })

    it('should return false for non-first action', () => {
      const context = createContext({
        phase: PhaseType.FLOP,
        phasePlayerActionIndex: 1,
        playerId: 123,
        handState: { lastAggressor: 123 }
      })
      expect(isCBetOpportunity(context)).toBe(false)
    })
  })

  describe('getStreetName', () => {
    it('should return correct street names', () => {
      expect(getStreetName(PhaseType.PREFLOP)).toBe('Preflop')
      expect(getStreetName(PhaseType.FLOP)).toBe('Flop')
      expect(getStreetName(PhaseType.TURN)).toBe('Turn')
      expect(getStreetName(PhaseType.RIVER)).toBe('River')
      expect(getStreetName(PhaseType.SHOWDOWN)).toBe('Showdown')
    })
  })

  describe('getBetLevel', () => {
    it('should calculate correct bet level', () => {
      expect(getBetLevel(1)).toBe(2)  // BB + 1 = 2-bet
      expect(getBetLevel(2)).toBe(3)  // 2-bet + 1 = 3-bet
      expect(getBetLevel(3)).toBe(4)  // 3-bet + 1 = 4-bet
    })
  })

  describe('ActionPatterns', () => {
    describe('createOpportunityPattern', () => {
      const pattern = ActionPatterns.createOpportunityPattern(
        'TEST',
        (ctx) => ctx.phasePrevBetCount === 2,
        (ctx) => ctx.actionType === ActionType.RAISE
      )

      it('should detect opportunity only', () => {
        const context = createContext({ 
          phasePrevBetCount: 2,
          actionType: ActionType.CALL 
        })
        expect(pattern(context)).toEqual(['TEST_OPPORTUNITY'])
      })

      it('should detect both opportunity and occurrence', () => {
        const context = createContext({ 
          phasePrevBetCount: 2,
          actionType: ActionType.RAISE 
        })
        expect(pattern(context)).toEqual(['TEST_OPPORTUNITY', 'TEST'])
      })

      it('should return empty array when no opportunity', () => {
        const context = createContext({ phasePrevBetCount: 1 })
        expect(pattern(context)).toEqual([])
      })
    })

    describe('createFacingPattern', () => {
      const pattern = ActionPatterns.createFacingPattern(
        'THREBET',
        (ctx) => ctx.phasePrevBetCount === 3,
        ActionType.FOLD
      )

      it('should detect facing only', () => {
        const context = createContext({ 
          phasePrevBetCount: 3,
          actionType: ActionType.CALL 
        })
        expect(pattern(context)).toEqual(['THREBET_FACING'])
      })

      it('should detect both facing and response', () => {
        const context = createContext({ 
          phasePrevBetCount: 3,
          actionType: ActionType.FOLD 
        })
        expect(pattern(context)).toEqual(['THREBET_FACING', 'THREBET_FOLD'])
      })

      it('should return empty array when not facing', () => {
        const context = createContext({ phasePrevBetCount: 2 })
        expect(pattern(context)).toEqual([])
      })
    })
  })
})