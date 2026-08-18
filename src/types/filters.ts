/**
 * Filter-related Types
 */

import type { TableSizeFilter } from '../utils/table-size'
import type { StatsLatestHands } from '../utils/stats-hand-limit'

export type { TableSizeFilter }

export interface GameTypeFilter {
  sng: boolean
  mtt: boolean
  ring: boolean
}

/**
 * Individual statistic display configuration
 */
export interface StatDisplayConfig {
  id: string        // Stat ID (e.g., 'vpip', 'pfr')
  enabled: boolean  // Whether to display this stat
  order: number     // Display order (lower numbers appear first)
}

/**
 * Overall filter and display options
 */
export interface FilterOptions {
  gameTypes: GameTypeFilter
  /**
   * 卓人数（配られた人数）フィルタ。C案、gameTypesと同格。undefined =
   * 既存ユーザー/フィールド欠落時のグレースフルなマイグレーション
   * （src/utils/table-size.ts の DEFAULT_TABLE_SIZE_FILTER = 全層選択
   * = フィルタなし、として扱う）。
   */
  tableSize?: TableSizeFilter
  /** undefined = all hands; public choices are 20/50/100/200/500 only. */
  handLimit?: StatsLatestHands
  statDisplayConfigs?: StatDisplayConfig[]  // Custom stat display configuration
}
