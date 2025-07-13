/**
 * 3BF - 3-Bet Fold
 */

import type { StatDefinition, ActionDetailContext } from '../../types/stats'
import { ActionDetail, ActionType } from '../../types/game'
import { formatPercentage } from '../utils'
import { isFacing3Bet } from '../helpers'

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
   * 3ベットに直面しているプレイヤーがFOLDする時の判定
   * phasePrevBetCount === 3 の時に3ベットに直面している
   */
  detectActionDetails: (context: ActionDetailContext): ActionDetail[] => {
    const details: ActionDetail[] = []
    
    // Use helper function for clarity
    if (isFacing3Bet(context)) {
      details.push(ActionDetail.$3BET_FOLD_CHANCE)
      if (context.actionType === ActionType.FOLD) {
        details.push(ActionDetail.$3BET_FOLD)
      }
    }
    
    return details
  }
}