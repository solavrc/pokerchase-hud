/**
 * VPIP - Voluntarily Put money In Pot
 * 
 * プリフロップで自発的にチップをポットに入れた頻度を測定します。
 * 
 * カウント対象:
 * - CALL: 相手のベット/レイズにコール
 * - RAISE: レイズ（リレイズ含む）
 * - ALL_IN: オールイン（ALL_INはWriteEntityStreamでCALL/RAISEに正規化されます）
 * 
 * 注意: 強制ベット（BB/SB）は含まれません
 */

import type { StatDefinition, ActionDetailContext } from '../../types/stats'
import { ActionDetail, ActionType, PhaseType } from '../../types/game'
import { formatPercentage } from '../utils'

export const vpipStat: StatDefinition = {
  id: 'vpip',
  name: 'VPIP',
  description: 'プリフロップで自発的にポットに参加した割合',
  calculate: ({ actions, hands }) => {
    // ActionDetail.VPIPが付与されたアクションをカウント
    // このフラグは、プリフロップで自発的なCALL/RAISEアクション時に付与される
    const voluntaryHandsCount = actions.filter(a => 
      a.actionDetails.includes(ActionDetail.VPIP)
    ).length
    
    return [voluntaryHandsCount, hands.length]
  },
  format: formatPercentage,
  
  /**
   * VPIP判定ロジック
   * プリフロップで最初のCALL/RAISEアクション時にVPIPフラグを付与
   * phasePlayerActionIndex === 0 はそのプレイヤーのフェーズ内最初のアクション
   * 
   * 注: 現在のコンテキストではBB/SBの区別ができないため、
   * すべてのプレイヤーの最初のCALL/RAISEをVPIPとしてカウントします
   */
  detectActionDetails: (context: ActionDetailContext): ActionDetail[] => {
    const { phase, phasePlayerActionIndex, actionType } = context
    
    // プリフロップで、そのプレイヤーの最初のアクションで、CALL/RAISEの場合
    if (phase === PhaseType.PREFLOP && 
        phasePlayerActionIndex === 0 && 
        [ActionType.RAISE, ActionType.CALL].includes(actionType)) {
      return [ActionDetail.VPIP]
    }
    
    return []
  }
}