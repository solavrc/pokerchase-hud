import { wwsfNoAiStat } from './wwsf-no-ai'
import { ActionType, PhaseType } from '../../types/game'
import { makeAction, makeCalcContext } from './__test-helpers'

describe('wwsfNoAiStat', () => {
  it('is disabled by default (opt-in variant)', () => {
    expect(wwsfNoAiStat.enabled).toBe(false)
  })

  describe('calculate', () => {
    it('should compute WWSFa = wins / hands with a flop action (preflop all-ins excluded)', () => {
      const actions = [
        makeAction({ handId: 1, phase: PhaseType.FLOP, actionType: ActionType.CHECK }),
        makeAction({ handId: 2, phase: PhaseType.FLOP, actionType: ActionType.BET }),
        makeAction({ handId: 3, phase: PhaseType.FLOP, actionType: ActionType.CHECK }),
      ]
      const winningHandIds = new Set([1, 3])
      expect(wwsfNoAiStat.calculate(makeCalcContext({ actions, winningHandIds }))).toEqual([2, 3])
    })

    it('should return [0, 0] when the player never acted on the flop', () => {
      expect(wwsfNoAiStat.calculate(makeCalcContext())).toEqual([0, 0])
    })

    it('should exclude preflop all-in wins (no flop action taken)', () => {
      const actions = [
        makeAction({ handId: 1, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE }),
      ]
      const winningHandIds = new Set([1])
      expect(wwsfNoAiStat.calculate(makeCalcContext({ actions, winningHandIds }))).toEqual([0, 0])
    })

    it('should return [0, N] when saw flop (acted) but never won', () => {
      const actions = [
        makeAction({ handId: 1, phase: PhaseType.FLOP, actionType: ActionType.CHECK }),
        makeAction({ handId: 2, phase: PhaseType.FLOP, actionType: ActionType.CHECK }),
      ]
      expect(wwsfNoAiStat.calculate(makeCalcContext({ actions }))).toEqual([0, 2])
    })

    it('should count multiple flop actions in the same hand once', () => {
      const actions = [
        makeAction({ handId: 1, phase: PhaseType.FLOP, actionType: ActionType.CHECK }),
        makeAction({ handId: 1, phase: PhaseType.TURN, actionType: ActionType.BET }),
      ]
      const winningHandIds = new Set([1])
      expect(wwsfNoAiStat.calculate(makeCalcContext({ actions, winningHandIds }))).toEqual([1, 1])
    })
  })
})
