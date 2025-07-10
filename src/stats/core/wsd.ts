/**
 * W$SD - Won Money at Showdown
 */

import type { StatDefinition } from '../../types/stats'
import { PhaseType } from '../../types/game'
import { formatPercentage } from '../utils'

export const wsdStat: StatDefinition = {
  id: 'wsd',
  name: 'W$SD',
  description: 'ショーダウン勝率',
  calculate: ({ phases, winningHandIds }) => {
    const showdownPhases = phases.filter(p => p.phase === PhaseType.SHOWDOWN)
    
    const wonAtShowdownCount = showdownPhases.filter(p => 
      p.handId && winningHandIds.has(p.handId)
    ).length
    
    return [wonAtShowdownCount, showdownPhases.length]
  },
  format: formatPercentage
}