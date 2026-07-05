/**
 * WTSD - Went to Showdown
 *
 * フロップを見たハンドのうち、ショーダウンまで到達した割合を計測します。
 *
 * PT4公式定義（"Went to Showdown"の分母は"Flop"）: PT4サポートスタッフの回答
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

export const wtsdStat: StatDefinition = {
  id: 'wtsd',
  name: 'WTSD',
  description: 'ショーダウン率（フロップ以降、プリフロップオールイン含む）',
  calculate: ({ phases }) => {
    // フロップを見たハンドID（プリフロップオールインを含む。#115）
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
