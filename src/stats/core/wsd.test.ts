import { wsdStat } from './wsd'
import { PhaseType } from '../../types/game'
import { makePhase, makeCalcContext } from './__test-helpers'

describe('wsdStat', () => {
  describe('calculate', () => {
    it('should compute W$SD = won at showdown / showdowns', () => {
      const phases = [
        makePhase(PhaseType.SHOWDOWN, 1),
        makePhase(PhaseType.SHOWDOWN, 2),
        makePhase(PhaseType.SHOWDOWN, 3),
      ]
      const winningHandIds = new Set([1, 3])
      expect(wsdStat.calculate(makeCalcContext({ phases, winningHandIds }))).toEqual([2, 3])
    })

    it('should return [0, 0] when no showdowns', () => {
      const phases = [makePhase(PhaseType.FLOP, 1), makePhase(PhaseType.TURN, 1)]
      expect(wsdStat.calculate(makeCalcContext({ phases }))).toEqual([0, 0])
    })

    it('should include preflop all-in showdowns (unlike WTSD)', () => {
      const phases = [
        makePhase(PhaseType.SHOWDOWN, 1),
        makePhase(PhaseType.SHOWDOWN, 2),
      ]
      expect(wsdStat.calculate(makeCalcContext({ phases, winningHandIds: new Set([1]) }))).toEqual([1, 2])
    })

    it('should return [0, N] when went to showdown but never won', () => {
      const phases = [makePhase(PhaseType.SHOWDOWN, 1), makePhase(PhaseType.SHOWDOWN, 2)]
      expect(wsdStat.calculate(makeCalcContext({ phases }))).toEqual([0, 2])
    })
  })

  describe('format', () => {
    it('should format as percentage', () => {
      expect(wsdStat.format!([2, 4])).toBe('50.0% (2/4)')
    })

    it('should show dash when no showdowns', () => {
      expect(wsdStat.format!([0, 0])).toBe('-')
    })
  })
})
