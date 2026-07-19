/**
 * AF - Aggression Factor
 *
 * アグレッションファクターは、パッシブなアクション（コール）に対する
 * アグレッシブなアクション（ベット・レイズ）の比率を測定します。
 *
 * 計算式: (BET + RAISE) / CALL、ポストフロップ（フロップ以降）のアクションのみが対象。
 *
 * PT4公式定義（"Aggression Factor"）: "Ratio of the times a player makes a
 * POSTFLOP aggressive action (bet or raise) to the times they call"。
 * プリフロップのオープンレイズ等は含めない（2026-監査でHUD独自にプリフロップを
 * 含めていたことが判明し、PT4/HM3標準に合わせて修正）。
 *
 * 注意:
 * - ALL_INはapp.tsで適切なアクションタイプ（BET/RAISE/CALL）に変換済み
 * - 値が高いほどアグレッシブ、低いほどパッシブなプレイスタイル
 * - 分母が0の場合（コールなし）は計算不可
 */

import type { StatDefinition } from '../../types/stats'
import { ActionType, PhaseType } from '../../types/game'
import { formatFactor } from '../utils'

export const afStat: StatDefinition = {
  id: 'af',
  name: 'AF',
  description: 'アグレッションファクター（ポストフロップのベット・レイズ回数／コール回数）',
  helpText: 'ポストフロップの(ベット+レイズ)÷コール。高いほどアグレッシブ',
  calculate: ({ actions }) => {
    // ポストフロップ（フロップ以降）のアクションのみを対象とする（PT4公式定義）
    const postflopActions = actions.filter(a => a.phase !== PhaseType.PREFLOP)

    // アグレッシブなアクション（BET, RAISE）をカウント
    // ALL_INがBET/RAISEに変換されたものも含まれる
    const betRaiseCount = postflopActions.filter(a =>
      [ActionType.BET, ActionType.RAISE].includes(a.actionType)
    ).length

    // パッシブなアクション（CALL）をカウント
    // ALL_INがCALLに変換されたものも含まれる
    const callCount = postflopActions.filter(a =>
      a.actionType === ActionType.CALL
    ).length

    return [betRaiseCount, callCount]
  },
  format: formatFactor
}
