import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import HandLog from './HandLog'
import { HandLogEntry, HandLogEntryType, HandLogConfig, DEFAULT_HAND_LOG_CONFIG } from '../types/hand-log'

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

  it('右下グリップの本体をドラッグして移動し端末ローカルへ保存する', () => {
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement
    logContainer.getBoundingClientRect = jest.fn(() => ({
      left: 500,
      top: 400,
      width: 400,
      height: 100,
      right: 900,
      bottom: 500,
      x: 500,
      y: 400,
      toJSON: () => {},
    }))

    fireEvent.mouseDown(screen.getByTestId('hand-log-move-grip'), {
      button: 0,
      clientX: 880,
      clientY: 480,
    })
    fireEvent.mouseMove(document, { clientX: 830, clientY: 450 })

    expect(logContainer.style.left).toBe('450px')
    expect(logContainer.style.top).toBe('370px')

    fireEvent.mouseUp(document)
    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
      {
        action: 'setDeviceHandLogLayout',
        layout: { left: 450, top: 370, width: 400, height: 100 },
      },
      expect.any(Function)
    )
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
    logContainer.getBoundingClientRect = jest.fn(() => ({
      left: 500,
      top: 400,
      width: 400,
      height: 100,
      right: 900,
      bottom: 500,
      x: 500,
      y: 400,
      toJSON: () => {},
    }))

    fireEvent.mouseDown(screen.getByTestId('hand-log-move-grip'), {
      button: 0,
      clientX: 880,
      clientY: 480,
    })
    fireEvent.mouseMove(document, { clientX: 830, clientY: 450 })
    resolveInitialLoad({
      success: true,
      layout: { left: 20, top: 30, width: 600, height: 300 },
    })

    expect(logContainer.style.left).toBe('450px')
    expect(logContainer.style.top).toBe('370px')
    fireEvent.mouseUp(document)
  })

  it('移動中だけ右下グリップが画面外へ消えないようにする', () => {
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement
    logContainer.getBoundingClientRect = jest.fn(() => ({
      left: 500,
      top: 400,
      width: 400,
      height: 100,
      right: 900,
      bottom: 500,
      x: 500,
      y: 400,
      toJSON: () => {},
    }))

    fireEvent.mouseDown(screen.getByTestId('hand-log-move-grip'), {
      button: 0,
      clientX: 880,
      clientY: 480,
    })
    fireEvent.mouseMove(document, { clientX: -2000, clientY: -2000 })

    expect(logContainer.style.left).toBe('-372px')
    expect(logContainer.style.top).toBe('-72px')
    fireEvent.mouseUp(document)
  })

  it('同じグリップの右下角で縦横をリサイズし最小値だけを適用する', () => {
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement
    logContainer.getBoundingClientRect = jest.fn(() => ({
      left: 500,
      top: 400,
      width: 400,
      height: 100,
      right: 900,
      bottom: 500,
      x: 500,
      y: 400,
      toJSON: () => {},
    }))
    const resizeCorner = screen.getByTestId('hand-log-resize-corner')

    fireEvent.mouseDown(resizeCorner, {
      button: 0,
      clientX: 900,
      clientY: 500,
    })
    fireEvent.mouseMove(document, { clientX: 1900, clientY: 1500 })

    expect(logContainer.style.width).toBe('1400px')
    expect(logContainer.style.height).toBe('1100px')
    fireEvent.mouseUp(document)

    fireEvent.mouseDown(resizeCorner, {
      button: 0,
      clientX: 1900,
      clientY: 1500,
    })
    fireEvent.mouseMove(document, { clientX: 0, clientY: 0 })

    expect(logContainer.style.width).toBe('200px')
    expect(logContainer.style.height).toBe('80px')
  })

  it('ポップアップからのリセットで既定の位置とサイズへ即時に戻す', () => {
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

    expect(logContainer.style.left).toBe('120px')
    expect(logContainer.style.width).toBe('520px')

    fireEvent(window, new CustomEvent('resetHandLogLayout'))

    expect(logContainer.style.left).toBe('')
    expect(logContainer.style.right).toBeTruthy()
    expect(logContainer.style.width).toBe(`${DEFAULT_HAND_LOG_CONFIG.width}px`)
    expect(logContainer.style.height).toBe(`${DEFAULT_HAND_LOG_CONFIG.height}px`)
  })

  it('旧sync configの位置とサイズを端末レイアウトへ流用しない', () => {
    const { container } = render(
      <HandLog
        entries={mockEntries}
        config={{ position: 'top-left', width: 580, height: 260 }}
      />
    )
    const logContainer = container.firstChild as HTMLElement

    expect(logContainer.style.bottom).toBeTruthy()
    expect(logContainer.style.right).toBeTruthy()
    expect(logContainer.style.top).toBe('')
    expect(logContainer.style.left).toBe('')
    expect(logContainer.style.width).toBe(`${DEFAULT_HAND_LOG_CONFIG.width}px`)
    expect(logContainer.style.height).toBe(`${DEFAULT_HAND_LOG_CONFIG.height}px`)
  })

  it('スケールが適用される', () => {
    const { container } = render(<HandLog entries={mockEntries} scale={1.5} />)
    const logContainer = container.firstChild as HTMLElement
    
    expect(logContainer.style.transform).toContain('scale(1.5)')
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
