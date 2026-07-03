/**
 * FTS - Fold to Steal
 */

import type { StatDefinition, ActionDetailContext } from '../../types/stats'
import { ActionDetail, ActionType, PhaseType, Position } from '../../types/game'
import { formatPercentage } from '../utils'

const BLIND_POSITIONS = new Set<Position>([Position.SB, Position.BB])

function isFacingSteal(context: ActionDetailContext): boolean {
  return (
    context.phase === PhaseType.PREFLOP &&
    context.phasePrevBetCount === 2 &&
    context.position !== undefined &&
    BLIND_POSITIONS.has(context.position) &&
    context.handState?.stealRaiser !== undefined &&
    context.handState.stealRaiser !== context.playerId
  )
}

export const foldToStealStat: StatDefinition = {
  id: 'foldToSteal',
  name: 'FTS',
  description: 'スチールに対するフォールド率',
  calculate: ({ actions }) => {
    const foldToStealChanceCount = actions.filter(a =>
      a.actionDetails.includes(ActionDetail.FOLD_TO_STEAL_CHANCE)
    ).length

    const foldToStealCount = actions.filter(a =>
      a.actionDetails.includes(ActionDetail.FOLD_TO_STEAL)
    ).length

    return [foldToStealCount, foldToStealChanceCount]
  },
  format: formatPercentage,

  /**
   * Fold to Steal判定ロジック
   * スチールレイズに対してブラインドがフォールドできる場面を判定します。
   */
  detectActionDetails: (context: ActionDetailContext): ActionDetail[] => {
    const details: ActionDetail[] = []

    if (isFacingSteal(context)) {
      details.push(ActionDetail.FOLD_TO_STEAL_CHANCE)
      if (context.actionType === ActionType.FOLD) {
        details.push(ActionDetail.FOLD_TO_STEAL)
      }
    }

    return details
  }
}
