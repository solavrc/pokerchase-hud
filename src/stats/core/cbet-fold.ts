/**
 * CBF - Fold to Continuation Bet
 */

import type { StatDefinition } from '../../types/stats'
import { ActionDetail } from '../../types/game'
import { formatPercentage } from '../utils'

export const cbetFoldStat: StatDefinition = {
  id: 'cbetFold',
  name: 'CBF',
  description: 'フロップコンティニュエーションベットに対するフォールド率',
  calculate: ({ actions }) => {
    const cbetFoldChanceCount = actions.filter(a => 
      a.actionDetails.includes(ActionDetail.CBET_FOLD_CHANCE)
    ).length
    
    const cbetFoldCount = actions.filter(a => 
      a.actionDetails.includes(ActionDetail.CBET_FOLD)
    ).length
    
    return [cbetFoldCount, cbetFoldChanceCount]
  },
  format: formatPercentage
  // CBetFoldの判定はCBetモジュール内で統合管理
}