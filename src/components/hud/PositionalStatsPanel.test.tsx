import { render, screen, waitFor, act } from '@testing-library/react'
import { PositionalStatsPanel } from './PositionalStatsPanel'
import { Position } from '../../types/game'
import type { PositionalStatsResult } from '../../types/stats'

const buildResult = (overrides: Partial<PositionalStatsResult> = {}): PositionalStatsResult => ({
  computedAt: Date.now(),
  positions: [
    { position: Position.BTN, handsN: 42, stats: { vpip: [10, 42], pfr: [8, 42], '3bet': [3, 20], steal: [5, 15], foldToSteal: [1, 4], cbet: [6, 12] } },
    { position: Position.CO, handsN: 30, stats: { vpip: [9, 30], pfr: [6, 30], '3bet': [2, 12], steal: [0, 0], foldToSteal: [0, 0], cbet: [4, 8] } },
    { position: Position.HJ, handsN: 5, stats: { vpip: [1, 5], pfr: [1, 5], '3bet': [0, 2], steal: [0, 0], foldToSteal: [0, 0], cbet: [0, 3] } },
    { position: Position.UTG, handsN: 0, stats: { vpip: [0, 0], pfr: [0, 0], '3bet': [0, 0], steal: [0, 0], foldToSteal: [0, 0], cbet: [0, 0] } },
    { position: Position.SB, handsN: 0, stats: { vpip: [0, 0], pfr: [0, 0], '3bet': [0, 0], steal: [0, 0], foldToSteal: [0, 0], cbet: [0, 0] } },
    { position: Position.BB, handsN: 10, stats: { vpip: [10, 10], pfr: [5, 10], '3bet': [1, 3], steal: [0, 0], foldToSteal: [2, 5], cbet: [1, 2] } },
    { position: 'unknown', handsN: 0, stats: { vpip: [0, 0], pfr: [0, 0], '3bet': [0, 0], steal: [0, 0], foldToSteal: [0, 0], cbet: [0, 0] } },
  ],
  ...overrides,
})

describe('PositionalStatsPanel', () => {
  let mockSendMessage: jest.Mock

  beforeEach(() => {
    mockSendMessage = jest.fn()
    global.chrome = {
      ...global.chrome,
      runtime: {
        ...global.chrome.runtime,
        sendMessage: mockSendMessage,
      },
    } as any
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('ロード中はローディング表示、応答が来るとテーブルに切り替わる', async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      // 非同期に応答（コールバックをすぐには呼ばない）
      Promise.resolve().then(() => callback({ success: true, positionalStats: buildResult() }))
    })

    render(<PositionalStatsPanel playerId={123} />)

    expect(screen.getByText('Loading positions…')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByText('BTN')).toBeInTheDocument()
    })

    expect(screen.queryByText('Loading positions…')).not.toBeInTheDocument()
  })

  it('リクエストはgetPositionalStatsアクションでplayerIdを渡す', async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      callback({ success: true, positionalStats: buildResult() })
    })

    render(<PositionalStatsPanel playerId={999} />)

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith(
        { action: 'getPositionalStats', playerId: 999 },
        expect.any(Function)
      )
    })
  })

  it('パーセンテージを0桁で表示し、分母0は"-"にする', async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      callback({ success: true, positionalStats: buildResult() })
    })

    render(<PositionalStatsPanel playerId={123} />)

    await waitFor(() => screen.getByText('BTN'))

    // BTN行: vpip 10/42 -> 24%
    const btnRow = screen.getByText('BTN').closest('tr')!
    expect(btnRow).toHaveTextContent('24%')

    // CO行: steal 0/0 -> '-'
    const coRow = screen.getByText('CO').closest('tr')!
    expect(coRow).toHaveTextContent('-')
  })

  it('サンプル数(分母)が10未満のセルは低サンプルとしてマークされる', async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      callback({ success: true, positionalStats: buildResult() })
    })

    render(<PositionalStatsPanel playerId={123} />)

    await waitFor(() => screen.getByText('HJ'))

    // HJ行: 3bet is [0,2] -> den=2 < 10, dimmed
    const hjRow = screen.getByText('HJ').closest('tr')!
    const lowSampleCells = hjRow.querySelectorAll('[data-low-sample="true"]')
    expect(lowSampleCells.length).toBeGreaterThan(0)
    lowSampleCells.forEach(cell => {
      expect(cell).toHaveStyle({ color: '#666666' })
    })

    // BTN行: vpip is [10,42] -> den=42 >= 10, not dimmed
    const btnRow = screen.getByText('BTN').closest('tr')!
    const vpipCell = btnRow.querySelectorAll('td')[2]
    expect(vpipCell).not.toHaveAttribute('data-low-sample')
  })

  it('unknownバケットはhandsNが0の場合は非表示', async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      callback({ success: true, positionalStats: buildResult() })
    })

    render(<PositionalStatsPanel playerId={123} />)

    await waitFor(() => screen.getByText('BTN'))

    expect(screen.queryByText('?')).not.toBeInTheDocument()
  })

  it('unknownバケットはhandsNが0より大きい場合は表示', async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      const result = buildResult()
      const unknownBucket = result.positions.find(p => p.position === 'unknown')!
      unknownBucket.handsN = 3
      callback({ success: true, positionalStats: result })
    })

    render(<PositionalStatsPanel playerId={123} />)

    await waitFor(() => {
      expect(screen.getByText('?')).toBeInTheDocument()
    })
  })

  it('success:falseの応答はフェイルオープンでプレースホルダーを表示', async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      callback({ success: false, error: 'boom' })
    })

    render(<PositionalStatsPanel playerId={123} />)

    await waitFor(() => {
      expect(screen.getByText('—')).toBeInTheDocument()
    })
    expect(screen.queryByText('BTN')).not.toBeInTheDocument()
  })

  it('タイムアウト（応答なし）はフェイルオープンでプレースホルダーを表示し、HUDをクラッシュさせない', async () => {
    jest.useFakeTimers()
    // コールバックを一切呼ばない = ハング中のservice workerを模倣
    mockSendMessage.mockImplementation(() => {})

    render(<PositionalStatsPanel playerId={123} />)

    expect(screen.getByText('Loading positions…')).toBeInTheDocument()

    await act(async () => {
      await jest.advanceTimersByTimeAsync(6000)
    })

    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('chrome.runtime.lastErrorが立っている場合もフェイルオープン', async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      ;(global.chrome.runtime as any).lastError = { message: 'no receiving end' }
      callback(undefined)
      delete (global.chrome.runtime as any).lastError
    })

    render(<PositionalStatsPanel playerId={123} />)

    await waitFor(() => {
      expect(screen.getByText('—')).toBeInTheDocument()
    })
  })

  it('playerIdが変わると再フェッチする', async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      callback({ success: true, positionalStats: buildResult() })
    })

    const { rerender } = render(<PositionalStatsPanel playerId={1} />)
    await waitFor(() => screen.getByText('BTN'))
    expect(mockSendMessage).toHaveBeenCalledTimes(1)

    rerender(<PositionalStatsPanel playerId={2} />)

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledTimes(2)
    })
    expect(mockSendMessage).toHaveBeenLastCalledWith(
      { action: 'getPositionalStats', playerId: 2 },
      expect.any(Function)
    )
  })
})
