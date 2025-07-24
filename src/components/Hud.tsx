import { CSSProperties, useState, useCallback, useMemo, memo } from 'react'
import type { PlayerStats } from '../app'
import type { StatDisplayConfig } from '../types'
import type { StatResult } from '../types/stats'
import type { RealTimeStats } from '../realtime-stats/realtime-stats-service'
import { useDraggable } from './Hud/hooks/useDraggable'
import { DragHandle } from './Hud/DragHandle'
import { HudHeader } from './Hud/HudHeader'
import { StatDisplay } from './Hud/StatDisplay'
import { PlayerTypeIcons } from './Hud/PlayerTypeIcons'
import { RealTimeStatsDisplay } from './Hud/RealTimeStatsDisplay'

// Types
interface PlayerPotOdds {
  spr?: number
  potOdds?: {
    pot: number
    call: number
    percentage: number
    ratio: string
    isPlayerTurn: boolean
  }
}

interface HudProps {
  actualSeatIndex: number
  stat: PlayerStats
  scale?: number
  statDisplayConfigs: StatDisplayConfig[]
  realTimeStats?: RealTimeStats
  playerPotOdds?: PlayerPotOdds
}

// Constants
const SEAT_POSITIONS: CSSProperties[] = [
  { top: '65%', left: '65%' },
  { top: '70%', left: '10%' },
  { top: '35%', left: '10%' },
  { top: '20%', left: '65%' },
  { top: '35%', left: '90%' },
  { top: '70%', left: '90%' },
]

const EMPTY_SEAT_ID = -1
const HUD_WIDTH = 240
const HOVER_BG_COLOR = 'rgba(0, 0, 0, 0.7)'
const NORMAL_BG_COLOR = 'rgba(0, 0, 0, 0.5)'

// Styles
const styles = {
  container: {
    position: 'fixed',
    pointerEvents: 'none',
    userSelect: 'none',
    zIndex: 9999,
    fontSize: '10px',
    fontFamily: 'monospace',
    color: '#ffffff',
    textShadow: '1px 1px 2px rgba(0, 0, 0, 0.8)',
  } as CSSProperties,
  
  background: {
    backgroundColor: NORMAL_BG_COLOR,
    backdropFilter: 'blur(2px)',
    border: '1px solid rgba(255, 255, 255, 0.15)',
    borderRadius: '6px',
    padding: '0',
    lineHeight: '1.1',
    width: `${HUD_WIDTH}px`,
    overflow: 'hidden',
  } as CSSProperties,
  
  header: {
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
    padding: '1px 6px',
    borderRadius: '6px 6px 0 0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: '16px',
  } as CSSProperties,
  
  playerName: {
    fontSize: '10px',
    fontWeight: 'bold',
    color: '#ffffff',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    textAlign: 'center' as const,
    letterSpacing: '0.3px',
    textShadow: '0 1px 2px rgba(0, 0, 0, 0.5)',
  } as CSSProperties,
  
  clickable: {
    cursor: 'pointer',
    transition: 'opacity 0.2s ease',
  } as CSSProperties,
}

// Helper functions
const formatStatValue = (value: number | [number, number]): string => {
  if (Array.isArray(value)) {
    const [top, bottom] = value
    const stat = top / bottom
    if (Number.isNaN(stat) || !Number.isFinite(stat)) return '-'
    return `${(Math.round(stat * 1000) / 10).toFixed(1)}% (${top}/${bottom})`
  }
  return String(value)
}

const getDisplayStats = (stat: PlayerStats): Array<[string, any, StatResult?]> => {
  if (stat.playerId === EMPTY_SEAT_ID) return []
  
  if ('statResults' in stat && stat.statResults && stat.statResults.length > 0) {
    return stat.statResults.map(s => [
      s.name || s.id.toUpperCase(),
      s.value,
      s
    ])
  }
  
  return []
}

const getPlayerName = (stat: PlayerStats): string | null => {
  if (stat.playerId === EMPTY_SEAT_ID) return null
  
  if ('statResults' in stat && stat.statResults) {
    const nameResult = stat.statResults.find(s => s.id === 'playerName' || s.name === 'Name')
    if (nameResult && typeof nameResult.value === 'string') {
      return nameResult.value
    }
  }
  
  return null
}

// Main component
const Hud = memo((props: HudProps) => {
  const [isHovering, setIsHovering] = useState(false)
  const defaultPosition = SEAT_POSITIONS[props.actualSeatIndex] || { top: '50%', left: '50%' }
  
  const {
    containerRef,
    isDragging,
    position,
    handleMouseDown
  } = useDraggable(props.actualSeatIndex, defaultPosition)

  const displayStats = useMemo(() => getDisplayStats(props.stat), [props.stat])
  const playerName = useMemo(() => getPlayerName(props.stat), [props.stat])
  const scale = props.scale || 1

  const copyStatsToClipboard = useCallback(async () => {
    try {
      let statsText = ''
      
      if (playerName) {
        statsText += `Player: ${playerName}\n`
        statsText += '---\n'
      }
      
      displayStats.forEach(([key, value, statResult]) => {
        const formattedValue = statResult?.formatted || formatStatValue(value as number | [number, number])
        statsText += `${key}: ${formattedValue}\n`
      })
      
      await navigator.clipboard.writeText(statsText.trim())
    } catch (error) {
      console.error('Failed to copy stats to clipboard:', error)
    }
  }, [displayStats, playerName])

  // Container styles
  const containerStyle: CSSProperties = {
    ...styles.container,
    ...(position || defaultPosition),
    pointerEvents: isDragging ? 'auto' : 'none',
    transform: `translate(-50%, -50%) scale(${scale})`,
    transformOrigin: 'center',
    cursor: isDragging ? 'move' : 'default',
  }
  
  const backgroundStyle: CSSProperties = {
    ...styles.background,
    backgroundColor: isHovering || isDragging ? HOVER_BG_COLOR : NORMAL_BG_COLOR,
    pointerEvents: 'auto',
    position: 'relative',
  }
  
  // Empty seat
  if (props.stat.playerId === EMPTY_SEAT_ID) {
    return (
      <div ref={containerRef} style={containerStyle}>
        <div
          style={backgroundStyle}
          onMouseEnter={() => setIsHovering(true)}
          onMouseLeave={() => setIsHovering(false)}
        >
          <DragHandle isHovering={isHovering} onMouseDown={handleMouseDown} />
          <div style={styles.header}>
            <span style={{ ...styles.playerName, color: '#888888', fontStyle: 'italic' }}>
              Waiting for Hand...
            </span>
            <PlayerTypeIcons />
          </div>
          <div style={{ padding: '4px 6px', minHeight: '20px' }} />
        </div>
      </div>
    )
  }
  
  // Player exists but no stats
  if (displayStats.length === 0) {
    return (
      <div ref={containerRef} style={containerStyle}>
        <div
          style={backgroundStyle}
          onMouseEnter={() => setIsHovering(true)}
          onMouseLeave={() => setIsHovering(false)}
        >
          <DragHandle isHovering={isHovering} onMouseDown={handleMouseDown} />
          <div style={styles.header}>
            <span style={{ ...styles.playerName, color: '#888888' }}>
              {playerName || `Player ${props.stat.playerId}`}
            </span>
            <PlayerTypeIcons />
          </div>
          <div style={{
            padding: '4px 6px',
            textAlign: 'center',
            minHeight: '20px',
          }}>
            <span style={{ color: '#888888', fontSize: '9px' }}>No Data</span>
          </div>
        </div>
      </div>
    )
  }
  
  // Normal HUD with stats
  return (
    <>
      {/* Real-time stats for hero (independent positioning) */}
      {props.actualSeatIndex === 0 && props.realTimeStats && (
        <RealTimeStatsDisplay stats={props.realTimeStats} seatIndex={props.actualSeatIndex} />
      )}
      
      {/* Regular HUD */}
      <div ref={containerRef} style={containerStyle}>
        <div
          style={{
            ...backgroundStyle,
            ...styles.clickable,
          }}
          onClick={copyStatsToClipboard}
          onMouseEnter={() => setIsHovering(true)}
          onMouseLeave={() => setIsHovering(false)}
          title="Click to copy stats to clipboard"
        >
          <DragHandle isHovering={isHovering} onMouseDown={handleMouseDown} />
          <HudHeader playerName={playerName} playerId={props.stat.playerId} playerPotOdds={props.playerPotOdds} />
          <StatDisplay displayStats={displayStats} formatValue={formatStatValue} />
        </div>
      </div>
    </>
  )
}, (prevProps, nextProps) => {
  if (prevProps.actualSeatIndex !== nextProps.actualSeatIndex) return false
  if (prevProps.stat.playerId !== nextProps.stat.playerId) return false
  if (prevProps.scale !== nextProps.scale) return false
  
  // Check real-time stats changes for hero
  if (prevProps.actualSeatIndex === 0) {
    if (prevProps.realTimeStats !== nextProps.realTimeStats) return false
  }
  
  if (prevProps.stat.playerId === EMPTY_SEAT_ID && nextProps.stat.playerId === EMPTY_SEAT_ID) return true
  
  const prevHasResults = 'statResults' in prevProps.stat
  const nextHasResults = 'statResults' in nextProps.stat
  
  if (!prevHasResults && !nextHasResults) return true
  if (!prevHasResults || !nextHasResults) return false
  
  const prevResults = prevProps.stat.statResults!
  const nextResults = nextProps.stat.statResults!
  
  if (prevResults.length !== nextResults.length) return false
  
  return prevResults.every((prev: StatResult, i: number) => {
    const next = nextResults[i]
    return prev.id === next?.id &&
      prev.value === next?.value &&
      prev.formatted === next?.formatted
  })
})

export default Hud