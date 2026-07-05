/**
 * AFq - Aggression Frequency
 *
 * アグレッション頻度は、意思決定が必要な場面（チップを賭ける場面）での
 * アグレッシブなアクションの割合を測定します。
 *
 * 計算式: (BET + RAISE) / (BET + RAISE + CALL + FOLD)、ポストフロップ
 * （フロップ以降）のアクションのみが対象。
 *
 * PT4公式定義に合わせ、AFと同様にポストフロップのみをカウントする
 * （"Ratio of the times a player makes a POSTFLOP aggressive action"の
 * 対象範囲をAFqにも適用）。2026-監査でHUD独自にプリフロップを含めていた
 * ことが判明し、PT4/HM3標準に合わせて修正。
 *
 * 注意点:
 * - CHECKは除外（無料のアクションのため）
 * - ALL_INは除外（app.tsで既にBET/RAISE/CALLに変換されているため）
 * - 実際にチップを賭ける意思決定場面でのアグレッション頻度を正確に反映
 */

import type { StatDefinition } from '../../types/stats'
import { ActionType, PhaseType } from '../../types/game'
import { formatPercentage } from '../utils'

export const afqStat: StatDefinition = {
  id: 'afq',
  name: 'AFq',
  description: 'アグレッション頻度（ポストフロップのベット・レイズ／ベット・レイズ・コール・フォールド）',
  calculate: ({ actions }) => {
    // ポストフロップ（フロップ以降）のアクションのみを対象とする（PT4公式定義）
    const postflopActions = actions.filter(a => a.phase !== PhaseType.PREFLOP)

    const betRaiseCount = postflopActions.filter(a =>
      [ActionType.BET, ActionType.RAISE].includes(a.actionType)
    ).length

    // BET, RAISE, CALL, FOLDのみをカウント
    // ALL_INは既にapp.tsで適切なアクションタイプに変換済み
    const betRaiseCallFoldCount = postflopActions.filter(a =>
      [ActionType.BET, ActionType.RAISE, ActionType.CALL, ActionType.FOLD].includes(a.actionType)
    ).length

    return [betRaiseCount, betRaiseCallFoldCount]
  },
  format: formatPercentage
}
