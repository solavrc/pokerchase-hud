/**
 * W$SD - Won Money at Showdown
 */

import type { StatDefinition } from '../../types/stats'
import { PhaseType } from '../../types/game'
import { formatPercentage } from '../utils'
import { getWinnerIdentityUnprovenHandIds } from '../winner-eligibility'

export const wsdStat: StatDefinition = {
  id: 'wsd',
  name: 'W$SD',
  description: 'ショーダウン勝率',
  helpText: 'ショーダウンに進んだ際に勝った割合',
  calculate: ({ phases, winningHandIds, hands }) => {
    const unproven = getWinnerIdentityUnprovenHandIds(hands)
    const showdownPhases = phases.filter(p => p.phase === PhaseType.SHOWDOWN && !unproven.has(p.handId!))
    
    const wonAtShowdownCount = showdownPhases.filter(p => 
      p.handId && winningHandIds.has(p.handId)
    ).length
    
    return [wonAtShowdownCount, showdownPhases.length]
  },
  format: formatPercentage
}
