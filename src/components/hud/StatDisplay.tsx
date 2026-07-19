import { memo } from 'react'
import type { CSSProperties } from 'react'
import type { StatResult } from '../../types/stats'
import { getStatValueColor } from './statColorRules'
import { composeStatTitle } from './statTooltip'

interface StatDisplayProps {
  displayStats: Array<[string, any, StatResult?]>
  formatValue: (value: number | [number, number]) => string
  /** Threshold-based value coloring, see statColorRules.ts. Defaults to off. */
  colorCoding?: boolean
}

const styles = {
  statsContainer: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '2px 6px',
    padding: '4px 6px',
  } as CSSProperties,
  
  statItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    whiteSpace: 'nowrap' as const,
  } as CSSProperties,
  
  statKey: {
    fontWeight: 'bold',
    color: '#aaaaaa',
    minWidth: '35px',
    fontSize: '9px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  } as CSSProperties,
  
  statValue: {
    color: '#dddddd',
    textAlign: 'right' as const,
    marginLeft: '4px',
    fontSize: '9px',
    maxWidth: '100px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  } as CSSProperties,
}

export const StatDisplay = memo(({ displayStats, formatValue, colorCoding }: StatDisplayProps) => (
  <div style={styles.statsContainer}>
    {displayStats
      .filter(([, , statResult]) => statResult?.id !== 'playerName')
      .map(([key, value, statResult], index) => {
        const displayValue = statResult?.formatted || formatValue(value as number | [number, number])
        // native title tooltip: stat name + value (num/den), plus the stat's
        // dynamic tooltip when defined (e.g. vpipF's per-layer breakdown)
        // and its static beginner-friendly helpText -- see statTooltip.ts.
        const tooltipText = composeStatTitle(statResult?.id ?? '', key, displayValue, statResult?.tooltip)
        const color = colorCoding && statResult ? getStatValueColor(statResult.id, statResult.value) : null
        return (
          <div key={index} style={styles.statItem} data-stat-id={statResult?.id}>
            <span style={styles.statKey} title={tooltipText}>{key}:</span>
            <span style={color ? { ...styles.statValue, color } : styles.statValue} title={tooltipText}>{displayValue}</span>
          </div>
        )
      })}
  </div>
))

StatDisplay.displayName = 'StatDisplay'