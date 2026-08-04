/** HUD統計のlatest windowとしてUIが公開する選択肢。 */
export const STATS_LATEST_HAND_OPTIONS = [20, 50, 100, 200, 500] as const

/** Popup・options・永続寄与windowが共有するlatest上限。 */
export const MAX_STATS_LATEST_HANDS = 500

/**
 * options/message由来のlatest windowを公開契約へ正規化する。
 * 正の有限値は旧slice互換のため小数も保持し、上限超過だけ500へ丸める。
 */
export function normalizeStatsLatestHands(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(MAX_STATS_LATEST_HANDS, value)
    : undefined
}
