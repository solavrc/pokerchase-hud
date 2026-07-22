import { memo } from 'react'
import type { CSSProperties } from 'react'
import type { StatResult } from '../../types/stats'
import { PlayerTypeIcons } from './PlayerTypeIcons'
import { PositionalPanelTrigger } from './PositionalPanelTrigger'
import { RecentHandsPanelTrigger } from './RecentHandsPanelTrigger'
import { HUD_MUTED_TEXT_COLOR } from './hudColors'

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
  /** ポジション別ドリルダウンパネルが開いているか（未指定ならトリガー自体を表示しない） */
  isPositionalPanelOpen?: boolean
  /** ドリルダウンパネルの開閉トグル。渡された時のみトリガーを表示する */
  onTogglePositionalPanel?: () => void
  /** 直近ハンド・ドリルダウンパネルが開いているか（未指定ならトリガー自体を表示しない） */
  isRecentHandsPanelOpen?: boolean
  /** 直近ハンド・ドリルダウンパネルの開閉トグル。渡された時のみトリガーを表示する */
  onToggleRecentHandsPanel?: () => void
  /** プレイヤータイプ分類アイコン（PlayerTypeIcons）に渡す、フィルタ前の全statResults */
  statResults?: StatResult[]
  /** bustしたプレイヤーの薄暗い表示中かどうか（Hud.tsx参照）。trueなら「離席」バッジを出す */
  isDimmed?: boolean
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

  dimmedBadge: {
    fontSize: '8px',
    fontWeight: 'bold',
    color: '#ffcc66',
    border: '1px solid rgba(255, 204, 102, 0.5)',
    borderRadius: '3px',
    padding: '0 3px',
    letterSpacing: '0.2px',
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
  } as CSSProperties,
}

export const HudHeader = memo(({ playerName, playerId, playerPotOdds, isPositionalPanelOpen, onTogglePositionalPanel, isRecentHandsPanelOpen, onToggleRecentHandsPanel, statResults, isDimmed }: HudHeaderProps) => {
  const hasPotOdds = playerPotOdds?.potOdds && playerPotOdds.potOdds.call > 0
  const hasSpr = playerPotOdds?.spr !== undefined
  const potOddsTooltip = 'ポットオッズ: コールに必要な最低勝率。式: コール額 ÷（メインポット＋全サイドポット＋コール額）'
  const sprTooltip = 'SPR: このプレイヤーの残りスタックと現在のポット総額の比。式: 残りスタック ÷（メインポット＋全サイドポット）'
  
  return (
    <div style={styles.header}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: '4px' }}>
        <span style={{ ...styles.playerName, flex: '0 1 auto', minWidth: 0 }} title={playerName || 'Unknown'}>
          {playerName || `Player ${playerId}`}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '9px', flex: '0 0 auto' }}>
          {isDimmed && (
            <span style={styles.dimmedBadge} title="このプレイヤーは現在の卓にいません（bust/離席）。表示は最後の統計のままです">
              離席
            </span>
          )}
          {hasPotOdds && (
            <span
              title={potOddsTooltip}
              aria-label={`ポットオッズ ${playerPotOdds.potOdds!.percentage.toFixed(0)}%。${potOddsTooltip}`}
              style={{
                color: playerPotOdds.potOdds!.isPlayerTurn ? '#00ff00' : HUD_MUTED_TEXT_COLOR,
                fontWeight: playerPotOdds.potOdds!.isPlayerTurn ? 'bold' : 'normal',
                whiteSpace: 'nowrap'
              }}
            >
              {playerPotOdds.potOdds!.percentage.toFixed(0)}%
            </span>
          )}
          {hasSpr && (
            <span
              title={sprTooltip}
              aria-label={`SPR ${playerPotOdds.spr}。${sprTooltip}`}
              style={{ color: '#ffcc00', fontWeight: 'bold', whiteSpace: 'nowrap' }}
            >
              {playerPotOdds.spr}
            </span>
          )}
          {onTogglePositionalPanel && (
            <PositionalPanelTrigger
              playerName={playerName}
              playerId={playerId}
              isOpen={isPositionalPanelOpen}
              onToggle={onTogglePositionalPanel}
            />
          )}
          {onToggleRecentHandsPanel && (
            <RecentHandsPanelTrigger
              playerName={playerName}
              playerId={playerId}
              isOpen={isRecentHandsPanelOpen}
              onToggle={onToggleRecentHandsPanel}
            />
          )}
        </div>
      </div>
      <PlayerTypeIcons statResults={statResults} />
    </div>
  )
})

HudHeader.displayName = 'HudHeader'
