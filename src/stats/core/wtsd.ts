/**
 * WTSD - Went to Showdown
 * 
 * フロップを見たハンドのうち、ショーダウンまで到達した割合を計測します。
 * プリフロップオールインは除外されます（フロップ以降の意思決定がないため）。
 */

import type { StatDefinition } from '../../types/stats'
import { PhaseType } from '../../types/game'
import { formatPercentage } from '../utils'

export const wtsdStat: StatDefinition = {
  id: 'wtsd',
  name: 'WTSD',
  description: 'ショーダウン率（フロップ以降）',
  calculate: ({ phases }) => {
    // アクティブにフロップを見たハンドID（プリフロップオールイン除外）
    const activeFlopHandIds = new Set(
      phases
        .filter(p => p.phase === PhaseType.FLOP)
        .map(p => p.handId)
    )
    
    // アクティブにショーダウンまで到達した回数
    // （フロップを見たハンドのうち、ショーダウンに到達したもののみカウント）
    const activeShowdownCount = phases
      .filter(p => 
        p.phase === PhaseType.SHOWDOWN && 
        p.handId && 
        activeFlopHandIds.has(p.handId)
      )
      .length
    
    return [activeShowdownCount, activeFlopHandIds.size]
  },
  format: formatPercentage
}