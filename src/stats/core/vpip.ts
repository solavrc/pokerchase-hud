/**
 * VPIP - Voluntarily Put money In Pot
 * 
 * プリフロップで自発的にチップをポットに入れた頻度を測定します。
 * 
 * カウント対象:
 * - CALL: 相手のベット/レイズにコール
 * - RAISE: レイズ（リレイズ含む）
 * - ALL_IN: オールイン（app.tsでCALL/RAISEに変換されたもの）
 * 
 * 注意: ActionDetail.VPIPフラグはapp.tsで自動的に付与されます
 */

import type { StatDefinition, ActionDetailContext } from '../../types/stats'
import { PhaseType, ActionDetail, ActionType } from '../../types/game'
import { formatPercentage } from '../utils'

export const vpipStat: StatDefinition = {
  id: 'vpip',
  name: 'VPIP',
  description: 'プリフロップで自発的にポットに参加した割合',
  calculate: ({ actions, hands }) => {
    // ActionDetail.VPIPが付与されたアクションをカウント
    // このフラグは、プリフロップで最初のCALL/RAISEアクション時に付与される
    const voluntaryHandsCount = actions.filter(a => 
      a.phase === PhaseType.PREFLOP && 
      a.actionDetails.includes(ActionDetail.VPIP)
    ).length
    
    return [voluntaryHandsCount, hands.length]
  },
  format: formatPercentage,
  
  /**
   * VPIP判定ロジック
   * プリフロップで最初のCALL/RAISEアクション時にVPIPフラグを付与
   */
  detectActionDetails: (context: ActionDetailContext): ActionDetail[] => {
    const { phase, phasePlayerActionIndex, actionType } = context
    
    if (phase === PhaseType.PREFLOP && 
        phasePlayerActionIndex === 0 && 
        [ActionType.RAISE, ActionType.CALL].includes(actionType)) {
      return [ActionDetail.VPIP]
    }
    
    return []
  }
}