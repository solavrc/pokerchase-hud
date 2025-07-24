import { memo } from 'react'
import type { CSSProperties } from 'react'

const styles = {
  playerTypeIcons: {
    display: 'flex',
    gap: '4px',
    fontSize: '10px',
    opacity: 0.4,
    marginLeft: '4px',
  } as CSSProperties,
}

export const PlayerTypeIcons = memo(() => (
  <div style={styles.playerTypeIcons}>
    <span>🐟</span>
    <span>🦈</span>
  </div>
))

PlayerTypeIcons.displayName = 'PlayerTypeIcons'