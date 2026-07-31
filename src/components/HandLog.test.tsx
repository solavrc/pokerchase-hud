import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import HandLog, {
  countWrappedLines,
  estimateEntryRowHeight,
  measureHandLogTextWidth,
  FALLBACK_NARROW_CHAR_WIDTH_RATIO,
  FALLBACK_WIDE_CHAR_WIDTH_RATIO,
} from './HandLog'
import { HandLogEntry, HandLogEntryType, HandLogConfig, DEFAULT_HAND_LOG_CONFIG } from '../types/hand-log'
import { DEVICE_LAYOUT_MESSAGE_TIMEOUT_MS } from '../utils/ui-config-storage'

// Mock react-window v2 API
jest.mock('react-window', () => {
  const React = require('react')
  // jsdomでは実測しようがないので、テストから明示的に切り替える。
  // 0 = macOSのオーバーレイスクロールバー、15 = Windows/Linuxの実体持ち。
  const scrollbar = { size: 0 }
  return {
    getScrollbarSize: (_recalculate?: boolean) => scrollbar.size,
    __setScrollbarSize: (size: number) => { scrollbar.size = size },
    List: ({ rowComponent: RowComponent, rowCount, rowProps, rowHeight, style, listRef }: any) => {
      // Mock scrollToRow method via listRef
      React.useImperativeHandle(listRef, () => ({
        scrollToRow: jest.fn(),
        get element() { return null },
      }))

      // 本物のListと同じく、行ラッパーへrowHeightの戻り値をそのまま適用する。
      // 行高の推定はこのラッパーのstyle.heightから検証する。
      return (
        <div data-testid="virtual-list" style={style}>
          {Array.from({ length: rowCount }).map((_, index) => (
            <div
              key={index}
              data-testid={`virtual-row-${index}`}
              style={{
                height: typeof rowHeight === 'function'
                  ? rowHeight(index, rowProps)
                  : rowHeight,
              }}
            >
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
const setDevicePixelRatio = (ratio: number) => {
  Object.defineProperty(window, 'devicePixelRatio', {
    value: ratio,
    writable: true,
    configurable: true,
  })
}
const setScrollbarSize = (size: number) => {
  (jest.requireMock('react-window') as {
    __setScrollbarSize: (size: number) => void
  }).__setScrollbarSize(size)
}

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
    setScrollbarSize(0)
    setDevicePixelRatio(1)
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

    expect(logContainer.style.left).toBe('10px')
    expect(logContainer.style.top).toBe('75px')
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
    // 既定位置は左上なので、左上方向へ動かすとclampで0に張り付いて
    // 「巻き戻していない」ことが観測できない。右下方向へ動かす。
    moveMouseWithPrimaryButton(750, 570)
    act(() => {
      resolveInitialLoad({
        success: true,
        layout: { left: 20, top: 30, width: 600, height: 300 },
      })
    })

    expect(logContainer.style.left).toBe('60px')
    expect(logContainer.style.top).toBe('105px')
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

  it('既定位置は0で頭打ちなのでviewportを0で読んでも画面内に残る', () => {
    // 上端はネームプレートを避けるためviewport比で決まるが、必ず[0, 400]で
    // 頭打ちにする。右下寄せ（viewportWidth - 余白 - 幅）だった頃はこの天井が
    // 無く、viewportが実ウィンドウより大きい値で読めた瞬間に既定座標が画面外へ
    // 落ちた（実機: ウィンドウを画面半分にした状態でリセットするとログが消え、
    // 最大化すると現れた）。
    setViewport(0, 0)
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement

    expect(logContainer.style.left).toBe('10px')
    expect(logContainer.style.top).toBe('0px')
    expect(logContainer.style.width).toBe('400px')
    expect(logContainer.style.height).toBe('100px')
  })

  it('既定位置は左上のネームプレートより上に収まる', () => {
    // プレートにはチップスタックが出るので、一部でも覆うと残りスタックが
    // 読めなくなる（sola指定、最優先の制約）。幅400pxのパネルは左端に置くと
    // 左列のプレートと横方向で必ず重なるため、縦で外すしかない。
    // 実測値は src/mockup/table-layout.ts の SEATS[].plate（viewport比）:
    // 上段プレイヤーB = 上端23.6%。
    const TOP_ROW_PLATE_TOP = 0.236

    for (const viewportHeight of [640, 720, 860, 900, 1080, 1440]) {
      setViewport(1280, viewportHeight)
      const { container, unmount } = render(<HandLog entries={mockEntries} />)
      const style = (container.firstChild as HTMLElement).style
      const bottom = parseFloat(style.top) + parseFloat(style.height)

      expect(bottom).toBeLessThanOrEqual(viewportHeight * TOP_ROW_PLATE_TOP)
      unmount()
    }
  })

  it('既定の上端は天井で頭打ちになりviewport高に比例し続けない', () => {
    // 天井が今回の修正の安全性質そのもの。これが無いと既定の上端は
    // viewportの読み値にそのまま比例し、実ウィンドウより大きい値を掴んだ
    // 瞬間に既定座標が画面外へ落ちる（＝直した不具合の入力が復活する）。
    setViewport(1280, 3000)
    const { container } = render(<HandLog entries={mockEntries} />)

    // 天井が無ければ 3000*0.236 - 100 - 6 = 602px になる
    expect((container.firstChild as HTMLElement).style.top).toBe('400px')
  })

  it('viewportが0のときは負へ動かしたドラッグ結果を画面内へ寄せる', () => {
    // viewport=0は「未確定」扱いで上限クランプを外す一方、下限0は常に効かせる。
    // 既定位置自体は非負なので、この分岐へ負値を通せるのはドラッグだけ。
    setViewport(0, 0)
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement

    fireEvent.mouseDown(screen.getByTestId('hand-log-move-grip'), {
      button: 0,
      clientX: 300,
      clientY: 300,
    })
    moveMouseWithPrimaryButton(150, 150)

    expect(logContainer.style.left).toBe('0px')
    expect(logContainer.style.top).toBe('0px')
    fireEvent.mouseUp(document)
  })

  it('既定位置はプレイヤーBのHUDパネルの帯へ入らない', () => {
    // BとAのプレートの間（32%〜57.8%）は一見あいているが、そこには
    // Hud.tsx の SEAT_POSITIONS[2] = top 35% がある。ログを差し込むと
    // HUDパネルそのものを潰す。
    const B_HUD_TOP_RATIO = 0.35

    for (const viewportHeight of [640, 860, 1080, 1440]) {
      setViewport(1280, viewportHeight)
      const { container, unmount } = render(<HandLog entries={mockEntries} />)
      const style = (container.firstChild as HTMLElement).style
      const bottom = parseFloat(style.top) + parseFloat(style.height)

      expect(bottom).toBeLessThanOrEqual(viewportHeight * B_HUD_TOP_RATIO)
      unmount()
    }
  })

  it('実ウィンドウより大きいviewportを保持していてもリセットは画面内へ戻す', () => {
    // 最大化時のviewportで環境をつかんだまま、ウィンドウが画面半分になり
    // resizeを取りこぼした状況。リセットはenvironmentを読み直すので、
    // 既定位置も画面内クランプも「今の」ウィンドウで決まる。
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement
    updateLayout({ left: 900, top: 700, width: 400, height: 100 })

    // resizeを発火させずにviewportだけ縮める＝environmentは1024x768のまま
    setViewport(500, 400)
    fireEvent(window, new CustomEvent('resetHandLogLayout'))

    expect(logContainer.style.left).toBe('10px')
    // 400高ではプレート上端(94px)の上に100pxを積む余地が無く0へ張り付く
    expect(logContainer.style.top).toBe('0px')
    // 幅400は500幅のviewportに収まるので表示は縮まない
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

    // 幅は表示上限（viewport実寸）まで縮み、左端の既定オフセット10pxは
    // 収まる余地が無いので0へ寄る。
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

  it('表示上限へ貼り付いた軸はリサイズしても保存サイズを縮めない', () => {
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      if (message.action === 'getDeviceHandLogLayout') {
        callback({
          success: true,
          layout: { left: 0, top: 100, width: 1400, height: 200 },
        })
      } else {
        callback?.({ success: true })
      }
    })
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement
    const resizeCorner = screen.getByTestId('hand-log-resize-corner')

    expect(logContainer.style.width).toBe('1024px')

    // 縦だけドラッグ: 横は掴んでいないので保存幅1400を維持する。
    fireEvent.mouseDown(resizeCorner, {
      button: 0,
      clientX: 1024,
      clientY: 300,
    })
    moveMouseWithPrimaryButton(1024, 350)
    fireEvent.mouseUp(document)

    expect(logContainer.style.height).toBe('250px')
    expect(savedLayoutCalls()[0]![0].layout).toEqual({
      left: 0,
      top: 100,
      width: 1400,
      height: 250,
    })

    // 外向きドラッグ: 既に上限なので表示は変わらない。保存幅も維持する。
    fireEvent.mouseDown(resizeCorner, {
      button: 0,
      clientX: 1024,
      clientY: 350,
    })
    moveMouseWithPrimaryButton(1300, 350)
    fireEvent.mouseUp(document)

    expect(logContainer.style.width).toBe('1024px')
    expect(savedLayoutCalls()[1]![0].layout.width).toBe(1400)
  })

  it('最小サイズを収容できないviewportではリサイズしても保存サイズを縮めない', () => {
    // 表示はviewport上限(160x60)に貼り付いていて1pxも動かせない。ここで保存値
    // だけ最小値へ落ちると、見えない縮小になってしまう。
    setViewport(320, 120)
    const { container } = render(<HandLog entries={mockEntries} scale={2} />)
    const logContainer = container.firstChild as HTMLElement

    fireEvent.mouseDown(screen.getByTestId('hand-log-resize-corner'), {
      button: 0,
      clientX: 320,
      clientY: 120,
    })
    moveMouseWithPrimaryButton(280, 100)
    fireEvent.mouseUp(document)

    expect(logContainer.style.width).toBe('160px')
    expect(logContainer.style.height).toBe('60px')
    expect(savedLayoutCalls()[0]![0].layout).toEqual({
      left: 0,
      top: 0,
      width: 400,
      height: 100,
    })
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
    expect(logContainer.style.left).toBe('10px')

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

  it('右端に寄せた位置からでも横幅を広げられる', () => {
    const { container } = render(<HandLog entries={mockEntries} scale={2} />)
    const logContainer = container.firstChild as HTMLElement
    // 右端から10pxまで寄せた状態。端で成長を止めるとほぼ拡大できないので、
    // はみ出しは位置clampがパネルを引き戻して解決する。
    updateLayout({ left: 214, top: 433, width: 400, height: 100 })

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

    expect(logContainer.style.left).toBe('10px')
    expect(logContainer.style.top).toBe('75px')
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

  it('操作中のresetは最新のscaleを採用して既定layoutを正規化する', () => {
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

    expect(logContainer.style.left).toBe('10px')
    // scale2では実寸200pxがプレート上端(181px)の上に収まらず0へ張り付く。
    // プレートを守る側に倒し、上のクライアントUIへ食い込ませる。
    expect(logContainer.style.top).toBe('0px')
    expect(logContainer.style.width).toBe(`${DEFAULT_HAND_LOG_CONFIG.width}px`)
    expect(logContainer.style.height).toBe(`${DEFAULT_HAND_LOG_CONFIG.height}px`)
    // 操作中に届いた新しいscaleは、resetの時点で確定して表示にも反映される
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

    expect(logContainer.style.left).toBe('10px')
    expect(logContainer.style.top).toBe('75px')
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

    expect(logContainer.style.left).toBe('10px')
    expect(logContainer.style.top).toBe('75px')
    expect(logContainer.style.width).toBe(`${DEFAULT_HAND_LOG_CONFIG.width}px`)
    expect(logContainer.style.height).toBe(`${DEFAULT_HAND_LOG_CONFIG.height}px`)
  })

  it('スケールが表示と正規化の共通environmentに適用される', () => {
    const { container } = render(<HandLog entries={mockEntries} scale={1.5} />)
    const logContainer = container.firstChild as HTMLElement
    // 既定位置は左上固定でscaleに依存しないため、scaleが正規化にも効いて
    // いることは画面端へ寄せた保存layoutでしか観測できない。
    // 幅400はscale1.5で実寸600、viewport1024なので左端上限は424になる。
    updateLayout({ left: 900, top: 700, width: 400, height: 100 })

    expect(logContainer.style.transform).toContain('scale(1.5)')
    expect(logContainer.style.left).toBe('424px')
    expect(logContainer.style.top).toBe('618px')
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

  describe('仮想リストの行高', () => {
    // 既定fontSize=8・等幅比0.6（jsdomにcanvasが無いためフォールバック）で
    // 1文字4.8px。折り返し幅は「表示幅 - border 1px×2 - EntryRowの左右
    // padding 8px×2」。
    const longEntry: HandLogEntry[] = [
      {
        id: 'long',
        handId: 1,
        timestamp: Date.now(),
        text: 'x'.repeat(100),
        type: HandLogEntryType.ACTION,
      },
    ]
    const rowHeight = (index: number) =>
      parseFloat(screen.getByTestId(`virtual-row-${index}`).style.height)

    it('パネル幅が狭いほど実際の折り返し行数だけ行高が伸びる', () => {
      render(<HandLog entries={longEntry} />)

      // 幅400: 本文382px ≒ 79文字/行 → 100文字は2行
      updateLayout({ left: 100, top: 100, width: 400, height: 100 })
      expect(rowHeight(0)).toBeCloseTo(21.2)

      // 幅200(最小): 本文182px ≒ 37文字/行 → 100文字は3行
      // 60文字固定の旧推定では幅によらず2行のままで、行が重なっていた
      updateLayout({ left: 100, top: 100, width: 200, height: 100 })
      expect(rowHeight(0)).toBeCloseTo(30.8)
    })

    it('viewportが保存幅より狭いときは表示幅で折り返しを数える', () => {
      render(<HandLog entries={longEntry} />)
      updateLayout({ left: 0, top: 0, width: 600, height: 300 })

      // 幅600: 本文582px ≒ 121文字/行 → 100文字は1行
      expect(rowHeight(0)).toBeCloseTo(11.6)

      setViewport(200, 768)
      fireEvent(window, new Event('resize'))

      // 保存幅は600pxのまま表示だけ200pxへ縮む。折り返しは縮んだ側で起きる
      // ので、保存幅で数えると1行のままになり行が重なる
      expect(rowHeight(0)).toBeCloseTo(30.8)
    })

    it('タイムスタンプ接頭辞の分だけ先頭行の残り幅を減らす', () => {
      render(<HandLog entries={longEntry} config={{ showTimestamps: true }} />)
      updateLayout({ left: 100, top: 100, width: 400, height: 100 })

      // [00:00:00]は6px等幅10文字+margin 8px = 44px ≒ 10文字分。
      // 先頭行には本文が入らず、80文字+20文字と合わせて3行になる
      expect(rowHeight(0)).toBeCloseTo(30.8)
    })

    it('フォントサイズを上げると1行あたり文字数が減り行高が伸びる', () => {
      render(<HandLog entries={longEntry} config={{ fontSize: 16 }} />)
      updateLayout({ left: 100, top: 100, width: 400, height: 100 })

      // 1文字9.6px ≒ 39文字/行 → 100文字は3行、1行の高さも倍
      expect(rowHeight(0)).toBeCloseTo(59.6)
    })

    it('日本語のプレイヤー名を全角幅で数える', () => {
      // 日本語は等幅フォントに収録されず約1emの日本語フォントへフォールバック
      // するので、ASCII基準(0.6em)で数えると行数を最大1.7倍過小評価する
      const japaneseEntry: HandLogEntry[] = [
        {
          id: 'jp',
          handId: 1,
          timestamp: Date.now(),
          text: '日本語'.repeat(15),
          type: HandLogEntryType.SEAT,
        },
      ]
      render(<HandLog entries={japaneseEntry} />)

      // 幅400: 本文382px = 全角47文字/行 → 45文字は1行
      updateLayout({ left: 100, top: 100, width: 400, height: 100 })
      expect(rowHeight(0)).toBeCloseTo(11.6)

      // 幅200: 本文182px = 全角22文字/行 → 45文字は3行
      // 半角基準だと37文字/行と数えて2行になり、行が重なる
      updateLayout({ left: 100, top: 100, width: 200, height: 100 })
      expect(rowHeight(0)).toBeCloseTo(30.8)
    })

    it('非オーバーレイのスクロールバー幅を本文幅から差し引く', () => {
      // Windows/Linuxの実体を持つスクロールバーは行の包含幅を狭める
      const entry: HandLogEntry[] = [
        {
          id: 'fit',
          handId: 1,
          timestamp: Date.now(),
          // 78文字 = 374.4px。スクロールバー無し(382px)なら1行、
          // 15px確保する環境(367px)では2行になる長さ
          text: 'x'.repeat(78),
          type: HandLogEntryType.ACTION,
        },
      ]
      const { unmount } = render(<HandLog entries={entry} />)
      updateLayout({ left: 100, top: 100, width: 400, height: 100 })
      expect(rowHeight(0)).toBeCloseTo(11.6)
      unmount()

      setScrollbarSize(15)
      render(<HandLog entries={entry} />)
      updateLayout({ left: 100, top: 100, width: 400, height: 100 })
      expect(rowHeight(0)).toBeCloseTo(21.2)
    })

    it('ズーム変更時にスクロールバー幅を測り直す', () => {
      // ページズームでスクロールバーのCSSピクセル幅が変わる。初回計測値を
      // 使い続けると、ズームアウト後は実際のgutterより狭くしか引かない
      const entry: HandLogEntry[] = [
        {
          id: 'fit',
          handId: 1,
          timestamp: Date.now(),
          text: 'x'.repeat(78),
          type: HandLogEntryType.ACTION,
        },
      ]
      render(<HandLog entries={entry} />)
      updateLayout({ left: 100, top: 100, width: 400, height: 100 })
      expect(rowHeight(0)).toBeCloseTo(11.6)

      setScrollbarSize(15)
      setDevicePixelRatio(0.5)
      fireEvent(window, new Event('resize'))

      expect(rowHeight(0)).toBeCloseTo(21.2)
    })

    it('スクロール有無で行幅が変わらないようgutterを固定する', () => {
      render(<HandLog entries={mockEntries} />)

      // 推定は常にスクロールバー幅を引くので、実描画側も常に確保させる
      expect(screen.getByTestId('virtual-list')).toHaveStyle({
        scrollbarGutter: 'stable',
      })
    })

    it('セパレーター行は固定高のまま', () => {
      render(<HandLog entries={mockEntries} />)
      updateLayout({ left: 100, top: 100, width: 200, height: 100 })

      // mockEntriesはhandId=1が3件、その後にhandId=2との区切りが入る
      expect(rowHeight(3)).toBe(10)
    })

    it('EntryRowはborder-boxでpadding込みの高さに一致させる', () => {
      render(<HandLog entries={longEntry} />)

      expect(screen.getByText('x'.repeat(100))).toHaveStyle({
        boxSizing: 'border-box',
        padding: '1px 8px',
      })
    })
  })
})

describe('HandLogの行高推定', () => {
  // 1文字10px（全角は20px）の決定的な計測器。実環境ではcanvas実測。
  const isWide = (char: string) => /[\u3000-\u30ff\u3400-\u9fff\uff00-\uff60]/.test(char)
  const measureToken = (token: string) =>
    [...token].reduce((width, char) => width + (isWide(char) ? 20 : 10), 0)
  const measureText = (text: string, fontSize: number) =>
    [...text].reduce(
      (width, char) => width + fontSize * (isWide(char) ? 1 : 0.6),
      0
    )

  describe('countWrappedLines', () => {
    it('空エントリは行を占有しない', () => {
      expect(countWrappedLines('', 400, measureToken)).toBe(0)
    })

    it('1行に収まるテキストは1行', () => {
      expect(countWrappedLines('Player1: folds', 400, measureToken)).toBe(1)
    })

    it('単語境界で折り返す', () => {
      expect(countWrappedLines('aaaa bbbb cccc', 100, measureToken)).toBe(2)
    })

    it('単語境界で折り返すため幅の単純除算より行数が増えうる', () => {
      const text = 'aaaaaa bbbbbb cccccc'
      expect(Math.ceil(measureToken(text) / 100)).toBe(2)
      expect(countWrappedLines(text, 100, measureToken)).toBe(3)
    })

    it('1行に収まらない単語だけをbreak-wordとして分割する', () => {
      expect(countWrappedLines('x'.repeat(25), 100, measureToken)).toBe(3)
    })

    it('行頭でない長い単語は次行へ送ってから分割する', () => {
      // "ab " の後に25文字の語 → 2行目から10/10/5に割れる
      expect(countWrappedLines(`ab ${'x'.repeat(25)}`, 100, measureToken)).toBe(4)
    })

    it('行末の空白はぶら下がり、次の単語から改行する', () => {
      expect(countWrappedLines('aaaaaaaaaa bb', 100, measureToken)).toBe(2)
    })

    it('明示的な改行を行として数える', () => {
      expect(countWrappedLines('abc\ndef', 100, measureToken)).toBe(2)
    })

    it('先頭オフセット（タイムスタンプ）を消費済み幅として扱う', () => {
      expect(countWrappedLines('cccc', 100, measureToken)).toBe(1)
      expect(countWrappedLines('cccc', 100, measureToken, 80)).toBe(2)
    })

    it('文字数ではなく実幅で数える（全角は半角の2倍幅）', () => {
      // 同じ5文字でも、全角は半角の2倍の幅を占める
      expect(countWrappedLines('abcde', 100, measureToken)).toBe(1)
      expect(countWrappedLines('あいうえお', 100, measureToken)).toBe(1)
      expect(countWrappedLines('あいうえおか', 100, measureToken)).toBe(2)
      // 文字数基準（10文字/行）だと1行と誤判定する長さ
      expect(countWrappedLines('日本語のプレイヤー名', 100, measureToken)).toBe(2)
    })

    it('CJKは空白が無くても文字間で折り返す', () => {
      // 半角の長語はbreak-wordで割られるが、CJKは通常の折り返し機会を持つ。
      // どちらも1行100pxに5文字ずつ入る
      expect(countWrappedLines('あいうえおかきくけこ', 100, measureToken)).toBe(2)
    })

    // 以下の期待値はChromeの既定（line-break: auto）を実測して確定したもの。
    // 1行=全角2文字ぶん(40px)で、'あいうえ'は2行が基準
    it('行末禁則: 開き括弧の直後では改行しない', () => {
      expect(countWrappedLines('あいうえ', 40, measureToken)).toBe(2)
      // あ / （い / あ の3行になる
      expect(countWrappedLines('あ（いあ', 40, measureToken)).toBe(3)
    })

    it('行頭禁則: 句読点・閉じ括弧を行頭に置かない', () => {
      // あ / い、 / う の3行になる
      expect(countWrappedLines('あい、う', 40, measureToken)).toBe(3)
      expect(countWrappedLines('あい）う', 40, measureToken)).toBe(3)
      expect(countWrappedLines('あい」う', 40, measureToken)).toBe(3)
      expect(countWrappedLines('あい・う', 40, measureToken)).toBe(3)
    })

    it('ASCII句読点も行頭禁則として扱う', () => {
      // '{日本語名}: raises' のように全角の直後へASCII句読点が続く行は
      // ハンドログの主要な形。あ / い: / う の3行になる
      expect(countWrappedLines('あい:う', 40, measureToken)).toBe(3)
      expect(countWrappedLines('あい,う', 40, measureToken)).toBe(3)
      expect(countWrappedLines('あい)う', 40, measureToken)).toBe(3)
    })

    it('ASCII開き括弧の直後も行末禁則として扱う', () => {
      expect(countWrappedLines('あ(いあ', 40, measureToken)).toBe(3)
    })

    it('Chrome既定で改行できる小書き仮名・長音符は禁則にしない', () => {
      // 禁則に含めると逆に行数を過大評価して余白が空く
      expect(countWrappedLines('あいっう', 40, measureToken)).toBe(2)
      expect(countWrappedLines('あいーう', 40, measureToken)).toBe(2)
      expect(countWrappedLines('あいぁう', 40, measureToken)).toBe(2)
    })

    it('半角と全角が混在する行を実幅で数える', () => {
      // 'Seat 1: '(80px) + 全角3文字(60px) = 140px → 2行
      expect(countWrappedLines('Seat 1: 日本語', 100, measureToken)).toBe(2)
    })

    it('半角カナ・絵文字は全角幅でなくても改行機会を持つ', () => {
      // Chrome実測: 半角カナ(4px)と絵文字(10px)は文字間で改行できるので、
      // 前置きの残り幅を使い切ってから折り返す。1語として扱うと語ごと次行へ
      // 送ってから割ることになり、行を1つ余計に確保してしまう
      const width = (token: string) =>
        [...token].reduce((total, char) => {
          if (/\p{Emoji_Presentation}/u.test(char)) return total + 25
          if (/[\uFF61-\uFF9F]/.test(char)) return total + 10
          return total + (isWide(char) ? 20 : 10)
        }, 0)
      expect(countWrappedLines(`a ${'\uFF71'.repeat(16)}`, 60, width)).toBe(3)
      expect(countWrappedLines(`a ${'\uD83D\uDC1F'.repeat(7)}`, 60, width)).toBe(4)
    })

    it('補助平面の漢字も改行機会として扱う', () => {
      // CJK拡張B（`\u{20BB7}`など）はBMPの範囲指定から漏れる。半角1語として
      // 扱うと名前ごと次行へ送ってから割るので、行を1つ余計に確保する
      const width = (token: string) =>
        [...token].reduce(
          (total, char) => total + (/\p{Ideographic}/u.test(char) || isWide(char) ? 20 : 10),
          0
        )
      expect(countWrappedLines(`a ${'\u{20BB7}'.repeat(8)}`, 60, width)).toBe(3)
      expect(countWrappedLines(`a ${'\u{29E3D}'.repeat(8)}`, 60, width)).toBe(3)
    })

    it('改行禁止の空白（NBSP等）を空白として扱わない', () => {
      // CSSはNBSPの前後で改行しない。空白扱いすると改行機会を作るうえ、
      // 行末でぶら下げて幅も落としてしまう
      // 同じ見た目でも、NBSPは1語として割られ通常の空白は改行機会になる
      expect(countWrappedLines('aa\u00A0bb', 20, measureToken)).toBe(3)
      expect(countWrappedLines('aa bb', 20, measureToken)).toBe(2)
      // 通常の空白は行末でぶら下がるが、NBSPは幅を持ったまま次行へ送られる
      expect(countWrappedLines('aaa\u00A0aaa', 30, measureToken)).toBe(3)
      expect(countWrappedLines('aaa aaa', 30, measureToken)).toBe(2)
    })

    it('トランプのスートや記号は改行機会にしない', () => {
      // Chrome実測: ♠★→①は改行機会を持たない（半角英字と同じ扱い）。
      // 改行機会にするとカード表記の行を余計に折り返して詰めてしまう
      expect(countWrappedLines(`a ${'\u2660'.repeat(13)}`, 60, measureToken)).toBe(4)
      expect(countWrappedLines(`a ${'x'.repeat(13)}`, 60, measureToken)).toBe(4)
      expect(countWrappedLines(`a ${'\u2605'.repeat(13)}`, 60, measureToken)).toBe(4)
      expect(countWrappedLines(`a ${'\u2460'.repeat(13)}`, 60, measureToken)).toBe(4)
    })

    it('60文字固定の旧推定が過小評価していた幅を正しく数える', () => {
      // 幅200pxのパネル ≒ 38文字/行。旧推定は ceil(100/60)=2行だった
      expect(countWrappedLines('x'.repeat(100), 380, measureToken)).toBe(3)
    })
  })

  describe('estimateEntryRowHeight', () => {
    const metrics = (textWidth: number, showTimestamps = false) => ({
      textWidth,
      fontSize: 8,
      showTimestamps,
      measureText,
    })

    it('1行のエントリは1行分の高さ + 上下padding', () => {
      expect(estimateEntryRowHeight('Player1: folds', metrics(384))).toBeCloseTo(11.6)
    })

    it('本文幅が狭いと行数が増える', () => {
      expect(estimateEntryRowHeight('x'.repeat(100), metrics(384))).toBeCloseTo(21.2)
      expect(estimateEntryRowHeight('x'.repeat(100), metrics(184))).toBeCloseTo(30.8)
    })

    it('日本語は全角幅で数える', () => {
      // 30文字の全角 = 240px。半角基準(4.8px/文字=144px)だと184pxに収まって
      // しまい1行と誤判定する
      expect(estimateEntryRowHeight('日本語'.repeat(10), metrics(184))).toBeCloseTo(21.2)
      expect(estimateEntryRowHeight('日本語'.repeat(10), metrics(384))).toBeCloseTo(11.6)
    })

    it('タイムスタンプ表示時は先頭行の残り幅が減る', () => {
      expect(estimateEntryRowHeight('x'.repeat(100), metrics(384, true))).toBeCloseTo(30.8)
    })

    it('本文幅が0以下でも1文字ずつ折り返して破綻しない', () => {
      expect(estimateEntryRowHeight('abc', metrics(0))).toBeCloseTo(3 * 9.6 + 2)
    })

    it('分解形の結合文字を余分な1文字として数えない', () => {
      // 見た目が同じ合成形と分解形は同じ行高になる。コードポイント単位で
      // 数えると分解形だけ2倍の幅になり、存在しない行ぶんの余白が空く
      const composed = '\u3070'.repeat(30)
      const decomposed = '\u306F\u3099'.repeat(30)
      const rowMetrics = {
        textWidth: 184,
        fontSize: 8,
        showTimestamps: false,
      }
      expect(estimateEntryRowHeight(decomposed, rowMetrics))
        .toBeCloseTo(estimateEntryRowHeight(composed, rowMetrics))
      // 全角30文字=240px → 184pxでは2行
      expect(estimateEntryRowHeight(decomposed, rowMetrics)).toBeCloseTo(21.2)
    })
  })

  describe('measureHandLogTextWidth', () => {
    it('結合文字を含むクラスタを1グリフとして測る', () => {
      // 合成形'ば'(U+3070)と分解形'は'+結合濁点(U+306F U+3099)は同じ1グリフ
      expect(measureHandLogTextWidth('\u3070', 8)).toBeCloseTo(8)
      expect(measureHandLogTextWidth('\u306F\u3099', 8)).toBeCloseTo(8)
      // 結合文字単体は送り幅0。妥当性の下限で1emへ丸めない
      expect(measureHandLogTextWidth('\u3099', 8)).toBe(0)
    })

    it('結合文字を含むクラスタを1グリフとして測る', () => {
      // 合成形'ば'(U+3070)と分解形'は'+濁点(U+306F U+3099)は同じ1グリフ
      expect(measureHandLogTextWidth('\u3070', 8)).toBeCloseTo(8)
      expect(measureHandLogTextWidth('\u306F\u3099', 8)).toBeCloseTo(8)
      // 結合文字単体は送り幅0（妥当性の下限で1emへ丸めない）
      expect(measureHandLogTextWidth('\u3099', 8)).toBe(0)
    })

    it('canvasが無い環境では保守的な半角/全角比へフォールバックする', () => {
      expect(measureHandLogTextWidth('00000', 8))
        .toBeCloseTo(5 * 8 * FALLBACK_NARROW_CHAR_WIDTH_RATIO)
      expect(measureHandLogTextWidth('あいうえお', 8))
        .toBeCloseTo(5 * 8 * FALLBACK_WIDE_CHAR_WIDTH_RATIO)
      expect(measureHandLogTextWidth('', 8)).toBe(0)
    })

    it('フォールバック比は想定フォント中で最も広いものを採る', () => {
      // 半角: Consolas 0.55 / Monaco・Courier New 0.6
      // 全角: 日本語フォントは1em（実測: 8pxで`あ`=8px）
      // 狭い比率を既定にすると1行あたりの文字数を過大評価して行が重なる
      expect(FALLBACK_NARROW_CHAR_WIDTH_RATIO).toBeGreaterThanOrEqual(0.6)
      expect(FALLBACK_WIDE_CHAR_WIDTH_RATIO).toBeGreaterThanOrEqual(1)
    })
  })
})
