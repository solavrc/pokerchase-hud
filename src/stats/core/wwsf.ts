/**
 * WWSF - Won When Saw Flop
 */

import type { StatDefinition } from '../../types/stats'
import { PhaseType } from '../../types/game'
import { formatPercentage } from '../utils'

export const wwsfStat: StatDefinition = {
  id: 'wwsf',
  name: 'WWSF',
  description: 'フロップ以降の勝率',
  calculate: ({ phases, winningHandIds }) => {
    const flopPhases = phases.filter(p => p.phase === PhaseType.FLOP)
    
    const wonAfterFlopCount = flopPhases.filter(p => 
      p.handId && winningHandIds.has(p.handId)
    ).length
    
    return [wonAfterFlopCount, flopPhases.length]
  },
  format: formatPercentage
}