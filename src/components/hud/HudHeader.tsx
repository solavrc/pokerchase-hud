import { memo } from 'react'
import type { CSSProperties } from 'react'
import { PlayerTypeIcons } from './PlayerTypeIcons'

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

interface HudHeaderProps {
  playerName: string | null
  playerId: number
  playerPotOdds?: PlayerPotOdds
}

const styles = {
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
}

export const HudHeader = memo(({ playerName, playerId, playerPotOdds }: HudHeaderProps) => {
  const hasPotOdds = playerPotOdds?.potOdds && playerPotOdds.potOdds.call > 0
  const hasSpr = playerPotOdds?.spr !== undefined
  
  return (
    <div style={styles.header}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: '4px' }}>
        <span style={{ ...styles.playerName, flex: '0 1 auto', minWidth: 0 }} title={playerName || 'Unknown'}>
          {playerName || `Player ${playerId}`}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '9px', flex: '0 0 auto' }}>
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

HudHeader.displayName = 'HudHeader'