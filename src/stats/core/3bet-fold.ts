/**
 * 3BF - 3-Bet Fold
 */

import type { StatDefinition, ActionDetailContext } from '../../types/stats'
import { ActionDetail, ActionType } from '../../types/game'
import { formatPercentage } from '../utils'

export const threeBetFoldStat: StatDefinition = {
  id: '3betfold',
  name: '3BF',
  description: 'スリーベットに対するフォールド率',
  calculate: ({ actions }) => {
    const threeBetFoldChanceCount = actions.filter(a => 
      a.actionDetails.includes(ActionDetail.$3BET_FOLD_CHANCE)
    ).length
    
    const threeBetFoldCount = actions.filter(a => 
      a.actionDetails.includes(ActionDetail.$3BET_FOLD)
    ).length
    
    return [threeBetFoldCount, threeBetFoldChanceCount]
  },
  format: formatPercentage,
  
  /**
   * 3BET FOLD判定ロジック
   * 3ベット後のFOLDアクション時に3BET_FOLDフラグを付与
   */
  detectActionDetails: (context: ActionDetailContext): ActionDetail[] => {
    const { phasePrevBetCount, actionType } = context
    const details: ActionDetail[] = []
    
    if (phasePrevBetCount === 3) {
      details.push(ActionDetail.$3BET_FOLD_CHANCE)
      if (actionType === ActionType.FOLD) {
        details.push(ActionDetail.$3BET_FOLD)
      }
    }
    
    return details
  }
}