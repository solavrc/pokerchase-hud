import { CSSProperties, useState, useCallback, useMemo, memo, useEffect, useRef } from 'react'
import { PlayerStats } from '../app'
import type { StatDisplayConfig } from '../types'
import type { StatResult } from '../types/stats'
import type { RealTimeStats } from '../realtime-stats/realtime-stats-service'
import { getStartingHandRanking } from '../utils/starting-hand-rankings'

// Types
interface HudPosition {
  top: string
  left: string
}

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

interface DragState {
  startX: number
  startY: number
  startLeft: number
  startTop: number
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
const REALTIME_HUD_WIDTH = 200  // リアルタイム統計専用の幅
const DRAG_OPACITY = 0.3
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
    fontSize: '9px',
    fontWeight: 'normal',
    color: '#cccccc',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    textAlign: 'center' as const,
    letterSpacing: '0.3px',
  } as CSSProperties,
  
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
  
  clickable: {
    cursor: 'pointer',
    transition: 'opacity 0.2s ease',
  } as CSSProperties,
  
  dragHandle: {
    cursor: 'move',
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '20px',
    opacity: 0,
    transition: 'opacity 0.2s ease',
  } as CSSProperties,
  
  playerTypeIcons: {
    display: 'flex',
    gap: '4px',
    fontSize: '10px',
    opacity: 0.4,
    marginLeft: '4px',
  } as CSSProperties,
}

// Custom hooks
const useDraggable = (seatIndex: number, defaultPosition: CSSProperties) => {
  const [isDragging, setIsDragging] = useState(false)
  const [position, setPosition] = useState<HudPosition | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Load saved position
  useEffect(() => {
    chrome.storage.sync.get(`hudPosition_${seatIndex}`, (result) => {
      const savedPosition = result[`hudPosition_${seatIndex}`]
      if (savedPosition) {
        setPosition(savedPosition)
      }
    })
  }, [seatIndex])

  // Save position
  useEffect(() => {
    if (position && !isDragging) {
      chrome.storage.sync.set({
        [`hudPosition_${seatIndex}`]: position
      })
    }
  }, [position, seatIndex, isDragging])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return

    const currentLeft = position?.left ? parseFloat(position.left) : parseFloat((defaultPosition?.left as string) || '0')
    const currentTop = position?.top ? parseFloat(position.top) : parseFloat((defaultPosition?.top as string) || '0')

    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startLeft: (currentLeft / 100) * window.innerWidth,
      startTop: (currentTop / 100) * window.innerHeight
    }

    setIsDragging(true)
  }, [position, defaultPosition])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current || !containerRef.current) return

      const deltaX = e.clientX - dragRef.current.startX
      const deltaY = e.clientY - dragRef.current.startY

      const newLeft = ((dragRef.current.startLeft + deltaX) / window.innerWidth) * 100
      const newTop = ((dragRef.current.startTop + deltaY) / window.innerHeight) * 100

      const clampedLeft = Math.max(0, Math.min(90, newLeft))
      const clampedTop = Math.max(0, Math.min(90, newTop))

      setPosition({
        left: `${clampedLeft}%`,
        top: `${clampedTop}%`
      })
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      dragRef.current = null
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

  return {
    containerRef,
    isDragging,
    position,
    handleMouseDown
  }
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



// Sub-components
const PlayerTypeIcons = memo(() => (
  <div style={styles.playerTypeIcons}>
    <span>🐟</span>
    <span>🦈</span>
  </div>
))

// Real-time stats display component
const RealTimeStatsDisplay = memo(({ stats, seatIndex }: { stats: RealTimeStats; seatIndex: number }) => {
  const [isHovering, setIsHovering] = useState(false)
  const defaultPosition: CSSProperties = { top: '70%', left: '25%' }
  
  const {
    containerRef,
    isDragging,
    position,
    handleMouseDown
  } = useDraggable(seatIndex + 100, defaultPosition) // Use seatIndex + 100 to avoid collision with regular HUD positions
  
  const hasStats = Object.keys(stats).length > 0
  
  
  if (!hasStats || !stats.handImprovement) return null
  
  const potOddsData = stats.potOdds?.value as { pot: number; call: number; percentage: number; ratio: string; isHeroTurn: boolean; spr?: number } | undefined
  const potOddsPercentage = potOddsData?.percentage
  const handImprovement = stats.handImprovement?.value as any
  
  if (!handImprovement || !handImprovement.improvements) return null
  
  const containerStyle: CSSProperties = {
    position: 'fixed',
    ...(position || defaultPosition),
    transform: 'translate(-50%, -50%)',
    zIndex: 9999,
    pointerEvents: isDragging ? 'auto' : 'none',
  }
  
  return (
    <div ref={containerRef} style={containerStyle}>
      <div 
        style={{
          backgroundColor: 'rgba(0, 0, 0, 0.6)',  // More transparent
          backdropFilter: 'blur(4px)',
          border: '1px solid rgba(255, 255, 255, 0.2)',
          borderRadius: '8px',
          fontSize: '10px',
          color: '#ffffff',
          pointerEvents: 'auto',
          userSelect: 'none',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
          margin: '4px',
          position: 'relative',
          cursor: isDragging ? 'move' : 'default',
          width: `${REALTIME_HUD_WIDTH}px`,
        }}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
      >
        <DragHandle isHovering={isHovering} onMouseDown={handleMouseDown} />
      {/* Header with hand ranking and pot odds */}
      <div style={{ padding: '6px 10px' }}>
        {/* First line: Hand ranking */}
        {stats.holeCards && (
          <div style={{ marginBottom: '2px' }}>
            <span style={{ 
              fontSize: '10px', 
              color: '#fff',
              fontWeight: '600',
              letterSpacing: '0.5px',
              textShadow: '0 1px 2px rgba(0, 0, 0, 0.5)'
            }}>
              {(() => {
                const handInfo = getStartingHandRanking(stats.holeCards)
                return handInfo ? `${handInfo.notation} (${handInfo.ranking}/169)` : ''
              })()}
            </span>
          </div>
        )}
        
        {/* Second line: Pot odds and SPR information */}
        {potOddsData && (
          <div style={{ height: '16px', display: 'flex', alignItems: 'center' }}>
            <span style={{ fontSize: '9px' }}>
              Pot {potOddsData.pot.toLocaleString()}
              {potOddsData.call > 0 && (
                <span style={{ color: potOddsData.isHeroTurn ? '#80c0ff' : '#888' }}>
                  {' / Call '}{potOddsData.call.toLocaleString()} ({potOddsData.percentage.toFixed(1)}%)
                </span>
              )}
              {potOddsData.spr !== undefined && (
                <span style={{ color: '#ddd', marginLeft: '8px' }}>
                  SPR: {potOddsData.spr}
                </span>
              )}
            </span>
          </div>
        )}
      </div>
      
      {/* Hand improvement table */}
      <div style={{ padding: '4px' }}>
        <table style={{ 
          width: '100%', 
          borderCollapse: 'collapse',
          fontSize: '9px'
        }}>
          <tbody>
            {handImprovement.improvements.map((improvement: any) => {
              const isCurrentHand = improvement.isCurrent
              const isComplete = improvement.isComplete
              const probability = improvement.probability
              const hasGoodOdds = potOddsData && potOddsData.call !== undefined && potOddsData.call > 0 && potOddsPercentage !== undefined && probability > potOddsPercentage && probability < 100
              const isBetterThanCurrent = improvement.rank > handImprovement.currentHand.rank
              
              let rowStyle: React.CSSProperties = {
                opacity: isCurrentHand ? 1 : (isBetterThanCurrent ? 0.9 : 0.5)
              }
              
              let cellStyle: React.CSSProperties = {
                padding: '2px 6px',
                borderBottom: '1px solid rgba(255, 255, 255, 0.05)'
              }
              
              if (isCurrentHand) {
                rowStyle.backgroundColor = 'rgba(255, 255, 255, 0.1)'
                rowStyle.fontWeight = 'bold'
              }
              
              const isWaitingForAction = !potOddsData?.isHeroTurn && potOddsData?.call === 0
              
              const probabilityColor = isComplete ? '#00ff00' : 
                                     isWaitingForAction ? '#cccccc' :  // Neutral color when waiting
                                     hasGoodOdds ? '#00ff00' : 
                                     probability > 0 ? '#ff6666' : '#666'
              
              return (
                <tr key={improvement.rank} style={rowStyle}>
                  <td style={{ ...cellStyle, textAlign: 'left' }}>
                    {improvement.name}
                  </td>
                  <td style={{ 
                    ...cellStyle, 
                    textAlign: 'right',
                    color: probabilityColor
                  }}>
                    {probability.toFixed(1)}%
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      </div>
    </div>
  )
})

const DragHandle = memo(({ isHovering, onMouseDown }: { isHovering: boolean, onMouseDown: (e: React.MouseEvent) => void }) => (
  <div
    style={{
      ...styles.dragHandle,
      opacity: isHovering ? DRAG_OPACITY : 0,
    }}
    onMouseDown={onMouseDown}
  />
))

const HudHeader = memo(({ playerName, playerId, playerPotOdds }: { 
  playerName: string | null, 
  playerId: number,
  playerPotOdds?: PlayerPotOdds 
}) => {
  const hasPotOdds = playerPotOdds?.potOdds && playerPotOdds.potOdds.call > 0
  const hasSpr = playerPotOdds?.spr !== undefined
  
  return (
    <div style={styles.header}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: '4px' }}>
        <span style={{ ...styles.playerName, flex: '0 1 auto', minWidth: 0 }} title={playerName || 'Unknown'}>
          {playerName || `Player ${playerId}`}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '7px', flex: '0 0 auto' }}>
          {hasSpr && (
            <span style={{ color: '#ffcc00', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
              SPR:{playerPotOdds.spr}
            </span>
          )}
          {hasPotOdds && (
            <span style={{ 
              color: playerPotOdds.potOdds!.isPlayerTurn ? '#00ff00' : '#888',
              fontWeight: playerPotOdds.potOdds!.isPlayerTurn ? 'bold' : 'normal',
              whiteSpace: 'nowrap'
            }}>
              {playerPotOdds.potOdds!.pot}/{playerPotOdds.potOdds!.call} ({playerPotOdds.potOdds!.percentage.toFixed(0)}%)
            </span>
          )}
        </div>
      </div>
      <PlayerTypeIcons />
    </div>
  )
})

const StatDisplay = memo(({ displayStats, formatValue }: { 
  displayStats: Array<[string, any, StatResult?]>, 
  formatValue: (value: number | [number, number]) => string 
}) => (
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