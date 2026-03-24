import { afStat } from './af'
import { ActionType } from '../../types/game'
import { makeAction, makeCalcContext } from './__test-helpers'

describe('afStat', () => {
  describe('calculate', () => {
    it('should compute AF = [aggressive, passive] counts', () => {
      const actions = [
        makeAction({ actionType: ActionType.BET }),
        makeAction({ actionType: ActionType.RAISE }),
        makeAction({ actionType: ActionType.CALL }),
        makeAction({ actionType: ActionType.CALL }),
        makeAction({ actionType: ActionType.CHECK }), // not counted
        makeAction({ actionType: ActionType.FOLD }),   // not counted
      ]
      const result = afStat.calculate(makeCalcContext({ actions }))
      expect(result).toEqual([2, 2])
    })

    it('should return [0, 0] with no actions', () => {
      expect(afStat.calculate(makeCalcContext())).toEqual([0, 0])
    })

    it('should handle all aggressive (no calls)', () => {
      const actions = [makeAction({ actionType: ActionType.BET }), makeAction({ actionType: ActionType.RAISE })]
      expect(afStat.calculate(makeCalcContext({ actions }))).toEqual([2, 0])
    })

    it('should handle all passive (no bets/raises)', () => {
      const actions = [makeAction({ actionType: ActionType.CALL }), makeAction({ actionType: ActionType.CALL })]
      expect(afStat.calculate(makeCalcContext({ actions }))).toEqual([0, 2])
    })
  })

  describe('format', () => {
    it('should format as factor ratio with counts', () => {
      expect(afStat.format!([4, 2])).toBe('2.00 (4/2)')
    })

    it('should show dash when no calls', () => {
      expect(afStat.format!([3, 0])).toBe('-')
    })

    it('should show 0.00 when no aggressive actions but has calls', () => {
      expect(afStat.format!([0, 5])).toBe('0.00 (0/5)')
    })
  })
})
