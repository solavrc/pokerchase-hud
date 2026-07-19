import { memo } from 'react'
import type { CSSProperties } from 'react'
import type { StatResult } from '../../types/stats'
import { classifyPlayerType } from './playerTypeRules'

interface PlayerTypeIconsProps {
  /** Full/unfiltered statResults for this player (see playerTypeRules.ts for the required ids and n-gates). */
  statResults?: StatResult[]
}

const styles = {
  playerTypeIcon: {
    fontSize: '10px',
    marginLeft: '4px',
    lineHeight: 1,
  } as CSSProperties,
}

/**
 * HM-style player-type classification icon shown in the HUD header (sola-
 * approved spec, replaces the old decorative 🐟/🦈 placeholder pair).
 *
 * Renders a single icon with the classifier's real-numbers explanation as
 * the native `title` tooltip, or nothing at all when the sample is too
 * small to classify (see classifyPlayerType's n-gates) -- an unplaceable
 * player shows no icon rather than a guess. Shared by both compact and
 * full HUD display modes since HudHeader itself doesn't vary by mode.
 */
export const PlayerTypeIcons = memo(({ statResults }: PlayerTypeIconsProps) => {
  const classification = classifyPlayerType(statResults)
  if (!classification) return null

  return (
    <span style={styles.playerTypeIcon} title={classification.reason} data-player-type={classification.type}>
      {classification.icon}
    </span>
  )
})

PlayerTypeIcons.displayName = 'PlayerTypeIcons'
