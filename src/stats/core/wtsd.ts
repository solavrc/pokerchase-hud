/**
 * WTSD - Went to Showdown
 */

import type { StatDefinition } from '../../types/stats'
import { PhaseType } from '../../types/game'
import { formatPercentage } from '../utils'

export const wtsdStat: StatDefinition = {
  id: 'wtsd',
  name: 'WTSD',
  description: 'ショーダウン率（フロップ以降）',
  calculate: ({ phases }) => {
    const showdownCount = phases.filter(p => 
      p.phase === PhaseType.SHOWDOWN
    ).length
    
    // Unique hands that saw flop
    const sawFlopHandIds = new Set(
      phases.filter(p => p.phase === PhaseType.FLOP).map(p => p.handId)
    )
    
    return [showdownCount, sawFlopHandIds.size]
  },
  format: formatPercentage
}