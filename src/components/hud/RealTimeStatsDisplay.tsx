import { memo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { RealTimeStats } from '../../realtime-stats/realtime-stats-service'
import { getStartingHandRanking } from '../../utils/starting-hand-rankings'
import { useDraggable } from './hooks/useDraggable'
import { DragHandle } from './DragHandle'

interface RealTimeStatsDisplayProps {
  stats: RealTimeStats
  seatIndex: number
}

const REALTIME_HUD_WIDTH = 200  // リアルタイム統計専用の幅

export const RealTimeStatsDisplay = memo(({ stats, seatIndex }: RealTimeStatsDisplayProps) => {
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
            {(() => {
              const handInfo = getStartingHandRanking(stats.holeCards)
              if (!handInfo) return null
              
              // Get color based on ranking strength
              let rankingColor = '#ffffff'
              if (handInfo.ranking <= 10) {
                rankingColor = '#ff6b6b'  // Red for premium hands
              } else if (handInfo.ranking <= 30) {
                rankingColor = '#ffd93d'  // Yellow for strong hands
              } else if (handInfo.ranking <= 60) {
                rankingColor = '#6bcf7f'  // Green for good hands
              } else if (handInfo.ranking <= 100) {
                rankingColor = '#95e1d3'  // Light blue for playable hands
              } else {
                rankingColor = '#95a5a6'  // Gray for weak hands
              }
              
              return (
                <span style={{ 
                  fontSize: '10px', 
                  color: rankingColor,
                  fontWeight: '600',
                  letterSpacing: '0.5px',
                  textShadow: '0 1px 2px rgba(0, 0, 0, 0.5)'
                }}
                title={`${handInfo.ranking}位/169位`}>
                  {handInfo.notation} ({handInfo.ranking}/169)
                </span>
              )
            })()}
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

RealTimeStatsDisplay.displayName = 'RealTimeStatsDisplay'