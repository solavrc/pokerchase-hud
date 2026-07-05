import { afqStat } from './afq'
import { ActionType, PhaseType } from '../../types/game'
import { makeAction, makeCalcContext } from './__test-helpers'

describe('afqStat', () => {
  describe('calculate', () => {
    // makeAction()のデフォルトphaseはFLOP（ポストフロップ）のため、
    // 以下の既存ケースはPT4のポストフロップ限定定義でも値は変わらない。
    it('should compute AFq = aggressive / (aggressive + passive + fold)', () => {
      const actions = [
        makeAction({ actionType: ActionType.BET }),
        makeAction({ actionType: ActionType.RAISE }),
        makeAction({ actionType: ActionType.CALL }),
        makeAction({ actionType: ActionType.FOLD }),
        makeAction({ actionType: ActionType.CHECK }), // excluded
      ]
      expect(afqStat.calculate(makeCalcContext({ actions }))).toEqual([2, 4])
    })

    it('should exclude CHECK from denominator', () => {
      const actions = [
        makeAction({ actionType: ActionType.CHECK }),
        makeAction({ actionType: ActionType.CHECK }),
        makeAction({ actionType: ActionType.BET }),
      ]
      expect(afqStat.calculate(makeCalcContext({ actions }))).toEqual([1, 1])
    })

    it('should return [0, 0] with no relevant actions', () => {
      const actions = [makeAction({ actionType: ActionType.CHECK })]
      expect(afqStat.calculate(makeCalcContext({ actions }))).toEqual([0, 0])
    })

    it('should count FOLD in denominator but not numerator', () => {
      const actions = [makeAction({ actionType: ActionType.FOLD }), makeAction({ actionType: ActionType.FOLD })]
      expect(afqStat.calculate(makeCalcContext({ actions }))).toEqual([0, 2])
    })

    // PT4/HM3標準に合わせ、AFと同じくポストフロップのみをカウントする。
    it('should exclude preflop actions entirely (PT4 postflop-only definition)', () => {
      const actions = [
        makeAction({ phase: PhaseType.PREFLOP, actionType: ActionType.RAISE }), // excluded
        makeAction({ phase: PhaseType.PREFLOP, actionType: ActionType.FOLD }),  // excluded
        makeAction({ phase: PhaseType.FLOP, actionType: ActionType.BET }),
        makeAction({ phase: PhaseType.RIVER, actionType: ActionType.CALL }),
      ]
      expect(afqStat.calculate(makeCalcContext({ actions }))).toEqual([1, 2])
    })

    it('should return [0, 0] when only preflop actions exist', () => {
      const actions = [
        makeAction({ phase: PhaseType.PREFLOP, actionType: ActionType.RAISE }),
        makeAction({ phase: PhaseType.PREFLOP, actionType: ActionType.CALL }),
      ]
      expect(afqStat.calculate(makeCalcContext({ actions }))).toEqual([0, 0])
    })
  })

  describe('format', () => {
    it('should format as percentage', () => {
      expect(afqStat.format!([2, 4])).toBe('50.0% (2/4)')
    })

    it('should show dash when denominator is 0', () => {
      expect(afqStat.format!([0, 0])).toBe('-')
    })
  })
})
