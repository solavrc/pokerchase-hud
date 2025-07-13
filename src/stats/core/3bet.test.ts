import { threeBetStat } from './3bet'
import { ActionType, PhaseType, ActionDetail } from '../../types/game'
import type { ActionDetailContext } from '../../types/stats'

describe('threeBetStat', () => {
  describe('detectActionDetails', () => {
    const createContext = (overrides: Partial<ActionDetailContext>): ActionDetailContext => ({
      playerId: 1,
      actionType: ActionType.CALL,
      phase: PhaseType.PREFLOP,
      phasePlayerActionIndex: 0,
      phasePrevBetCount: 1,
      ...overrides
    })

    it('should detect 3-bet opportunity when facing 2-bet', () => {
      const context = createContext({
        phasePrevBetCount: 2
      })
      
      const details = threeBetStat.detectActionDetails!(context)
      expect(details).toContain(ActionDetail.$3BET_CHANCE)
      expect(details).not.toContain(ActionDetail.$3BET)
    })

    it('should detect 3-bet when raising against 2-bet', () => {
      const context = createContext({
        phasePrevBetCount: 2,
        actionType: ActionType.RAISE
      })
      
      const details = threeBetStat.detectActionDetails!(context)
      expect(details).toContain(ActionDetail.$3BET_CHANCE)
      expect(details).toContain(ActionDetail.$3BET)
    })

    it('should not detect 3-bet opportunity when not facing 2-bet', () => {
      const context = createContext({
        phasePrevBetCount: 1  // Only BB posted
      })
      
      const details = threeBetStat.detectActionDetails!(context)
      expect(details).toEqual([])
    })

    it('should not detect 3-bet opportunity postflop', () => {
      const context = createContext({
        phase: PhaseType.FLOP,
        phasePrevBetCount: 2
      })
      
      const details = threeBetStat.detectActionDetails!(context)
      expect(details).toEqual([])
    })
  })

  describe('calculate', () => {
    const createCalculationContext = (actions: any[]) => ({
      playerId: 1,
      actions: actions,
      hands: [],
      phases: [],
      allPlayerActions: actions,
      allPlayerPhases: [],
      winningHandIds: new Set<number>(),
      session: { 
        id: '1', 
        battleType: 0, 
        name: 'Test',
        players: new Map(),
        reset: () => {}
      }
    })

    it('should calculate 3-bet percentage correctly', () => {
      const mockActions = [
        { actionDetails: [ActionDetail.$3BET_CHANCE] },
        { actionDetails: [ActionDetail.$3BET_CHANCE, ActionDetail.$3BET] },
        { actionDetails: [ActionDetail.$3BET_CHANCE] },
        { actionDetails: [] },  // Unrelated action
      ]
      
      const result = threeBetStat.calculate(createCalculationContext(mockActions))
      
      expect(result).toEqual([1, 3])  // 1 3-bet out of 3 opportunities
    })

    it('should return [0, 0] when no opportunities', () => {
      const result = threeBetStat.calculate(createCalculationContext([]))
      
      expect(result).toEqual([0, 0])
    })
  })

  describe('format', () => {
    it('should format as percentage', () => {
      const formatted = threeBetStat.format!([25, 100])
      expect(formatted).toBe('25.0% (25/100)')
    })
  })
})