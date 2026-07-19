import { CSSProperties, useState, useCallback, useMemo, memo } from 'react'
import type { PlayerStats } from '../types'
import type { StatDisplayConfig } from '../types'
import type { StatResult } from '../types/stats'
import type { RealTimeStats } from '../realtime-stats/realtime-stats-service'
import { useDraggable } from './hud/hooks/useDraggable'
import { DragHandle } from './hud/DragHandle'
import { HudHeader } from './hud/HudHeader'
import { StatDisplay } from './hud/StatDisplay'
import { CompactStatDisplay } from './hud/CompactStatDisplay'
import { PlayerTypeIcons } from './hud/PlayerTypeIcons'
import { RealTimeStatsDisplay } from './hud/RealTimeStatsDisplay'
import { PositionalStatsPanel } from './hud/PositionalStatsPanel'
import { PositionalPanelTrigger } from './hud/PositionalPanelTrigger'

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
  /** ポジション別ドリルダウンパネルが開いているか（Appが単一のopenPlayerIdで管理） */
  isPositionalPanelOpen?: boolean
  /** ドリルダウンパネルの開閉トグル。渡された時のみヘッダーにトリガーを表示する */
  onTogglePositionalPanel?: () => void
  /** HUD表示密度。'full'（デフォルト、既存の16統計グリッド）または'compact'（クラシックHUDライン）。UIConfig.hudDisplayMode参照 */
  hudDisplayMode?: 'full' | 'compact'
  /** しきい値ベースの値カラーリング（compact/full両モード共通）。UIConfig.hudColorCoding参照 */
  hudColorCoding?: boolean
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

  expandableStatBody: {
    cursor: 'pointer',
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

/**
 * Filters the (unfiltered) displayStats tuples down to only the stats the
 * user has enabled via the HUD statistics settings (statDisplayConfigs).
 * Used for the full 16-stat grid and the clipboard copy.
 *
 * NOT used for CompactStatDisplay: read-entity-stream.ts always computes a
 * fixed set of compact-required stats (vpip/pfr/3bet/hands/af/cbet/steal,
 * see stats/compactStats.ts) regardless of the user's enabled flag, so that
 * the compact line's fixed format never silently blanks out a stat the
 * user merely hid from the full grid (PR #143 review). CompactStatDisplay
 * is handed the raw, unfiltered displayStats so it can still find those
 * stats even when this filter would have excluded them.
 */
const filterEnabledDisplayStats = (
  displayStats: Array<[string, any, StatResult?]>,
  statDisplayConfigs: StatDisplayConfig[]
): Array<[string, any, StatResult?]> => {
  const enabledIds = new Set(
    statDisplayConfigs.filter(config => config.enabled).map(config => config.id)
  )
  return displayStats.filter(([, , statResult]) => !!statResult && enabledIds.has(statResult.id))
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
  // クリックで展開する16統計グリッド（compactモードのみ）。パネルごとのローカル
  // state -- 各Hudインスタンスが自分のstateを持つため、複数プレイヤーを同時に
  // 展開できる。
  const [isStatBodyExpanded, setIsStatBodyExpanded] = useState(false)
  const defaultPosition = SEAT_POSITIONS[props.actualSeatIndex] || { top: '50%', left: '50%' }

  const {
    containerRef,
    isDragging,
    position,
    handleMouseDown
  } = useDraggable(props.actualSeatIndex, defaultPosition)

  // Unfiltered: every stat currently computed for this player (includes
  // compact-required stats even when the user disabled them, see
  // stats/compactStats.ts). Feed this to CompactStatDisplay directly.
  const displayStats = useMemo(() => getDisplayStats(props.stat), [props.stat])
  // Full-grid rows honor the user's HUD statistics visibility settings.
  const gridDisplayStats = useMemo(
    () => filterEnabledDisplayStats(displayStats, props.statDisplayConfigs),
    [displayStats, props.statDisplayConfigs]
  )
  const playerName = useMemo(() => getPlayerName(props.stat), [props.stat])
  // Unfiltered statResults for the player-type classification icon
  // (PlayerTypeIcons, via HudHeader) -- same "ignore the grid's enabled
  // filter" rationale as displayStats above, since the classifier's
  // required stats (vpip/af/vpipF) are forced on regardless of the user's
  // display config (see stats/compactStats.ts's CLASSIFIER_REQUIRED_STAT_IDS).
  const statResultsForHeader = 'statResults' in props.stat ? props.stat.statResults : undefined
  const scale = props.scale || 1
  const hudDisplayMode = props.hudDisplayMode || 'full'
  const hudColorCoding = props.hudColorCoding || false

  // compactモードの統計ボディをクリックすると16統計グリッドをその場で展開する
  // （#128のポジション別ドリルダウン用トリガーと同様、stopPropagationでHUD全体の
  // クリップボードコピーハンドラーへの伝播とドラッグ開始を断つ）。
  const toggleStatBodyExpand = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setIsStatBodyExpanded(prev => !prev)
  }, [])

  const copyStatsToClipboard = useCallback(async () => {
    try {
      let statsText = ''
      
      if (playerName) {
        statsText += `Player: ${playerName}\n`
        statsText += '---\n'
      }
      
      gridDisplayStats.forEach(([key, value, statResult]) => {
        const formattedValue = statResult?.formatted || formatStatValue(value as number | [number, number])
        statsText += `${key}: ${formattedValue}\n`
      })

      await navigator.clipboard.writeText(statsText.trim())
    } catch (error) {
      console.error('Failed to copy stats to clipboard:', error)
    }
  }, [gridDisplayStats, playerName])

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
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              {props.onTogglePositionalPanel && (
                <PositionalPanelTrigger
                  playerName={playerName}
                  playerId={props.stat.playerId}
                  isOpen={props.isPositionalPanelOpen}
                  onToggle={props.onTogglePositionalPanel}
                />
              )}
              <PlayerTypeIcons />
            </div>
          </div>
          <div style={{
            padding: '4px 6px',
            textAlign: 'center',
            minHeight: '20px',
          }}>
            <span style={{ color: '#888888', fontSize: '9px' }}>No Data</span>
          </div>
          {props.isPositionalPanelOpen && (
            <PositionalStatsPanel playerId={props.stat.playerId} />
          )}
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
          <HudHeader
            playerName={playerName}
            playerId={props.stat.playerId}
            playerPotOdds={props.playerPotOdds}
            isPositionalPanelOpen={props.isPositionalPanelOpen}
            onTogglePositionalPanel={props.onTogglePositionalPanel}
            statResults={statResultsForHeader}
          />
          {hudDisplayMode === 'compact' ? (
            <div
              style={styles.expandableStatBody}
              onClick={toggleStatBodyExpand}
              title={isStatBodyExpanded ? 'クリックで折りたたむ' : 'クリックで全統計を表示'}
            >
              {isStatBodyExpanded
                ? <StatDisplay displayStats={gridDisplayStats} formatValue={formatStatValue} colorCoding={hudColorCoding} />
                : <CompactStatDisplay displayStats={displayStats} colorCoding={hudColorCoding} />}
            </div>
          ) : (
            <StatDisplay displayStats={gridDisplayStats} formatValue={formatStatValue} colorCoding={hudColorCoding} />
          )}
          {props.isPositionalPanelOpen && (
            <PositionalStatsPanel playerId={props.stat.playerId} />
          )}
        </div>
      </div>
    </>
  )
}, (prevProps, nextProps) => {
  if (prevProps.actualSeatIndex !== nextProps.actualSeatIndex) return false
  if (prevProps.stat.playerId !== nextProps.stat.playerId) return false
  if (prevProps.scale !== nextProps.scale) return false
  if (prevProps.isPositionalPanelOpen !== nextProps.isPositionalPanelOpen) return false
  if (prevProps.hudDisplayMode !== nextProps.hudDisplayMode) return false
  if (prevProps.hudColorCoding !== nextProps.hudColorCoding) return false
  // statDisplayConfigs governs which stats reach the full grid
  // (filterEnabledDisplayStats) -- a config change must re-render even if
  // statResults itself is unchanged.
  if (prevProps.statDisplayConfigs !== nextProps.statDisplayConfigs) return false

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
      prev.formatted === next?.formatted &&
      prev.tooltip === next?.tooltip
  })
})

export default Hud