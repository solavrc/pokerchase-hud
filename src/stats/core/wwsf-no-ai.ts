/**
 * WWSFa - Won When Saw Flop (no preflop all-ins), opt-in variant
 *
 * WWSFのPT4公式定義（プリフロップオールインを含む「フロップを見た」）に対し、
 * 本統計はHUD従来の「決定focused」な代替定義を変種として温存したもの。
 * 系譜・分母の考え方はwtsd-no-ai.tsを参照（PT4カスタムスタッツ
 * 「WTSD without preflop all-ins」/ Hand2Note「Flop Any Action」と同系統）。
 *
 * 分母（base）: そのプレイヤーがphase===FLOPのアクションを最低1回行った
 * ハンドID集合（プリフロップオールイン除外）。
 * 分子: 分母のハンドのうち、winningHandIdsに含まれるもの。
 */

import type { StatDefinition } from '../../types/stats'
import { PhaseType } from '../../types/game'
import { formatPercentage } from '../utils'

export const wwsfNoAiStat: StatDefinition = {
  id: 'wwsfNoAi',
  name: 'WWSFa',
  // wwsf.ts側の記法「フロップ以降の勝率（プリフロップオールイン含む）」と
  // 対で読めるよう、括弧内は除外条件のみに揃える(理由はwtsd-no-ai.ts参照)。
  description: 'フロップ以降の勝率（プリフロップオールイン除外）',
  helpText: 'フロップを見た後に勝った割合(プリフロップオールイン除外)',
  enabled: false,
  calculate: ({ actions, winningHandIds }) => {
    // フロップで最低1アクションを行ったハンドID（プリフロップオールイン除外）
    const baseHandIds = new Set(
      actions
        .filter(a => a.phase === PhaseType.FLOP && a.handId !== undefined)
        .map(a => a.handId!)
    )

    let wonCount = 0
    for (const handId of baseHandIds) {
      if (winningHandIds.has(handId)) wonCount++
    }

    return [wonCount, baseHandIds.size]
  },
  format: formatPercentage
}
