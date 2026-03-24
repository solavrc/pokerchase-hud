import { wwsfStat } from './wwsf'
import { PhaseType } from '../../types/game'
import { makePhase, makeCalcContext } from './__test-helpers'

describe('wwsfStat', () => {
  describe('calculate', () => {
    it('should compute WWSF = won after flop / flops seen', () => {
      const phases = [
        makePhase(PhaseType.FLOP, 1),
        makePhase(PhaseType.FLOP, 2),
        makePhase(PhaseType.FLOP, 3),
      ]
      const winningHandIds = new Set([1, 3])
      expect(wwsfStat.calculate(makeCalcContext({ phases, winningHandIds }))).toEqual([2, 3])
    })

    it('should return [0, 0] when no flops seen', () => {
      expect(wwsfStat.calculate(makeCalcContext())).toEqual([0, 0])
    })

    it('should return [0, N] when saw flop but never won', () => {
      const phases = [makePhase(PhaseType.FLOP, 1), makePhase(PhaseType.FLOP, 2)]
      expect(wwsfStat.calculate(makeCalcContext({ phases }))).toEqual([0, 2])
    })

    it('should exclude preflop all-in wins (no flop phase)', () => {
      expect(wwsfStat.calculate(makeCalcContext({ winningHandIds: new Set([1]) }))).toEqual([0, 0])
    })

    it('should not count showdown-only phases', () => {
      const phases = [makePhase(PhaseType.SHOWDOWN, 1)]
      expect(wwsfStat.calculate(makeCalcContext({ phases, winningHandIds: new Set([1]) }))).toEqual([0, 0])
    })
  })
})
