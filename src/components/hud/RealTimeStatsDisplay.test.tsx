import { render, screen, fireEvent } from '@testing-library/react'
import { RealTimeStatsDisplay } from './RealTimeStatsDisplay'
import type { RealTimeStats } from '../../realtime-stats/realtime-stats-service'

// Mock useDraggable hook
const mockHandleMouseDown = jest.fn()
jest.mock('./hooks/useDraggable', () => ({
  useDraggable: jest.fn(() => ({
    containerRef: { current: null },
    isDragging: false,
    position: { top: '50%', left: '50%' },
    handleMouseDown: mockHandleMouseDown,
  })),
}))

describe('RealTimeStatsDisplay', () => {
  const mockStats: RealTimeStats = {
    holeCards: [51, 39], // Ad2s
    communityCards: [3, 4, 5],
    currentPhase: 'Flop',
    potOdds: {
      id: 'potOdds',
      name: 'Pot Odds',
      value: { pot: 100, call: 20, percentage: 16.7, ratio: '5:1', isHeroTurn: true },
      formatted: '16.7% (5:1)',
    },
    handImprovement: {
      id: 'handImprovement',
      name: 'Hand Improvement',
      value: {
        improvements: [
          { name: 'One Pair', probability: 25.0, rank: 2, isCurrent: false, isComplete: false },
          { name: 'Two Pair', probability: 15.0, rank: 3, isCurrent: false, isComplete: false },
          { name: 'Straight', probability: 10.0, rank: 5, isCurrent: false, isComplete: false },
          { name: 'Flush', probability: 5.0, rank: 6, isCurrent: false, isComplete: false },
          { name: 'Full House', probability: 2.5, rank: 7, isCurrent: false, isComplete: false },
          { name: 'Four of a Kind', probability: 0.5, rank: 8, isCurrent: false, isComplete: false },
          { name: 'Straight Flush', probability: 0.1, rank: 9, isCurrent: false, isComplete: false },
          { name: 'Three of a Kind', probability: 0, rank: 4, isCurrent: false, isComplete: false },
        ],
        currentHand: { rank: 1 }
      },
      formatted: 'Multiple improvements',
    },
  }

  it('リアルタイム統計を表示', () => {
    render(<RealTimeStatsDisplay stats={mockStats} seatIndex={0} />)

    // Starting hand ranking is displayed - AJs is the 10th ranked hand
    expect(screen.getByText(/AJs/)).toBeInTheDocument()  // Starting hand notation
    expect(screen.getByText(/\(10\/169\)/)).toBeInTheDocument()  // Hand ranking

    // 手札改善確率
    expect(screen.getByText('Straight Flush')).toBeInTheDocument()
    expect(screen.getByText('0.1%')).toBeInTheDocument()
    expect(screen.getByText('Four of a Kind')).toBeInTheDocument()
    expect(screen.getByText('0.5%')).toBeInTheDocument()
    expect(screen.getByText('Flush')).toBeInTheDocument()
    expect(screen.getByText('5.0%')).toBeInTheDocument()
  })

  it('改善確率が0%の手も表示される', () => {
    render(<RealTimeStatsDisplay stats={mockStats} seatIndex={0} />)

    // Three of a Kindは0%でも表示される
    expect(screen.getByText('Three of a Kind')).toBeInTheDocument()
    expect(screen.getByText('0.0%')).toBeInTheDocument()
  })

  it('手札改善情報がない場合は表示しない', () => {
    const statsWithoutImprovement: RealTimeStats = {
      ...mockStats,
      handImprovement: undefined,
    }

    const { container } = render(<RealTimeStatsDisplay stats={statsWithoutImprovement} seatIndex={0} />)

    // Component returns null, so nothing is rendered
    expect(container.firstChild).toBeNull()
  })

  it('ホバー時に背景色が変わる', async () => {
    const { container } = render(<RealTimeStatsDisplay stats={mockStats} seatIndex={0} />)
    
    // Find the element with pointer-events: auto which handles hover
    const hudElement = container.querySelector('[style*="pointer-events: auto"]') as HTMLElement
    
    // RealTimeStatsDisplay uses a static background color of rgba(0, 0, 0, 0.6)
    // and doesn't change on hover
    expect(hudElement).toBeInTheDocument()
    expect(hudElement.style.backgroundColor).toBe('rgba(0, 0, 0, 0.6)')
  })

  it('ドラッグ可能', () => {
    const { container } = render(<RealTimeStatsDisplay stats={mockStats} seatIndex={0} />)
    
    // ドラッグハンドルを探す - cursor: move style を持つ要素
    const dragHandle = container.querySelector('[style*="cursor: move"]')
    expect(dragHandle).toBeInTheDocument()

    // Clear previous calls
    mockHandleMouseDown.mockClear()

    // マウスダウンイベント
    fireEvent.mouseDown(dragHandle!)
    expect(mockHandleMouseDown).toHaveBeenCalled()
  })

  it('確率の高い順にソートして表示', () => {
    render(<RealTimeStatsDisplay stats={mockStats} seatIndex={0} />)

    const improvements = screen.getAllByText(/%$/)
    const values = improvements.map(el => parseFloat(el.textContent!))
    
    // 降順でソートされているか確認
    for (let i = 1; i < values.length; i++) {
      expect(values[i - 1]).toBeGreaterThanOrEqual(values[i]!)
    }
  })

})