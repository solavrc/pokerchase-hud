import { cbetFoldStat } from './cbet-fold'
import { ActionType, ActionDetail } from '../../types/game'
import { makeAction, makeCalcContext } from './__test-helpers'

describe('cbetFoldStat', () => {
  describe('calculate', () => {
    it('should count CBetFold chances and folds', () => {
      const actions = [
        makeAction({ actionType: ActionType.FOLD, actionDetails: [ActionDetail.CBET_FOLD_CHANCE, ActionDetail.CBET_FOLD] }),
        makeAction({ actionType: ActionType.CALL, actionDetails: [ActionDetail.CBET_FOLD_CHANCE] }),
        makeAction({ actionType: ActionType.FOLD, actionDetails: [ActionDetail.CBET_FOLD_CHANCE, ActionDetail.CBET_FOLD] }),
      ]
      expect(cbetFoldStat.calculate(makeCalcContext({ actions }))).toEqual([2, 3])
    })

    it('should return [0, 0] when no CBetFold chances', () => {
      const actions = [
        makeAction({ actionType: ActionType.FOLD, actionDetails: [] }),
        makeAction({ actionType: ActionType.CALL, actionDetails: [ActionDetail.VPIP] }),
      ]
      expect(cbetFoldStat.calculate(makeCalcContext({ actions }))).toEqual([0, 0])
    })

    it('should return [0, N] when faced CBet but never folded', () => {
      const actions = [
        makeAction({ actionType: ActionType.CALL, actionDetails: [ActionDetail.CBET_FOLD_CHANCE] }),
        makeAction({ actionType: ActionType.RAISE, actionDetails: [ActionDetail.CBET_FOLD_CHANCE] }),
      ]
      expect(cbetFoldStat.calculate(makeCalcContext({ actions }))).toEqual([0, 2])
    })
  })
})
