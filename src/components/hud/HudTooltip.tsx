import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface HudTooltipPosition {
  left: number
  top: number
}

interface HudTooltipPortalProps {
  children: ReactNode
  position?: HudTooltipPosition
}

const TOOLTIP_MARGIN = 8
const TOOLTIP_MAX_WIDTH = 280

const tooltipStyle = (position: HudTooltipPosition): CSSProperties => ({
  position: 'fixed',
  left: `${Math.min(
    Math.max(position.left, TOOLTIP_MARGIN),
    Math.max(TOOLTIP_MARGIN, window.innerWidth - TOOLTIP_MAX_WIDTH - TOOLTIP_MARGIN)
  )}px`,
  top: `${Math.min(position.top, Math.max(TOOLTIP_MARGIN, window.innerHeight - 64))}px`,
  zIndex: 2147483647,
  boxSizing: 'border-box',
  maxWidth: `min(${TOOLTIP_MAX_WIDTH}px, calc(100vw - ${TOOLTIP_MARGIN * 2}px))`,
  padding: '5px 7px',
  border: '1px solid rgba(255, 255, 255, 0.3)',
  borderRadius: '4px',
  backgroundColor: 'rgba(16, 16, 16, 0.96)',
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.5)',
  color: '#ffffff',
  fontFamily: 'sans-serif',
  fontSize: '11px',
  lineHeight: 1.4,
  whiteSpace: 'normal',
  pointerEvents: 'none',
  userSelect: 'none',
})

export const HudTooltipPortal = ({ children, position }: HudTooltipPortalProps) => {
  if (!position) return null

  return createPortal(
    <div role="tooltip" style={tooltipStyle(position)}>
      {children}
    </div>,
    document.body
  )
}

interface HudMetricProps {
  ariaLabel: string
  children: ReactNode
  style: CSSProperties
  tooltip: string
}

export const HudMetric = ({ ariaLabel, children, style, tooltip }: HudMetricProps) => {
  const [tooltipPosition, setTooltipPosition] = useState<HudTooltipPosition>()

  return (
    <>
      <span
        data-hud-metric="true"
        aria-label={ariaLabel}
        style={style}
        onMouseEnter={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          setTooltipPosition({ left: rect.left, top: rect.bottom + 6 })
        }}
        onMouseLeave={() => setTooltipPosition(undefined)}
      >
        {children}
      </span>
      <HudTooltipPortal position={tooltipPosition}>{tooltip}</HudTooltipPortal>
    </>
  )
}
