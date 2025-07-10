/**
 * HandLogコンポーネント - 最適化バージョン
 * バーチャル化を使用したリアルタイムハンド履歴ログオーバーレイ
 */

import React, { useState, useEffect, useRef, CSSProperties, useCallback, useMemo, memo } from 'react'
import { VariableSizeList as List } from 'react-window'
import {
  HandLogEntry,
  HandLogEntryType,
  HandLogConfig,
  DEFAULT_HAND_LOG_CONFIG
} from '../types/hand-log'

interface HandLogProps {
  entries: HandLogEntry[]
  config?: Partial<HandLogConfig>
  onClearLog?: () => void
  scale?: number
}

const getPositionStyles = (position: string): CSSProperties => {
  const offset = 10
  const defaultPosition: CSSProperties = { bottom: offset, right: offset }
  
  switch (position) {
    case 'bottom-right':
      return { bottom: offset, right: offset }
    case 'bottom-left':
      return { bottom: offset, left: offset }
    case 'top-right':
      return { top: offset, right: offset }
    case 'top-left':
      return { top: offset, left: offset }
    default:
      return defaultPosition
  }
}

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

interface EntryRowProps {
  index: number
  style: CSSProperties
  data: {
    items: Array<{ entry: HandLogEntry, isSeparator: boolean }>
    showTimestamps: boolean
    copiedHandId: number | null
    onEntryClick: (entry: HandLogEntry) => void
    fontSize: number
  }
}

const EntryRow = memo(({ index, style, data }: EntryRowProps) => {
  const { items, showTimestamps, copiedHandId, onEntryClick, fontSize } = data
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
})

EntryRow.displayName = 'EntryRow'

const HandLog = memo<HandLogProps>(({ entries, config: userConfig, onClearLog, scale = 1 }) => {
  const config = useMemo(() => ({ ...DEFAULT_HAND_LOG_CONFIG, ...userConfig }), [userConfig])
  const listRef = useRef<List>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isHovered, setIsHovered] = useState(false)
  const [copiedHandId, setCopiedHandId] = useState<number | null>(null)
  const [width, setWidth] = useState(config.width)
  const [isResizing, setIsResizing] = useState(false)
  const [isResizeHovered, setIsResizeHovered] = useState(false)
  const [showCopied, setShowCopied] = useState(false)
  const [showCleared, setShowCleared] = useState(false)
  const lastClickTimeRef = useRef<number>(0)

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

  // ストレージから保存された幅を読み込み
  useEffect(() => {
    chrome.storage.sync.get('handLogConfig', (result) => {
      if (result.handLogConfig?.width) {
        setWidth(result.handLogConfig.width)
      }
    })
  }, [])

  // 新しいエントリが到着したとき自動的に下にスクロール
  useEffect(() => {
    if (listRef.current && processedItems.length > 0) {
      listRef.current.scrollToItem(processedItems.length - 1, 'end')
    }
  }, [processedItems.length])

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

      const logText = handEntries.map(e => e.text).join('\n')

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
    if (isResizing) return

    const currentTime = Date.now()
    const timeSinceLastClick = currentTime - lastClickTimeRef.current
    lastClickTimeRef.current = currentTime

    if (timeSinceLastClick < 300 && onClearLog) {
      onClearLog()
      setShowCleared(true)
      setTimeout(() => setShowCleared(false), 1500)
    }
  }, [isResizing, onClearLog])

  // リサイズを処理
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)

    const startX = e.clientX
    const startWidth = width
    const isRightSide = config.position.includes('right')

    document.body.style.cursor = 'ew-resize'

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - startX
      const newWidth = isRightSide
        ? Math.max(200, Math.min(600, startWidth - deltaX))
        : Math.max(200, Math.min(600, startWidth + deltaX))
      setWidth(newWidth)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      document.body.style.cursor = ''
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)

      chrome.storage.sync.get('handLogConfig', (result) => {
        const updatedConfig = { ...result.handLogConfig, width }
        chrome.storage.sync.set({ handLogConfig: updatedConfig })
      })
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [width, config.position])

  // 無効の場合はレンダリングしない
  if (!config.enabled) return null

  const isRightSide = config.position.includes('right')
  const expandedHeight = isHovered ? window.innerWidth / 16 * 9 - 30 : config.height

  // コンテナスタイル
  const containerStyle: CSSProperties = {
    position: 'fixed',
    ...getPositionStyles(config.position),
    width: width,
    height: expandedHeight,
    backgroundColor: `rgba(0, 0, 0, ${isHovered ? config.opacity + 0.1 : config.opacity})`,
    backdropFilter: 'blur(4px)',
    border: '1px solid rgba(255, 255, 255, 0.2)',
    borderRadius: '4px',
    padding: '6px',
    [isRightSide ? 'paddingLeft' : 'paddingRight']: '10px',
    transform: `scale(${scale})`,
    transformOrigin: config.position.replace('-', ' '),
    overflowY: 'hidden',
    overflowX: 'hidden',
    fontFamily: 'Consolas, Monaco, "Courier New", monospace',
    fontSize: config.fontSize,
    color: '#ffffff',
    zIndex: isHovered ? 10000 : 9998,
    transition: 'height 0.3s ease, background-color 0.2s ease, width 0.1s ease',
    boxShadow: isHovered ? '0 4px 12px rgba(0, 0, 0, 0.5)' : '0 2px 4px rgba(0, 0, 0, 0.3)',
    cursor: 'pointer'
  }

  // リサイズハンドルスタイル
  const resizeHandleStyle: CSSProperties = {
    position: 'absolute',
    [isRightSide ? 'left' : 'right']: 0,
    top: 0,
    bottom: 0,
    width: '4px',
    cursor: 'ew-resize',
    backgroundColor: isResizing
      ? 'rgba(255, 255, 255, 0.4)'
      : isResizeHovered
        ? 'rgba(255, 255, 255, 0.2)'
        : 'transparent',
    transition: 'background-color 0.2s ease'
  }

  const itemData = {
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
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={handleContainerClick}
    >
      {processedItems.length > 0 ? (
        <List
          ref={listRef}
          height={expandedHeight - 12}
          itemCount={processedItems.length}
          itemSize={getItemSize}
          width={width - 16}
          itemData={itemData}
        >
          {EntryRow}
        </List>
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

      {/* リサイズハンドル */}
      <div
        style={resizeHandleStyle}
        onMouseDown={handleResizeStart}
        onMouseEnter={() => {
          setIsHovered(true)
          setIsResizeHovered(true)
        }}
        onMouseLeave={() => setIsResizeHovered(false)}
      />

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
