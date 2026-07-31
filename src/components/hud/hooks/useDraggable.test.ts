import { renderHook, act } from '@testing-library/react'
import { useDraggable } from './useDraggable'

const mockChromeRuntimeSendMessage = jest.fn()
global.chrome = {
  runtime: {
    sendMessage: mockChromeRuntimeSendMessage,
  },
} as any

describe('useDraggable', () => {
  const defaultPosition = { top: '50%', left: '50%' }

  beforeEach(() => {
    jest.clearAllMocks()
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      if (message.action === 'getDeviceUILayout') {
        callback({ success: true, scale: 1 })
      } else {
        callback({ success: true })
      }
    })
  })

  it('初期状態を確認', () => {
    const { result } = renderHook(() => useDraggable(0, defaultPosition))

    // 初期状態ではpositionはnull（Chrome storageから読み込むまで）
    expect(result.current.position).toBeNull()
    expect(result.current.isDragging).toBe(false)
    
    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
      { action: 'getDeviceUILayout', seatIndex: 0 },
      expect.any(Function)
    )
  })

  it('保存された位置を読み込む', async () => {
    const savedPosition = { top: '30%', left: '70%' }
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      callback({
        success: true,
        scale: 1,
        ...(message.action === 'getDeviceUILayout' ? { position: savedPosition } : {}),
      })
    })

    const { result } = renderHook(() => useDraggable(0, defaultPosition))

    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
      { action: 'getDeviceUILayout', seatIndex: 0 },
      expect.any(Function)
    )
    expect(result.current.position).toEqual(savedPosition)
    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledTimes(1)
  })

  it('ドラッグ操作を処理', () => {
    const { result } = renderHook(() => useDraggable(0, defaultPosition))

    // containerRefをモック
    const mockContainer = document.createElement('div')
    mockContainer.getBoundingClientRect = jest.fn(() => ({
      top: 0,
      left: 0,
      width: 100,
      height: 100,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => {},
    }))
    
    // containerRefに値を設定
    Object.defineProperty(result.current.containerRef, 'current', {
      value: mockContainer,
      writable: true
    })

    // マウスダウンイベント
    const mouseDownEvent = {
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
      clientX: 100,
      clientY: 100,
    } as unknown as React.MouseEvent

    act(() => {
      result.current.handleMouseDown(mouseDownEvent)
    })

    expect(result.current.isDragging).toBe(true)

    // マウス移動イベント
    const mouseMoveEvent = new MouseEvent('mousemove', {
      clientX: 150,
      clientY: 120,
      bubbles: true,
    })

    act(() => {
      document.dispatchEvent(mouseMoveEvent)
    })

    // 位置が更新される（パーセンテージベース）
    expect(result.current.position).not.toEqual(defaultPosition)

    // マウスアップイベント
    const mouseUpEvent = new MouseEvent('mouseup', {
      bubbles: true,
    })

    act(() => {
      document.dispatchEvent(mouseUpEvent)
    })

    expect(result.current.isDragging).toBe(false)
    
    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
      {
        action: 'setDeviceHudPosition',
        seatIndex: 0,
        position: expect.objectContaining({
          top: expect.any(String),
          left: expect.any(String),
        }),
      },
      expect.any(Function)
    )
  })

  it('ドラッグ開始後に届いた古い保存位置でユーザー操作を巻き戻さない', () => {
    let resolveInitialLoad!: (response: unknown) => void
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      if (message.action === 'getDeviceUILayout') {
        resolveInitialLoad = callback
      } else {
        callback({ success: true })
      }
    })
    const { result } = renderHook(() => useDraggable(0, defaultPosition))
    const mockContainer = document.createElement('div')
    mockContainer.getBoundingClientRect = jest.fn(() => ({
      top: 0,
      left: 0,
      width: 100,
      height: 100,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => {},
    }))
    Object.defineProperty(result.current.containerRef, 'current', {
      value: mockContainer,
      writable: true,
    })

    act(() => {
      result.current.handleMouseDown({
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
        clientX: 100,
        clientY: 100,
      } as unknown as React.MouseEvent)
    })
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', {
        clientX: 150,
        clientY: 120,
        bubbles: true,
      }))
    })
    const userPosition = result.current.position
    expect(userPosition).not.toBeNull()

    act(() => {
      resolveInitialLoad({
        success: true,
        scale: 1,
        position: { top: '10%', left: '20%' },
      })
    })
    expect(result.current.position).toEqual(userPosition)

    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
      {
        action: 'setDeviceHudPosition',
        seatIndex: 0,
        position: userPosition,
      },
      expect.any(Function)
    )
  })

  describe('ポップアップからの配置リセット', () => {
    const startDrag = (result: { current: ReturnType<typeof useDraggable> }) => {
      const mockContainer = document.createElement('div')
      mockContainer.getBoundingClientRect = jest.fn(() => ({
        top: 0, left: 0, width: 100, height: 100,
        right: 100, bottom: 100, x: 0, y: 0, toJSON: () => {},
      }))
      Object.defineProperty(result.current.containerRef, 'current', {
        value: mockContainer,
        writable: true,
      })
      act(() => {
        result.current.handleMouseDown({
          preventDefault: jest.fn(),
          stopPropagation: jest.fn(),
          clientX: 100,
          clientY: 100,
        } as unknown as React.MouseEvent)
      })
    }

    it('保存済み位置を捨ててdefaultPositionの描画へ戻す', () => {
      const savedPosition = { top: '30%', left: '70%' }
      mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
        callback({
          success: true,
          scale: 1,
          ...(message.action === 'getDeviceUILayout' ? { position: savedPosition } : {}),
        })
      })
      const { result } = renderHook(() => useDraggable(0, defaultPosition))
      expect(result.current.position).toEqual(savedPosition)

      act(() => {
        window.dispatchEvent(new CustomEvent('resetHudPositions'))
      })

      // positionがnull＝Hud.tsxがdefaultPosition（SEAT_POSITIONS）を描く状態。
      expect(result.current.position).toBeNull()
      // storageはbackground側で既に空。ここから書き戻してはならない。
      expect(mockChromeRuntimeSendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'setDeviceHudPosition' }),
        expect.any(Function)
      )
    })

    it('リセット後に届いた古い保存位置で復活させない', () => {
      let resolveInitialLoad!: (response: unknown) => void
      mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
        if (message.action === 'getDeviceUILayout') {
          resolveInitialLoad = callback
        } else {
          callback({ success: true })
        }
      })
      const { result } = renderHook(() => useDraggable(0, defaultPosition))

      act(() => {
        window.dispatchEvent(new CustomEvent('resetHudPositions'))
      })
      act(() => {
        resolveInitialLoad({
          success: true,
          scale: 1,
          position: { top: '30%', left: '70%' },
        })
      })

      expect(result.current.position).toBeNull()
    })

    it('進行中のドラッグを破棄して消した位置を書き戻させない', () => {
      const { result } = renderHook(() => useDraggable(0, defaultPosition))
      startDrag(result)
      act(() => {
        document.dispatchEvent(new MouseEvent('mousemove', {
          clientX: 150, clientY: 120, bubbles: true,
        }))
      })
      expect(result.current.position).not.toBeNull()

      act(() => {
        window.dispatchEvent(new CustomEvent('resetHudPositions'))
      })

      expect(result.current.isDragging).toBe(false)
      expect(result.current.position).toBeNull()

      // 掴んだままのmousemove/mouseupが残っていても再保存されない
      act(() => {
        document.dispatchEvent(new MouseEvent('mousemove', {
          clientX: 300, clientY: 300, bubbles: true,
        }))
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      })

      expect(result.current.position).toBeNull()
      expect(mockChromeRuntimeSendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'setDeviceHudPosition' }),
        expect.any(Function)
      )
    })

    it('アンマウント後のリセット通知でstate更新しない', () => {
      const { unmount } = renderHook(() => useDraggable(0, defaultPosition))
      unmount()

      expect(() => {
        window.dispatchEvent(new CustomEvent('resetHudPositions'))
      }).not.toThrow()
    })
  })

  it('別の席番号では異なるストレージキーを使用', () => {
    renderHook(() => useDraggable(3, defaultPosition))

    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
      { action: 'getDeviceUILayout', seatIndex: 3 },
      expect.any(Function)
    )
  })

  it('ドラッグ中にコンポーネントがアンマウントされてもエラーにならない', () => {
    const { result, unmount } = renderHook(() => useDraggable(0, defaultPosition))

    // マウスダウンイベント
    const mouseDownEvent = new MouseEvent('mousedown', {
      clientX: 100,
      clientY: 100,
      bubbles: true,
    })

    act(() => {
      result.current.handleMouseDown(mouseDownEvent as any)
    })

    // コンポーネントをアンマウント
    unmount()

    // マウス移動イベント（エラーが発生しないことを確認）
    const mouseMoveEvent = new MouseEvent('mousemove', {
      clientX: 150,
      clientY: 120,
      bubbles: true,
    })

    act(() => {
      window.dispatchEvent(mouseMoveEvent)
    })

    // エラーが発生しないことを確認
    expect(true).toBe(true)
  })

  it('イベントのデフォルト動作を防ぐ', () => {
    const { result } = renderHook(() => useDraggable(0, defaultPosition))

    const mouseDownEvent = new MouseEvent('mousedown', {
      clientX: 100,
      clientY: 100,
      bubbles: true,
      cancelable: true,
    })

    const preventDefaultSpy = jest.spyOn(mouseDownEvent, 'preventDefault')

    act(() => {
      result.current.handleMouseDown(mouseDownEvent as any)
    })

    expect(preventDefaultSpy).toHaveBeenCalled()
  })

  it('containerRefが提供される', () => {
    const { result } = renderHook(() => useDraggable(0, defaultPosition))

    expect(result.current.containerRef).toBeDefined()
    expect(result.current.containerRef.current).toBeNull()
  })
})
