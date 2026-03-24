import { cbetStat } from './cbet'
import { ActionType, PhaseType, ActionDetail } from '../../types/game'
import { makeAction, makeCalcContext } from './__test-helpers'
import type { ActionDetailContext } from '../../types/stats'

describe('cbetStat', () => {
  const createContext = (overrides: Partial<ActionDetailContext>): ActionDetailContext => ({
    playerId: 1,
    actionType: ActionType.CHECK,
    phase: PhaseType.FLOP,
    phasePlayerActionIndex: 0,
    phasePrevBetCount: 0,
    handState: {},
    ...overrides
  })

  describe('detectActionDetails', () => {
    it('should detect CBET_CHANCE + CBET when PFR bets on flop', () => {
      const details = cbetStat.detectActionDetails!(createContext({
        playerId: 1,
        actionType: ActionType.BET,
        phasePrevBetCount: 0,
        handState: { cBetter: 1 }
      }))
      expect(details).toContain(ActionDetail.CBET_CHANCE)
      expect(details).toContain(ActionDetail.CBET)
    })

    it('should detect CBET_CHANCE but not CBET when PFR checks', () => {
      const details = cbetStat.detectActionDetails!(createContext({
        playerId: 1,
        actionType: ActionType.CHECK,
        phasePrevBetCount: 0,
        handState: { cBetter: 1 }
      }))
      expect(details).toContain(ActionDetail.CBET_CHANCE)
      expect(details).not.toContain(ActionDetail.CBET)
    })

    it('should not detect CBET for non-PFR player', () => {
      const details = cbetStat.detectActionDetails!(createContext({
        playerId: 2,
        actionType: ActionType.BET,
        phasePrevBetCount: 0,
        handState: { cBetter: 1 }
      }))
      expect(details).toEqual([])
    })

    it('should not detect anything on preflop', () => {
      const details = cbetStat.detectActionDetails!(createContext({
        phase: PhaseType.PREFLOP,
        handState: { cBetter: 1 }
      }))
      expect(details).toEqual([])
    })

    it('should not detect CBET when someone already bet', () => {
      const details = cbetStat.detectActionDetails!(createContext({
        playerId: 1,
        actionType: ActionType.RAISE,
        phasePrevBetCount: 1,
        handState: { cBetter: 1 }
      }))
      expect(details).toEqual([])
    })
  })

  describe('CBetFold detection', () => {
    it('should detect CBET_FOLD_CHANCE after CBet was executed', () => {
      const details = cbetStat.detectActionDetails!(createContext({
        playerId: 2,
        actionType: ActionType.CALL,
        phasePrevBetCount: 1,
        handState: { cBetExecuted: true, cBetPhase: PhaseType.FLOP }
      }))
      expect(details).toContain(ActionDetail.CBET_FOLD_CHANCE)
      expect(details).not.toContain(ActionDetail.CBET_FOLD)
    })

    it('should detect CBET_FOLD when folding to CBet', () => {
      const details = cbetStat.detectActionDetails!(createContext({
        playerId: 2,
        actionType: ActionType.FOLD,
        phasePrevBetCount: 1,
        handState: { cBetExecuted: true, cBetPhase: PhaseType.FLOP }
      }))
      expect(details).toContain(ActionDetail.CBET_FOLD_CHANCE)
      expect(details).toContain(ActionDetail.CBET_FOLD)
    })

    it('should NOT detect CBetFold when CBet was not executed (PFR checked)', () => {
      const details = cbetStat.detectActionDetails!(createContext({
        playerId: 2,
        actionType: ActionType.FOLD,
        phasePrevBetCount: 1,
        handState: {}
      }))
      expect(details).not.toContain(ActionDetail.CBET_FOLD_CHANCE)
    })

    it('should NOT detect CBetFold on a different street than CBet', () => {
      const details = cbetStat.detectActionDetails!(createContext({
        playerId: 2,
        actionType: ActionType.FOLD,
        phase: PhaseType.TURN,
        phasePrevBetCount: 1,
        handState: { cBetExecuted: true, cBetPhase: PhaseType.FLOP }
      }))
      expect(details).not.toContain(ActionDetail.CBET_FOLD_CHANCE)
    })
  })

  describe('updateHandState', () => {
    it('should set cBetter on preflop RAISE', () => {
      const handState: any = {}
      cbetStat.updateHandState!(createContext({
        playerId: 3,
        actionType: ActionType.RAISE,
        phase: PhaseType.PREFLOP,
        handState
      }))
      expect(handState.cBetter).toBe(3)
    })

    it('should update cBetter to last raiser on preflop', () => {
      const handState: any = { cBetter: 1 }
      cbetStat.updateHandState!(createContext({
        playerId: 5,
        actionType: ActionType.RAISE,
        phase: PhaseType.PREFLOP,
        handState
      }))
      expect(handState.cBetter).toBe(5)
    })

    it('should clear cBetter and set cBetExecuted when PFR bets on flop', () => {
      const handState: any = { cBetter: 1 }
      cbetStat.updateHandState!(createContext({
        playerId: 1,
        actionType: ActionType.BET,
        phasePrevBetCount: 0,
        handState
      }))
      expect(handState.cBetter).toBeUndefined()
      expect(handState.cBetExecuted).toBe(true)
      expect(handState.cBetPhase).toBe(PhaseType.FLOP)
    })

    it('should clear cBetter without cBetExecuted when PFR checks', () => {
      const handState: any = { cBetter: 1 }
      cbetStat.updateHandState!(createContext({
        playerId: 1,
        actionType: ActionType.CHECK,
        phasePrevBetCount: 0,
        handState
      }))
      expect(handState.cBetter).toBeUndefined()
      expect(handState.cBetExecuted).toBeUndefined()
    })

    it('should clear cBetter when another player bets first', () => {
      const handState: any = { cBetter: 1 }
      cbetStat.updateHandState!(createContext({
        playerId: 2,
        actionType: ActionType.BET,
        phasePrevBetCount: 0,
        handState
      }))
      expect(handState.cBetter).toBeUndefined()
    })
  })

  describe('calculate', () => {
    it('should count CBet chances and executions', () => {
      const actions = [
        makeAction({ actionType: ActionType.BET, actionDetails: [ActionDetail.CBET_CHANCE, ActionDetail.CBET] }),
        makeAction({ actionType: ActionType.CHECK, actionDetails: [ActionDetail.CBET_CHANCE] }),
        makeAction({ actionType: ActionType.BET, actionDetails: [] }),
      ]
      expect(cbetStat.calculate(makeCalcContext({ actions }))).toEqual([1, 2])
    })
  })
})
