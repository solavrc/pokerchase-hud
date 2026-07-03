import { stealStat } from './steal'
import { ActionDetail, ActionType, PhaseType, Position } from '../../types/game'
import { makeAction, makeCalcContext } from './__test-helpers'
import type { ActionDetailContext } from '../../types/stats'

describe('stealStat', () => {
  const createContext = (overrides: Partial<ActionDetailContext>): ActionDetailContext => ({
    playerId: 1,
    actionType: ActionType.FOLD,
    phase: PhaseType.PREFLOP,
    phasePlayerActionIndex: 0,
    phasePrevBetCount: 1,
    position: Position.BTN,
    handState: {
      actions: []
    },
    ...overrides
  })

  describe('detectActionDetails', () => {
    it('should detect steal chance when action is folded to late position preflop', () => {
      const details = stealStat.detectActionDetails!(createContext({
        position: Position.BTN,
        actionType: ActionType.FOLD
      }))

      expect(details).toContain(ActionDetail.STEAL_CHANCE)
      expect(details).not.toContain(ActionDetail.STEAL)
    })

    it('should detect steal when late position opens with a raise', () => {
      const details = stealStat.detectActionDetails!(createContext({
        position: Position.CO,
        actionType: ActionType.RAISE
      }))

      expect(details).toContain(ActionDetail.STEAL_CHANCE)
      expect(details).toContain(ActionDetail.STEAL)
    })

    it('should not detect steal after a preflop limp', () => {
      const details = stealStat.detectActionDetails!(createContext({
        position: Position.BTN,
        actionType: ActionType.RAISE,
        handState: {
          actions: [
            makeAction({
              phase: PhaseType.PREFLOP,
              actionType: ActionType.CALL,
              playerId: 2,
              position: Position.UTG
            })
          ]
        }
      }))

      expect(details).toEqual([])
    })

    it('should not detect steal outside late positions or postflop', () => {
      expect(stealStat.detectActionDetails!(createContext({
        position: Position.HJ,
        actionType: ActionType.RAISE
      }))).toEqual([])

      expect(stealStat.detectActionDetails!(createContext({
        phase: PhaseType.FLOP,
        position: Position.BTN,
        actionType: ActionType.RAISE,
        phasePrevBetCount: 0
      }))).toEqual([])
    })
  })

  describe('updateHandState', () => {
    it('should remember the steal raiser after a steal attempt', () => {
      const handState: any = {
        actions: []
      }

      stealStat.updateHandState!(createContext({
        playerId: 7,
        position: Position.SB,
        actionType: ActionType.RAISE,
        handState
      }))

      expect(handState.stealRaiser).toBe(7)
    })
  })

  describe('calculate', () => {
    it('should count steal chances and steal attempts', () => {
      const actions = [
        makeAction({ actionType: ActionType.FOLD, actionDetails: [ActionDetail.STEAL_CHANCE] }),
        makeAction({ actionType: ActionType.RAISE, actionDetails: [ActionDetail.STEAL_CHANCE, ActionDetail.STEAL] }),
        makeAction({ actionType: ActionType.CALL, actionDetails: [] })
      ]

      expect(stealStat.calculate(makeCalcContext({ actions }))).toEqual([1, 2])
    })

    it('should return [0, 0] when there are no steal chances', () => {
      expect(stealStat.calculate(makeCalcContext())).toEqual([0, 0])
    })
  })
})
