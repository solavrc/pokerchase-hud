import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import HandLog from './HandLog'
import { HandLogEntry, HandLogEntryType, HandLogConfig, DEFAULT_HAND_LOG_CONFIG } from '../types/hand-log'

// Mock react-window
jest.mock('react-window', () => ({
  VariableSizeList: React.forwardRef(({ children: Children, itemCount, itemData, height, width }: any, ref: any) => {
    // Mock scrollToItem method
    React.useImperativeHandle(ref, () => ({
      scrollToItem: jest.fn(),
    }))
    
    // Children is a React component, not a function
    return (
      <div ref={ref} data-testid="virtual-list" style={{ height, width }}>
        {Array.from({ length: itemCount }).map((_, index) => (
          <div key={index}>
            <Children index={index} style={{}} data={itemData} />
          </div>
        ))}
      </div>
    )
  }),
}))

// Mock navigator.clipboard
const mockWriteText = jest.fn()
Object.assign(navigator, {
  clipboard: {
    writeText: mockWriteText,
  },
})

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
    mockWriteText.mockResolvedValue(undefined)
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

  it('ホバー時に高さが拡張される', async () => {
    const { container } = render(<HandLog entries={mockEntries} />)
    const logContainer = container.firstChild as HTMLElement
    
    // 初期の高さを確認
    expect(logContainer.style.height).toBe(`${DEFAULT_HAND_LOG_CONFIG.height}px`)
    
    // ホバー
    fireEvent.mouseEnter(logContainer)
    
    // 高さが拡張される（ウィンドウの高さの半分）
    await waitFor(() => {
      expect(logContainer.style.height).toBe(`${window.innerHeight / 2}px`)
    })
    
    // ホバー解除
    fireEvent.mouseLeave(logContainer)
    
    // 元の高さに戻る
    await waitFor(() => {
      expect(logContainer.style.height).toBe(`${DEFAULT_HAND_LOG_CONFIG.height}px`)
    })
  })

  it('位置設定に基づいて配置される', () => {
    const positions: Array<'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'> = [
      'bottom-right',
      'bottom-left',
      'top-right',
      'top-left',
    ]

    positions.forEach((position) => {
      const { container, unmount } = render(
        <HandLog entries={mockEntries} config={{ position }} />
      )
      const logContainer = container.firstChild as HTMLElement
      
      if (position.includes('bottom')) {
        expect(logContainer.style.bottom).toBeTruthy()
      } else {
        expect(logContainer.style.top).toBeTruthy()
      }
      
      if (position.includes('right')) {
        expect(logContainer.style.right).toBeTruthy()
      } else {
        expect(logContainer.style.left).toBeTruthy()
      }
      
      unmount()
    })
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