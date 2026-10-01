import { render, screen } from '@testing-library/react'
import { RealTimeStatsDisplay } from './RealTimeStatsDisplay'
import { RankType } from '../../types/game'
import { handImprovementStat, setHandImprovementHeroHoleCards, setHandImprovementBatchMode } from '../../realtime-stats/hand-improvement'
import { PhaseType } from '../../types/game'
import type { RealTimeStats } from '../../realtime-stats/realtime-stats-service'

jest.mock('./hooks/useDraggable', () => ({
  useDraggable: () => ({
    containerRef: { current: null }, isDragging: false,
    position: { top: '50%', left: '50%' }, handleMouseDown: jest.fn()
  })
}))

const makeStats = (potOddsPercentage = 25): RealTimeStats => ({
  holeCards: [48, 49], communityCards: [0, 5, 10], currentPhase: 'Flop',
  potOdds: {
    id: 'potOdds', name: 'Pot Odds', formatted: '',
    value: { pot: 400, call: 100, percentage: potOddsPercentage, ratio: '3:1', isHeroTurn: true }
  },
  handImprovement: {
    id: 'handImprovement', name: 'Hand Improvement', formatted: '',
    value: {
      currentHand: { rank: RankType.ONE_PAIR, name: 'One Pair' },
      improvements: [
        { rank: RankType.FLUSH, name: 'Flush', probability: 20, isCurrent: false, isComplete: false },
        { rank: RankType.THREE_OF_A_KIND, name: 'Three of a Kind', probability: 10, isCurrent: false, isComplete: false },
        { rank: RankType.ONE_PAIR, name: 'One Pair', probability: 70, isCurrent: true, isComplete: false },
        { rank: RankType.HIGH_CARD, name: 'High Card', probability: 0, isCurrent: false, isComplete: false }
      ]
    }
  }
})

describe('リアルタイム役確率の表示回帰', () => {
  test('必要勝率との大小にかかわらず、未確定の役確率は中立色で表示する', () => {
    const { rerender } = render(<RealTimeStatsDisplay stats={makeStats(25)} seatIndex={0} />)
    expect(screen.getByText('70.0%')).toHaveStyle({ color: '#cccccc' })
    expect(screen.getByText('20.0%')).toHaveStyle({ color: '#cccccc' })
    rerender(<RealTimeStatsDisplay stats={makeStats(80)} seatIndex={0} />)
    expect(screen.getByText('70.0%')).toHaveStyle({ color: '#cccccc' })
    expect(screen.getByRole('table').getAttribute('title')).toMatch(/勝.*ではありません/)
  })

  test('現在役・強い役・弱い役の不透明度が正しい', () => {
    render(<RealTimeStatsDisplay stats={makeStats()} seatIndex={0} />)
    expect(screen.getByText('One Pair').closest('tr')).toHaveStyle({ opacity: '1' })
    expect(screen.getByText('Flush').closest('tr')).toHaveStyle({ opacity: '0.9' })
    expect(screen.getByText('High Card').closest('tr')).toHaveStyle({ opacity: '0.5' })
  })

  test('確定した役だけ緑色にする', () => {
    const stats = makeStats()
    stats.handImprovement = {
      id: 'handImprovement', name: 'Hand Improvement', formatted: '',
      value: {
        currentHand: { rank: RankType.FLUSH, name: 'Flush' },
        improvements: [{ rank: RankType.FLUSH, name: 'Flush', probability: 100, isCurrent: true, isComplete: true }]
      }
    }
    render(<RealTimeStatsDisplay stats={stats} seatIndex={0} />)
    expect(screen.getByText('100.0%')).toHaveStyle({ color: '#00ff00' })
  })

  test('プリフロップでも正確な最終役分布とスターティングハンド順位を表示する', async () => {
    setHandImprovementBatchMode(true)
    setHandImprovementBatchMode(false)
    setHandImprovementHeroHoleCards('display-test', '101', [48, 49])
    const value = await handImprovementStat.calculate({
      playerId: 101, actions: [], allPlayerActions: [], allPlayerPhases: [], winningHandIds: new Set<number>(),
      hands: [{
        id: 1, seatUserIds: [101], winningPlayerIds: [], smallBlind: 10, bigBlind: 20,
        session: { id: undefined, battleType: undefined, name: undefined }, results: []
      }],
      phases: [{ handId: 1, phase: PhaseType.PREFLOP, seatUserIds: [101], communityCards: [] }],
      session: { id: undefined, battleType: undefined, name: undefined, players: new Map(), reset: () => {} }
    })
    const stats: RealTimeStats = {
      ...makeStats(), currentPhase: 'Preflop', communityCards: [],
      handImprovement: { id: 'handImprovement', name: 'Hand Improvement', formatted: '', value }
    }
    render(<RealTimeStatsDisplay stats={stats} seatIndex={0} />)
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('0.8%')).toBeInTheDocument()
    expect(screen.getByText('36.0%')).toBeInTheDocument()
    expect(screen.queryByText('62.8%')).not.toBeInTheDocument()
    expect(screen.getByText(/AA/)).toBeInTheDocument()
  })
})
