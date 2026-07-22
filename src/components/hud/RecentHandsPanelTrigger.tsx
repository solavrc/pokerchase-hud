import { memo } from 'react'
import type { CSSProperties } from 'react'

interface RecentHandsPanelTriggerProps {
  playerName: string | null
  playerId: number
  isOpen?: boolean
  onToggle: () => void
}

// PositionalPanelTrigger.tsxと同じ理由でposition+z-indexを明示し、DragHandle
// より手前に来るようにする。onMouseDown/onClickのstopPropagationでドラッグ
// 開始・クリップボードコピー（HUD全体のonClick）への伝播も断つ。
const style: CSSProperties = {
  position: 'relative',
  zIndex: 1,
  background: 'transparent',
  border: 'none',
  padding: 0,
  margin: '0 0 0 4px',
  cursor: 'pointer',
  fontSize: '9px',
  lineHeight: 1,
  flex: '0 0 auto',
}

// グリフ選定: 🂠（U+1F0A0、Playing Cards Unicodeブロック）はフォント対応が
// まちまちで9px表示では潰れる/tofu化しやすいため不採用。🃏（ジョーカー、
// 一般的な絵文字ブロック）も色付き絵文字レンダリングだと極小サイズで
// 判別しづらいため見送り、視認性を優先してプレーンなUnicodeグリフ「≡」
// （行の並び=直近ハンドの一覧、を素朴に表す）を採用。#128のポジション別
// トリガー（▸/▾三角形）と混同しないよう、色をシアン系（#66ccff）に分けて
// アクティブ状態を示す。E2Eスクリーンショットで実サイズの視認性を確認済み
// （e2e/out/recent-hands-*.png参照）。
export const RecentHandsPanelTrigger = memo(({ playerName, playerId, isOpen, onToggle }: RecentHandsPanelTriggerProps) => (
  <button
    type="button"
    style={{ ...style, color: isOpen ? '#66ccff' : '#aaaaaa' }}
    title="直近ハンド"
    aria-label={`${playerName || `Player ${playerId}`}の直近ハンドを${isOpen ? '閉じる' : '開く'}`}
    aria-expanded={isOpen ?? false}
    aria-controls={`recent-hands-panel-${playerId}`}
    onMouseDown={(e) => e.stopPropagation()}
    onClick={(e) => {
      e.stopPropagation()
      onToggle()
    }}
  >
    ≡
  </button>
))

RecentHandsPanelTrigger.displayName = 'RecentHandsPanelTrigger'
