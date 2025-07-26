/**
 * RCA - River Call Accuracy
 * 
 * リバーでコールした際の勝率を計測します。
 * ブラフキャッチの精度を測定し、リバーでの判断力を評価します。
 */

import type { StatDefinition, ActionDetailContext } from '../../types/stats'
import { ActionDetail, ActionType, PhaseType } from '../../types/game'
import { formatPercentage } from '../utils'

export const riverCallAccuracyStat: StatDefinition = {
  id: 'riverCallAccuracy',
  name: 'RCA',
  description: 'リバーコール精度',
  calculate: ({ actions }) => {
    // リバーでコールしたアクション
    const riverCalls = actions.filter(a => 
      a.actionDetails.includes(ActionDetail.RIVER_CALL)
    )
    
    // リバーでコールして勝利したアクション
    const riverCallWins = actions.filter(a => 
      a.actionDetails.includes(ActionDetail.RIVER_CALL_WON)
    )
    
    return [riverCallWins.length, riverCalls.length]
  },
  format: formatPercentage,
  
  /**
   * RIVER_CALL判定ロジック
   * リバーでベットまたはレイズに対してコールした場合にマーク
   * 勝利判定はハンド終了時に追加
   */
  detectActionDetails: (context: ActionDetailContext): ActionDetail[] => {
    const details: ActionDetail[] = []
    
    // リバーでコールアクションの場合
    if (context.phase === PhaseType.RIVER && context.actionType === ActionType.CALL) {
      details.push(ActionDetail.RIVER_CALL)
    }
    
    return details
  }
}