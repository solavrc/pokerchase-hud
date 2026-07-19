import { memo } from 'react'
import type { CSSProperties } from 'react'
import type { StatResult, StatValue } from '../../types/stats'
import { getStatValueColor } from './statColorRules'
import { composeStatTitle } from './statTooltip'

interface CompactStatDisplayProps {
  displayStats: Array<[string, any, StatResult?]>
  /** Threshold-based value coloring, see statColorRules.ts. */
  colorCoding?: boolean
}

const styles = {
  container: {
    padding: '4px 6px',
  } as CSSProperties,

  classicLine: {
    fontSize: '11px',
    fontWeight: 'bold',
    color: '#dddddd',
    whiteSpace: 'nowrap' as const,
  } as CSSProperties,

  secondaryLine: {
    display: 'flex',
    gap: '8px',
    marginTop: '2px',
    whiteSpace: 'nowrap' as const,
  } as CSSProperties,

  secondaryKey: {
    fontWeight: 'bold',
    color: '#aaaaaa',
    fontSize: '9px',
  } as CSSProperties,

  secondaryValue: {
    color: '#dddddd',
    fontSize: '9px',
    marginLeft: '2px',
  } as CSSProperties,
}

/** Secondary line stat ids, in display order: AF / CB (cbet) / STL (steal). */
const SECONDARY_STAT_IDS = ['af', 'cbet', 'steal']

const findStat = (displayStats: CompactStatDisplayProps['displayStats'], id: string): StatResult | undefined =>
  displayStats.find(([, , statResult]) => statResult?.id === id)?.[2]

/** Classic-HUD segment format: a bare rounded percentage (no '%' sign), or '-' when there's no opportunity yet. */
const formatClassicSegment = (value: StatValue | undefined): string => {
  if (!Array.isArray(value) || value.length !== 2) return '-'
  const [numerator, denominator] = value
  if (denominator === 0) return '-'
  return String(Math.round((numerator / denominator) * 100))
}

const formatSecondaryValue = (statResult: StatResult): string => {
  const value = statResult.value
  if (!Array.isArray(value) || value.length !== 2) return typeof value === 'number' ? String(value) : '-'
  const [numerator, denominator] = value
  if (statResult.id === 'af') return (numerator / denominator).toFixed(1)
  return `${Math.round((numerator / denominator) * 100)}%`
}

/**
 * Compact HUD display (#143): a single classic-HUD line
 * (`VPIP/PFR/3B (HAND)`, e.g. `24/18/8 (67)`) plus a secondary line for
 * AF/CB/STL. Zero-opportunity secondary stats are dropped entirely rather
 * than rendered as '-' rows (the classic line's own VPIP/PFR/3B segments
 * still fall back to '-' individually -- it's one fused line, not
 * per-stat rows, so there's nothing to suppress without breaking the
 * familiar "x/y/z (n)" shape).
 *
 * Every segment carries its own composed `title` tooltip (name + full
 * value + one-line explanation, see statTooltip.ts) even though the
 * on-screen text is abbreviated.
 *
 * Click-to-expand to the full 16-stat grid is handled by the parent
 * (Hud.tsx), which wraps this component in a click target -- this
 * component has no click handling of its own.
 */
export const CompactStatDisplay = memo(({ displayStats, colorCoding }: CompactStatDisplayProps) => {
  const vpip = findStat(displayStats, 'vpip')
  const pfr = findStat(displayStats, 'pfr')
  const threeBet = findStat(displayStats, '3bet')
  const hands = findStat(displayStats, 'hands')
  const handCount = hands && typeof hands.value === 'number' ? hands.value : 0

  const colorFor = (statResult: StatResult | undefined): CSSProperties | undefined => {
    if (!colorCoding || !statResult) return undefined
    const color = getStatValueColor(statResult.id, statResult.value)
    return color ? { color } : undefined
  }

  const titleFor = (id: string, name: string, statResult: StatResult | undefined): string =>
    composeStatTitle(id, name, statResult?.formatted ?? '-', statResult?.tooltip)

  const secondaryStats = SECONDARY_STAT_IDS.map((id) => findStat(displayStats, id)).filter(
    (statResult): statResult is StatResult =>
      !!statResult && Array.isArray(statResult.value) && statResult.value.length === 2 && statResult.value[1] > 0
  )

  return (
    <div style={styles.container}>
      <div style={styles.classicLine}>
        <span data-stat-id="vpip" style={colorFor(vpip)} title={titleFor('vpip', 'VPIP', vpip)}>{formatClassicSegment(vpip?.value)}</span>
        /
        <span data-stat-id="pfr" style={colorFor(pfr)} title={titleFor('pfr', 'PFR', pfr)}>{formatClassicSegment(pfr?.value)}</span>
        /
        <span data-stat-id="3bet" style={colorFor(threeBet)} title={titleFor('3bet', '3B', threeBet)}>{formatClassicSegment(threeBet?.value)}</span>
        {' '}
        <span data-stat-id="hands" title={titleFor('hands', 'HAND', hands)}>({handCount})</span>
      </div>
      {secondaryStats.length > 0 && (
        <div style={styles.secondaryLine}>
          {secondaryStats.map((statResult) => (
            <span key={statResult.id} data-stat-id={statResult.id}>
              <span style={styles.secondaryKey} title={titleFor(statResult.id, statResult.name, statResult)}>{statResult.name}:</span>
              <span style={{ ...styles.secondaryValue, ...colorFor(statResult) }} title={titleFor(statResult.id, statResult.name, statResult)}>
                {formatSecondaryValue(statResult)}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
})

CompactStatDisplay.displayName = 'CompactStatDisplay'
