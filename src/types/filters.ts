/**
 * Filter-related Types
 */

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
  handLimit?: number  // undefined = all hands, otherwise limit to recent N hands
  statDisplayConfigs?: StatDisplayConfig[]  // Custom stat display configuration
}