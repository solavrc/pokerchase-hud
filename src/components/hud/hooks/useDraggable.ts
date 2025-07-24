import { useState, useRef, useEffect, useCallback } from 'react'
import type { CSSProperties } from 'react'

interface HudPosition {
  top: string
  left: string
}

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
  const containerRef = useRef<HTMLDivElement>(null)

  // Load saved position
  useEffect(() => {
    chrome.storage.sync.get(`hudPosition_${seatIndex}`, (result) => {
      const savedPosition = result[`hudPosition_${seatIndex}`]
      if (savedPosition) {
        setPosition(savedPosition)
      }
    })
  }, [seatIndex])

  // Save position
  useEffect(() => {
    if (position && !isDragging) {
      chrome.storage.sync.set({
        [`hudPosition_${seatIndex}`]: position
      })
    }
  }, [position, seatIndex, isDragging])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return

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