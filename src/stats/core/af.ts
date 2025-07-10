/**
 * AF - Aggression Factor
 * 
 * アグレッションファクターは、パッシブなアクション（コール）に対する
 * アグレッシブなアクション（ベット・レイズ）の比率を測定します。
 * 
 * 計算式: (BET + RAISE) / CALL
 * 
 * 注意:
 * - ALL_INはapp.tsで適切なアクションタイプ（BET/RAISE/CALL）に変換済み
 * - 値が高いほどアグレッシブ、低いほどパッシブなプレイスタイル
 * - 分母が0の場合（コールなし）は計算不可
 */

import type { StatDefinition } from '../../types/stats'
import { ActionType } from '../../types/game'
import { formatFactor } from '../utils'

export const afStat: StatDefinition = {
  id: 'af',
  name: 'AF',
  description: 'アグレッションファクター（ベット・レイズ回数／コール回数）',
  calculate: ({ actions }) => {
    // アグレッシブなアクション（BET, RAISE）をカウント
    // ALL_INがBET/RAISEに変換されたものも含まれる
    const betRaiseCount = actions.filter(a => 
      [ActionType.BET, ActionType.RAISE].includes(a.actionType)
    ).length
    
    // パッシブなアクション（CALL）をカウント
    // ALL_INがCALLに変換されたものも含まれる
    const callCount = actions.filter(a => 
      a.actionType === ActionType.CALL
    ).length
    
    return [betRaiseCount, callCount]
  },
  format: formatFactor
}