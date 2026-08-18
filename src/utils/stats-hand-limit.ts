/** HUD統計のlatest windowとしてUIが公開する選択肢。 */
export const STATS_LATEST_HAND_OPTIONS = [20, 50, 100, 200, 500] as const

export type StatsLatestHands = typeof STATS_LATEST_HAND_OPTIONS[number]

/** Popup・options・永続寄与windowが共有するlatest上限。 */
export const MAX_STATS_LATEST_HANDS = 500

/**
 * options/message/service由来のlatest windowを公開契約へ正規化する。
 *
 * Popupが表現できる値は公開選択肢だけなので、選択肢の間にある値を
 * ledgerへ渡すと、例えば0.5がsliceの結果0件になる一方でPopupはALLを
 * 表示する。契約外の値はALL（undefined）へ戻し、旧データに残り得る500超
 * だけは従来の上限互換として500へ丸める。
 */
export function normalizeStatsLatestHands(value: unknown): StatsLatestHands | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  if (value > MAX_STATS_LATEST_HANDS) return MAX_STATS_LATEST_HANDS
  return (STATS_LATEST_HAND_OPTIONS as readonly number[]).includes(value)
    ? value as StatsLatestHands
    : undefined
}
