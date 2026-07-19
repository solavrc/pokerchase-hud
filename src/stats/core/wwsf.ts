/**
 * WWSF - Won When Saw Flop
 *
 * フロップを見たハンドのうち、勝利した割合を計測します。
 *
 * PT4公式定義（WTSDと同一の"flops seen"分母を共有）: PT4サポートスタッフの回答
 * "Those stats are based on flops seen, not based on flops seen when not
 * all-in, so all-in spots will count" の通り、プリフロップオールインで
 * 迎えたフロップも「フロップを見た」に含める。フェーズ所属（FLOPフェーズの
 * seatUserIds）はentity-converter.ts/write-entity-stream.tsで
 * BetStatus===BET_ABLE || BetStatus===ALL_INのプレイヤーとして構築される
 * （#115）。プリフロップでフォールドしたプレイヤーは引き続き除外される
 * （#97のフォールドプレイヤー混入バグ修正は維持）。
 *
 * このモジュール自体はフェーズメンバーシップをそのまま集計するのみで、
 * BetStatusのフィルタリングはpipeline側（entity-converter.ts /
 * write-entity-stream.ts）の責務。
 */

import type { StatDefinition } from '../../types/stats'
import { PhaseType } from '../../types/game'
import { formatPercentage } from '../utils'

export const wwsfStat: StatDefinition = {
  id: 'wwsf',
  name: 'WWSF',
  description: 'フロップ以降の勝率（プリフロップオールイン含む）',
  helpText: 'フロップを見た後に勝った割合(プリフロップオールイン含む)',
  calculate: ({ phases, winningHandIds }) => {
    // フロップを見たハンド（プリフロップオールインを含む。#115）
    const flopPhases = phases.filter(p => p.phase === PhaseType.FLOP)

    // フロップを見て勝利した回数
    const wonAfterFlopCount = flopPhases.filter(p =>
      p.handId && winningHandIds.has(p.handId)
    ).length

    return [wonAfterFlopCount, flopPhases.length]
  },
  format: formatPercentage
}
