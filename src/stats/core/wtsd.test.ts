import { wtsdStat } from './wtsd'
import { PhaseType } from '../../types/game'
import { makePhase, makeCalcContext } from './__test-helpers'

describe('wtsdStat', () => {
  describe('calculate', () => {
    it('should compute WTSD = showdowns / flops seen', () => {
      const phases = [
        makePhase(PhaseType.FLOP, 1),
        makePhase(PhaseType.SHOWDOWN, 1),
        makePhase(PhaseType.FLOP, 2),
        makePhase(PhaseType.FLOP, 3),
        makePhase(PhaseType.SHOWDOWN, 3),
      ]
      expect(wtsdStat.calculate(makeCalcContext({ phases }))).toEqual([2, 3])
    })

    it('should return [0, 0] when no flops seen', () => {
      expect(wtsdStat.calculate(makeCalcContext())).toEqual([0, 0])
    })

    it('should exclude preflop all-in showdowns (no flop phase)', () => {
      const phases = [
        makePhase(PhaseType.SHOWDOWN, 4),
        makePhase(PhaseType.FLOP, 5),
        makePhase(PhaseType.SHOWDOWN, 5),
      ]
      expect(wtsdStat.calculate(makeCalcContext({ phases }))).toEqual([1, 1])
    })

    it('should count flop without showdown as opportunity', () => {
      const phases = [makePhase(PhaseType.FLOP, 1), makePhase(PhaseType.FLOP, 2)]
      expect(wtsdStat.calculate(makeCalcContext({ phases }))).toEqual([0, 2])
    })
  })
})
