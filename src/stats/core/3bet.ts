/**
 * 3B - 3-Bet
 */

import type { StatDefinition, ActionDetailContext } from '../../types/stats'
import { ActionDetail, ActionType } from '../../types/game'
import { formatPercentage } from '../utils'

export const threeBetStat: StatDefinition = {
  id: '3bet',
  name: '3B',
  description: 'スリーベット率',
  calculate: ({ actions }) => {
    const threeBetChanceCount = actions.filter(a => 
      a.actionDetails.includes(ActionDetail.$3BET_CHANCE)
    ).length
    
    const threeBetCount = actions.filter(a => 
      a.actionDetails.includes(ActionDetail.$3BET)
    ).length
    
    return [threeBetCount, threeBetChanceCount]
  },
  format: formatPercentage,
  
  /**
   * 3BET判定ロジック
   * 2ベット後のRAISEアクション時に3BETフラグを付与
   */
  detectActionDetails: (context: ActionDetailContext): ActionDetail[] => {
    const { phasePrevBetCount, actionType } = context
    const details: ActionDetail[] = []
    
    if (phasePrevBetCount === 2) {
      details.push(ActionDetail.$3BET_CHANCE)
      if (actionType === ActionType.RAISE) {
        details.push(ActionDetail.$3BET)
      }
    }
    
    return details
  }
}