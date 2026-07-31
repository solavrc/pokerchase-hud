/**
 * HandLogコンポーネント - 最適化バージョン
 * バーチャル化を使用したリアルタイムハンド履歴ログオーバーレイ
 */

import React, { useState, useEffect, useLayoutEffect, useRef, CSSProperties, useCallback, useMemo, memo } from 'react'
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
  isValidHandLogLayout,
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

const HAND_LOG_HEADER_HEIGHT = 28
const HAND_LOG_HEADER_REACHABLE_WIDTH = 80
const HAND_LOG_DRAG_THRESHOLD = 4
const HAND_LOG_DEFAULT_RIGHT = 10
const HAND_LOG_DEFAULT_BOTTOM = 135

type HandLogInteractionMode = 'move' | 'resize'

interface HandLogEnvironment {
  scale: number
  viewportWidth: number
  viewportHeight: number
}

interface ActiveHandLogInteraction {
  phase: 'interacting'
  mode: HandLogInteractionMode
  startX: number
  startY: number
  startLayout: HandLogLayout
  startEnvironment: HandLogEnvironment
  moved: boolean
}

interface IdleHandLogInteraction {
  phase: 'idle'
}

type HandLogInteraction =
  | IdleHandLogInteraction
  | ActiveHandLogInteraction

interface HandLogLoad {
  id: number
  scale: number
}

interface HandLogLayoutMachine {
  layout: HandLogLayout
  environment: HandLogEnvironment
  interaction: HandLogInteraction
  pendingEnvironment: HandLogEnvironment | null
  activeLoad: HandLogLoad | null
}

type HandLogMachineAction =
  | { type: 'environmentChanged', environment: HandLogEnvironment }
  | { type: 'loadStarted', load: HandLogLoad }
  | { type: 'loadResolved', load: HandLogLoad, layout: HandLogLayout | undefined }
  | { type: 'externalLayout', layout: HandLogLayout }
  | { type: 'reset' }
  | { type: 'interactionStarted', mode: HandLogInteractionMode, x: number, y: number }
  | { type: 'pointerMoved', x: number, y: number }
  | { type: 'interactionFinished', deferPersistenceForLoad?: boolean }

interface HandLogTransition {
  state: HandLogLayoutMachine
  persist?: HandLogLayout
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const sameEnvironment = (
  left: HandLogEnvironment,
  right: HandLogEnvironment
): boolean =>
  left.scale === right.scale &&
  left.viewportWidth === right.viewportWidth &&
  left.viewportHeight === right.viewportHeight

const readHandLogEnvironment = (scale: number): HandLogEnvironment => ({
  scale,
  viewportWidth: window.innerWidth,
  viewportHeight: window.innerHeight,
})

const getHandLogDisplayHeight = (
  layout: HandLogLayout,
  environment: HandLogEnvironment
): number =>
  Math.min(layout.height, environment.viewportHeight / environment.scale)

const normalizeHandLogLayout = (
  layout: HandLogLayout,
  environment: HandLogEnvironment
): HandLogLayout => {
  const { scale, viewportWidth, viewportHeight } = environment
  const maximumHeight = viewportHeight / scale
  // A sub-minimum viewport temporarily shrinks only the rendered panel.
  // Keep state/persistence at HAND_LOG_MIN_HEIGHT or above; see PR #304.
  const height = clamp(
    layout.height,
    HAND_LOG_MIN_HEIGHT,
    Math.max(HAND_LOG_MIN_HEIGHT, maximumHeight)
  )
  const renderedWidth = layout.width * scale
  const renderedHeight = getHandLogDisplayHeight(
    { ...layout, height },
    environment
  ) * scale
  const reachableWidth = Math.min(
    HAND_LOG_HEADER_REACHABLE_WIDTH * scale,
    viewportWidth
  )

  return {
    ...layout,
    left: clamp(
      layout.left,
      reachableWidth - renderedWidth,
      viewportWidth - reachableWidth
    ),
    top: clamp(
      layout.top,
      0,
      Math.max(0, viewportHeight - renderedHeight)
    ),
    height,
  }
}

const createDefaultHandLogLayout = (
  environment: HandLogEnvironment
): HandLogLayout =>
  normalizeHandLogLayout({
    left:
      environment.viewportWidth -
      HAND_LOG_DEFAULT_RIGHT -
      DEFAULT_HAND_LOG_CONFIG.width * environment.scale,
    top:
      environment.viewportHeight -
      HAND_LOG_DEFAULT_BOTTOM -
      DEFAULT_HAND_LOG_CONFIG.height * environment.scale,
    width: DEFAULT_HAND_LOG_CONFIG.width,
    height: DEFAULT_HAND_LOG_CONFIG.height,
  }, environment)

const createHandLogLayoutMachine = (
  environment: HandLogEnvironment
): HandLogLayoutMachine => ({
  layout: createDefaultHandLogLayout(environment),
  environment,
  interaction: { phase: 'idle' },
  pendingEnvironment: null,
  activeLoad: null,
})

const transitionHandLogLayout = (
  state: HandLogLayoutMachine,
  action: HandLogMachineAction
): HandLogTransition => {
  switch (action.type) {
    case 'environmentChanged': {
      if (state.interaction.phase === 'interacting') {
        const pendingEnvironment = sameEnvironment(
          state.environment,
          action.environment
        )
          ? null
          : action.environment
        if (
          (state.pendingEnvironment === null && pendingEnvironment === null) ||
          (
            state.pendingEnvironment !== null &&
            pendingEnvironment !== null &&
            sameEnvironment(state.pendingEnvironment, pendingEnvironment)
          )
        ) {
          return { state }
        }
        // The active environment is intentionally unchanged until finish, so
        // its in-flight load remains valid during the interaction.
        return {
          state: {
            ...state,
            pendingEnvironment,
          },
        }
      }
      if (sameEnvironment(state.environment, action.environment)) {
        return { state }
      }
      const scaleChanged = state.environment.scale !== action.environment.scale
      return {
        state: {
          ...state,
          layout: normalizeHandLogLayout(state.layout, action.environment),
          environment: action.environment,
          pendingEnvironment: null,
          activeLoad: scaleChanged ? null : state.activeLoad,
        },
      }
    }

    case 'loadStarted':
      if (state.interaction.phase === 'interacting') return { state }
      return {
        state: {
          ...state,
          activeLoad: action.load,
        },
      }

    case 'loadResolved': {
      if (
        state.activeLoad?.id !== action.load.id ||
        state.activeLoad.scale !== action.load.scale ||
        state.environment.scale !== action.load.scale
      ) {
        return { state }
      }
      if (!action.layout) {
        return { state }
      }
      if (
        state.interaction.phase === 'interacting' &&
        state.interaction.moved
      ) {
        return { state: { ...state, activeLoad: null } }
      }
      const layout = normalizeHandLogLayout(
        action.layout,
        state.environment
      )
      return {
        state: {
          ...state,
          layout,
          interaction:
            state.interaction.phase === 'interacting'
              ? { ...state.interaction, startLayout: layout }
              : state.interaction,
          activeLoad: null,
        },
      }
    }

    case 'externalLayout': {
      if (
        state.interaction.phase === 'interacting' &&
        state.interaction.moved
      ) {
        return { state }
      }
      const layout = normalizeHandLogLayout(
        action.layout,
        state.environment
      )
      return {
        state: {
          ...state,
          layout,
          interaction:
            state.interaction.phase === 'interacting'
              ? { ...state.interaction, startLayout: layout }
              : state.interaction,
          activeLoad: null,
        },
      }
    }

    case 'reset': {
      const environment = state.pendingEnvironment ?? state.environment
      return {
        state: {
          ...state,
          layout: createDefaultHandLogLayout(environment),
          environment,
          interaction: { phase: 'idle' },
          pendingEnvironment: null,
          activeLoad: null,
        },
      }
    }

    case 'interactionStarted':
      if (state.interaction.phase === 'interacting') return { state }
      return {
        state: {
          ...state,
          interaction: {
            phase: 'interacting',
            mode: action.mode,
            startX: action.x,
            startY: action.y,
            startLayout: state.layout,
            startEnvironment: state.environment,
            moved: false,
          },
        },
      }

    case 'pointerMoved': {
      if (state.interaction.phase !== 'interacting') return { state }
      const deltaX = action.x - state.interaction.startX
      const deltaY = action.y - state.interaction.startY
      if (
        !state.interaction.moved &&
        Math.hypot(deltaX, deltaY) < HAND_LOG_DRAG_THRESHOLD
      ) {
        return { state }
      }
      const { startLayout, startEnvironment } = state.interaction
      const proposedLayout =
        state.interaction.mode === 'move'
          ? {
              ...startLayout,
              left: startLayout.left + deltaX,
              top: startLayout.top + deltaY,
            }
          : {
              ...startLayout,
              width: Math.max(
                HAND_LOG_MIN_WIDTH,
                startLayout.width + deltaX / startEnvironment.scale
              ),
              height: Math.max(
                HAND_LOG_MIN_HEIGHT,
                startLayout.height + deltaY / startEnvironment.scale
              ),
            }
      return {
        state: {
          ...state,
          layout: normalizeHandLogLayout(
            proposedLayout,
            state.environment
          ),
          interaction: {
            ...state.interaction,
            moved: true,
          },
        },
      }
    }

    case 'interactionFinished': {
      if (state.interaction.phase !== 'interacting') return { state }
      const environment = state.pendingEnvironment ?? state.environment
      const layout = normalizeHandLogLayout(
        state.layout,
        environment
      )
      const shouldPersist =
        (
          state.interaction.moved ||
          state.pendingEnvironment !== null
        ) &&
        !action.deferPersistenceForLoad
      return {
        state: {
          ...state,
          layout,
          environment,
          interaction: { phase: 'idle' },
          pendingEnvironment: null,
          activeLoad: shouldPersist ? null : state.activeLoad,
        },
        persist: shouldPersist ? layout : undefined,
      }
    }
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
  const [copiedHandId, setCopiedHandId] = useState<number | null>(null)
  const [layoutMachine, setLayoutMachine] =
    useState<HandLogLayoutMachine>(() =>
      createHandLogLayoutMachine(readHandLogEnvironment(scale))
    )
  const layoutMachineRef = useRef(layoutMachine)
  const loadSequenceRef = useRef(0)
  const requestedLoadScaleRef = useRef<number | null>(null)
  const latestScaleRef = useRef(scale)
  latestScaleRef.current = scale
  const [showCopied, setShowCopied] = useState(false)
  const [showCleared, setShowCleared] = useState(false)
  const lastClickTimeRef = useRef<number>(0)

  const commitLayoutAction = useCallback((
    action: HandLogMachineAction,
    render = true
  ) => {
    const transition = transitionHandLogLayout(
      layoutMachineRef.current,
      action
    )
    if (transition.state !== layoutMachineRef.current) {
      layoutMachineRef.current = transition.state
      if (render) {
        setLayoutMachine(transition.state)
      }
    }
    if (transition.persist) {
      saveHandLogLayout(transition.persist)
    }
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

  // Prop scale and viewport dimensions are inputs to the same layout machine
  // as pointer interaction. useLayoutEffect updates scale before paint while
  // idle; an active interaction keeps rendering its start environment and
  // applies the pending environment through the common finish transition.
  useLayoutEffect(() => {
    commitLayoutAction({
      type: 'environmentChanged',
      environment: readHandLogEnvironment(scale),
    })
  }, [scale, commitLayoutAction])

  useEffect(() => {
    // A scale change during pointer interaction is loaded only after the
    // interaction ends. This avoids adding another layout-machine lifecycle
    // branch while ensuring the latest scale still gets an authoritative load.
    if (layoutMachine.interaction.phase === 'interacting') return
    if (requestedLoadScaleRef.current === scale) return
    requestedLoadScaleRef.current = scale
    const load = {
      id: ++loadSequenceRef.current,
      scale,
    }
    commitLayoutAction({ type: 'loadStarted', load })
    loadHandLogLayout(savedLayout => {
      commitLayoutAction({
        type: 'loadResolved',
        load,
        layout: savedLayout,
      })
    })
  }, [scale, layoutMachine.interaction.phase, commitLayoutAction])

  useEffect(() => {
    const handleViewportResize = () => {
      commitLayoutAction({
        type: 'environmentChanged',
        environment: readHandLogEnvironment(scale),
      })
    }
    const handleReset = () => {
      commitLayoutAction({ type: 'reset' })
    }
    const handleUpdate = (event: Event) => {
      const nextLayout = (event as CustomEvent<unknown>).detail
      if (!isValidHandLogLayout(nextLayout)) return
      commitLayoutAction({ type: 'externalLayout', layout: nextLayout })
    }
    window.addEventListener('resize', handleViewportResize)
    window.addEventListener('resetHandLogLayout', handleReset)
    window.addEventListener('updateHandLogLayout', handleUpdate)
    return () => {
      window.removeEventListener('resize', handleViewportResize)
      window.removeEventListener('resetHandLogLayout', handleReset)
      window.removeEventListener('updateHandLogLayout', handleUpdate)
    }
  }, [scale, commitLayoutAction])

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
    if (layoutMachineRef.current.interaction.phase === 'interacting') return

    const currentTime = Date.now()
    const timeSinceLastClick = currentTime - lastClickTimeRef.current
    lastClickTimeRef.current = currentTime

    if (timeSinceLastClick < 300 && onClearLog) {
      onClearLog()
      setShowCleared(true)
      setTimeout(() => setShowCleared(false), 1500)
    }
  }, [onClearLog])

  const handleInteractionStart = useCallback((
    mode: HandLogInteractionMode,
    e: React.MouseEvent
  ) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()

    commitLayoutAction({
      type: 'interactionStarted',
      mode,
      x: e.clientX,
      y: e.clientY,
    })
  }, [commitLayoutAction])

  const finishLayoutInteraction = useCallback((render = true) => {
    const current = layoutMachineRef.current
    if (current.interaction.phase !== 'interacting') return

    const deferredScaleLoad =
      requestedLoadScaleRef.current !== latestScaleRef.current
    const deferPersistenceForLoad =
      !current.interaction.moved &&
      (
        deferredScaleLoad ||
        (
          current.pendingEnvironment !== null &&
          current.activeLoad !== null
        )
      )

    if (current.interaction.moved && deferredScaleLoad) {
      // An intentional move/resize wins over the deferred saved layout.
      // Mark the new scale handled so the post-finish effect cannot rewind it.
      requestedLoadScaleRef.current = latestScaleRef.current
    }

    commitLayoutAction({
      type: 'interactionFinished',
      deferPersistenceForLoad,
    }, render)
  }, [commitLayoutAction])

  useEffect(() => {
    const interaction = layoutMachine.interaction
    const interactionMode =
      interaction.phase === 'interacting' ? interaction.mode : null
    if (!interactionMode) return

    const cursor = interactionMode === 'move' ? 'grabbing' : 'nwse-resize'
    document.body.style.cursor = cursor
    document.body.style.userSelect = 'none'

    const finishInteraction = () => {
      finishLayoutInteraction()
    }

    const handleMouseMove = (event: MouseEvent) => {
      // A mouseup released outside the browser may never reach the document.
      // The first move after re-entry exposes the released primary button, so
      // finish without applying that stale pointer position.
      if ((event.buttons & 1) === 0) {
        finishInteraction()
        return
      }
      commitLayoutAction({
        type: 'pointerMoved',
        x: event.clientX,
        y: event.clientY,
      })
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', finishInteraction)
    window.addEventListener('blur', finishInteraction)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', finishInteraction)
      window.removeEventListener('blur', finishInteraction)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [
    layoutMachine.interaction.phase,
    layoutMachine.interaction.phase === 'interacting'
      ? layoutMachine.interaction.mode
      : null,
    finishLayoutInteraction,
  ])

  // Unmount uses the exact same transition/persistence outlet as
  // mouseup/blur, but skips the render after the component is gone.
  useEffect(() => () => {
    finishLayoutInteraction(false)
  }, [finishLayoutInteraction])

  // 無効の場合はレンダリングしない
  if (!config.enabled) return null

  const { layout, environment } = layoutMachine
  const { width } = layout
  // Display-only shrink: the layout kept by the machine remains persistable.
  const height = getHandLogDisplayHeight(layout, environment)
  const interactionMode =
    layoutMachine.interaction.phase === 'interacting'
      ? layoutMachine.interaction.mode
      : null
  const bodyHeight = Math.max(0, height - HAND_LOG_HEADER_HEIGHT)

  // コンテナスタイル
  const containerStyle: CSSProperties = {
    position: 'fixed',
    left: layout.left,
    top: layout.top,
    width: width,
    height,
    backgroundColor: `rgba(0, 0, 0, ${config.opacity})`,
    backdropFilter: 'blur(4px)',
    border: '1px solid rgba(255, 255, 255, 0.2)',
    borderRadius: '4px',
    padding: '0',
    transform: `scale(${environment.scale})`,
    transformOrigin: 'top left',
    overflowY: 'hidden',
    overflowX: 'hidden',
    fontFamily: 'Consolas, Monaco, "Courier New", monospace',
    fontSize: config.fontSize,
    color: '#ffffff',
    // Keep the header and resize corner above player HUD panels (z-index
    // 9999) so an overlap cannot make either interaction unreachable.
    zIndex: 10000,
    boxShadow: '0 2px 4px rgba(0, 0, 0, 0.3)',
    cursor: 'default'
  }

  const headerStyle: CSSProperties = {
    boxSizing: 'border-box',
    width: '100%',
    height: HAND_LOG_HEADER_HEIGHT,
    padding: '0 8px',
    cursor: interactionMode === 'move' ? 'grabbing' : 'grab',
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    borderBottom: '1px solid rgba(255, 255, 255, 0.2)',
    color: 'rgba(255, 255, 255, 0.9)',
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    fontSize: Math.max(11, config.fontSize - 1),
    fontWeight: 600,
    lineHeight: 1,
    userSelect: 'none',
  }

  const headerGripIconStyle: CSSProperties = {
    color: 'rgba(255, 255, 255, 0.65)',
    fontSize: 14,
    letterSpacing: -2,
  }

  const resizeCornerStyle: CSSProperties = {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 12,
    height: 12,
    cursor: 'nwse-resize',
    background: 'linear-gradient(135deg, transparent 48%, rgba(255, 255, 255, 0.9) 50%)',
    zIndex: 2,
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
      style={containerStyle}
      onClick={handleContainerClick}
    >
      <div
        data-testid="hand-log-header"
        title="ドラッグしてハンドログを移動"
        style={headerStyle}
        onMouseDown={(event) => handleInteractionStart('move', event)}
        onClick={(event) => event.stopPropagation()}
      >
        <span aria-hidden="true" style={headerGripIconStyle}>⠿</span>
        <span>ハンドログ</span>
      </div>

      {processedItems.length > 0 ? (
        <List
          listRef={listRef}
          rowCount={processedItems.length}
          rowHeight={getItemSize}
          rowComponent={EntryRow}
          rowProps={rowProps}
          style={{ height: bodyHeight, width }}
        />
      ) : (
        <div style={{
          height: bodyHeight,
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#666666',
          textAlign: 'center',
          fontSize: config.fontSize - 1
        }}>
          Waiting for hand...
        </div>
      )}

      {/* 右下はリサイズ専用。移動は上部ヘッダーだけが開始する。 */}
      <div
        data-testid="hand-log-resize-corner"
        title="ドラッグしてハンドログのサイズを変更"
        style={resizeCornerStyle}
        onMouseDown={(event) => handleInteractionStart('resize', event)}
        onClick={(event) => event.stopPropagation()}
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
