import { renderHook, act } from '@testing-library/react'
import { useDraggable } from './useDraggable'

// Mock chrome storage
const mockChromeStorageGet = jest.fn()
const mockChromeStorageSet = jest.fn()
global.chrome = {
  storage: {
    sync: {
      get: mockChromeStorageGet,
      set: mockChromeStorageSet,
    },
  },
} as any

describe('useDraggable', () => {
  const defaultPosition = { top: '50%', left: '50%' }

  beforeEach(() => {
    jest.clearAllMocks()
    mockChromeStorageGet.mockImplementation((_, callback) => {
      callback({})
    })
  })

  it('初期状態を確認', () => {
    const { result } = renderHook(() => useDraggable(0, defaultPosition))

    // 初期状態ではpositionはnull（Chrome storageから読み込むまで）
    expect(result.current.position).toBeNull()
    expect(result.current.isDragging).toBe(false)
    
    // Chrome storageから読み込みを試みる
    expect(mockChromeStorageGet).toHaveBeenCalledWith('hudPosition_0', expect.any(Function))
  })

  it('保存された位置を読み込む', async () => {
    const savedPosition = { top: '30%', left: '70%' }
    mockChromeStorageGet.mockImplementation((_, callback) => {
      callback({ hudPosition_0: savedPosition })
    })

    const { result } = renderHook(() => useDraggable(0, defaultPosition))

    // Chrome storageから位置が読み込まれる
    expect(mockChromeStorageGet).toHaveBeenCalledWith('hudPosition_0', expect.any(Function))
    expect(result.current.position).toEqual(savedPosition)
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
    
    // Chrome storageに位置が保存される
    expect(mockChromeStorageSet).toHaveBeenCalledWith({
      hudPosition_0: expect.objectContaining({
        top: expect.any(String),
        left: expect.any(String),
      }),
    })
  })

  it('別の席番号では異なるストレージキーを使用', () => {
    renderHook(() => useDraggable(3, defaultPosition))

    expect(mockChromeStorageGet).toHaveBeenCalledWith('hudPosition_3', expect.any(Function))
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