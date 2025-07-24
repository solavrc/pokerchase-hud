import { memo } from 'react'
import type { CSSProperties } from 'react'

interface DragHandleProps {
  isHovering: boolean
  onMouseDown: (e: React.MouseEvent) => void
}

const DRAG_OPACITY = 0.3

const styles = {
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
}

export const DragHandle = memo(({ isHovering, onMouseDown }: DragHandleProps) => (
  <div
    style={{
      ...styles.dragHandle,
      opacity: isHovering ? DRAG_OPACITY : 0,
    }}
    onMouseDown={onMouseDown}
  />
))

DragHandle.displayName = 'DragHandle'