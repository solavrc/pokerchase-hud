import { CSSProperties, useState, useCallback, useMemo, memo, useEffect, useRef } from 'react'
import { PlayerStats } from '../app'
import type { StatDisplayConfig } from '../types'
import type { StatResult } from '../types/stats'

// レスポンシブな座席位置定義（16:9キャンバス基準の正規化座標）
const seatStyles: CSSProperties[] = [
  { top: '65%', left: '65%' },
  { top: '70%', left: '10%' },
  { top: '35%', left: '10%' },
  { top: '20%', left: '65%' },
  { top: '35%', left: '90%' },
  { top: '70%', left: '90%' },
]

const hudContainerStyle: CSSProperties = {
  position: 'fixed',
  pointerEvents: 'none',        // 完全なクリック透過
  userSelect: 'none',           // テキスト選択無効
  zIndex: 9999,                 // 最前面表示
  fontSize: '10px',             // 小さく読みやすいフォント
  fontFamily: 'monospace',      // 等幅フォントで数値を揃える
  color: '#ffffff',             // 白文字
  textShadow: '1px 1px 2px rgba(0, 0, 0, 0.8)', // 見やすい影
}

const hudBackgroundStyle: CSSProperties = {
  backgroundColor: 'rgba(0, 0, 0, 0.5)', // 半透明背景を薄く
  backdropFilter: 'blur(2px)',             // 背景ぼかし効果
  border: '1px solid rgba(255, 255, 255, 0.15)', // より薄い境界線
  borderRadius: '6px',                     // 角丸
  padding: '0',                            // パディングは個別に設定
  lineHeight: '1.1',                       // 行間
  minWidth: '240px',                       // 最小幅（増加）
  maxWidth: '240px',                       // 最大幅（固定幅）
  overflow: 'hidden',                      // オーバーフロー制御
}

const statItemStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  whiteSpace: 'nowrap' as const,
}

const headerStyle: CSSProperties = {
  backgroundColor: 'rgba(0, 0, 0, 0.3)',  // 控えめな背景色
  borderBottom: '1px solid rgba(255, 255, 255, 0.1)',  // 薄いボーダー
  padding: '1px 6px',  // より細いパディング
  borderRadius: '6px 6px 0 0',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',  // 左右に配置
  minHeight: '16px',  // 最小高さを減少
}

const playerNameStyle: CSSProperties = {
  fontSize: '9px',  // より小さく控えめに
  fontWeight: 'normal',  // 通常の太さに
  color: '#cccccc',  // より薄い色に
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const,
  textAlign: 'center' as const,
  letterSpacing: '0.3px',  // 文字間隔を少し減少
}

const statsContainerStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '2px 6px',
  padding: '4px 6px',
}

const statKeyStyle: CSSProperties = {
  fontWeight: 'bold',
  color: '#aaaaaa',  // より薄い色に
  minWidth: '35px',
  fontSize: '9px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const,
}

const statValueStyle: CSSProperties = {
  color: '#dddddd',  // より薄い色に
  textAlign: 'right' as const,
  marginLeft: '4px',
  fontSize: '9px',
  maxWidth: '100px',  // 最大幅を増加
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const,
}

const clickableHudStyle: CSSProperties = {
  cursor: 'pointer',
  transition: 'opacity 0.2s ease',
}

const dragHandleStyle: CSSProperties = {
  cursor: 'move',
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  height: '20px',
  opacity: 0,
  transition: 'opacity 0.2s ease',
}

const playerTypeIconsStyle: CSSProperties = {
  display: 'flex',
  gap: '4px',  // 間隔を広げる
  fontSize: '10px',
  opacity: 0.4,  // もう少し目立つ透明度
  marginLeft: '4px',
}

interface HudPosition {
  top: string
  left: string
}

const Hud = memo((props: { actualSeatIndex: number, stat: PlayerStats, scale?: number, statDisplayConfigs: StatDisplayConfig[] }) => {
  const [isHovering, setIsHovering] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [position, setPosition] = useState<HudPosition | null>(null)
  const dragRef = useRef<{ startX: number, startY: number, startLeft: number, startTop: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const valueHandler = useCallback((value: number | [number, number]) => {
    if (Array.isArray(value)) {
      const [top, bottom] = value
      const stat = top / bottom
      if (Number.isNaN(stat) || !Number.isFinite(stat)) return '-'
      return `${(Math.round(stat * 1000) / 10).toFixed(1)}% (${top}/${bottom})`
    }
    return String(value)
  }, [])

  const getDisplayStats = useCallback((stat: PlayerStats): Array<[string, any, StatResult?]> => {
    if (stat.playerId === -1) {
      // 真の空席の場合は空配列を返す
      return []
    }

    // 表示には常にstatResultsを使用
    if ('statResults' in stat && stat.statResults && stat.statResults.length > 0) {
      return stat.statResults.map(s => [
        s.name || s.id.toUpperCase(),
        s.value,
        s
      ])
    }

    // プレイヤーは存在するが統計データがない場合（フィルタで除外など）
    return []
  }, [])

  // プレイヤー名を取得
  const getPlayerName = useCallback((stat: PlayerStats): string | null => {
    if (stat.playerId === -1) return null
    
    if ('statResults' in stat && stat.statResults) {
      // idが'playerName'または表示名が'Name'の統計を探す
      const nameResult = stat.statResults.find(s => s.id === 'playerName' || s.name === 'Name')
      if (nameResult && typeof nameResult.value === 'string') {
        return nameResult.value
      }
    }
    
    return null
  }, [])

  const displayStats = useMemo(() => getDisplayStats(props.stat), [props.stat, getDisplayStats])
  const playerName = useMemo(() => getPlayerName(props.stat), [props.stat, getPlayerName])

  const copyStatsToClipboard = useCallback(async () => {
    try {
      let statsText = ''
      
      // プレイヤー名を含める
      if (playerName) {
        statsText += `Player: ${playerName}\n`
        statsText += '---\n'
      }

      displayStats.forEach(([key, value, statResult]) => {
        const formattedValue = statResult?.formatted || valueHandler(value as number | [number, number])
        statsText += `${key}: ${formattedValue}\n`
      })

      await navigator.clipboard.writeText(statsText.trim())
      // 統計をクリップボードにコピー
    } catch (error) {
      console.error('Failed to copy stats to clipboard:', error)
    }
  }, [displayStats, valueHandler, playerName])

  const scale = props.scale || 1

  // 保存された位置を読み込み
  useEffect(() => {
    chrome.storage.sync.get(`hudPosition_${props.actualSeatIndex}`, (result) => {
      const savedPosition = result[`hudPosition_${props.actualSeatIndex}`]
      if (savedPosition) {
        setPosition(savedPosition)
      }
    })
  }, [props.actualSeatIndex])

  // ドラッグ開始
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    
    const defaultStyle = seatStyles[props.actualSeatIndex]
    const currentLeft = position?.left ? parseFloat(position.left) : parseFloat((defaultStyle?.left as string) || '0')
    const currentTop = position?.top ? parseFloat(position.top) : parseFloat((defaultStyle?.top as string) || '0')
    
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startLeft: (currentLeft / 100) * window.innerWidth,
      startTop: (currentTop / 100) * window.innerHeight
    }
    
    setIsDragging(true)
  }, [position, props.actualSeatIndex])

  // ドラッグ中のマウス移動と終了を処理
  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current || !containerRef.current) return
      
      const deltaX = e.clientX - dragRef.current.startX
      const deltaY = e.clientY - dragRef.current.startY
      
      const newLeft = ((dragRef.current.startLeft + deltaX) / window.innerWidth) * 100
      const newTop = ((dragRef.current.startTop + deltaY) / window.innerHeight) * 100
      
      // 画面内に制限
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
      
      // 位置を保存
      if (position) {
        chrome.storage.sync.set({
          [`hudPosition_${props.actualSeatIndex}`]: position
        })
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, position, props.actualSeatIndex])

  // 空席の場合は"Waiting for Hand..."を表示
  if (props.stat.playerId === -1) {
    return (
      <div
        ref={containerRef}
        style={{
          ...hudContainerStyle,
          ...(position || seatStyles[props.actualSeatIndex]),
          pointerEvents: isDragging ? 'auto' : 'none',
          transform: `translate(-50%, -50%) scale(${scale})`,
          transformOrigin: 'center',
          cursor: isDragging ? 'move' : 'default',
        }}
      >
        <div
          style={{
            ...hudBackgroundStyle,
            backgroundColor: isDragging ? 'rgba(0, 0, 0, 0.7)' : 'rgba(0, 0, 0, 0.5)',
            pointerEvents: 'auto',
            position: 'relative',
          }}
        >
          {/* ドラッグハンドル */}
          <div
            style={{
              ...dragHandleStyle,
              opacity: isHovering ? 0.3 : 0,
            }}
            onMouseDown={handleMouseDown}
            onMouseEnter={() => setIsHovering(true)}
            onMouseLeave={() => setIsHovering(false)}
          />
          
          {/* ヘッダー領域 */}
          <div style={headerStyle}>
            <span style={{ ...playerNameStyle, color: '#888888', fontStyle: 'italic' }}>
              Waiting for Hand...
            </span>
            <div style={playerTypeIconsStyle}>
              <span>🐟</span>
              <span>🦈</span>
            </div>
          </div>
          
          {/* 空のボディ */}
          <div style={{ padding: '4px 6px', minHeight: '20px' }} />
        </div>
      </div>
    )
  }

  // プレイヤーは存在するが統計データがない場合（フィルタで除外など）
  if (displayStats.length === 0) {
    return (
      <div
        ref={containerRef}
        style={{
          ...hudContainerStyle,
          ...(position || seatStyles[props.actualSeatIndex]),
          pointerEvents: isDragging ? 'auto' : 'none',
          transform: `translate(-50%, -50%) scale(${scale})`,
          transformOrigin: 'center',
          cursor: isDragging ? 'move' : 'default',
        }}
      >
        <div
          style={{
            ...hudBackgroundStyle,
            backgroundColor: isDragging ? 'rgba(0, 0, 0, 0.7)' : 'rgba(0, 0, 0, 0.5)',
            pointerEvents: 'auto',
            position: 'relative',
          }}
        >
          {/* ドラッグハンドル */}
          <div
            style={{
              ...dragHandleStyle,
              opacity: isHovering ? 0.3 : 0,
            }}
            onMouseDown={handleMouseDown}
            onMouseEnter={() => setIsHovering(true)}
            onMouseLeave={() => setIsHovering(false)}
          />
          
          {/* ヘッダー領域（プレイヤー名またはNo Data） */}
          <div style={headerStyle}>
            <span style={{ ...playerNameStyle, color: '#888888' }}>
              {playerName || `Player ${props.stat.playerId}`}
            </span>
            <div style={playerTypeIconsStyle}>
              <span>🐟</span>
              <span>🦈</span>
            </div>
          </div>
          
          {/* No Dataボディ */}
          <div style={{
            padding: '4px 6px',
            textAlign: 'center',
            minHeight: '20px',
          }}>
            <span style={{ color: '#888888', fontSize: '9px' }}>No Data</span>
          </div>
        </div>
      </div>
    )
  }

  // データがある場合は通常のHUDを表示
  return (
    <div
      ref={containerRef}
      style={{
        ...hudContainerStyle,
        ...(position || seatStyles[props.actualSeatIndex]),
        pointerEvents: isDragging ? 'auto' : 'none', // ドラッグ中はauto
        transform: `translate(-50%, -50%) scale(${scale})`,
        transformOrigin: 'center',
        cursor: isDragging ? 'move' : 'default',
      }}
    >
      <div
        style={{
          ...hudBackgroundStyle,
          ...clickableHudStyle,
          backgroundColor: isHovering || isDragging ? 'rgba(0, 0, 0, 0.7)' : 'rgba(0, 0, 0, 0.5)',
          pointerEvents: 'auto',
          position: 'relative',
        }}
        onClick={copyStatsToClipboard}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
        title="Click to copy stats to clipboard"
      >
        {/* ドラッグハンドル */}
        <div
          style={{
            ...dragHandleStyle,
            opacity: isHovering ? 0.3 : 0,
          }}
          onMouseDown={handleMouseDown}
        />
        {/* ヘッダー領域（プレイヤー名） */}
        <div style={headerStyle}>
          <span style={playerNameStyle} title={playerName || 'Unknown'}>
            {playerName || `Player ${props.stat.playerId}`}
          </span>
          <div style={playerTypeIconsStyle}>
            <span>🦈</span>
            <span>🐟</span>
          </div>
        </div>
        
        {/* 統計データ領域 */}
        <div style={statsContainerStyle}>
          {displayStats
            .filter(([, , statResult]) => statResult?.id !== 'playerName') // playerName統計はヘッダーに表示したので除外
            .map(([key, value, statResult], index) => {
              // statResultからフォーマットされた値があれば使用
              const displayValue = statResult?.formatted || valueHandler(value as number | [number, number])

              return (
                <div key={index} style={statItemStyle}>
                  <span style={statKeyStyle} title={key}>{key}:</span>
                  <span style={statValueStyle} title={displayValue}>{displayValue}</span>
                </div>
              )
            })}
        </div>
      </div>
    </div>
  )
}, (prevProps, nextProps) => {
  // React.memo用のカスタム比較関数
  // playerId、statResults、またはscaleが変更された場合のみ再レンダリング
  if (prevProps.actualSeatIndex !== nextProps.actualSeatIndex) return false
  if (prevProps.stat.playerId !== nextProps.stat.playerId) return false
  if (prevProps.scale !== nextProps.scale) return false
  
  // 空席の場合、基本的なpropsのみチェック（statDisplayConfigsのチェックは不要）
  if (prevProps.stat.playerId === -1 && nextProps.stat.playerId === -1) return true

  // statsがstatResultsを持っているかチェックするタイプガード
  const prevHasResults = 'statResults' in prevProps.stat
  const nextHasResults = 'statResults' in nextProps.stat

  if (!prevHasResults && !nextHasResults) return true
  if (!prevHasResults || !nextHasResults) return false

  const prevResults = prevProps.stat.statResults!
  const nextResults = nextProps.stat.statResults!

  if (prevResults.length !== nextResults.length) return false

  // statResultsの深い比較
  return prevResults.every((prev: import('../types/stats').StatResult, i: number) => {
    const next = nextResults[i]
    return prev.id === next?.id &&
      prev.value === next?.value &&
      prev.formatted === next?.formatted
  })
})

export default Hud
