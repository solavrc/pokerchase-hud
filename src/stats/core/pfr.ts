/**
 * PFR - Pre-Flop Raise
 * 
 * プリフロップでレイズした頻度を測定します。
 * 
 * カウント対象:
 * - RAISE: オープンレイズ、3ベット、4ベット等全てのレイズ
 * - ALL_IN: レイズとして変換されたオールイン（app.tsで自動変換）
 * 
 * 注意: 
 * - ALL_INアクションは、文脈に応じてapp.tsでRAISEに変換される場合があります
 * - 同一ハンドで複数回レイズしても1回としてカウント（getUniqueHandIds使用）
 */

import type { StatDefinition } from '../../types/stats'
import { PhaseType, ActionType } from '../../types/game'
import { getUniqueHandIds, formatPercentage } from '../utils'

export const pfrStat: StatDefinition = {
  id: 'pfr',
  name: 'PFR',
  description: 'プリフロップレイズ率',
  calculate: ({ actions, hands }) => {
    // プリフロップでRAISEアクションを行ったユニークなハンド数を取得
    // ALL_INがRAISEに変換されたものも自動的に含まれる
    const pfrHandsCount = getUniqueHandIds(
      actions.filter(a => 
        a.phase === PhaseType.PREFLOP && 
        a.actionType === ActionType.RAISE
      )
    )
    
    return [pfrHandsCount, hands.length]
  },
  format: formatPercentage
}