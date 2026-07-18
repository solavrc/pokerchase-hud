/**
 * VPIP·F - VPIP restricted to "full table" hands (opt-in, HUD-original)
 *
 * 背景 (poker-warehouse 2026-07 分析、hand-over:
 * workspace/reports/pokerchase-hud-vpip-f-handover.md): SNG では卓人数が
 * 減るほど（ヘッズアップに近づくほど）VPIP が構造的に高くなる。さらに、
 * 高VPIPゾーン（残り人数が少ない終盤）には「飛ばずに生き残った時しか
 * 到達しない」ため、終盤ハンドの構成比自体が成績の関数になり（生存者
 * 効果）、集計VPIP はプレイヤー間比較を歪める。実測（hero=sola、直近
 * 1,980ハンド）: 5-6人卓 35.2% に対し 4人卓 47.0% / 3人卓 56.1% / HU
 * 71.9%（層間で30pt以上の差）。
 *
 * 本統計は、分子/分母とも既存 vpip.ts と完全に同一のロジック
 * （ウォーク除外込み、#115 PT4/HM標準）を「フルテーブル層のハンド」に
 * 限定して適用する。既存の `vpip` 統計は一切変更しない
 * （トラッカー互換の約束、#115 の体制を維持）。
 *
 * フルテーブル層の定義（テーブル種別相対）:
 * - 6-max卓（seatUserIds.length === 6）: 配られた人数（seatUserIdsの
 *   非-1要素数）が5人以上
 * - 4-max卓（seatUserIds.length === 4）: 配られた人数が4人（満席）
 * - 根拠: 空席1つまでは構造インフレなし。4-maxの3人卓は既にショート
 *   挙動なのでフル層に含めない
 *
 * 層区分（ツールチップ内訳用）: フル / 4人（6maxのみ） / 3人 / HU
 * （4-maxの4人卓はフル層に含まれるため、「4人」層は6-max限定）
 *
 * 位置づけ: HUD独自統計（PT4/HM3に対応物なし）。RCA
 * （river-call-accuracy.ts）と同じ枠。デフォルト無効（opt-in）。
 * ポップアップのHUD表示設定から有効化する（#115のWTSDa/WWSFaと同じ配線）。
 *
 * 読み取り時導出で完結: 卓人数はhands.seatUserIdsからcalculate()内で
 * 導出するのみで、entity-converter.ts / write-entity-stream.ts /
 * スキーマには一切触れない。REBUILD_ADVISORY_VERSIONのbump不要
 * （#115のWTSDa/WWSFaパターンと同じ）。
 */

import type { StatDefinition, StatCalculationContext } from '../../types/stats'
import type { Hand, Action } from '../../types/entities'
import { ActionDetail, PhaseType } from '../../types/game'
import { formatPercentage } from '../utils'

/** フルテーブル層の区分。'full' が vpipF の主値、他3層はツールチップ内訳用。 */
export type VpipFLayer = 'full' | '4p' | '3p' | 'hu'

/**
 * ハンドをフルテーブル層に分類する（テーブル種別相対のルール）。
 * どの層にも該当しない異常系（配られた人数が1人以下、テーブルサイズが
 * 4/6以外等）は null を返し、vpipF・ツールチップ内訳のいずれからも除外する。
 */
export function classifyVpipFLayer(hand: Pick<Hand, 'seatUserIds'>): VpipFLayer | null {
  const tableSize = hand.seatUserIds.length
  const dealtCount = hand.seatUserIds.filter(id => id !== -1).length

  if (tableSize === 6) {
    if (dealtCount >= 5) return 'full'
    if (dealtCount === 4) return '4p'
    if (dealtCount === 3) return '3p'
    if (dealtCount === 2) return 'hu'
    return null
  }
  if (tableSize === 4) {
    if (dealtCount === 4) return 'full'
    if (dealtCount === 3) return '3p'
    if (dealtCount === 2) return 'hu'
    return null
  }
  return null
}

/**
 * 与えられたハンド部分集合に対して、vpip.ts と同一ロジック（ウォーク除外
 * 込み）でVPIPの[分子, 分母]を計算する。actionsは呼び出し元でこのハンド
 * 集合に属するものだけに絞り込む。
 */
function computeVpipForHands(playerId: number, actions: Action[], hands: Hand[]): [number, number] {
  const handIds = new Set(hands.map(h => h.id))

  const voluntaryCount = actions.filter(a =>
    a.actionDetails.includes(ActionDetail.VPIP) &&
    a.handId !== undefined &&
    handIds.has(a.handId)
  ).length

  const handIdsWithPreflopAction = new Set(
    actions
      .filter(a => a.phase === PhaseType.PREFLOP && a.handId !== undefined && handIds.has(a.handId))
      .map(a => a.handId!)
  )

  const opportunityHands = hands.filter(hand =>
    !(hand.bigBlindUserId === playerId && !handIdsWithPreflopAction.has(hand.id))
  )

  return [voluntaryCount, opportunityHands.length]
}

const VPIP_F_LAYERS: VpipFLayer[] = ['full', '4p', '3p', 'hu']

function groupHandsByLayer(hands: Hand[]): Record<VpipFLayer, Hand[]> {
  const groups: Record<VpipFLayer, Hand[]> = { full: [], '4p': [], '3p': [], hu: [] }
  for (const hand of hands) {
    const layer = classifyVpipFLayer(hand)
    if (layer) groups[layer].push(hand)
  }
  return groups
}

const LAYER_LABELS: Record<VpipFLayer, string> = {
  full: 'VPIP·F',
  '4p': '4p',
  '3p': '3p',
  hu: 'HU',
}

/** ツールチップ用の層別内訳文字列（各層のVPIP%とn）を組み立てる。 */
function formatLayerBreakdown(playerId: number, actions: Action[], hands: Hand[]): string {
  const groups = groupHandsByLayer(hands)
  return VPIP_F_LAYERS.map(layer => {
    const [num, den] = computeVpipForHands(playerId, actions, groups[layer])
    const pct = den === 0 ? '-' : `${(Math.round((num / den) * 1000) / 10).toFixed(1)}%`
    return `${LAYER_LABELS[layer]} ${pct} (n=${den})`
  }).join(' | ')
}

export const vpipFullStat: StatDefinition = {
  id: 'vpipF',
  name: 'VPIP·F',
  description: 'フルテーブル層（6max≥5人 / 4max=4人）に限定したVPIP（ウォーク除外, HUD独自指標, opt-in）',
  enabled: false,
  calculate: ({ playerId, actions, hands }) => {
    const { full } = groupHandsByLayer(hands)
    return computeVpipForHands(playerId, actions, full)
  },
  format: formatPercentage,
  tooltip: ({ playerId, actions, hands }: StatCalculationContext) =>
    formatLayerBreakdown(playerId, actions, hands),
}
