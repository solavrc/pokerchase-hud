import { vpipStat } from './vpip'
import { ActionType, PhaseType, ActionDetail } from '../../types/game'
import type { ActionDetailContext } from '../../types/stats'

describe('vpipStat', () => {
  describe('detectActionDetails', () => {
    const createContext = (overrides: Partial<ActionDetailContext>): ActionDetailContext => ({
      playerId: 1,
      actionType: ActionType.FOLD,
      phase: PhaseType.PREFLOP,
      phasePlayerActionIndex: 0,
      phasePrevBetCount: 1,
      ...overrides
    })

    it('should detect VPIP on first preflop CALL', () => {
      const context = createContext({
        phasePlayerActionIndex: 0,
        actionType: ActionType.CALL
      })
      
      const details = vpipStat.detectActionDetails!(context)
      expect(details).toContain(ActionDetail.VPIP)
    })

    it('should detect VPIP on first preflop RAISE', () => {
      const context = createContext({
        phasePlayerActionIndex: 0,
        actionType: ActionType.RAISE
      })
      
      const details = vpipStat.detectActionDetails!(context)
      expect(details).toContain(ActionDetail.VPIP)
    })

    it('should not detect VPIP on FOLD', () => {
      const context = createContext({
        phasePlayerActionIndex: 0,
        actionType: ActionType.FOLD
      })
      
      const details = vpipStat.detectActionDetails!(context)
      expect(details).toEqual([])
    })

    it('should not detect VPIP on CHECK or BET', () => {
      expect(vpipStat.detectActionDetails!(createContext({
        actionType: ActionType.CHECK
      }))).toEqual([])
      
      expect(vpipStat.detectActionDetails!(createContext({
        actionType: ActionType.BET
      }))).toEqual([])
    })

    it('should not detect VPIP on second action', () => {
      const context = createContext({
        phasePlayerActionIndex: 1,
        actionType: ActionType.CALL
      })
      
      const details = vpipStat.detectActionDetails!(context)
      expect(details).toEqual([])
    })

    it('should not detect VPIP postflop', () => {
      const context = createContext({
        phase: PhaseType.FLOP,
        phasePlayerActionIndex: 0,
        actionType: ActionType.CALL
      })
      
      const details = vpipStat.detectActionDetails!(context)
      expect(details).toEqual([])
    })
  })

  describe('calculate', () => {
    const createCalculationContext = (actions: any[]) => ({
      playerId: 1,
      actions: actions,
      hands: [
        { id: 1, seatUserIds: [], winningPlayerIds: [], smallBlind: 0, bigBlind: 0, ante: 0, session: {} },
        { id: 2, seatUserIds: [], winningPlayerIds: [], smallBlind: 0, bigBlind: 0, ante: 0, session: {} }
      ] as any,  // 2 hands
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

    it('should calculate VPIP percentage correctly', () => {
      const mockActions = [
        { actionDetails: [ActionDetail.VPIP] },        // Hand 1: VPIP
        { actionDetails: [] },                         // Hand 2: No VPIP
        { actionDetails: [ActionDetail.VPIP] },        // Another VPIP (same hand counts once)
      ]
      
      const result = vpipStat.calculate(createCalculationContext(mockActions))
      
      expect(result).toEqual([2, 2])  // 2 VPIP actions out of 2 hands
    })

    it('should return [0, hands] when no VPIP', () => {
      const mockActions = [
        { actionDetails: [] },
        { actionDetails: [] },
      ]
      
      const result = vpipStat.calculate(createCalculationContext(mockActions))
      
      expect(result).toEqual([0, 2])  // 0 VPIP out of 2 hands
    })
  })

  describe('format', () => {
    it('should format as percentage', () => {
      const formatted = vpipStat.format!([1, 2])
      expect(formatted).toBe('50.0% (1/2)')
    })
  })
})