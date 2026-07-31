import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import HandLog from './HandLog'
import { HandLogEntry, HandLogEntryType, HandLogConfig, DEFAULT_HAND_LOG_CONFIG } from '../types/hand-log'
import { DEVICE_LAYOUT_MESSAGE_TIMEOUT_MS } from '../utils/ui-config-storage'

// Mock react-window v2 API
jest.mock('react-window', () => {
  const React = require('react')
  return {
    List: ({ rowComponent: RowComponent, rowCount, rowProps, style, listRef }: any) => {
      // Mock scrollToRow method via listRef
      React.useImperativeHandle(listRef, () => ({
        scrollToRow: jest.fn(),
        get element() { return null },
      }))

      return (
        <div data-testid="virtual-list" style={style}>
          {Array.from({ length: rowCount }).map((_, index) => (
            <div key={index}>
              <RowComponent
                index={index}
                style={{}}
                ariaAttributes={{ 'aria-posinset': index + 1, 'aria-setsize': rowCount, role: 'listitem' }}
                {...rowProps}
              />
            </div>
          ))}
        </div>
      )
    },
    useListRef: (init: any) => React.useRef(init),
  }
})

// Mock navigator.clipboard
const mockWriteText = jest.fn()
const mockChromeRuntimeSendMessage = chrome.runtime.sendMessage as jest.Mock
const moveMouseWithPrimaryButton = (clientX: number, clientY: number) => {
  fireEvent.mouseMove(document, { buttons: 1, clientX, clientY })
}
const setViewport = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', {
    value: width,
    writable: true,
    configurable: true,
  })
  Object.defineProperty(window, 'innerHeight', {
    value: height,
    writable: true,
    configurable: true,
  })
}
const updateLayout = (layout: {
  left: number
  top: number
  width: number
  height: number
}) => {
  fireEvent(window, new CustomEvent('updateHandLogLayout', { detail: layout }))
}
const savedLayoutCalls = () =>
  mockChromeRuntimeSendMessage.mock.calls.filter(
    ([message]) => message.action === 'setDeviceHandLogLayout'
  )

describe('HandLog', () => {
  const mockEntries: HandLogEntry[] = [
    {
      id: '1',
      handId: 1,
      timestamp: Date.now(),
      text: 'Hand #1: Tournament started',
      type: HandLogEntryType.HEADER,
    },
    {
      id: '2',
      handId: 1,
      timestamp: Date.now(),
      text: 'Seat 1: Player1 (1000 chips)',
      type: HandLogEntryType.SEAT,
    },
    {
      id: '3',
      handId: 1,
      timestamp: Date.now(),
      text: 'Player1: folds',
      type: HandLogEntryType.ACTION,
    },
    {
      id: '4',
      handId: 2,
      timestamp: Date.now(),
      text: 'Hand #2: Next hand',
      type: HandLogEntryType.HEADER,
    },
  ]

  const mockOnClearLog = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    setViewport(1024, 768)
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      if (message.action === 'getDeviceHandLogLayout') {
        callback({ success: true })
      } else {
        callback?.({ success: true })
      }
    })
    mockWriteText.mockResolvedValue(undefined)
    // Re-install the clipboard mock every test: `userEvent.setup()` (used by
    // the double-click test) unconditionally replaces `navigator.clipboard`
    // with user-event's own ClipboardStub (a configurable getter), so under
    // `jest --randomize` any test running after it would otherwise assert
    // against the stub instead of this mock. defineProperty (not
    // Object.assign) because the stub property is getter-only.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      configurable: true,
    })
  })

  it('コンフィグが無効の場合は何も表示されない', () => {
    const config: Partial<HandLogConfig> = { enabled: false }
    const { container } = render(<HandLog entries={mockEntries} config={config} />)
    expect(container.firstChild).toBeNull()
  })

  it('エントリがない場合は待機メッセージを表示', () => {
    render(<HandLog entries={[]} />)
    expect(screen.getByText('Waiting for hand...')).toBeInTheDocument()
  })

  it('エントリを表示する', () => {
    render(<HandLog entries={mockEntries} />)
    
    expect(screen.getByText('Hand #1: Tournament started')).toBeInTheDocument()
    expect(screen.getByText('Seat 1: Player1 (1000 chips)')).toBeInTheDocument()
    expect(screen.getByText('Player1: folds')).toBeInTheDocument()
    expect(screen.getByText('Hand #2: Next hand')).toBeInTheDocument()
  })

  it('タイムスタンプを表示できる', () => {
    const config: Partial<HandLogConfig> = { showTimestamps: true }
    render(<HandLog entries={mockEntries} config={config} />)
    
    // タイムスタンプフォーマットが表示される
    const timestampRegex = /\[\d{2}:\d{2}:\d{2}\]/
    const timestamps = screen.getAllByText(timestampRegex)
    expect(timestamps.length).toBeGreaterThan(0)
  })

  it('エントリをクリックすると手札をコピーする', async () => {
    render(<HandLog entries={mockEntries} />)
    
    const firstEntry = screen.getByText('Hand #1: Tournament started')
    await userEvent.click(firstEntry)
    
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'Hand #1: Tournament started\nSeat 1: Player1 (1000 chips)\nPlayer1: folds'
      )
    })
    
    // コピー通知が表示される
    expect(screen.getByText('Copied Hand!')).toBeInTheDocument()
  })

  it('ダブルクリックでログをクリアする', async () => {
    const user = userEvent.setup()
    render(<HandLog entries={mockEntries} onClearLog={mockOnClearLog} />)
    
    const container = screen.getByTestId('virtual-list').parentElement!
    
    // ダブルクリック
    await user.dblClick(container)
    
    await waitFor(() => {
      expect(mockOnClearLog).toHaveBeenCalled()
    })
    
    // クリア通知が表示される
    expect(screen.getByText('Cleared!')).toBeInTheDocument()
  })

  it('ホバーしても高さを自動変更しない', () => {
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement

    fireEvent.mouseEnter(logContainer)

    expect(logContainer.style.height).toBe(`${DEFAULT_HAND_LOG_CONFIG.height}px`)
  })

  it('HUDと重なっても移動グリップとリサイズ角を掴めるstacking順を維持する', () => {
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement

    expect(Number(logContainer.style.zIndex)).toBeGreaterThan(9999)
    expect(screen.getByTestId('hand-log-resize-corner')).toBeInTheDocument()
    expect(screen.queryByTestId('hand-log-header')).not.toBeInTheDocument()
    // グリップはヘッダー帯と違い本文の上に重なるので、被って掴めなくならない
    // よう本文より前面に置く必要がある。行頭は必ず文字で埋まるため右上固定。
    const moveGrip = screen.getByTestId('hand-log-move-grip')
    expect(moveGrip).toHaveStyle({
      width: '16px',
      height: '16px',
      position: 'absolute',
      top: '0px',
      right: '0px',
    })
    expect(Number(moveGrip.style.zIndex)).toBeGreaterThan(
      Number(screen.getByTestId('virtual-list').style.zIndex || 0)
    )
  })

  it('移動グリップをドラッグして移動し端末ローカルへ一度だけ保存する', () => {
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement
    updateLayout({ left: 500, top: 400, width: 400, height: 100 })

    fireEvent.mouseDown(screen.getByTestId('hand-log-move-grip'), {
      button: 0,
      clientX: 600,
      clientY: 414,
    })
    moveMouseWithPrimaryButton(550, 384)

    expect(logContainer.style.left).toBe('450px')
    expect(logContainer.style.top).toBe('370px')

    fireEvent.mouseUp(document)
    expect(savedLayoutCalls()).toEqual([
      [
        {
          action: 'setDeviceHandLogLayout',
          layout: { left: 450, top: 370, width: 400, height: 100 },
        },
        expect.any(Function),
      ],
    ])
  })

  it('本文からは移動を開始しない', () => {
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement

    fireEvent.mouseDown(screen.getByTestId('virtual-list'), {
      button: 0,
      clientX: 700,
      clientY: 580,
    })
    moveMouseWithPrimaryButton(650, 550)
    fireEvent.mouseUp(document)

    expect(logContainer.style.left).toBe('614px')
    expect(logContainer.style.top).toBe('533px')
    expect(savedLayoutCalls()).toHaveLength(0)
  })

  it('移動グリップとリサイズ角のdouble-clickでログを誤消去しない', async () => {
    const user = userEvent.setup()
    render(<HandLog entries={mockEntries} onClearLog={mockOnClearLog} />)

    await user.dblClick(screen.getByTestId('hand-log-move-grip'))
    await user.dblClick(screen.getByTestId('hand-log-resize-corner'))

    expect(mockOnClearLog).not.toHaveBeenCalled()
    expect(mockWriteText).not.toHaveBeenCalled()
  })

  it('ドラッグ開始後に届いた古い保存layoutで移動を巻き戻さない', () => {
    let resolveInitialLoad!: (response: unknown) => void
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      if (message.action === 'getDeviceHandLogLayout') {
        resolveInitialLoad = callback
      } else {
        callback?.({ success: true })
      }
    })
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement

    fireEvent.mouseDown(screen.getByTestId('hand-log-move-grip'), {
      button: 0,
      clientX: 700,
      clientY: 540,
    })
    moveMouseWithPrimaryButton(650, 510)
    act(() => {
      resolveInitialLoad({
        success: true,
        layout: { left: 20, top: 30, width: 600, height: 300 },
      })
    })

    expect(logContainer.style.left).toBe('564px')
    expect(logContainer.style.top).toBe('503px')
    fireEvent.mouseUp(document)
  })

  it.each([
    { testId: 'hand-log-move-grip', startX: 700, startY: 540 },
    { testId: 'hand-log-resize-corner', startX: 1014, startY: 633 },
  ])('操作の微小jitterでは遅れて届いた保存layoutを無効化しない', ({
    testId,
    startX,
    startY,
  }) => {
    let resolveInitialLoad!: (response: unknown) => void
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      if (message.action === 'getDeviceHandLogLayout') {
        resolveInitialLoad = callback
      } else {
        callback?.({ success: true })
      }
    })
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement

    fireEvent.mouseDown(screen.getByTestId(testId), {
      button: 0,
      clientX: startX,
      clientY: startY,
    })
    moveMouseWithPrimaryButton(startX + 2, startY + 2)
    fireEvent.mouseUp(document)
    act(() => {
      resolveInitialLoad({
        success: true,
        layout: { left: 120, top: 80, width: 520, height: 240 },
      })
    })

    expect(logContainer.style.left).toBe('120px')
    expect(logContainer.style.top).toBe('80px')
    expect(logContainer.style.width).toBe('520px')
    expect(savedLayoutCalls()).toHaveLength(0)
  })

  it('旧レイアウトの負値topを読んでも移動グリップを画面内へ復帰させる', () => {
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      if (message.action === 'getDeviceHandLogLayout') {
        callback({
          success: true,
          layout: { left: 200, top: -72, width: 400, height: 100 },
        })
      } else {
        callback?.({ success: true })
      }
    })
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement

    expect(logContainer.style.top).toBe('0px')
    expect(screen.getByTestId('hand-log-move-grip')).toBeInTheDocument()
  })

  it('画面高を超える保存heightは表示だけ上限へ戻しリサイズ角を画面内へ保つ', () => {
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      if (message.action === 'getDeviceHandLogLayout') {
        callback({
          success: true,
          layout: { left: 100, top: 400, width: 400, height: 1100 },
        })
      } else {
        callback?.({ success: true })
      }
    })
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement
    const resizeCorner = screen.getByTestId('hand-log-resize-corner')

    expect(logContainer.style.top).toBe('0px')
    expect(logContainer.style.height).toBe('768px')

    fireEvent.mouseDown(resizeCorner, {
      button: 0,
      clientX: 500,
      clientY: 768,
    })
    moveMouseWithPrimaryButton(500, 688)
    fireEvent.mouseUp(document)

    expect(logContainer.style.height).toBe('688px')
    expect(savedLayoutCalls()).toHaveLength(1)
  })

  it('viewportの一時的な縮小で指定サイズを恒久的に潰さない', () => {
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      if (message.action === 'getDeviceHandLogLayout') {
        callback({
          success: true,
          layout: { left: 100, top: 100, width: 600, height: 300 },
        })
      } else {
        callback?.({ success: true })
      }
    })
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement

    setViewport(320, 240)
    fireEvent(window, new Event('resize'))

    expect(logContainer.style.left).toBe('0px')
    expect(logContainer.style.top).toBe('0px')
    expect(logContainer.style.width).toBe('320px')
    expect(logContainer.style.height).toBe('240px')

    setViewport(1024, 768)
    fireEvent(window, new Event('resize'))

    expect(logContainer.style.width).toBe('600px')
    expect(logContainer.style.height).toBe('300px')
  })

  it('viewportが0で読めてもパネルを消さず位置も動かさない', () => {
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      if (message.action === 'getDeviceHandLogLayout') {
        callback({
          success: true,
          layout: { left: 100, top: 100, width: 600, height: 300 },
        })
      } else {
        callback?.({ success: true })
      }
    })
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement

    // 遷移直後などinnerWidth/innerHeightは一時的に0で読めることがある。
    setViewport(0, 0)
    fireEvent(window, new Event('resize'))

    expect(logContainer.style.left).toBe('100px')
    expect(logContainer.style.top).toBe('100px')
    expect(logContainer.style.width).toBe('600px')
    expect(logContainer.style.height).toBe('300px')
    expect(savedLayoutCalls()).toHaveLength(0)
  })

  it('viewportが0でも負の既定座標は画面内へ寄せる', () => {
    // 保存layoutがない状態で0を読むと既定layoutは大きな負値になる。
    // 上限だけがviewport依存で、下限0は常に効かせる。
    setViewport(0, 0)
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement

    expect(logContainer.style.left).toBe('0px')
    expect(logContainer.style.top).toBe('0px')
    expect(logContainer.style.width).toBe('400px')
    expect(logContainer.style.height).toBe('100px')
  })

  it('mount後のviewport縮小でもパネル全体を画面内へ正規化する', () => {
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      if (message.action === 'getDeviceHandLogLayout') {
        callback({
          success: true,
          layout: { left: 100, top: 500, width: 400, height: 200 },
        })
      } else {
        callback?.({ success: true })
      }
    })
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement

    setViewport(640, 480)
    fireEvent(window, new Event('resize'))

    expect(logContainer.style.top).toBe('280px')
    expect(logContainer.style.height).toBe('200px')
  })

  it('保存layoutがない狭い初期viewportでも既定layoutを即時に正規化する', () => {
    setViewport(320, 120)
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement

    expect(logContainer.style.left).toBe('0px')
    expect(logContainer.style.top).toBe('0px')
    expect(logContainer.style.width).toBe('320px')
    expect(logContainer.style.height).toBe('100px')
  })

  it('最小サイズより狭いviewportでは表示だけ縮め保存サイズを潰さない', () => {
    setViewport(320, 120)
    const { container } = render(<HandLog entries={mockEntries} scale={2} />)
    const logContainer = container.firstChild as HTMLElement

    expect(logContainer.style.left).toBe('0px')
    expect(logContainer.style.top).toBe('0px')
    expect(logContainer.style.width).toBe('160px')
    expect(logContainer.style.height).toBe('60px')
    expect(logContainer.style.transform).toContain('scale(2)')
    expect(screen.getByTestId('hand-log-resize-corner')).toBeInTheDocument()

    fireEvent.mouseDown(screen.getByTestId('hand-log-move-grip'), {
      button: 0,
      clientX: 100,
      clientY: 20,
    })
    moveMouseWithPrimaryButton(110, 30)
    fireEvent.mouseUp(document)

    expect(savedLayoutCalls()).toHaveLength(1)
    // 表示は160x60でも、保存されるのは指定サイズのまま。
    expect(savedLayoutCalls()[0]![0].layout).toEqual({
      left: 0,
      top: 0,
      width: 400,
      height: 100,
    })
    expect(logContainer.style.width).toBe('160px')
    expect(logContainer.style.height).toBe('60px')
  })

  it('layout読込timeout後も同じloadの権威的応答を適用する', () => {
    jest.useFakeTimers()
    const loadCallbacks: Array<(response: unknown) => void> = []
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      if (message.action === 'getDeviceHandLogLayout') {
        loadCallbacks.push(callback)
      } else {
        callback?.({ success: true })
      }
    })
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement

    act(() => {
      jest.advanceTimersByTime(DEVICE_LAYOUT_MESSAGE_TIMEOUT_MS)
    })
    expect(logContainer.style.left).toBe('614px')

    act(() => {
      loadCallbacks[0]!({
        success: true,
        layout: { left: 40, top: 30, width: 500, height: 200 },
      })
    })

    expect(logContainer.style.left).toBe('40px')
    expect(logContainer.style.top).toBe('30px')
    expect(logContainer.style.width).toBe('500px')
    expect(logContainer.style.height).toBe('200px')
    jest.useRealTimers()
  })

  it('旧scaleに束縛された非同期load結果を新scaleのlayoutへ適用しない', () => {
    const loadCallbacks: Array<(response: unknown) => void> = []
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      if (message.action === 'getDeviceHandLogLayout') {
        loadCallbacks.push(callback)
      } else {
        callback?.({ success: true })
      }
    })
    const { container, rerender } = render(
      <HandLog entries={mockEntries} scale={1} />
    )
    const logContainer = container.firstChild as HTMLElement

    rerender(<HandLog entries={mockEntries} scale={2} />)
    expect(loadCallbacks).toHaveLength(2)

    act(() => {
      loadCallbacks[1]!({
        success: true,
        layout: { left: 40, top: 30, width: 200, height: 100 },
      })
      loadCallbacks[0]!({
        success: true,
        layout: { left: 300, top: 200, width: 500, height: 600 },
      })
    })

    expect(logContainer.style.left).toBe('40px')
    expect(logContainer.style.top).toBe('30px')
    expect(logContainer.style.width).toBe('200px')
    expect(logContainer.style.height).toBe('100px')
    expect(logContainer.style.transform).toContain('scale(2)')
  })

  it('旧effectのresize listenerも最新scaleでviewportを更新する', () => {
    const addEventListenerSpy = jest.spyOn(window, 'addEventListener')
    const loadCallbacks: Array<(response: unknown) => void> = []
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      if (message.action === 'getDeviceHandLogLayout') {
        loadCallbacks.push(callback)
      } else {
        callback?.({ success: true })
      }
    })

    try {
      const { container, rerender } = render(
        <HandLog entries={mockEntries} scale={1} />
      )
      const logContainer = container.firstChild as HTMLElement
      const staleResizeListener = addEventListenerSpy.mock.calls.find(
        ([type]) => type === 'resize'
      )?.[1] as EventListener

      rerender(<HandLog entries={mockEntries} scale={2} />)
      act(() => {
        staleResizeListener(new Event('resize'))
        loadCallbacks[1]!({
          success: true,
          layout: { left: 40, top: 30, width: 300, height: 200 },
        })
      })

      expect(logContainer.style.left).toBe('40px')
      expect(logContainer.style.top).toBe('30px')
      expect(logContainer.style.transform).toContain('scale(2)')
    } finally {
      addEventListenerSpy.mockRestore()
    }
  })

  it('操作中に保留した新scaleのlayout読込を終了後に再開する', () => {
    const loadCallbacks: Array<(response: unknown) => void> = []
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      if (message.action === 'getDeviceHandLogLayout') {
        loadCallbacks.push(callback)
      } else {
        callback?.({ success: true })
      }
    })
    const { container, rerender } = render(
      <HandLog entries={mockEntries} scale={1} />
    )
    const logContainer = container.firstChild as HTMLElement

    expect(loadCallbacks).toHaveLength(1)
    fireEvent.mouseDown(screen.getByTestId('hand-log-move-grip'), {
      button: 0,
      clientX: 700,
      clientY: 550,
    })
    rerender(<HandLog entries={mockEntries} scale={2} />)
    expect(loadCallbacks).toHaveLength(1)

    fireEvent.mouseUp(document)
    expect(loadCallbacks).toHaveLength(2)
    expect(savedLayoutCalls()).toHaveLength(0)

    act(() => {
      loadCallbacks[1]!({
        success: true,
        layout: { left: 40, top: 30, width: 300, height: 200 },
      })
      loadCallbacks[0]!({
        success: true,
        layout: { left: 300, top: 200, width: 500, height: 600 },
      })
    })

    expect(logContainer.style.left).toBe('40px')
    expect(logContainer.style.top).toBe('30px')
    expect(logContainer.style.width).toBe('300px')
    expect(logContainer.style.height).toBe('200px')
    expect(logContainer.style.transform).toContain('scale(2)')
  })

  it('操作中のviewport変更をmouseupまで保持し正規化後layoutを一度だけ保存する', () => {
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      if (message.action === 'getDeviceHandLogLayout') {
        callback({
          success: true,
          layout: { left: 100, top: 500, width: 400, height: 200 },
        })
      } else {
        callback?.({ success: true })
      }
    })
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement

    fireEvent.mouseDown(screen.getByTestId('hand-log-move-grip'), {
      button: 0,
      clientX: 200,
      clientY: 514,
    })
    setViewport(640, 480)
    fireEvent(window, new Event('resize'))

    expect(logContainer.style.top).toBe('500px')
    moveMouseWithPrimaryButton(210, 524)
    expect(logContainer.style.top).toBe('510px')
    fireEvent.mouseUp(document)

    expect(logContainer.style.top).toBe('280px')
    expect(savedLayoutCalls()).toEqual([
      [
        {
          action: 'setDeviceHandLogLayout',
          layout: { left: 110, top: 280, width: 400, height: 200 },
        },
        expect.any(Function),
      ],
    ])
  })

  it('操作中のscale変更をmouseupまで保持しpointer移動なしなら再読込する', () => {
    let loadCount = 0
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      if (message.action === 'getDeviceHandLogLayout') {
        loadCount += 1
        callback({
          success: true,
          layout: { left: 100, top: 500, width: 400, height: 200 },
        })
      } else {
        callback?.({ success: true })
      }
    })
    const { container, rerender } = render(
      <HandLog entries={mockEntries} scale={1} />
    )
    const logContainer = container.firstChild as HTMLElement

    fireEvent.mouseDown(screen.getByTestId('hand-log-move-grip'), {
      button: 0,
      clientX: 200,
      clientY: 514,
    })
    rerender(<HandLog entries={mockEntries} scale={2} />)

    expect(logContainer.style.top).toBe('500px')
    expect(logContainer.style.transform).toContain('scale(1)')
    fireEvent.mouseUp(document)

    expect(logContainer.style.top).toBe('368px')
    expect(logContainer.style.height).toBe('200px')
    expect(logContainer.style.transform).toContain('scale(2)')
    expect(loadCount).toBe(2)
    expect(savedLayoutCalls()).toHaveLength(0)
  })

  it('左上へ移動してもパネル全体を画面内へ保つ', () => {
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement
    updateLayout({ left: 500, top: 400, width: 400, height: 100 })

    fireEvent.mouseDown(screen.getByTestId('hand-log-move-grip'), {
      button: 0,
      clientX: 600,
      clientY: 414,
    })
    moveMouseWithPrimaryButton(-2000, -2000)

    expect(logContainer.style.left).toBe('0px')
    expect(logContainer.style.top).toBe('0px')
    fireEvent.mouseUp(document)
  })

  it('右下へ移動してもパネル全体を画面内へ保つ', () => {
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement
    updateLayout({ left: 500, top: 400, width: 400, height: 100 })

    fireEvent.mouseDown(screen.getByTestId('hand-log-move-grip'), {
      button: 0,
      clientX: 600,
      clientY: 414,
    })
    moveMouseWithPrimaryButton(3000, 3000)

    // 右下端 = viewport - パネル実寸 (1024-400, 768-100)
    expect(logContainer.style.left).toBe('624px')
    expect(logContainer.style.top).toBe('668px')
    fireEvent.mouseUp(document)

    expect(savedLayoutCalls()).toEqual([
      [
        {
          action: 'setDeviceHandLogLayout',
          layout: { left: 624, top: 668, width: 400, height: 100 },
        },
        expect.any(Function),
      ],
    ])
  })

  it('scale込みの実寸で画面内に収める', () => {
    const { container } = render(<HandLog entries={mockEntries} scale={2} />)
    const logContainer = container.firstChild as HTMLElement
    updateLayout({ left: 100, top: 100, width: 400, height: 200 })

    fireEvent.mouseDown(screen.getByTestId('hand-log-move-grip'), {
      button: 0,
      clientX: 200,
      clientY: 200,
    })
    moveMouseWithPrimaryButton(3000, 3000)

    // 実寸は 800x400。scaleを無視した400x200では画面外へはみ出す。
    expect(logContainer.style.left).toBe('224px')
    expect(logContainer.style.top).toBe('368px')
    fireEvent.mouseUp(document)
  })

  it('画面幅を超える保存widthは表示だけ上限へ戻して画面内へ収める', () => {
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      if (message.action === 'getDeviceHandLogLayout') {
        callback({
          success: true,
          layout: { left: 800, top: 100, width: 1400, height: 200 },
        })
      } else {
        callback?.({ success: true })
      }
    })
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement

    expect(logContainer.style.left).toBe('0px')
    expect(logContainer.style.width).toBe('1024px')
    expect(logContainer.style.top).toBe('100px')

    // 表示だけの縮小であること: 移動しても保存widthは1400のまま。
    fireEvent.mouseDown(screen.getByTestId('hand-log-move-grip'), {
      button: 0,
      clientX: 8,
      clientY: 108,
    })
    moveMouseWithPrimaryButton(8, 158)
    fireEvent.mouseUp(document)

    expect(savedLayoutCalls()[0]![0].layout).toEqual({
      left: 0,
      top: 150,
      width: 1400,
      height: 200,
    })
  })

  it('右下角で縦横をリサイズし最小値を適用する', () => {
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement
    updateLayout({ left: 500, top: 400, width: 400, height: 100 })
    const resizeCorner = screen.getByTestId('hand-log-resize-corner')

    fireEvent.mouseDown(resizeCorner, {
      button: 0,
      clientX: 900,
      clientY: 500,
    })
    moveMouseWithPrimaryButton(700, 450)

    expect(logContainer.style.width).toBe('200px')
    expect(logContainer.style.height).toBe('80px')
    fireEvent.mouseUp(document)
  })

  it('画面端を越える拡大はviewport実寸で頭打ちし左上を戻して収める', () => {
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement
    updateLayout({ left: 500, top: 400, width: 400, height: 100 })

    fireEvent.mouseDown(screen.getByTestId('hand-log-resize-corner'), {
      button: 0,
      clientX: 900,
      clientY: 500,
    })
    moveMouseWithPrimaryButton(1900, 1500)

    expect(logContainer.style.width).toBe('1024px')
    expect(logContainer.style.height).toBe('768px')
    expect(logContainer.style.left).toBe('0px')
    expect(logContainer.style.top).toBe('0px')
    fireEvent.mouseUp(document)

    // 保存されるのも実寸まで。画面に出ない巨大サイズは作らない。
    expect(savedLayoutCalls()[0]![0].layout).toEqual({
      left: 0,
      top: 0,
      width: 1024,
      height: 768,
    })
  })

  it('既定の右下寄せ位置からでも横幅を広げられる', () => {
    const { container } = render(<HandLog entries={mockEntries} scale={2} />)
    const logContainer = container.firstChild as HTMLElement

    // 既定位置は右端から10pxしかない。端で成長を止めるとほぼ拡大できない。
    expect(logContainer.style.left).toBe('214px')

    fireEvent.mouseDown(screen.getByTestId('hand-log-resize-corner'), {
      button: 0,
      clientX: 1014,
      clientY: 633,
    })
    moveMouseWithPrimaryButton(1214, 633)

    expect(logContainer.style.width).toBe('500px')
    expect(logContainer.style.left).toBe('24px')
    fireEvent.mouseUp(document)
  })

  it('画面端を越えてもmouseupまではリサイズを継続する', () => {
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement
    updateLayout({ left: 500, top: 400, width: 400, height: 100 })

    fireEvent.mouseDown(screen.getByTestId('hand-log-resize-corner'), {
      button: 0,
      clientX: 900,
      clientY: 500,
    })
    moveMouseWithPrimaryButton(910, 510)
    fireEvent.mouseLeave(document)
    moveMouseWithPrimaryButton(1900, 1500)

    expect(logContainer.style.width).toBe('1024px')
    expect(logContainer.style.height).toBe('768px')
    expect(savedLayoutCalls()).toHaveLength(0)

    fireEvent.mouseUp(document)
    expect(savedLayoutCalls()).toHaveLength(1)
  })

  it('window外でmouseupを取りこぼしても無押下の再入場時に操作を終了する', () => {
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement
    updateLayout({ left: 500, top: 400, width: 400, height: 100 })

    fireEvent.mouseDown(screen.getByTestId('hand-log-resize-corner'), {
      button: 0,
      clientX: 900,
      clientY: 500,
    })
    moveMouseWithPrimaryButton(910, 510)
    fireEvent.mouseMove(document, {
      buttons: 0,
      clientX: 1900,
      clientY: 1500,
    })

    expect(logContainer.style.width).toBe('410px')
    expect(logContainer.style.height).toBe('110px')
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
    expect(savedLayoutCalls()).toHaveLength(1)

    fireEvent.mouseMove(document, {
      buttons: 0,
      clientX: 2000,
      clientY: 1600,
    })
    fireEvent.mouseUp(document)
    expect(savedLayoutCalls()).toHaveLength(1)
  })

  it('window blurでも最後の位置を一度だけ保存してdrag状態を解除する', () => {
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement
    updateLayout({ left: 500, top: 400, width: 400, height: 100 })

    fireEvent.mouseDown(screen.getByTestId('hand-log-move-grip'), {
      button: 0,
      clientX: 600,
      clientY: 414,
    })
    moveMouseWithPrimaryButton(550, 384)
    fireEvent(window, new Event('blur'))

    expect(logContainer.style.left).toBe('450px')
    expect(logContainer.style.top).toBe('370px')
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
    expect(savedLayoutCalls()).toHaveLength(1)
  })

  it('HUD切替で操作中にunmountしても最後の位置を一度だけ保存する', () => {
    const { unmount } = render(<HandLog entries={mockEntries} />)
    updateLayout({ left: 500, top: 400, width: 400, height: 100 })

    fireEvent.mouseDown(screen.getByTestId('hand-log-move-grip'), {
      button: 0,
      clientX: 600,
      clientY: 414,
    })
    moveMouseWithPrimaryButton(550, 384)
    unmount()

    expect(savedLayoutCalls()).toHaveLength(1)
    expect(savedLayoutCalls()[0]![0].layout).toEqual({
      left: 450,
      top: 370,
      width: 400,
      height: 100,
    })
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
  })

  it('ポップアップからのリセットで既定の具体座標とサイズへ即時に戻す', () => {
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      if (message.action === 'getDeviceHandLogLayout') {
        callback({
          success: true,
          layout: { left: 120, top: 80, width: 520, height: 240 },
        })
      } else {
        callback?.({ success: true })
      }
    })
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement

    fireEvent(window, new CustomEvent('resetHandLogLayout'))

    expect(logContainer.style.left).toBe('614px')
    expect(logContainer.style.top).toBe('533px')
    expect(logContainer.style.width).toBe(`${DEFAULT_HAND_LOG_CONFIG.width}px`)
    expect(logContainer.style.height).toBe(`${DEFAULT_HAND_LOG_CONFIG.height}px`)
  })

  it('reset後の保存済みlayout配信を同じ状態機械へ取り込む', () => {
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement

    fireEvent(window, new CustomEvent('resetHandLogLayout'))
    updateLayout({ left: 80, top: 60, width: 520, height: 240 })

    expect(logContainer.style.left).toBe('80px')
    expect(logContainer.style.top).toBe('60px')
    expect(logContainer.style.width).toBe('520px')
    expect(logContainer.style.height).toBe('240px')
  })

  it('操作中のresetはpending scaleを採用して既定layoutを正規化する', () => {
    const { container, rerender } = render(
      <HandLog entries={mockEntries} scale={1} />
    )
    const logContainer = container.firstChild as HTMLElement

    fireEvent.mouseDown(screen.getByTestId('hand-log-move-grip'), {
      button: 0,
      clientX: 700,
      clientY: 550,
    })
    rerender(<HandLog entries={mockEntries} scale={2} />)
    expect(logContainer.style.transform).toContain('scale(1)')

    fireEvent(window, new CustomEvent('resetHandLogLayout'))

    expect(logContainer.style.left).toBe('214px')
    expect(logContainer.style.top).toBe('433px')
    expect(logContainer.style.width).toBe(`${DEFAULT_HAND_LOG_CONFIG.width}px`)
    expect(logContainer.style.height).toBe(`${DEFAULT_HAND_LOG_CONFIG.height}px`)
    expect(logContainer.style.transform).toContain('scale(2)')
    expect(savedLayoutCalls()).toHaveLength(0)
  })

  it('進行中のドラッグを古い保存済みlayout配信で上書きしない', () => {
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement
    updateLayout({ left: 500, top: 400, width: 400, height: 100 })

    fireEvent.mouseDown(screen.getByTestId('hand-log-move-grip'), {
      button: 0,
      clientX: 600,
      clientY: 414,
    })
    moveMouseWithPrimaryButton(550, 384)
    updateLayout({ left: 80, top: 60, width: 520, height: 240 })

    expect(logContainer.style.left).toBe('450px')
    expect(logContainer.style.top).toBe('370px')
    fireEvent.mouseUp(document)
  })

  it.each([
    {
      testId: 'hand-log-move-grip',
      startX: 220,
      startY: 94,
      movedX: 250,
      movedY: 124,
    },
    {
      testId: 'hand-log-resize-corner',
      startX: 640,
      startY: 320,
      movedX: 670,
      movedY: 350,
    },
  ])('リセット通知は進行中の$testId操作を破棄して再保存させない', ({
    testId,
    startX,
    startY,
    movedX,
    movedY,
  }) => {
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      if (message.action === 'getDeviceHandLogLayout') {
        callback({
          success: true,
          layout: { left: 120, top: 80, width: 520, height: 240 },
        })
      } else {
        callback?.({ success: true })
      }
    })
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement

    fireEvent.mouseDown(screen.getByTestId(testId), {
      button: 0,
      clientX: startX,
      clientY: startY,
    })
    moveMouseWithPrimaryButton(movedX, movedY)
    fireEvent(window, new CustomEvent('resetHandLogLayout'))

    expect(logContainer.style.left).toBe('614px')
    expect(logContainer.style.top).toBe('533px')
    expect(logContainer.style.width).toBe(`${DEFAULT_HAND_LOG_CONFIG.width}px`)
    expect(logContainer.style.height).toBe(`${DEFAULT_HAND_LOG_CONFIG.height}px`)
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')

    fireEvent.mouseMove(document, {
      clientX: movedX + 100,
      clientY: movedY + 100,
    })
    fireEvent.mouseUp(document)
    expect(savedLayoutCalls()).toHaveLength(0)
  })

  it('旧sync configの位置とサイズを端末レイアウトへ流用しない', () => {
    const { container } = render(
      <HandLog
        entries={mockEntries}
        config={{ position: 'top-left', width: 580, height: 260 }}
      />
    )
    const logContainer = container.firstChild as HTMLElement

    expect(logContainer.style.left).toBe('614px')
    expect(logContainer.style.top).toBe('533px')
    expect(logContainer.style.width).toBe(`${DEFAULT_HAND_LOG_CONFIG.width}px`)
    expect(logContainer.style.height).toBe(`${DEFAULT_HAND_LOG_CONFIG.height}px`)
  })

  it('スケールが表示と正規化の共通environmentに適用される', () => {
    const { container } = render(<HandLog entries={mockEntries} scale={1.5} />)
    const logContainer = container.firstChild as HTMLElement

    expect(logContainer.style.transform).toContain('scale(1.5)')
    expect(logContainer.style.left).toBe('414px')
    expect(logContainer.style.top).toBe('483px')
  })

  it('保存済みouter sizeからborderだけ引いて本文へ渡す', () => {
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      if (message.action === 'getDeviceHandLogLayout') {
        callback({
          success: true,
          layout: { left: 120, top: 80, width: 520, height: 240 },
        })
      } else {
        callback?.({ success: true })
      }
    })
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement

    expect(logContainer.style.width).toBe('520px')
    expect(logContainer.style.height).toBe('240px')
    // 画面端の判定と実寸を一致させるためborder-box。本文はそのぶん内側。
    expect(logContainer).toHaveStyle({ boxSizing: 'border-box' })
    // ヘッダー帯を廃したので、本文が失うのは1pxのborderだけ。
    expect(screen.getByTestId('virtual-list')).toHaveStyle({
      width: '518px',
      height: '238px',
    })
  })

  it('リサイズdeltaを操作開始時のscaleで補正する', () => {
    const { container } = render(<HandLog entries={mockEntries} scale={2} />)
    const logContainer = container.firstChild as HTMLElement

    fireEvent.mouseDown(screen.getByTestId('hand-log-resize-corner'), {
      button: 0,
      clientX: 1214,
      clientY: 683,
    })
    moveMouseWithPrimaryButton(1414, 783)

    expect(logContainer.style.width).toBe('500px')
    expect(logContainer.style.height).toBe('150px')
    fireEvent.mouseUp(document)
  })

  it('スクロール位置が最新エントリに移動する', () => {
    const { rerender } = render(<HandLog entries={mockEntries} />)
    
    // 新しいエントリを追加
    const newEntries = [
      ...mockEntries,
      {
        id: '5',
        handId: 3,
        timestamp: Date.now(),
        text: 'Hand #3: Another hand',
        type: HandLogEntryType.HEADER,
      },
    ]
    
    rerender(<HandLog entries={newEntries} />)
    
    // Virtual list should render new entries
    expect(screen.getByText('Hand #3: Another hand')).toBeInTheDocument()
  })

  it('scrollToLatestプロパティで外部からスクロールを制御できる', () => {
    const { rerender } = render(<HandLog entries={mockEntries} scrollToLatest={false} />)
    
    // scrollToLatestをtrueに変更
    rerender(<HandLog entries={mockEntries} scrollToLatest={true} />)
    
    // スクロールがトリガーされることを確認（virtual listなので実際のスクロールは測定できない）
    expect(screen.getByTestId('virtual-list')).toBeInTheDocument()
  })

  it('エントリタイプによって異なる色が適用される', () => {
    render(<HandLog entries={mockEntries} />)
    
    // 各タイプのエントリが正しくレンダリングされている
    const headerEntry = screen.getByText('Hand #1: Tournament started')
    const seatEntry = screen.getByText('Seat 1: Player1 (1000 chips)')
    const actionEntry = screen.getByText('Player1: folds')
    
    expect(headerEntry).toBeInTheDocument()
    expect(seatEntry).toBeInTheDocument()
    expect(actionEntry).toBeInTheDocument()
  })

  it('ハンド間にセパレーターが表示される', () => {
    render(<HandLog entries={mockEntries} />)
    
    // Virtual listの中にセパレーターが含まれている
    const virtualList = screen.getByTestId('virtual-list')
    expect(virtualList.children.length).toBeGreaterThan(mockEntries.length) // セパレーターが追加されている
  })
})
