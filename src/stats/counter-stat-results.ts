import type { Session } from '../types/entities'
import type { StatDisplayConfig } from '../types/filters'
import type { StatResult, StatValue } from '../types/stats'
import { COMPACT_REQUIRED_STAT_IDS, CLASSIFIER_REQUIRED_STAT_IDS } from './compactStats'
import { defaultRegistry, defaultStatDisplayConfigs } from './index'
import {
  NUMERIC_STAT_IDS,
  getVpipFLayerCounter,
  statValueFromCounterVector,
  type HandStatCounterVector,
  type NumericStatId,
} from './hand-contribution'
import type { TableSizeLayer } from '../utils/table-size'

const FORCED_ENABLED_STAT_IDS: ReadonlySet<string> = new Set([
  ...COMPACT_REQUIRED_STAT_IDS,
  ...CLASSIFIER_REQUIRED_STAT_IDS,
])

const NUMERIC_STAT_ID_SET: ReadonlySet<string> = new Set(NUMERIC_STAT_IDS)

const VPIP_F_LAYERS: readonly TableSizeLayer[] = ['full', '4p', '3p', 'hu']
const VPIP_F_LAYER_LABELS: Record<TableSizeLayer, string> = {
  full: 'VPIP·F',
  '4p': '4p',
  '3p': '3p',
  hu: 'HU',
}

function isNumericStatId(id: string): id is NumericStatId {
  return NUMERIC_STAT_ID_SET.has(id)
}

/**
 * compact HUDとplayer classifierが常に必要とする指標を、保存済み表示設定に関わらず計算対象にする。
 */
export function getEffectiveStatDisplayConfigs(
  configs: readonly StatDisplayConfig[] | undefined
): StatDisplayConfig[] {
  return (configs ?? defaultStatDisplayConfigs).map(config =>
    !config.enabled && FORCED_ENABLED_STAT_IDS.has(config.id)
      ? { ...config, enabled: true }
      : { ...config }
  )
}

/** VPIP·Fの従来ツールチップと同じ4層内訳をcounter vectorから組み立てる。 */
export function formatVpipFLayerBreakdownFromCounters(
  counters: readonly number[]
): string {
  return VPIP_F_LAYERS.map(layer => {
    const [numerator, denominator] = getVpipFLayerCounter(counters, layer)
    const percentage = denominator === 0
      ? '-'
      : `${(Math.round((numerator / denominator) * 1000) / 10).toFixed(1)}%`
    return `${VPIP_F_LAYER_LABELS[layer]} ${percentage} (n=${denominator})`
  }).join(' | ')
}

function resolveValue(
  statId: string,
  counters: HandStatCounterVector,
  playerId: number,
  session: Session
): StatValue {
  if (statId === 'playerName') {
    return session.players.get(playerId)?.name ?? `Player ${playerId}`
  }
  if (isNumericStatId(statId)) {
    return statValueFromCounterVector(counters, statId)
  }
  throw new RangeError(`Stat ${statId} is not represented by the contribution ledger`)
}

/**
 * 完成ハンド寄与counterから、従来のStatsRegistryと同じmetadata・format・並び順の
 * `StatResult[]`を作る。新しい履歴統計を追加する際は、対応するcounterと
 * `HAND_STAT_CONTRIBUTION_VERSION`も同時に更新しなければならない（MUST）。
 */
export function buildStatResultsFromCounters(
  counters: HandStatCounterVector,
  playerId: number,
  session: Session,
  configs: readonly StatDisplayConfig[]
): StatResult[] {
  return [...configs]
    .filter(config => config.enabled)
    .sort((left, right) => left.order - right.order)
    .map(config => {
      const definition = defaultRegistry.get(config.id)
      if (!definition) {
        console.warn(`[StatsLedger] Stat ${config.id} not found in registry`)
        return { id: config.id, name: 'Unknown', value: 0, formatted: '-' }
      }

      try {
        const value = resolveValue(definition.id, counters, playerId, session)
        return {
          id: definition.id,
          name: definition.name,
          value,
          formatted: definition.format ? definition.format(value) : undefined,
          ...(definition.id === 'vpipF'
            ? { tooltip: formatVpipFLayerBreakdownFromCounters(counters) }
            : {}),
        }
      } catch (error) {
        console.error(`[StatsLedger] Error materializing stat ${definition.id}:`, error)
        return { id: definition.id, name: definition.name, value: 0, formatted: '-' }
      }
    })
}
