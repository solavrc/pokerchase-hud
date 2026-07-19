/**
 * WTSDa - Went to Showdown (no preflop all-ins), opt-in variant
 *
 * WTSDのPT4公式定義（プリフロップオールインを含む「フロップを見た」）に対し、
 * 本統計はHUD従来の「決定focused」な代替定義を変種として温存したもの。
 *
 * 系譜: PT4のカスタムスタッツ「WTSD without preflop all-ins」、および
 * Hand2Noteの「Flop Any Action」ベースの派生スタッツと同じ思想 —
 * プリフロップオールインしたプレイヤーはフロップ以降に一切の意思決定を
 * 行わないため、「意思決定の粘着性」を測る指標としては母集団から除外する。
 *
 * 分母（base）: そのプレイヤーがphase===FLOPのアクションを最低1回行った
 * ハンドID集合。BET_ABLEでフロップを迎えたプレイヤーは必ずフロップで
 * 最低1アクション取る一方、プリフロップオールインしたプレイヤーは
 * フロップでアクションを起こさない（ALL_INステータスのままアクション権を
 * 持たない）ため、これはPT4カスタムスタッツと同じ「プリフロップオールイン
 * 除外」を実現する。
 * 分子: 分母のハンドのうち、ショーダウンに到達したもの（wtsd.tsと同様、
 * SHOWDOWNフェーズへの所属で判定）。
 */

import type { StatDefinition } from '../../types/stats'
import { PhaseType } from '../../types/game'
import { formatPercentage } from '../utils'

export const wtsdNoAiStat: StatDefinition = {
  id: 'wtsdNoAi',
  name: 'WTSDa',
  description: 'ショーダウン率（プリフロップオールイン除外、意思決定ベースの変種）',
  helpText: 'フロップを見た後にショーダウンまで進んだ割合(プリフロップオールイン除外)',
  enabled: false,
  calculate: ({ actions, phases }) => {
    // フロップで最低1アクションを行ったハンドID（プリフロップオールイン除外）
    const baseHandIds = new Set(
      actions
        .filter(a => a.phase === PhaseType.FLOP && a.handId !== undefined)
        .map(a => a.handId!)
    )

    const showdownCount = phases
      .filter(p =>
        p.phase === PhaseType.SHOWDOWN &&
        p.handId &&
        baseHandIds.has(p.handId)
      )
      .length

    return [showdownCount, baseHandIds.size]
  },
  format: formatPercentage
}
