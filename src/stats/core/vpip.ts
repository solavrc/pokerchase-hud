/**
 * VPIP - Voluntarily Put money In Pot
 *
 * プリフロップで自発的にチップをポットに入れた頻度を測定します。
 *
 * カウント対象:
 * - CALL: 相手のベット/レイズにコール
 * - RAISE: レイズ（リレイズ含む）
 * - ALL_IN: オールイン（ALL_INはWriteEntityStreamでCALL/RAISEに正規化されます）
 *
 * 注意: 強制ベット（BB/SB）は含まれません
 *
 * 分母（機会数） - ウォーク除外（PT4/HM標準, #115）:
 * PT4/HM3の標準定義では、分母は「hands − walks」。ビッグブラインドを務めた
 * ハンドで、そのハンド中に一度もプリフロップアクションを行っていない場合
 * （＝真のウォーク、または他家が全員オールイン/フォールドしてBBのアクションが
 * スキップされた場合、docs/api-events.md「EVT_ACTION: 送信されないケース」参照）、BBには自発的な
 * プリフロップの意思決定機会が一切なかったことになるため、分母から除外する。
 * BB以外のプレイヤーがプリフロップでフォールドした場合は、意思決定を
 * 行った（フォールドを選んだ）ため、引き続き機会としてカウントする。
 */

import type { StatDefinition, ActionDetailContext } from '../../types/stats'
import { ActionDetail, ActionType, PhaseType } from '../../types/game'
import { formatPercentage } from '../utils'
import { countPreflopStatOpportunities } from '../preflop-trials'

export const vpipStat: StatDefinition = {
  id: 'vpip',
  name: 'VPIP',
  description: 'プリフロップで自発的にポットに参加した割合（ウォーク除外）',
  helpText: '自発的にチップをポットに入れたハンドの割合(ウォーク除外)',
  calculate: ({ playerId, actions, hands }) => {
    // ActionDetail.VPIPが付与されたアクションをカウント
    // このフラグは、プリフロップで自発的なCALL/RAISEアクション時に付与される
    const voluntaryHandsCount = actions.filter(a =>
      a.actionDetails.includes(ActionDetail.VPIP)
    ).length

    const opportunities = countPreflopStatOpportunities(playerId, actions, hands)
    return [voluntaryHandsCount, opportunities.vpip]
  },
  format: formatPercentage,

  /**
   * VPIP判定ロジック
   * プリフロップで最初のCALL/RAISEアクション時にVPIPフラグを付与
   * phasePlayerActionIndex === 0 はそのプレイヤーのフェーズ内最初のアクション
   *
   * 注: 現在のコンテキストではBB/SBの区別ができないため、
   * すべてのプレイヤーの最初のCALL/RAISEをVPIPとしてカウントします
   */
  detectActionDetails: (context: ActionDetailContext): ActionDetail[] => {
    const { phase, phasePlayerActionIndex, actionType } = context

    // プリフロップで、そのプレイヤーの最初のアクションで、CALL/RAISEの場合
    if (phase === PhaseType.PREFLOP &&
        phasePlayerActionIndex === 0 &&
        ([ActionType.RAISE, ActionType.CALL].includes(actionType) || context.normalizationUnproven)) {
      return [ActionDetail.VPIP]
    }

    return []
  }
}
