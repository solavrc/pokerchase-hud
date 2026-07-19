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
 *
 * 分母（機会数） - ウォーク除外（PT4/HM標準, #115）:
 * VPIPと同じ理由でウォーク（および他家全員オールイン/フォールドによる
 * BBアクションスキップ）を分母から除外する。BBには自発的なプリフロップの
 * 意思決定機会が一切なかったため。詳細はvpip.tsのコメントを参照。
 */

import type { StatDefinition } from '../../types/stats'
import { PhaseType, ActionType } from '../../types/game'
import { getUniqueHandIds, formatPercentage } from '../utils'

export const pfrStat: StatDefinition = {
  id: 'pfr',
  name: 'PFR',
  description: 'プリフロップレイズ率（ウォーク除外）',
  helpText: 'プリフロップでレイズしたハンドの割合',
  calculate: ({ playerId, actions, hands }) => {
    // プリフロップでRAISEアクションを行ったユニークなハンド数を取得
    // ALL_INがRAISEに変換されたものも自動的に含まれる
    const pfrHandsCount = getUniqueHandIds(
      actions.filter(a =>
        a.phase === PhaseType.PREFLOP &&
        a.actionType === ActionType.RAISE
      )
    )

    // このプレイヤーが何らかのプリフロップアクションを行ったハンドIDの集合
    const handIdsWithPreflopAction = new Set(
      actions
        .filter(a => a.phase === PhaseType.PREFLOP && a.handId !== undefined)
        .map(a => a.handId!)
    )

    // 機会（分母）: 自分がBBを務め、かつそのハンドで一度もプリフロップ
    // アクションを行っていないハンド（ウォーク/BBアクションスキップ）を除外
    const opportunityHands = hands.filter(hand =>
      !(hand.bigBlindUserId === playerId && !handIdsWithPreflopAction.has(hand.id))
    )

    return [pfrHandsCount, opportunityHands.length]
  },
  format: formatPercentage
}
