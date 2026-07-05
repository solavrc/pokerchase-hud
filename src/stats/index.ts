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
import type { StatDisplayConfig } from '../types/filters'
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
  'steal',        // STL
  'foldToSteal',  // FTS
  'af',           // AF
  'afq',          // AFq
  'wtsd',         // WTSD
  'wwsf',         // WWSF
  'wtsdNoAi',     // WTSDa (opt-in variant, disabled by default)
  'wwsfNoAi',     // WWSFa (opt-in variant, disabled by default)
  'wsd',          // W$SD
  'riverCallAccuracy' // RCA
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
// stat.enabled !== false を尊重する: StatDefinitionでenabled: falseを明示した
// 統計（例: wtsdNoAi/wwsfNoAi等のオプトイン変種）はデフォルト非表示のまま
// マージ処理（mergeStatDisplayConfigs）に渡され、ポップアップの統計設定UIから
// ユーザーが個別に有効化できる。以前はここで無条件にenabled: trueとしていた
// ため、StatDefinition.enabled = falseの意図がdisplay configに反映されず、
// 新規統計が常時有効な状態でHUDに表示されてしまっていた。
export const defaultStatDisplayConfigs = orderedCoreStats.map(({ stat }) => ({
  id: stat.id,
  enabled: stat.enabled !== false,
  order: stat.order!
}))

/**
 * 保存済みのstatDisplayConfigsをデフォルト構成とマージする。
 *
 * 背景: ユーザーが以前保存した設定（storageの`filterOptions.statDisplayConfigs`）は、
 * リリース後に新しい統計項目が追加されても自動的には増えない。
 * このマージ処理を通さずにそのまま使うと、STL/FTS等（#86）のような
 * 新規統計がHUDに一切表示されなくなる（ポップアップを開いて再保存するまで）。
 *
 * マージ結果はデフォルト構成をベース（順序・新規項目を保証）にしつつ、
 * 既存項目についてはユーザーが設定したenabled/orderを保持する:
 * - デフォルトに存在し、保存済み設定にもある項目 → ユーザーのenabled/orderを維持
 * - デフォルトに存在するが、保存済み設定にない項目（新規統計） → デフォルト設定のまま追加
 * - 保存済み設定にあるがデフォルトに存在しない項目（廃止された統計） → 除外
 *
 * @param existingConfigs 保存済みのstatDisplayConfigs（undefined/空配列可）
 * @param defaultConfigs デフォルトのstatDisplayConfigs
 * @returns マージ後のstatDisplayConfigs（orderでソート済み）
 */
export function mergeStatDisplayConfigs(
  existingConfigs: StatDisplayConfig[] | undefined,
  defaultConfigs: StatDisplayConfig[]
): StatDisplayConfig[] {
  const existingMap = new Map((existingConfigs || []).map(config => [config.id, config]))

  // デフォルト構成をベースにする（順序を保証し、廃止された統計を自動的に除外する）
  const mergedConfigs = defaultConfigs.map(defaultConfig => {
    const existingConfig = existingMap.get(defaultConfig.id)
    if (existingConfig) {
      // ユーザー設定（enabled/order）を維持しつつ、その他のデフォルト値を反映
      return {
        ...defaultConfig,
        enabled: existingConfig.enabled,
        order: existingConfig.order
      }
    }
    // 新規統計 - デフォルト設定をそのまま使用
    return defaultConfig
  })

  // orderでソートして表示順を安定させる
  return mergedConfigs.sort((a, b) => a.order - b.order)
}

// Export registry and utilities
export { defaultRegistry } from './registry'
export * from './utils'
