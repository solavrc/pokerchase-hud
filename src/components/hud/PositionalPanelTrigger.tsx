import { memo } from 'react'
import type { CSSProperties } from 'react'

interface PositionalPanelTriggerProps {
  playerName: string | null
  playerId: number
  isOpen?: boolean
  onToggle: () => void
}

// DragHandle（position:absolute, height:20px, z-index:auto）はヘッダー行の上に
// 重なってヒットテスト上の最前面になる。このトリガーは明示的なposition+z-indexで
// 常にDragHandleより手前に来るようにする。onMouseDown/onClickのstopPropagationで
// ドラッグ開始・クリックコピー（HUD全体のonClick）への伝播も断つ
const style: CSSProperties = {
  position: 'relative',
  zIndex: 1,
  background: 'transparent',
  border: 'none',
  padding: 0,
  margin: 0,
  cursor: 'pointer',
  fontSize: '9px',
  lineHeight: 1,
  flex: '0 0 auto',
}

export const PositionalPanelTrigger = memo(({ playerName, playerId, isOpen, onToggle }: PositionalPanelTriggerProps) => (
  <button
    type="button"
    style={{ ...style, color: isOpen ? '#ffcc00' : '#aaaaaa' }}
    title="ポジション別スタッツ"
    aria-label={`${playerName || `Player ${playerId}`}のポジション別スタッツを${isOpen ? '閉じる' : '開く'}`}
    aria-expanded={isOpen ?? false}
    onMouseDown={(e) => e.stopPropagation()}
    onClick={(e) => {
      e.stopPropagation()
      onToggle()
    }}
  >
    {isOpen ? '▾' : '▸'}
  </button>
))

PositionalPanelTrigger.displayName = 'PositionalPanelTrigger'
