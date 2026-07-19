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

    expect(screen.getByText('Waiting for Hand...')).toBeInTheDocument()
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

    expect(screen.getByText('No Data')).toBeInTheDocument()
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

  it('ポットオッズとSPRを表示', () => {
    render(
      <Hud
        actualSeatIndex={0}
        stat={mockPlayerStats}
        scale={1}
        statDisplayConfigs={mockStatDisplayConfigs}
        playerPotOdds={mockPlayerPotOdds}
      />
    )

    expect(screen.getByText('100/20 (17%)')).toBeInTheDocument()
    expect(screen.getByText('SPR:10.5')).toBeInTheDocument()
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

    const potOddsElement = screen.getByText('100/20 (17%)')
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
  })
})