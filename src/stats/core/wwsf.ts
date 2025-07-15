/**
 * WWSF - Won When Saw Flop
 * 
 * フロップを見たハンドのうち、勝利した割合を計測します。
 * プリフロップオールインは除外されます（フロップ以降の意思決定がないため）。
 */

import type { StatDefinition } from '../../types/stats'
import { PhaseType } from '../../types/game'
import { formatPercentage } from '../utils'

export const wwsfStat: StatDefinition = {
  id: 'wwsf',
  name: 'WWSF',
  description: 'フロップ以降の勝率',
  calculate: ({ phases, winningHandIds }) => {
    // アクティブにフロップを見たハンド
    // （プリフロップオールインではFLOPフェーズが作成されないため、自動的に除外される）
    const flopPhases = phases.filter(p => p.phase === PhaseType.FLOP)
    
    // アクティブにフロップを見て勝利した回数
    const wonAfterFlopCount = flopPhases.filter(p => 
      p.handId && winningHandIds.has(p.handId)
    ).length
    
    return [wonAfterFlopCount, flopPhases.length]
  },
  format: formatPercentage
}