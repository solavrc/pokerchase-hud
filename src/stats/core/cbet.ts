/**
 * CB - Continuation Bet
 */

import type { StatDefinition, ActionDetailContext } from '../../types/stats'
import { PhaseType, ActionDetail, ActionType } from '../../types/game'
import { formatPercentage } from '../utils'

export const cbetStat: StatDefinition = {
  id: 'cbet',
  name: 'CB',
  description: 'フロップコンティニュエーションベット率',
  calculate: ({ actions }) => {
    const flopCBChanceCount = actions.filter(a => 
      a.phase === PhaseType.FLOP && 
      a.actionDetails.includes(ActionDetail.CBET_CHANCE)
    ).length
    
    const flopCBCount = actions.filter(a => 
      a.phase === PhaseType.FLOP && 
      a.actionDetails.includes(ActionDetail.CBET)
    ).length
    
    return [flopCBCount, flopCBChanceCount]
  },
  format: formatPercentage,
  
  /**
   * CBet判定ロジック
   * 
   * CBet: A continuation bet is opening the betting on a street when you made the last bet or raise on the previous street.
   * Normally this means being the preflop raiser and opening the betting on the flop, but is extended to the turn and river while you retain the initiative.
   * You can only make a continuation bet on the turn if you made one on the flop; and on the river if you made one on the turn.
   */
  detectActionDetails: (context: ActionDetailContext): ActionDetail[] => {
    const { playerId, actionType, phase, phasePrevBetCount, handState } = context
    const details: ActionDetail[] = []
    
    if (phase !== PhaseType.PREFLOP && handState?.cBetter) {
      if (phasePrevBetCount === 0) {
        if (handState.cBetter === playerId) {
          details.push(ActionDetail.CBET_CHANCE)
          if (actionType === ActionType.BET) {
            details.push(ActionDetail.CBET)
          }
        }
      } else if (phasePrevBetCount === 1) {
        // CBetが行われた後のアクション（cBetterがまだ存在する = CBetが行われていない）
        // これはCBetではなく、他のプレイヤーがベットしたケース
        // CBetFoldの機会はない
      }
    }
    
    // CBetFoldの判定（CBetが実際に行われた後のみ、同一ストリートのみ）
    if (phase !== PhaseType.PREFLOP && handState?.cBetExecuted && handState?.cBetPhase === phase && phasePrevBetCount === 1) {
      // cBetExecutedがtrue = CBetが実際に実行された後の相手プレイヤーのアクション
      details.push(ActionDetail.CBET_FOLD_CHANCE)
      if (actionType === ActionType.FOLD) {
        details.push(ActionDetail.CBET_FOLD)
      }
    }
    
    return details
  },
  
  /**
   * HandState更新ロジック
   * PREFLOPでのRAISEを追跡し、cBetterを更新
   */
  updateHandState: (context: ActionDetailContext): void => {
    const { playerId, actionType, phase, phasePrevBetCount, handState } = context
    
    if (!handState) return
    
    if (phase === PhaseType.PREFLOP) {
      if (actionType === ActionType.RAISE) {
        handState.cBetter = playerId // PREFLOPで最後にRAISEしたプレイヤー
      }
    } else if (handState.cBetter) {
      if (phasePrevBetCount === 0) {
        if (handState.cBetter === playerId) {
          if (actionType === ActionType.BET) {
            // CBが実行された
            handState.cBetter = undefined
            handState.cBetExecuted = true
            handState.cBetPhase = phase
          } else {
            handState.cBetter = undefined // CB機会を逃した（cBetExecutedはfalseのまま）
          }
        } else {
          if (actionType === ActionType.BET) {
            handState.cBetter = undefined // 他のプレイヤーが先にベット
          }
        }
      }
    }
  }
}