/**
 * 3B - 3-Bet
 */

import type { StatDefinition, ActionDetailContext } from '../../types/stats'
import { ActionDetail, ActionType, PhaseType } from '../../types/game'
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
   * プリフロップでのレイズ判定
   * phasePrevBetCount === 2 の時に3BETの機会となる
   * （1: BB, 2: 最初のレイズ（2ベット）後, 3: 2回目のレイズ（3ベット）後）
   */
  detectActionDetails: (context: ActionDetailContext): ActionDetail[] => {
    const { phasePrevBetCount, actionType, phase } = context
    const details: ActionDetail[] = []
    
    // プリフロップのみで判定、phasePrevBetCount === 2は2ベット後のアクション
    if (phase === PhaseType.PREFLOP && phasePrevBetCount === 2) {
      details.push(ActionDetail.$3BET_CHANCE)
      if (actionType === ActionType.RAISE) {
        details.push(ActionDetail.$3BET)
      }
    }
    
    return details
  }
}