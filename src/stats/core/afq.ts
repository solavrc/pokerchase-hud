/**
 * AFq - Aggression Frequency
 * 
 * アグレッション頻度は、意思決定が必要な場面（チップを賭ける場面）での
 * アグレッシブなアクションの割合を測定します。
 * 
 * 計算式: (BET + RAISE) / (BET + RAISE + CALL + FOLD)
 * 
 * 注意点:
 * - CHECKは除外（無料のアクションのため）
 * - ALL_INは除外（app.tsで既にBET/RAISE/CALLに変換されているため）
 * - 実際にチップを賭ける意思決定場面でのアグレッション頻度を正確に反映
 */

import type { StatDefinition } from '../../types/stats'
import { ActionType } from '../../types/game'
import { formatPercentage } from '../utils'

export const afqStat: StatDefinition = {
  id: 'afq',
  name: 'AFq',
  description: 'アグレッション頻度（ベット・レイズ／ベット・レイズ・コール・フォールド）',
  calculate: ({ actions }) => {
    const betRaiseCount = actions.filter(a => 
      [ActionType.BET, ActionType.RAISE].includes(a.actionType)
    ).length
    
    // BET, RAISE, CALL, FOLDのみをカウント
    // ALL_INは既にapp.tsで適切なアクションタイプに変換済み
    const betRaiseCallFoldCount = actions.filter(a => 
      [ActionType.BET, ActionType.RAISE, ActionType.CALL, ActionType.FOLD].includes(a.actionType)
    ).length
    
    return [betRaiseCount, betRaiseCallFoldCount]
  },
  format: formatPercentage
}