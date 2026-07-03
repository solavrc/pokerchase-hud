/**
 * STL - Attempt to Steal
 */

import type { StatDefinition, ActionDetailContext } from '../../types/stats'
import { ActionDetail, ActionType, PhaseType, Position } from '../../types/game'
import { formatPercentage } from '../utils'

const STEAL_POSITIONS = new Set<Position>([Position.CO, Position.BTN, Position.SB])

function isFoldedToLatePosition(context: ActionDetailContext): boolean {
  if (context.phase !== PhaseType.PREFLOP || context.phasePrevBetCount !== 1) {
    return false
  }

  if (context.position === undefined || !STEAL_POSITIONS.has(context.position)) {
    return false
  }

  const priorPreflopActions = context.handState?.actions?.filter(action => action.phase === PhaseType.PREFLOP) ?? []
  return priorPreflopActions.every(action => action.actionType === ActionType.FOLD)
}

export const stealStat: StatDefinition = {
  id: 'steal',
  name: 'STL',
  description: 'スチール試行率',
  calculate: ({ actions }) => {
    const stealChanceCount = actions.filter(a =>
      a.actionDetails.includes(ActionDetail.STEAL_CHANCE)
    ).length

    const stealCount = actions.filter(a =>
      a.actionDetails.includes(ActionDetail.STEAL)
    ).length

    return [stealCount, stealChanceCount]
  },
  format: formatPercentage,

  /**
   * スチール判定ロジック
   * CO/BTN/SBまでフォールドで回ってきたプリフロップのオープン機会を判定します。
   */
  detectActionDetails: (context: ActionDetailContext): ActionDetail[] => {
    const details: ActionDetail[] = []

    if (isFoldedToLatePosition(context)) {
      details.push(ActionDetail.STEAL_CHANCE)
      if (context.actionType === ActionType.RAISE) {
        details.push(ActionDetail.STEAL)
      }
    }

    return details
  },

  updateHandState: (context: ActionDetailContext): void => {
    if (!context.handState) return

    if (isFoldedToLatePosition(context) && context.actionType === ActionType.RAISE) {
      context.handState.stealRaiser = context.playerId
    }
  }
}
