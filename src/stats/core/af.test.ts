import { afStat } from './af'
import { ActionType, PhaseType } from '../../types/game'
import { makeAction, makeCalcContext } from './__test-helpers'

describe('afStat', () => {
  describe('calculate', () => {
    // makeAction()のデフォルトphaseはFLOP（ポストフロップ）のため、
    // 以下の既存ケースはPT4のポストフロップ限定定義でも値は変わらない。
    it('should compute AF = [aggressive, passive] counts (postflop)', () => {
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

    // PT4公式定義: "Ratio of the times a player makes a POSTFLOP aggressive
    // action (bet or raise) to the times they call" — プリフロップのアクションは
    // 分子・分母のいずれからも除外される。
    it('should exclude preflop actions entirely (PT4 postflop-only definition)', () => {
      const actions = [
        makeAction({ phase: PhaseType.PREFLOP, actionType: ActionType.RAISE }), // excluded
        makeAction({ phase: PhaseType.PREFLOP, actionType: ActionType.CALL }),  // excluded
        makeAction({ phase: PhaseType.FLOP, actionType: ActionType.BET }),
        makeAction({ phase: PhaseType.TURN, actionType: ActionType.CALL }),
      ]
      expect(afStat.calculate(makeCalcContext({ actions }))).toEqual([1, 1])
    })

    it('should return [0, 0] when only preflop actions exist', () => {
      const actions = [
        makeAction({ phase: PhaseType.PREFLOP, actionType: ActionType.RAISE }),
        makeAction({ phase: PhaseType.PREFLOP, actionType: ActionType.CALL }),
      ]
      expect(afStat.calculate(makeCalcContext({ actions }))).toEqual([0, 0])
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
