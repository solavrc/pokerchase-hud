/**
 * Core Statistics Module
 * Automatically registers all statistics from the core directory
 *
 * To add a new statistic:
 * 1. Create a new .ts file in ./core/
 * 2. Export a StatDefinition with name ending in "Stat"
 * 3. Add the export to ./core/index.ts
 * 4. The statistic will be automatically registered with proper ordering
 */

import type { StatDefinition } from '../types/stats'
import { defaultRegistry } from './registry'

// Import all core statistics automatically
import * as coreStats from './core'

// Define the desired display order for core statistics
// New statistics not in this list will be appended at the end
const STAT_ORDER = [
  'hands',        // HAND count
  'playerName',   // Player Name
  'vpip',         // VPIP
  'pfr',          // PFR
  'cbet',         // CB
  'cbetFold',     // CBF
  '3bet',         // 3B (mapped from threeBet)
  '3betfold',     // 3BF (mapped from threeBetFold)
  'af',           // AF
  'afq',          // AFq
  'wtsd',         // WTSD
  'wwsf',         // WWSF
  'wsd'           // W$SD
]

// Extract all StatDefinition exports (those ending with 'Stat')
const statDefinitions = Object.entries(coreStats)
  .filter(([key, value]) => key.endsWith('Stat') && value && typeof value === 'object')
  .map(([_, stat]) => stat as StatDefinition)

// Sort statistics according to STAT_ORDER, with unknown stats at the end
const sortedStats = statDefinitions.sort((a, b) => {
  const getOrder = (stat: StatDefinition) => {
    const index = STAT_ORDER.indexOf(stat.id)
    return index === -1 ? 1000 + stat.id.charCodeAt(0) : index
  }
  return getOrder(a) - getOrder(b)
})

// Create ordered stat configurations
const orderedCoreStats = sortedStats.map((stat, index) => ({
  stat,
  order: index
}))

// Register all statistics
orderedCoreStats.forEach(({ stat, order }) => {
  stat.order = order
  defaultRegistry.register(stat)
})

// Automatically registered core statistics

// Create default stat display configuration
export const defaultStatDisplayConfigs = orderedCoreStats.map(({ stat }) => ({
  id: stat.id,
  enabled: true,
  order: stat.order!
}))

// Export registry and utilities
export { defaultRegistry } from './registry'
export * from './utils'

