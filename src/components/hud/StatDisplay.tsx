import { memo } from 'react'
import type { CSSProperties } from 'react'
import type { StatResult } from '../../types/stats'

interface StatDisplayProps {
  displayStats: Array<[string, any, StatResult?]>
  formatValue: (value: number | [number, number]) => string
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

export const StatDisplay = memo(({ displayStats, formatValue }: StatDisplayProps) => (
  <div style={styles.statsContainer}>
    {displayStats
      .filter(([, , statResult]) => statResult?.id !== 'playerName')
      .map(([key, value, statResult], index) => {
        const displayValue = statResult?.formatted || formatValue(value as number | [number, number])
        return (
          <div key={index} style={styles.statItem}>
            <span style={styles.statKey} title={key}>{key}:</span>
            <span style={styles.statValue} title={displayValue}>{displayValue}</span>
          </div>
        )
      })}
  </div>
))

StatDisplay.displayName = 'StatDisplay'