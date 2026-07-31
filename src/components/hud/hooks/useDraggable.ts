import { useState, useRef, useEffect, useCallback } from 'react'
import type { CSSProperties } from 'react'
import type { HudPosition } from '../../../types/messages'
import {
  loadHudPosition,
  saveHudPosition,
} from '../../../utils/ui-config-storage'

interface DragState {
  startX: number
  startY: number
  startLeft: number
  startTop: number
}

export const useDraggable = (seatIndex: number, defaultPosition: CSSProperties) => {
  const [isDragging, setIsDragging] = useState(false)
  const [position, setPosition] = useState<HudPosition | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const shouldPersistPositionRef = useRef(false)
  const positionEditGenerationRef = useRef(0)
  const containerRef = useRef<HTMLDivElement>(null)

  // Layout is device-local because each device can have a different viewport.
  useEffect(() => {
    const loadGeneration = positionEditGenerationRef.current
    loadHudPosition(seatIndex, savedPosition => {
      if (
        savedPosition &&
        positionEditGenerationRef.current === loadGeneration
      ) {
        setPosition(savedPosition)
      }
    })
  }, [seatIndex])

  // Persist only after drag completion; inactive/stale tabs do not write.
  useEffect(() => {
    if (position && !isDragging && shouldPersistPositionRef.current) {
      shouldPersistPositionRef.current = false
      saveHudPosition(seatIndex, position)
    }
  }, [position, seatIndex, isDragging])

  // ポップアップの「位置とサイズをリセット」。バックグラウンドが
  // storage.local から hudPosition_* を消し、ゲームタブへ配信してくる。
  // 保存済みの位置を捨てて defaultPosition の描画へ戻すだけで、
  // ここからは書き戻さない（storageは背景側で既に空になっている）。
  useEffect(() => {
    const handleReset = () => {
      // A reset is newer than any in-flight startup read. Without this bump a
      // loadHudPosition callback still in flight would restore the position
      // that was just cleared.
      positionEditGenerationRef.current += 1
      // 進行中のドラッグは破棄する。残すとmousemoveが掴んだ時点の
      // startLeft/startTopから再開し、消したはずの位置を書き戻してしまう。
      dragRef.current = null
      shouldPersistPositionRef.current = false
      setIsDragging(false)
      setPosition(null)
    }
    window.addEventListener('resetHudPositions', handleReset)
    return () => {
      window.removeEventListener('resetHudPositions', handleReset)
    }
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return

    // A pointer interaction is newer than any in-flight startup read. Ignore
    // a saved position that arrives after this point so it cannot snap the HUD
    // back or be persisted over the user's drag.
    positionEditGenerationRef.current += 1

    const currentLeft = position?.left ? parseFloat(position.left) : parseFloat((defaultPosition?.left as string) || '0')
    const currentTop = position?.top ? parseFloat(position.top) : parseFloat((defaultPosition?.top as string) || '0')

    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startLeft: (currentLeft / 100) * window.innerWidth,
      startTop: (currentTop / 100) * window.innerHeight
    }

    setIsDragging(true)
  }, [position, defaultPosition])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current || !containerRef.current) return

      const deltaX = e.clientX - dragRef.current.startX
      const deltaY = e.clientY - dragRef.current.startY

      const newLeft = ((dragRef.current.startLeft + deltaX) / window.innerWidth) * 100
      const newTop = ((dragRef.current.startTop + deltaY) / window.innerHeight) * 100

      const clampedLeft = Math.max(0, Math.min(90, newLeft))
      const clampedTop = Math.max(0, Math.min(90, newTop))

      shouldPersistPositionRef.current = true
      setPosition({
        left: `${clampedLeft}%`,
        top: `${clampedTop}%`
      })
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      dragRef.current = null
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

  return {
    containerRef,
    isDragging,
    position,
    handleMouseDown
  }
}
