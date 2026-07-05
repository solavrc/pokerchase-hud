import { wtsdNoAiStat } from './wtsd-no-ai'
import { ActionType, PhaseType } from '../../types/game'
import { makeAction, makePhase, makeCalcContext } from './__test-helpers'

describe('wtsdNoAiStat', () => {
  it('is disabled by default (opt-in variant)', () => {
    expect(wtsdNoAiStat.enabled).toBe(false)
  })

  describe('calculate', () => {
    it('should compute WTSDa = showdowns / hands with a flop action (preflop all-ins excluded)', () => {
      const actions = [
        makeAction({ handId: 1, phase: PhaseType.FLOP, actionType: ActionType.CHECK }),
        makeAction({ handId: 2, phase: PhaseType.FLOP, actionType: ActionType.BET }),
        makeAction({ handId: 3, phase: PhaseType.FLOP, actionType: ActionType.CHECK }),
      ]
      const phases = [
        makePhase(PhaseType.SHOWDOWN, 1),
        makePhase(PhaseType.SHOWDOWN, 3),
      ]
      expect(wtsdNoAiStat.calculate(makeCalcContext({ actions, phases }))).toEqual([2, 3])
    })

    it('should return [0, 0] when the player never acted on the flop', () => {
      expect(wtsdNoAiStat.calculate(makeCalcContext())).toEqual([0, 0])
    })

    it('should exclude preflop all-in hands even if a showdown phase exists (no flop action taken)', () => {
      // Preflop all-in: player has no FLOP-phase action, so hand is excluded from the base
      // even though a SHOWDOWN phase exists for that hand.
      const actions = [
        makeAction({ handId: 1, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE }),
      ]
      const phases = [
        makePhase(PhaseType.SHOWDOWN, 1),
      ]
      expect(wtsdNoAiStat.calculate(makeCalcContext({ actions, phases }))).toEqual([0, 0])
    })

    it('should count a flop action without reaching showdown as an opportunity only', () => {
      const actions = [
        makeAction({ handId: 1, phase: PhaseType.FLOP, actionType: ActionType.FOLD }),
      ]
      expect(wtsdNoAiStat.calculate(makeCalcContext({ actions }))).toEqual([0, 1])
    })

    it('should count multiple flop actions in the same hand once', () => {
      const actions = [
        makeAction({ handId: 1, phase: PhaseType.FLOP, actionType: ActionType.CHECK }),
        makeAction({ handId: 1, phase: PhaseType.TURN, actionType: ActionType.BET }),
      ]
      const phases = [makePhase(PhaseType.SHOWDOWN, 1)]
      expect(wtsdNoAiStat.calculate(makeCalcContext({ actions, phases }))).toEqual([1, 1])
    })
  })
})
