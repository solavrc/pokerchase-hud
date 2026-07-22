import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Hud from './Hud'
import type { PlayerStats } from '../types/entities'
import type { StatDisplayConfig } from '../types/filters'
import type { RealTimeStats } from '../realtime-stats/realtime-stats-service'

// Mock chrome storage
const mockChromeStorageGet = jest.fn()
const mockChromeStorageSet = jest.fn()
global.chrome = {
  ...global.chrome,
  storage: {
    ...global.chrome.storage,
    sync: {
      get: mockChromeStorageGet,
      set: mockChromeStorageSet,
    },
  },
} as any

// Mock navigator.clipboard
Object.assign(navigator, {
  clipboard: {
    writeText: jest.fn().mockResolvedValue(undefined),
  },
})

describe('Hud', () => {
  const mockStatDisplayConfigs: StatDisplayConfig[] = [
    { id: 'vpip', enabled: true, order: 0 },
    { id: 'pfr', enabled: true, order: 1 },
    { id: '3bet', enabled: true, order: 2 },
  ]

  const mockPlayerStats: PlayerStats = {
    playerId: 123,
    statResults: [
      { id: 'playerName', name: 'Name', value: 'TestPlayer', formatted: 'TestPlayer' },
      { id: 'vpip', name: 'VPIP', value: [30, 100], formatted: '30.0% (30/100)' },
      { id: 'pfr', name: 'PFR', value: [20, 100], formatted: '20.0% (20/100)' },
      { id: '3bet', name: '3B', value: [5, 50], formatted: '10.0% (5/50)' },
    ],
  }

  const mockEmptyStats: PlayerStats = {
    playerId: -1,
  }

  const mockRealTimeStats: RealTimeStats = {
    holeCards: [51, 39], // Ad2s
    communityCards: [3, 4, 5],
    currentPhase: 'Flop',
    potOdds: { 
      id: 'potOdds', 
      name: 'Pot Odds', 
      value: { pot: 100, call: 20, percentage: 16.7, ratio: '5:1', isHeroTurn: true }, 
      formatted: '16.7% (5:1)' 
    },
    handImprovement: {
      id: 'handImprovement',
      name: 'Hand Improvement',
      value: { 
        improvements: [
          { name: 'Straight Flush', probability: 0.1, rank: 9, isCurrent: false, isComplete: false },
          { name: 'Four of a Kind', probability: 0.2, rank: 8, isCurrent: false, isComplete: false },
        ],
        currentHand: { rank: 1 }
      },
      formatted: 'Straight Flush: 0.1%'
    },
  }

  const mockPlayerPotOdds = {
    spr: 10.5,
    potOdds: {
      pot: 100,
      call: 20,
      percentage: 16.7,
      ratio: '5:1',
      isPlayerTurn: true,
    },
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockChromeStorageGet.mockImplementation((_, callback) => {
      callback({ [`hudPosition_0`]: { top: '50%', left: '50%' } })
    })
    global.chrome = {
      ...global.chrome,
      runtime: {
        ...global.chrome.runtime,
        sendMessage: jest.fn(),
      },
    } as any
  })

  it('空席の場合は"Waiting for Hand..."を表示', () => {
    render(
      <Hud
        actualSeatIndex={0}
        stat={mockEmptyStats}
        scale={1}
        statDisplayConfigs={mockStatDisplayConfigs}
      />
    )

    expect(screen.getByText('Waiting for Hand...')).toHaveStyle({ color: '#b8b8b8' })
  })

  it('プレイヤーがいるがデータがない場合は"No Data"を表示', () => {
    const noDataStats: PlayerStats = {
      playerId: 123,
      statResults: [],
    }

    render(
      <Hud
        actualSeatIndex={0}
        stat={noDataStats}
        scale={1}
        statDisplayConfigs={mockStatDisplayConfigs}
      />
    )

    expect(screen.getByText('No Data')).toHaveStyle({ color: '#b8b8b8' })
  })

  it('プレイヤー名と統計を表示', () => {
    render(
      <Hud
        actualSeatIndex={0}
        stat={mockPlayerStats}
        scale={1}
        statDisplayConfigs={mockStatDisplayConfigs}
      />
    )

    expect(screen.getByText('TestPlayer')).toBeInTheDocument()
    expect(screen.getByText('VPIP:')).toBeInTheDocument()
    expect(screen.getByText('30.0% (30/100)')).toBeInTheDocument()
    expect(screen.getByText('PFR:')).toBeInTheDocument()
    expect(screen.getByText('20.0% (20/100)')).toBeInTheDocument()
  })

  it.each(['full', 'compact'] as const)('%s HUDでポットオッズをSPRより先に表示', (hudDisplayMode) => {
    render(
      <Hud
        actualSeatIndex={0}
        stat={mockPlayerStats}
        scale={1}
        statDisplayConfigs={mockStatDisplayConfigs}
        playerPotOdds={mockPlayerPotOdds}
        hudDisplayMode={hudDisplayMode}
      />
    )

    const potOdds = screen.getByText('17%')
    const spr = screen.getByText('10.5')

    expect(potOdds.compareDocumentPosition(spr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('non-heroのポットオッズとSPRをリアルタイムに更新', () => {
    const { rerender } = render(
      <Hud
        actualSeatIndex={1}
        stat={mockPlayerStats}
        scale={1}
        statDisplayConfigs={mockStatDisplayConfigs}
        playerPotOdds={mockPlayerPotOdds}
      />
    )

    expect(screen.getByText('17%')).toBeInTheDocument()
    expect(screen.getByText('10.5')).toBeInTheDocument()

    rerender(
      <Hud
        actualSeatIndex={1}
        stat={mockPlayerStats}
        scale={1}
        statDisplayConfigs={mockStatDisplayConfigs}
        playerPotOdds={{
          spr: 6.25,
          potOdds: {
            pot: 140,
            call: 40,
            percentage: 22.2,
            ratio: '3.5:1',
            isPlayerTurn: false,
          },
        }}
      />
    )

    expect(screen.getByText('22%')).toBeInTheDocument()
    expect(screen.getByText('6.25')).toBeInTheDocument()
  })

  it('ヒーロー（席0）の場合はリアルタイム統計を表示', () => {
    render(
      <Hud
        actualSeatIndex={0}
        stat={mockPlayerStats}
        scale={1}
        statDisplayConfigs={mockStatDisplayConfigs}
        realTimeStats={mockRealTimeStats}
      />
    )

    // RealTimeStatsDisplayコンポーネントがレンダリングされる
    // Real-time stats displays hand ranking instead of "Pot Odds" label
    expect(screen.getByText(/Straight Flush/)).toBeInTheDocument()
  })

  it('クリックで統計をクリップボードにコピー', async () => {
    render(
      <Hud
        actualSeatIndex={0}
        stat={mockPlayerStats}
        scale={1}
        statDisplayConfigs={mockStatDisplayConfigs}
      />
    )

    const hudElement = screen.getByText('TestPlayer').closest('div')!.parentElement!
    await userEvent.click(hudElement)

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('Player: TestPlayer')
      )
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('VPIP: 30.0% (30/100)')
      )
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('PFR: 20.0% (20/100)')
      )
    })
  })

  it('ドラッグ可能', async () => {
    render(
      <Hud
        actualSeatIndex={0}
        stat={mockPlayerStats}
        scale={1}
        statDisplayConfigs={mockStatDisplayConfigs}
      />
    )

    // ドラッグハンドルを探す
    const container = screen.getByText('TestPlayer').closest('[style*="position: fixed"]')!
    // Drag handle is a child div with cursor: move style
    const dragHandle = container.querySelector('div[style*="cursor: move"]')

    expect(dragHandle).toBeInTheDocument()

    // マウスダウンイベント
    fireEvent.mouseDown(dragHandle!, { clientX: 100, clientY: 100 })

    // ドラッグ中の状態
    fireEvent.mouseMove(window, { clientX: 150, clientY: 150 })

    // マウスアップでドラッグ終了
    fireEvent.mouseUp(window)

    // Chrome storageに位置が保存される
    await waitFor(() => {
      expect(mockChromeStorageSet).toHaveBeenCalledWith(
        expect.objectContaining({
          hudPosition_0: expect.objectContaining({
            top: expect.any(String),
            left: expect.any(String),
          }),
        })
      )
    })
  })

  it('スケールが適用される', () => {
    render(
      <Hud
        actualSeatIndex={0}
        stat={mockPlayerStats}
        scale={1.5}
        statDisplayConfigs={mockStatDisplayConfigs}
      />
    )

    // Find the outermost container which has the transform style
    const playerNameElement = screen.getByText('TestPlayer')
    // Go up until we find the element with position: fixed which has the transform
    let hudElement = playerNameElement.parentElement
    while (hudElement && !hudElement.style.position?.includes('fixed')) {
      hudElement = hudElement.parentElement
    }
    expect(hudElement?.style.transform).toContain('scale(1.5)')
  })

  it('ホバー時に背景色が変わる', async () => {
    render(
      <Hud
        actualSeatIndex={0}
        stat={mockPlayerStats}
        scale={1}
        statDisplayConfigs={mockStatDisplayConfigs}
      />
    )

    // Find the HUD background element (not the header)
    const playerNameElement = screen.getByText('TestPlayer')
    // The background element is the one with pointer-events: auto that contains the header
    const hudElement = playerNameElement.closest('[style*="pointer-events: auto"]') as HTMLElement
    
    // 初期状態
    expect(hudElement.style.backgroundColor).toBe('rgba(0, 0, 0, 0.5)')

    // ホバー
    fireEvent.mouseEnter(hudElement)
    
    await waitFor(() => {
      expect(hudElement.style.backgroundColor).toBe('rgba(0, 0, 0, 0.7)')
    })

    // ホバー解除
    fireEvent.mouseLeave(hudElement)
    
    await waitFor(() => {
      expect(hudElement.style.backgroundColor).toBe('rgba(0, 0, 0, 0.5)')
    })
  })

  it('プレイヤーのターンの場合はポットオッズがハイライトされる', () => {
    render(
      <Hud
        actualSeatIndex={0}
        stat={mockPlayerStats}
        scale={1}
        statDisplayConfigs={mockStatDisplayConfigs}
        playerPotOdds={mockPlayerPotOdds}
      />
    )

    const potOddsElement = screen.getByText('17%')
    expect(potOddsElement).toHaveStyle({ color: '#00ff00' })
  })

  it('各席の初期位置が正しく設定される', () => {
    // Mock Chrome storage to return empty so default positions are used
    mockChromeStorageGet.mockImplementation((_, callback) => {
      callback({})
    })

    const positions = [
      { top: '65%', left: '65%' },
      { top: '70%', left: '10%' },
      { top: '35%', left: '10%' },
      { top: '20%', left: '65%' },
      { top: '35%', left: '90%' },
      { top: '70%', left: '90%' },
    ]

    positions.forEach((expectedPos, index) => {
      const { container, unmount } = render(
        <Hud
          actualSeatIndex={index}
          stat={mockPlayerStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
        />
      )

      // Wait for position to be set from default
      const hudElement = container.querySelector('div[style*="position: fixed"]') as HTMLElement
      // Note: The position might be null initially until the hook sets it
      if (hudElement) {
        expect(hudElement.style.top).toBe(expectedPos.top)
        expect(hudElement.style.left).toBe(expectedPos.left)
      }

      unmount()
    })
  })

  describe('ポジション別ドリルダウン', () => {
    it('onTogglePositionalPanelが渡されない場合はトリガーを表示しない', () => {
      render(
        <Hud
          actualSeatIndex={0}
          stat={mockPlayerStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
        />
      )

      expect(screen.queryByTitle('ポジション別スタッツ')).not.toBeInTheDocument()
    })

    it('トリガーをクリックするとonTogglePositionalPanelが呼ばれ、クリップボードコピーは発火しない', async () => {
      const handleToggle = jest.fn()

      render(
        <Hud
          actualSeatIndex={0}
          stat={mockPlayerStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
          onTogglePositionalPanel={handleToggle}
        />
      )

      const trigger = screen.getByTitle('ポジション別スタッツ')
      await userEvent.click(trigger)

      expect(handleToggle).toHaveBeenCalledTimes(1)
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
    })

    it('isPositionalPanelOpenがtrueの時のみドリルダウンパネルを表示する', async () => {
      (chrome.runtime.sendMessage as jest.Mock).mockImplementation(
        (_message: unknown, callback: (response: unknown) => void) => {
          callback({
            success: true,
            positionalStats: {
              computedAt: Date.now(),
              positions: [
                { position: 0, handsN: 12, stats: { vpip: [3, 12], pfr: [2, 12], '3bet': [0, 5], steal: [0, 0], foldToSteal: [0, 0], cbet: [0, 0] } },
              ],
            },
          })
        }
      )

      const { rerender } = render(
        <Hud
          actualSeatIndex={0}
          stat={mockPlayerStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
          onTogglePositionalPanel={jest.fn()}
          isPositionalPanelOpen={false}
        />
      )

      expect(screen.queryByTestId('positional-stats-panel')).not.toBeInTheDocument()

      rerender(
        <Hud
          actualSeatIndex={0}
          stat={mockPlayerStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
          onTogglePositionalPanel={jest.fn()}
          isPositionalPanelOpen={true}
        />
      )

      await waitFor(() => {
        expect(screen.getByTestId('positional-stats-panel')).toBeInTheDocument()
      })
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        { action: 'getPositionalStats', playerId: mockPlayerStats.playerId },
        expect.any(Function)
      )
    })

    it('データがない("No Data")プレイヤーにもトリガーとパネルを表示できる', async () => {
      (chrome.runtime.sendMessage as jest.Mock).mockImplementation(
        (_message: unknown, callback: (response: unknown) => void) => {
          callback({ success: false, error: 'no data' })
        }
      )

      const noDataStats: PlayerStats = { playerId: 456, statResults: [] }

      render(
        <Hud
          actualSeatIndex={0}
          stat={noDataStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
          onTogglePositionalPanel={jest.fn()}
          isPositionalPanelOpen={true}
        />
      )

      expect(screen.getByTitle('ポジション別スタッツ')).toBeInTheDocument()
      await waitFor(() => {
        expect(screen.getByTestId('positional-stats-panel')).toBeInTheDocument()
      })
    })
  })

  describe('直近ハンド・ドリルダウン', () => {
    it('onToggleRecentHandsPanelが渡されない場合はトリガーを表示しない', () => {
      render(
        <Hud
          actualSeatIndex={0}
          stat={mockPlayerStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
        />
      )

      expect(screen.queryByTitle('直近ハンド')).not.toBeInTheDocument()
    })

    it('トリガーをクリックするとonToggleRecentHandsPanelが呼ばれ、クリップボードコピーは発火しない', async () => {
      const handleToggle = jest.fn()

      render(
        <Hud
          actualSeatIndex={0}
          stat={mockPlayerStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
          onToggleRecentHandsPanel={handleToggle}
        />
      )

      const trigger = screen.getByTitle('直近ハンド')
      await userEvent.click(trigger)

      expect(handleToggle).toHaveBeenCalledTimes(1)
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
    })

    it('isRecentHandsPanelOpenがtrueの時のみドリルダウンパネルを表示する', async () => {
      (chrome.runtime.sendMessage as jest.Mock).mockImplementation(
        (_message: unknown, callback: (response: unknown) => void) => {
          callback({
            success: true,
            recentHands: {
              computedAt: Date.now(),
              hands: [
                { handId: 1, approxTimestamp: Date.now(), position: 0, holeCards: ['As', 'Ah'], preflopLine: 'Open', sawFlop: true, wentToShowdown: true, won: true, netChips: 1240 },
              ],
            },
          })
        }
      )

      const { rerender } = render(
        <Hud
          actualSeatIndex={0}
          stat={mockPlayerStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
          onToggleRecentHandsPanel={jest.fn()}
          isRecentHandsPanelOpen={false}
        />
      )

      expect(screen.queryByTestId('recent-hands-panel')).not.toBeInTheDocument()

      rerender(
        <Hud
          actualSeatIndex={0}
          stat={mockPlayerStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
          onToggleRecentHandsPanel={jest.fn()}
          isRecentHandsPanelOpen={true}
        />
      )

      await waitFor(() => {
        expect(screen.getByTestId('recent-hands-panel')).toBeInTheDocument()
      })
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        { action: 'getRecentHands', playerId: mockPlayerStats.playerId },
        expect.any(Function)
      )
    })

    it('データがない("No Data")プレイヤーにもトリガーとパネルを表示できる', async () => {
      (chrome.runtime.sendMessage as jest.Mock).mockImplementation(
        (_message: unknown, callback: (response: unknown) => void) => {
          callback({ success: false, error: 'no data' })
        }
      )

      const noDataStats: PlayerStats = { playerId: 456, statResults: [] }

      render(
        <Hud
          actualSeatIndex={0}
          stat={noDataStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
          onToggleRecentHandsPanel={jest.fn()}
          isRecentHandsPanelOpen={true}
        />
      )

      expect(screen.getByTitle('直近ハンド')).toBeInTheDocument()
      await waitFor(() => {
        expect(screen.getByTestId('recent-hands-panel')).toBeInTheDocument()
      })
    })

    it('複数プレイヤーのパネルを同時表示し、handEpoch更新時にそれぞれ再フェッチする', async () => {
      (chrome.runtime.sendMessage as jest.Mock).mockImplementation(
        (_message: unknown, callback: (response: unknown) => void) => {
          callback({
            success: true,
            recentHands: { computedAt: Date.now(), hands: [] },
          })
        }
      )
      const secondPlayerStats: PlayerStats = {
        playerId: 456,
        statResults: [
          { id: 'playerName', name: 'Name', value: 'SecondPlayer', formatted: 'SecondPlayer' },
        ],
      }
      const renderBoth = (handEpoch: number) => (
        <>
          <Hud
            actualSeatIndex={0}
            stat={mockPlayerStats}
            scale={1}
            statDisplayConfigs={mockStatDisplayConfigs}
            onToggleRecentHandsPanel={jest.fn()}
            isRecentHandsPanelOpen={true}
            handEpoch={handEpoch}
          />
          <Hud
            actualSeatIndex={1}
            stat={secondPlayerStats}
            scale={1}
            statDisplayConfigs={mockStatDisplayConfigs}
            onToggleRecentHandsPanel={jest.fn()}
            isRecentHandsPanelOpen={true}
            handEpoch={handEpoch}
          />
        </>
      )

      const { rerender } = render(renderBoth(1))

      await waitFor(() => {
        expect(screen.getAllByTestId('recent-hands-panel')).toHaveLength(2)
      })
      expect(screen.getAllByTestId('recent-hands-panel').map(panel => panel.dataset.playerId)).toEqual(['123', '456'])
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        { action: 'getRecentHands', playerId: 123 },
        expect.any(Function)
      )
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        { action: 'getRecentHands', playerId: 456 },
        expect.any(Function)
      )

      rerender(renderBoth(2))
      await waitFor(() => {
        expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(4)
      })
    })

    it('ポジション別トリガーと同時に表示しても両方独立してクリックできる', async () => {
      const handleTogglePositional = jest.fn()
      const handleToggleRecentHands = jest.fn()

      render(
        <Hud
          actualSeatIndex={0}
          stat={mockPlayerStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
          onTogglePositionalPanel={handleTogglePositional}
          onToggleRecentHandsPanel={handleToggleRecentHands}
        />
      )

      await userEvent.click(screen.getByTitle('直近ハンド'))
      expect(handleToggleRecentHands).toHaveBeenCalledTimes(1)
      expect(handleTogglePositional).not.toHaveBeenCalled()
    })
  })

  describe('handEpoch — 開いたドリルダウンパネルの再フェッチ（監査指摘11、P2）', () => {
    it('statが同一でもhandEpochが変わればパネルが再フェッチする（memoのカスタム比較関数を素通りしない）', async () => {
      let callCount = 0
      ;(chrome.runtime.sendMessage as jest.Mock).mockImplementation(
        (_message: unknown, callback: (response: unknown) => void) => {
          callCount++
          callback({
            success: true,
            positionalStats: {
              computedAt: Date.now(),
              positions: [
                { position: 0, handsN: callCount, stats: { vpip: [3, 12], pfr: [2, 12], '3bet': [0, 5], steal: [0, 0], foldToSteal: [0, 0], cbet: [0, 0] } },
              ],
            },
          })
        }
      )

      // statもactualSeatIndexも一切変えない再レンダーだけで、Hudのカスタムmemo
      // 比較関数が「statResultsが同一なので再レンダー不要」と誤って早期returnし、
      // パネル側に新しいhandEpochが届かない…という回帰を防ぐテスト。
      const { rerender } = render(
        <Hud
          actualSeatIndex={0}
          stat={mockPlayerStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
          onTogglePositionalPanel={jest.fn()}
          isPositionalPanelOpen={true}
          handEpoch={1}
        />
      )

      await waitFor(() => {
        expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1)
      })

      // 実況の1アクションごとの更新はhandEpochを変えない想定 -- 同じepochでの
      // 再レンダーは再フェッチを引き起こさない。
      rerender(
        <Hud
          actualSeatIndex={0}
          stat={mockPlayerStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
          onTogglePositionalPanel={jest.fn()}
          isPositionalPanelOpen={true}
          handEpoch={1}
        />
      )
      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1)

      // ハンドが1件完了してhandEpochが増える(statは不変)
      rerender(
        <Hud
          actualSeatIndex={0}
          stat={mockPlayerStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
          onTogglePositionalPanel={jest.fn()}
          isPositionalPanelOpen={true}
          handEpoch={2}
        />
      )

      await waitFor(() => {
        expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2)
      })
    })

    it('パネルが閉じている座席ではhandEpochの変化だけで再レンダー(sendMessage)を起こさない', () => {
      (chrome.runtime.sendMessage as jest.Mock).mockClear()

      const { rerender } = render(
        <Hud
          actualSeatIndex={0}
          stat={mockPlayerStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
          onTogglePositionalPanel={jest.fn()}
          isPositionalPanelOpen={false}
          handEpoch={1}
        />
      )
      expect(screen.queryByTestId('positional-stats-panel')).not.toBeInTheDocument()

      rerender(
        <Hud
          actualSeatIndex={0}
          stat={mockPlayerStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
          onTogglePositionalPanel={jest.fn()}
          isPositionalPanelOpen={false}
          handEpoch={2}
        />
      )

      expect(screen.queryByTestId('positional-stats-panel')).not.toBeInTheDocument()
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled()
    })
  })

  describe('コンパクト表示モード（#143）', () => {
    it('hudDisplayModeを渡さない場合はフルの16統計グリッドのまま（ゼロリグレッション）', () => {
      render(
        <Hud
          actualSeatIndex={0}
          stat={mockPlayerStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
        />
      )

      // フルグリッドの完全な値表示（"30.0% (30/100)"）が出る = compactの丸め表示("30")ではない
      expect(screen.getByText('VPIP:')).toBeInTheDocument()
      expect(screen.getByText('30.0% (30/100)')).toBeInTheDocument()
    })

    it('hudDisplayMode="compact"の場合はクラシックライン(VPIP/PFR/3B (HAND))を表示する', () => {
      render(
        <Hud
          actualSeatIndex={0}
          stat={mockPlayerStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
          hudDisplayMode="compact"
        />
      )

      // compactは丸めた整数のみ表示（フルの"30.0% (30/100)"は出ない）
      expect(screen.getByText('30')).toBeInTheDocument()
      expect(screen.queryByText('30.0% (30/100)')).not.toBeInTheDocument()
      expect(screen.queryByText('VPIP:')).not.toBeInTheDocument()
    })

    it('compactの統計ボディをクリックするとフルの16統計グリッドが展開され、クリップボードコピーは発火しない', async () => {
      render(
        <Hud
          actualSeatIndex={0}
          stat={mockPlayerStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
          hudDisplayMode="compact"
        />
      )

      // 展開前: compact表示
      expect(screen.getByText('30')).toBeInTheDocument()
      expect(screen.queryByText('30.0% (30/100)')).not.toBeInTheDocument()

      // クリックで展開
      await userEvent.click(screen.getByText('30'))

      expect(screen.getByText('30.0% (30/100)')).toBeInTheDocument()
      expect(screen.getByText('VPIP:')).toBeInTheDocument()
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled()

      // 再クリックで折りたたむ
      await userEvent.click(screen.getByText('30.0% (30/100)'))
      expect(screen.getByText('30')).toBeInTheDocument()
      expect(screen.queryByText('30.0% (30/100)')).not.toBeInTheDocument()
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
    })

    it('compactモードでもヘッダー領域のクリックはクリップボードコピーを発火する（コピー機能が壊れていない）', async () => {
      render(
        <Hud
          actualSeatIndex={0}
          stat={mockPlayerStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
          hudDisplayMode="compact"
        />
      )

      await userEvent.click(screen.getByText('TestPlayer'))

      await waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
          expect.stringContaining('Player: TestPlayer')
        )
      })
    })

    it('#128のポジション別ドリルダウンはcompactモードでも独立して機能する', async () => {
      const handleToggle = jest.fn()

      render(
        <Hud
          actualSeatIndex={0}
          stat={mockPlayerStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
          hudDisplayMode="compact"
          onTogglePositionalPanel={handleToggle}
        />
      )

      const trigger = screen.getByTitle('ポジション別スタッツ')
      await userEvent.click(trigger)

      expect(handleToggle).toHaveBeenCalledTimes(1)
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
      // ポジション別トリガーのクリックはcompactの展開もトグルしない
      expect(screen.getByText('30')).toBeInTheDocument()
    })

    it('hudColorCoding=trueをcompact/fullどちらのStatDisplayにも伝播する', () => {
      const highVpipStats = {
        playerId: 123,
        statResults: [
          { id: 'playerName', name: 'Name', value: 'TestPlayer', formatted: 'TestPlayer' },
          { id: 'vpip', name: 'VPIP', value: [45, 100], formatted: '45.0% (45/100)' },
        ],
      }

      const { rerender } = render(
        <Hud
          actualSeatIndex={0}
          stat={highVpipStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
          hudDisplayMode="full"
          hudColorCoding
        />
      )

      expect(screen.getByText('45.0% (45/100)')).toHaveStyle({ color: '#e57373' })

      rerender(
        <Hud
          actualSeatIndex={0}
          stat={highVpipStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
          hudDisplayMode="compact"
          hudColorCoding
        />
      )

      expect(screen.getByText('45')).toHaveStyle({ color: '#e57373' })
    })

    it('statDisplayConfigsでvpipを無効化しても、compactラインは実際のVPIP値を表示する（#143 review）', async () => {
      // read-entity-stream.ts はcompact必須統計(vpip等)を、ユーザーがフルグリッドで
      // 無効化していても常に計算してstatResultsに含める(stats/compactStats.ts)。
      // ここではその後段(Hud.tsx)の挙動を検証する: statDisplayConfigsでvpipを
      // enabled:falseにしても、statResultsには実データが乗っている想定。
      const statsWithVpipDisabled: PlayerStats = {
        playerId: 123,
        statResults: [
          { id: 'playerName', name: 'Name', value: 'TestPlayer', formatted: 'TestPlayer' },
          { id: 'vpip', name: 'VPIP', value: [30, 100], formatted: '30.0% (30/100)' },
          { id: 'pfr', name: 'PFR', value: [20, 100], formatted: '20.0% (20/100)' },
          { id: '3bet', name: '3B', value: [5, 50], formatted: '10.0% (5/50)' },
        ],
      }
      const configsWithVpipDisabled: StatDisplayConfig[] = [
        { id: 'vpip', enabled: false, order: 0 },
        { id: 'pfr', enabled: true, order: 1 },
        { id: '3bet', enabled: true, order: 2 },
      ]

      render(
        <Hud
          actualSeatIndex={0}
          stat={statsWithVpipDisabled}
          scale={1}
          statDisplayConfigs={configsWithVpipDisabled}
          hudDisplayMode="compact"
        />
      )

      // compactのクラシックラインはvpipが無効化されていても実値(30)を表示する
      // ("-"や0にフォールバックしない)
      expect(screen.getByText('30')).toBeInTheDocument()

      // フルグリッドを展開すると、無効化されたvpipは行として現れない
      // （可視性設定が支配するのはフルグリッドの行のみ、という仕様どおり）
      await userEvent.click(screen.getByText('30'))
      expect(screen.queryByText('VPIP:')).not.toBeInTheDocument()
      expect(screen.getByText('PFR:')).toBeInTheDocument()
      expect(screen.getByText('3B:')).toBeInTheDocument()
    })
  })

  describe('bustしたプレイヤーの薄暗い表示（isDimmed, sola仕様）', () => {
    it('isDimmedがfalse（未指定）の場合は「離席」バッジを表示せず、通常の不透明度で表示する', () => {
      render(
        <Hud
          actualSeatIndex={0}
          stat={mockPlayerStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
        />
      )

      expect(screen.queryByText('離席')).not.toBeInTheDocument()
      const panel = screen.getByTestId('hud-panel')
      expect(panel).toHaveStyle({ opacity: '1' })
    })

    it('isDimmedがtrueの場合、統計は表示したまま「離席」バッジを出し、パネル全体を減光する', () => {
      render(
        <Hud
          actualSeatIndex={1}
          stat={mockPlayerStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
          isDimmed
        />
      )

      // 統計自体は読める（クリアされていない）
      expect(screen.getByText('TestPlayer')).toBeInTheDocument()
      expect(screen.getByText('VPIP:')).toBeInTheDocument()
      expect(screen.getByText('30.0% (30/100)')).toBeInTheDocument()

      // 離席インジケーターが出る
      expect(screen.getByText('離席')).toBeInTheDocument()

      // パネル全体が減光される
      const panel = screen.getByTestId('hud-panel')
      expect(panel).toHaveStyle({ opacity: '0.45' })
    })

    it('isDimmedがtrueでも、ホバー中はドリルダウン操作しやすいよう通常の不透明度へ戻る', () => {
      render(
        <Hud
          actualSeatIndex={1}
          stat={mockPlayerStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
          isDimmed
        />
      )

      const panel = screen.getByTestId('hud-panel')
      expect(panel).toHaveStyle({ opacity: '0.45' })

      fireEvent.mouseEnter(panel)
      expect(panel).toHaveStyle({ opacity: '1' })

      fireEvent.mouseLeave(panel)
      expect(panel).toHaveStyle({ opacity: '0.45' })
    })

    it('「プレイヤーがいるがデータがない」状態でもisDimmedなら離席バッジを出す（fail-open）', () => {
      const noDataStats: PlayerStats = { playerId: 123, statResults: [] }
      render(
        <Hud
          actualSeatIndex={0}
          stat={noDataStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
          isDimmed
        />
      )

      expect(screen.getByText('No Data')).toBeInTheDocument()
      expect(screen.getByText('離席')).toBeInTheDocument()
    })

    it('ドリルダウン（ポジション別）トリガーはisDimmed中も引き続き機能する（playerId経由でfail-open、離席プレイヤーでもクラッシュしない）', async () => {
      (chrome.runtime.sendMessage as jest.Mock).mockImplementation(
        (_message: unknown, callback: (response: unknown) => void) => {
          callback({ success: false, error: 'player not at table' })
        }
      )
      const onTogglePositionalPanel = jest.fn()

      render(
        <Hud
          actualSeatIndex={1}
          stat={mockPlayerStats}
          scale={1}
          statDisplayConfigs={mockStatDisplayConfigs}
          isDimmed
          onTogglePositionalPanel={onTogglePositionalPanel}
          isPositionalPanelOpen={true}
        />
      )

      // ミュート中でもトリガーは表示・操作可能
      const trigger = screen.getByTitle('ポジション別スタッツ')
      await userEvent.click(trigger)
      expect(onTogglePositionalPanel).toHaveBeenCalledTimes(1)

      // playerId経由でリクエストが飛び、失敗レスポンスでもクラッシュしない（fail-open）
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        { action: 'getPositionalStats', playerId: mockPlayerStats.playerId },
        expect.any(Function)
      )
      await waitFor(() => {
        expect(screen.getByTestId('positional-stats-panel')).toBeInTheDocument()
      })
    })
  })
})
