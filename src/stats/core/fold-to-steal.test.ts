import { foldToStealStat } from './fold-to-steal'
import { ActionDetail, ActionType, PhaseType, Position } from '../../types/game'
import { makeAction, makeCalcContext } from './__test-helpers'
import type { ActionDetailContext } from '../../types/stats'

describe('foldToStealStat', () => {
  const createContext = (overrides: Partial<ActionDetailContext>): ActionDetailContext => ({
    playerId: 2,
    actionType: ActionType.CALL,
    phase: PhaseType.PREFLOP,
    phasePlayerActionIndex: 0,
    phasePrevBetCount: 2,
    position: Position.BB,
    handState: {
      actions: [],
      stealRaiser: 1
    },
    ...overrides
  })

  describe('detectActionDetails', () => {
    it('should detect fold-to-steal chance when a blind faces a steal raise', () => {
      const details = foldToStealStat.detectActionDetails!(createContext({
        position: Position.BB,
        actionType: ActionType.CALL
      }))

      expect(details).toContain(ActionDetail.FOLD_TO_STEAL_CHANCE)
      expect(details).not.toContain(ActionDetail.FOLD_TO_STEAL)
    })

    it('should detect fold-to-steal when a blind folds to a steal raise', () => {
      const details = foldToStealStat.detectActionDetails!(createContext({
        position: Position.SB,
        actionType: ActionType.FOLD
      }))

      expect(details).toContain(ActionDetail.FOLD_TO_STEAL_CHANCE)
      expect(details).toContain(ActionDetail.FOLD_TO_STEAL)
    })

    it('should not detect fold-to-steal without a remembered steal raiser', () => {
      const details = foldToStealStat.detectActionDetails!(createContext({
        handState: {
          actions: []
        },
        actionType: ActionType.FOLD
      }))

      expect(details).toEqual([])
    })

    it('should not detect fold-to-steal outside blinds or when facing a 3-bet', () => {
      expect(foldToStealStat.detectActionDetails!(createContext({
        position: Position.BTN,
        actionType: ActionType.FOLD
      }))).toEqual([])

      expect(foldToStealStat.detectActionDetails!(createContext({
        phasePrevBetCount: 3,
        actionType: ActionType.FOLD
      }))).toEqual([])
    })
  })

  describe('calculate', () => {
    it('should count fold-to-steal chances and folds', () => {
      const actions = [
        makeAction({ actionType: ActionType.FOLD, actionDetails: [ActionDetail.FOLD_TO_STEAL_CHANCE, ActionDetail.FOLD_TO_STEAL] }),
        makeAction({ actionType: ActionType.CALL, actionDetails: [ActionDetail.FOLD_TO_STEAL_CHANCE] }),
        makeAction({ actionType: ActionType.RAISE, actionDetails: [] })
      ]

      expect(foldToStealStat.calculate(makeCalcContext({ actions }))).toEqual([1, 2])
    })

    it('should return [0, 0] when there are no fold-to-steal chances', () => {
      expect(foldToStealStat.calculate(makeCalcContext())).toEqual([0, 0])
    })
  })
})
