import { threeBetFoldStat } from './3bet-fold'
import { ActionType, PhaseType, ActionDetail } from '../../types/game'
import { makeAction, makeCalcContext } from './__test-helpers'
import type { ActionDetailContext } from '../../types/stats'

describe('threeBetFoldStat', () => {
  const createContext = (overrides: Partial<ActionDetailContext>): ActionDetailContext => ({
    playerId: 1,
    actionType: ActionType.FOLD,
    phase: PhaseType.PREFLOP,
    phasePlayerActionIndex: 0,
    phasePrevBetCount: 3,
    ...overrides
  })

  describe('detectActionDetails', () => {
    it('should detect 3BET_FOLD_CHANCE when facing 3bet (phasePrevBetCount=3)', () => {
      const details = threeBetFoldStat.detectActionDetails!(createContext({ phasePrevBetCount: 3 }))
      expect(details).toContain(ActionDetail.$3BET_FOLD_CHANCE)
    })

    it('should detect 3BET_FOLD when folding to 3bet', () => {
      const details = threeBetFoldStat.detectActionDetails!(createContext({
        phasePrevBetCount: 3,
        actionType: ActionType.FOLD
      }))
      expect(details).toContain(ActionDetail.$3BET_FOLD)
    })

    it('should NOT detect 3BET_FOLD when calling 3bet', () => {
      const details = threeBetFoldStat.detectActionDetails!(createContext({
        phasePrevBetCount: 3,
        actionType: ActionType.CALL
      }))
      expect(details).toContain(ActionDetail.$3BET_FOLD_CHANCE)
      expect(details).not.toContain(ActionDetail.$3BET_FOLD)
    })

    it('should NOT detect anything when not facing 3bet', () => {
      expect(threeBetFoldStat.detectActionDetails!(createContext({ phasePrevBetCount: 2 }))).toEqual([])
      expect(threeBetFoldStat.detectActionDetails!(createContext({ phasePrevBetCount: 1 }))).toEqual([])
      expect(threeBetFoldStat.detectActionDetails!(createContext({ phasePrevBetCount: 4 }))).toEqual([])
    })

    it('should NOT detect anything postflop', () => {
      const details = threeBetFoldStat.detectActionDetails!(createContext({
        phase: PhaseType.FLOP,
        phasePrevBetCount: 3
      }))
      expect(details).toEqual([])
    })
  })

  describe('calculate', () => {
    it('should count 3bet fold chances and folds', () => {
      const actions = [
        makeAction({ actionType: ActionType.FOLD, actionDetails: [ActionDetail.$3BET_FOLD_CHANCE, ActionDetail.$3BET_FOLD] }),
        makeAction({ actionType: ActionType.CALL, actionDetails: [ActionDetail.$3BET_FOLD_CHANCE] }),
      ]
      expect(threeBetFoldStat.calculate(makeCalcContext({ actions }))).toEqual([1, 2])
    })

    it('should return [0, 0] when never faced 3bet', () => {
      expect(threeBetFoldStat.calculate(makeCalcContext())).toEqual([0, 0])
    })
  })
})
