/**
 * HandLogコンポーネント - 最適化バージョン
 * バーチャル化を使用したリアルタイムハンド履歴ログオーバーレイ
 */

import React, { useState, useEffect, useRef, CSSProperties, useCallback, useMemo, memo } from 'react'
import { List, useListRef } from 'react-window'
import {
  HandLogEntry,
  HandLogEntryType,
  HandLogConfig,
  HandLogLayout,
  DEFAULT_HAND_LOG_CONFIG
} from '../types/hand-log'
import { formatHandLogEntries } from '../utils/hand-log-text'
import {
  HAND_LOG_MIN_HEIGHT,
  HAND_LOG_MIN_WIDTH,
  loadHandLogLayout,
  saveHandLogLayout,
} from '../utils/ui-config-storage'

interface HandLogProps {
  entries: HandLogEntry[]
  config?: Partial<HandLogConfig>
  onClearLog?: () => void
  scale?: number
  scrollToLatest?: boolean
}

const getPositionStyles = (position: string): CSSProperties => {
  const offset = 10
  const bottomOffset = 135  // 125px持ち上げるため、10 + 125 = 135
  const defaultPosition: CSSProperties = { bottom: bottomOffset, right: offset }

  switch (position) {
    case 'bottom-right':
      return { bottom: bottomOffset, right: offset }
    case 'bottom-left':
      return { bottom: bottomOffset, left: offset }
    case 'top-right':
      return { top: offset, right: offset }
    case 'top-left':
      return { top: offset, left: offset }
    default:
      return defaultPosition
  }
}

const HAND_LOG_GRIP_SIZE = 28
const HAND_LOG_DRAG_THRESHOLD = 4

type HandLogInteractionMode = 'move' | 'resize'

interface HandLogInteraction {
  mode: HandLogInteractionMode
  startX: number
  startY: number
  startLayout: HandLogLayout
  moved: boolean
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const entryTypeColors: Record<HandLogEntryType, string> = {
  [HandLogEntryType.HEADER]: '#ffffff',
  [HandLogEntryType.SEAT]: '#aaaaaa',
  [HandLogEntryType.CARDS]: '#ffcc00',
  [HandLogEntryType.ACTION]: '#cccccc',
  [HandLogEntryType.STREET]: '#00ccff',
  [HandLogEntryType.SHOWDOWN]: '#ffcc00',
  [HandLogEntryType.SUMMARY]: '#aaaaaa',
  [HandLogEntryType.SYSTEM]: '#ff6666'
}

const formatTimestamp = (timestamp: number): string => {
  const date = new Date(timestamp)
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

interface EntryRowData {
  items: Array<{ entry: HandLogEntry, isSeparator: boolean }>
  showTimestamps: boolean
  copiedHandId: number | null
  onEntryClick: (entry: HandLogEntry) => void
  fontSize: number
}

const EntryRow = ({ index, style, items, showTimestamps, copiedHandId, onEntryClick, fontSize }: {
  index: number
  style: CSSProperties
  ariaAttributes: {
    'aria-posinset': number
    'aria-setsize': number
    role: 'listitem'
  }
} & EntryRowData): React.ReactElement | null => {
  const item = items[index]

  if (!item) return null

  if (item.isSeparator) {
    return (
      <div style={{
        ...style,
        display: 'flex',
        alignItems: 'center',
        padding: '0 8px'
      }}>
        <div style={{
          borderTop: '1px solid rgba(255, 255, 255, 0.2)',
          width: '100%',
          opacity: 0.5
        }} />
      </div>
    )
  }

  const { entry } = item
  const [isHovered, setIsHovered] = useState(false)

  const entryStyle: CSSProperties = {
    color: entryTypeColors[entry.type],
    lineHeight: 1.2,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    opacity: entry.type === HandLogEntryType.SEAT ? 0.8 : 1,
    cursor: 'pointer',
    transition: 'background-color 0.1s ease',
    backgroundColor: isHovered
      ? 'rgba(255, 255, 255, 0.1)'
      : copiedHandId === entry.handId
        ? 'rgba(0, 200, 0, 0.2)'
        : 'transparent',
    padding: '1px 8px',
    fontSize
  }

  const timestampStyle: CSSProperties = {
    color: '#666666',
    fontSize: fontSize - 2,
    marginRight: '8px'
  }

  return (
    <div
      style={{ ...style, ...entryStyle }}
      onClick={() => onEntryClick(entry)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {showTimestamps && (
        <span style={timestampStyle}>
          [{formatTimestamp(entry.timestamp)}]
        </span>
      )}
      {entry.text}
    </div>
  )
}

const HandLog = memo<HandLogProps>(({ entries, config: userConfig, onClearLog, scale = 1, scrollToLatest }) => {
  const config = useMemo(() => ({ ...DEFAULT_HAND_LOG_CONFIG, ...userConfig }), [userConfig])
  const listRef = useListRef(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [copiedHandId, setCopiedHandId] = useState<number | null>(null)
  const [layout, setLayout] = useState<HandLogLayout | null>(null)
  const layoutRef = useRef<HandLogLayout | null>(null)
  const layoutEditGenerationRef = useRef(0)
  const interactionRef = useRef<HandLogInteraction | null>(null)
  const [interactionMode, setInteractionMode] = useState<HandLogInteractionMode | null>(null)
  const [showCopied, setShowCopied] = useState(false)
  const [showCleared, setShowCleared] = useState(false)
  const lastClickTimeRef = useRef<number>(0)

  const applyLayout = useCallback((nextLayout: HandLogLayout | null) => {
    layoutRef.current = nextLayout
    setLayout(nextLayout)
  }, [])

  // セパレーターを追加するためエントリを処理
  const processedItems = useMemo(() => {
    const items: Array<{ entry: HandLogEntry, isSeparator: boolean }> = []
    const handGroups = new Map<number | undefined, HandLogEntry[]>()

    // handIdでエントリをグループ化
    entries.forEach(entry => {
      const group = handGroups.get(entry.handId) || []
      group.push(entry)
      handGroups.set(entry.handId, group)
    })

    // セパレーター付きでエントリを追加
    let isFirstHand = true
    handGroups.forEach((handEntries, handId) => {
      if (!isFirstHand && handId !== undefined) {
        items.push({ entry: handEntries[0]!, isSeparator: true })
      }
      isFirstHand = false

      handEntries.forEach(entry => {
        items.push({ entry, isSeparator: false })
      })
    })

    return items
  }, [entries])

  // アイテムの高さを計算
  const getItemSize = useCallback((index: number) => {
    const item = processedItems[index]
    if (!item) return 0
    if (item.isSeparator) return 10

    // テキストの長さとフォントサイズに基づいて高さを推定
    const lines = Math.ceil(item.entry.text.length / 60)
    return lines * (config.fontSize * 1.2) + 2
  }, [processedItems, config.fontSize])

  // Position and size are device-local. Read once on mount; another tab does
  // not need live synchronization because PokerChase permits one active login.
  useEffect(() => {
    const loadGeneration = layoutEditGenerationRef.current
    loadHandLogLayout(savedLayout => {
      if (
        savedLayout &&
        layoutEditGenerationRef.current === loadGeneration
      ) {
        const pendingInteraction = interactionRef.current
        if (pendingInteraction && !pendingInteraction.moved) {
          pendingInteraction.startLayout = savedLayout
        }
        applyLayout(savedLayout)
      }
    })
  }, [applyLayout])

  // The popup reset is delivered to open game tabs after the local value is
  // removed. A reload is not required for the visible panel to recover.
  useEffect(() => {
    const handleReset = () => {
      layoutEditGenerationRef.current += 1
      applyLayout(null)
    }
    window.addEventListener('resetHandLogLayout', handleReset)
    return () => window.removeEventListener('resetHandLogLayout', handleReset)
  }, [applyLayout])

  // 新しいエントリが到着したとき自動的に下にスクロール
  useEffect(() => {
    if (listRef.current && processedItems.length > 0) {
      listRef.current.scrollToRow({ index: processedItems.length - 1, align: "end" })
    }
  }, [processedItems.length])
  
  // 外部クリックでスクロールをトリガー
  useEffect(() => {
    if (scrollToLatest && listRef.current && processedItems.length > 0) {
      listRef.current.scrollToRow({ index: processedItems.length - 1, align: "end" })
    }
  }, [scrollToLatest, processedItems.length])

  // ハンドをクリップボードにコピー
  const copyHandToClipboard = useCallback(async (handId: number | undefined) => {
    try {
      if (!handId) {
        console.warn('No handId found for clicked entry')
        return
      }

      const handEntries = entries.filter(e => e.handId === handId)
      if (handEntries.length === 0) {
        console.warn('No entries found for handId:', handId)
        return
      }

      const logText = formatHandLogEntries(handEntries)

      await navigator.clipboard.writeText(logText)
      setCopiedHandId(handId)
      setShowCopied(true)

      setTimeout(() => {
        setShowCopied(false)
        setCopiedHandId(null)
      }, 1500)
    } catch (error) {
      console.error('Failed to copy hand to clipboard:', error)
    }
  }, [entries])

  // エントリクリックを処理
  const handleEntryClick = useCallback((entry: HandLogEntry) => {
    copyHandToClipboard(entry.handId)
  }, [copyHandToClipboard])

  // コンテナクリックを処理 - ダブルクリックでクリア
  const handleContainerClick = useCallback((_e: React.MouseEvent) => {
    if (interactionMode) return

    const currentTime = Date.now()
    const timeSinceLastClick = currentTime - lastClickTimeRef.current
    lastClickTimeRef.current = currentTime

    if (timeSinceLastClick < 300 && onClearLog) {
      onClearLog()
      setShowCleared(true)
      setTimeout(() => setShowCleared(false), 1500)
    }
  }, [interactionMode, onClearLog])

  const handleInteractionStart = useCallback((
    mode: HandLogInteractionMode,
    e: React.MouseEvent
  ) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()

    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return

    const currentLayout = layoutRef.current
    interactionRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      startLayout: {
        left: currentLayout?.left ?? rect.left,
        top: currentLayout?.top ?? rect.top,
        width: currentLayout?.width ?? DEFAULT_HAND_LOG_CONFIG.width,
        height: currentLayout?.height ?? DEFAULT_HAND_LOG_CONFIG.height,
      },
      moved: false,
    }
    setInteractionMode(mode)
  }, [])

  useEffect(() => {
    if (!interactionMode) return

    const cursor = interactionMode === 'move' ? 'grabbing' : 'nwse-resize'
    document.body.style.cursor = cursor
    document.body.style.userSelect = 'none'

    const handleMouseMove = (event: MouseEvent) => {
      const interaction = interactionRef.current
      if (!interaction) return

      const deltaX = event.clientX - interaction.startX
      const deltaY = event.clientY - interaction.startY
      if (
        !interaction.moved &&
        Math.hypot(deltaX, deltaY) < HAND_LOG_DRAG_THRESHOLD
      ) {
        return
      }
      const { startLayout } = interaction
      let nextLayout: HandLogLayout

      if (interaction.mode === 'move') {
        const renderedWidth = startLayout.width * scale
        const renderedHeight = startLayout.height * scale
        nextLayout = {
          ...startLayout,
          // Clamp only while the user is moving the panel. This keeps the
          // lower-right grip reachable without reacting to later viewport
          // changes or rewriting the saved coordinates on load.
          left: clamp(
            startLayout.left + deltaX,
            HAND_LOG_GRIP_SIZE - renderedWidth,
            window.innerWidth - renderedWidth
          ),
          top: clamp(
            startLayout.top + deltaY,
            HAND_LOG_GRIP_SIZE - renderedHeight,
            window.innerHeight - renderedHeight
          ),
        }
      } else {
        nextLayout = {
          ...startLayout,
          width: Math.max(
            HAND_LOG_MIN_WIDTH,
            startLayout.width + deltaX / scale
          ),
          height: Math.max(
            HAND_LOG_MIN_HEIGHT,
            startLayout.height + deltaY / scale
          ),
        }
      }

      if (!interaction.moved) {
        layoutEditGenerationRef.current += 1
        interaction.moved = true
      }
      applyLayout(nextLayout)
    }

    const finalizeInteraction = () => {
      const interaction = interactionRef.current
      const finalLayout = layoutRef.current
      if (interaction?.moved && finalLayout) {
        saveHandLogLayout(finalLayout)
      }
      interactionRef.current = null
    }

    const finishInteraction = () => {
      finalizeInteraction()
      setInteractionMode(null)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', finishInteraction)
    document.addEventListener('mouseleave', finishInteraction)
    window.addEventListener('blur', finishInteraction)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', finishInteraction)
      document.removeEventListener('mouseleave', finishInteraction)
      window.removeEventListener('blur', finishInteraction)
      // Cleanup also runs when the HUD shortcut unmounts HandLog while the
      // mouse is still held. Persist the last visible layout before refs and
      // listeners disappear.
      finalizeInteraction()
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [applyLayout, interactionMode, scale])

  // 無効の場合はレンダリングしない
  if (!config.enabled) return null

  const width = layout?.width ?? DEFAULT_HAND_LOG_CONFIG.width
  const height = layout?.height ?? DEFAULT_HAND_LOG_CONFIG.height

  // コンテナスタイル
  const containerStyle: CSSProperties = {
    position: 'fixed',
    ...(layout
      ? { left: layout.left, top: layout.top }
      : getPositionStyles(DEFAULT_HAND_LOG_CONFIG.position)),
    width: width,
    height,
    backgroundColor: `rgba(0, 0, 0, ${config.opacity})`,
    backdropFilter: 'blur(4px)',
    border: '1px solid rgba(255, 255, 255, 0.2)',
    borderRadius: '4px',
    padding: '0',
    transform: `scale(${scale})`,
    transformOrigin: layout
      ? 'top left'
      : DEFAULT_HAND_LOG_CONFIG.position.replace('-', ' '),
    overflowY: 'hidden',
    overflowX: 'hidden',
    fontFamily: 'Consolas, Monaco, "Courier New", monospace',
    fontSize: config.fontSize,
    color: '#ffffff',
    // The lower-right grip is the only way to move or resize this window.
    // Keep its stacking context above player HUD panels (z-index 9999) so an
    // overlap can never make the grip unreachable.
    zIndex: 10000,
    boxShadow: '0 2px 4px rgba(0, 0, 0, 0.3)',
    cursor: 'pointer'
  }

  // One visible lower-right control owns both interactions: drag the main
  // surface to move, or drag its triangular outer corner to resize.
  const gripStyle: CSSProperties = {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: HAND_LOG_GRIP_SIZE,
    height: HAND_LOG_GRIP_SIZE,
    cursor: interactionMode === 'move' ? 'grabbing' : 'grab',
    backgroundColor: 'rgba(255, 255, 255, 0.14)',
    borderTopLeftRadius: 6,
    color: 'rgba(255, 255, 255, 0.75)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 15,
    lineHeight: 1,
    userSelect: 'none',
    zIndex: 2,
  }

  const resizeCornerStyle: CSSProperties = {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 12,
    height: 12,
    cursor: 'nwse-resize',
    background: 'linear-gradient(135deg, transparent 48%, rgba(255, 255, 255, 0.9) 50%)',
  }

  const rowProps: EntryRowData = {
    items: processedItems,
    showTimestamps: config.showTimestamps,
    copiedHandId,
    onEntryClick: handleEntryClick,
    fontSize: config.fontSize
  }

  return (
    <div
      ref={containerRef}
      style={containerStyle}
      onClick={handleContainerClick}
    >
      {processedItems.length > 0 ? (
        <List
          listRef={listRef}
          rowCount={processedItems.length}
          rowHeight={getItemSize}
          rowComponent={EntryRow}
          rowProps={rowProps}
          style={{ height, width }}
        />
      ) : (
        <div style={{
          color: '#666666',
          textAlign: 'center',
          marginTop: '40%',
          transform: 'translateY(-50%)',
          fontSize: config.fontSize - 1
        }}>
          Waiting for hand...
        </div>
      )}

      {/* 右下の移動兼リサイズグリップ */}
      <div
        data-testid="hand-log-move-grip"
        title="ドラッグしてハンドログを移動"
        style={gripStyle}
        onMouseDown={(event) => handleInteractionStart('move', event)}
        onClick={(event) => event.stopPropagation()}
      >
        ⠿
        <div
          data-testid="hand-log-resize-corner"
          title="ドラッグしてハンドログのサイズを変更"
          style={resizeCornerStyle}
          onMouseDown={(event) => handleInteractionStart('resize', event)}
          onClick={(event) => event.stopPropagation()}
        />
      </div>

      {/* ステータスインジケーター */}
      {showCopied && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          backgroundColor: 'rgba(0, 200, 0, 0.9)',
          color: 'white',
          padding: '8px 16px',
          borderRadius: '4px',
          fontWeight: 'bold',
          pointerEvents: 'none',
          zIndex: 1000
        }}>
          Copied Hand!
        </div>
      )}
      {showCleared && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          backgroundColor: 'rgba(200, 0, 0, 0.9)',
          color: 'white',
          padding: '8px 16px',
          borderRadius: '4px',
          fontWeight: 'bold',
          pointerEvents: 'none',
          zIndex: 1000
        }}>
          Cleared!
        </div>
      )}
    </div>
  )
})

HandLog.displayName = 'HandLog'

export default HandLog
