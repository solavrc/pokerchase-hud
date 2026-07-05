import { pfrStat } from './pfr'
import { ActionType, PhaseType } from '../../types/game'

describe('pfrStat', () => {
  describe('calculate', () => {
    const createCalculationContext = (actions: any[]) => ({
      playerId: 1,
      actions: actions,
      hands: [
        { id: 1, seatUserIds: [], winningPlayerIds: [], smallBlind: 0, bigBlind: 0, ante: 0, session: {} },
        { id: 2, seatUserIds: [], winningPlayerIds: [], smallBlind: 0, bigBlind: 0, ante: 0, session: {} },
        { id: 3, seatUserIds: [], winningPlayerIds: [], smallBlind: 0, bigBlind: 0, ante: 0, session: {} }
      ] as any,  // 3 hands
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

    it('should calculate PFR percentage correctly', () => {
      const mockActions = [
        // Hand 1: Preflop raise
        { handId: 1, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE },
        // Hand 1: Another raise in same hand (should count as same hand)
        { handId: 1, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE },
        // Hand 2: Preflop call (not a raise)
        { handId: 2, phase: PhaseType.PREFLOP, actionType: ActionType.CALL },
        // Hand 3: Preflop raise
        { handId: 3, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE },
        // Hand 3: Flop raise (not preflop)
        { handId: 3, phase: PhaseType.FLOP, actionType: ActionType.RAISE },
      ]
      
      const result = pfrStat.calculate(createCalculationContext(mockActions))
      
      expect(result).toEqual([2, 3])  // 2 hands with PFR out of 3 total hands
    })

    it('should return [0, hands] when no preflop raises', () => {
      const mockActions = [
        { handId: 1, phase: PhaseType.PREFLOP, actionType: ActionType.CALL },
        { handId: 2, phase: PhaseType.PREFLOP, actionType: ActionType.FOLD },
        { handId: 3, phase: PhaseType.FLOP, actionType: ActionType.RAISE },  // Not preflop
      ]
      
      const result = pfrStat.calculate(createCalculationContext(mockActions))
      
      expect(result).toEqual([0, 3])  // 0 PFR out of 3 hands
    })

    it('should count only unique hands', () => {
      const mockActions = [
        // Multiple raises in the same hand
        { handId: 1, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE },
        { handId: 1, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE },
        { handId: 1, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE },
      ]
      
      const result = pfrStat.calculate(createCalculationContext(mockActions))
      
      expect(result).toEqual([1, 3])  // Only 1 unique hand with raises
    })
  })

  describe('format', () => {
    it('should format as percentage', () => {
      const formatted = pfrStat.format!([20, 100])
      expect(formatted).toBe('20.0% (20/100)')
    })
  })

  // PT4/HM標準の分母（hands - walks, #115）: BBが一度もプリフロップアクションを
  // 行っていないハンド（真のウォーク、またはBBアクションスキップ）は機会から除外する。
  describe('calculate - walk exclusion (#115)', () => {
    const baseHand = { seatUserIds: [], winningPlayerIds: [], smallBlind: 0, bigBlind: 0, session: {} } as any
    const baseContext = (actions: any[], hands: any[]) => ({
      playerId: 1,
      actions,
      hands,
      phases: [],
      allPlayerActions: actions,
      allPlayerPhases: [],
      winningHandIds: new Set<number>(),
      session: { id: '1', battleType: 0, name: 'Test', players: new Map(), reset: () => {} }
    })

    it('should exclude a walk hand from the denominator for the BB', () => {
      const hands = [
        { id: 1, bigBlindUserId: 1, ...baseHand }, // walk: player 1 (BB) has no preflop action
        { id: 2, bigBlindUserId: 2, ...baseHand }, // player 1 is not BB here
      ]
      const actions = [
        { handId: 2, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE },
      ]
      const result = pfrStat.calculate(baseContext(actions, hands) as any)
      expect(result).toEqual([1, 1]) // hand 1 (walk) excluded from denominator
    })

    it('should still count a hand where the BB folded/called/raised preflop', () => {
      const hands = [
        { id: 1, bigBlindUserId: 1, ...baseHand },
      ]
      const actions = [
        { handId: 1, phase: PhaseType.PREFLOP, actionType: ActionType.CALL }, // BB acted, not a walk
      ]
      const result = pfrStat.calculate(baseContext(actions, hands) as any)
      expect(result).toEqual([0, 1]) // opportunity retained, just no PFR
    })

    it('should not exclude non-BB players', () => {
      const hands = [
        { id: 1, bigBlindUserId: 2, ...baseHand }, // player 1 is NOT the BB
      ]
      const result = pfrStat.calculate(baseContext([], hands) as any)
      expect(result).toEqual([0, 1]) // still counted as an opportunity
    })
  })
})