import { render, screen, waitFor, act } from '@testing-library/react'
import { ApiType } from '../app'
import App from './App'
import type { StatsData } from '../content_script'
import type { HandLogConfig, HandLogEvent } from '../types/hand-log'
import { DEFAULT_HAND_LOG_CONFIG, DEFAULT_UI_CONFIG, HandLogEntryType } from '../types/hand-log'
import type { ApiEvent } from '../types'

// Mock components
jest.mock('./Hud', () => ({
  __esModule: true,
  default: ({ actualSeatIndex, stat, scale, statDisplayConfigs, realTimeStats, playerPotOdds }: any) => (
    <div data-testid={`hud-${actualSeatIndex}`}>
      Player: {stat.playerId}
      Scale: {scale}
      Stats: {statDisplayConfigs?.length || 0}
      RealTime: {realTimeStats ? 'yes' : 'no'}
      PotOdds: {playerPotOdds ? 'yes' : 'no'}
    </div>
  ),
}))

jest.mock('./HandLog', () => ({
  __esModule: true,
  default: ({ entries, config, scale, scrollToLatest }: any) => (
    <div data-testid="hand-log">
      Entries: {entries.length}
      Enabled: {config.enabled ? 'yes' : 'no'}
      Scale: {scale}
      ScrollToLatest: {scrollToLatest ? 'yes' : 'no'}
    </div>
  ),
}))

describe('App', () => {
  const mockStatsData: StatsData = {
    stats: [
      { playerId: 1, statResults: [] },
      { playerId: 2, statResults: [] },
      { playerId: 3, statResults: [] },
      { playerId: 4, statResults: [] },
      { playerId: 5, statResults: [] },
      { playerId: 6, statResults: [] },
    ],
  }

  beforeEach(() => {
    // Mock chrome.storage.sync.get
    (global.chrome.storage.sync.get as jest.Mock).mockImplementation((_, callback) => {
      callback({
        handLogConfig: DEFAULT_HAND_LOG_CONFIG,
        uiConfig: DEFAULT_UI_CONFIG,
        options: {
          filterOptions: {
            statDisplayConfigs: [],
          },
        },
      })
    })
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('初期レンダリング時に6つのHUDが表示される', async () => {
    render(<App />)
    
    await waitFor(() => {
      expect(screen.getByTestId('hud-0')).toBeInTheDocument()
    })

    // 6つのHUDが表示されることを確認
    for (let i = 0; i < 6; i++) {
      expect(screen.getByTestId(`hud-${i}`)).toBeInTheDocument()
    }

    // HandLogも表示される
    expect(screen.getByTestId('hand-log')).toBeInTheDocument()
  })

  it('uiConfig.displayEnabledがfalseの場合、何も表示されない', async () => {
    (global.chrome.storage.sync.get as jest.Mock).mockImplementation((_, callback) => {
      callback({
        uiConfig: { ...DEFAULT_UI_CONFIG, displayEnabled: false },
      })
    })

    const { container } = render(<App />)
    
    await waitFor(() => {
      expect(container.firstChild).toBeNull()
    })
  })

  it('PokerChaseServiceイベントでstatsが更新される', async () => {
    render(<App />)
    
    await waitFor(() => {
      expect(screen.getByTestId('hud-0')).toBeInTheDocument()
    })

    // イベントをディスパッチ
    act(() => {
      const event = new CustomEvent('PokerChaseServiceEvent', {
        detail: mockStatsData,
      })
      window.dispatchEvent(event)
    })

    await waitFor(() => {
      expect(screen.getByTestId('hud-0')).toHaveTextContent('Player: 1')
      expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 2')
    })
  })

  it('EVT_DEALイベントでヒーローが席0に配置される', async () => {
    render(<App />)
    
    await waitFor(() => {
      expect(screen.getByTestId('hud-0')).toBeInTheDocument()
    })

    // 初期状態を設定
    act(() => {
      const event = new CustomEvent('PokerChaseServiceEvent', {
        detail: mockStatsData,
      })
      window.dispatchEvent(event)
    })

    await waitFor(() => {
      expect(screen.getByTestId('hud-0')).toHaveTextContent('Player: 1')
    })

    // ヒーローが席2にいるEVT_DEALイベント - 完全な構造で作成
    const statsDataWithHero: StatsData = {
      stats: [...mockStatsData.stats], // 明示的にコピーを作成
      evtDeal: {
        ApiTypeId: ApiType.EVT_DEAL as const,
        Player: { 
          SeatIndex: 2, 
          BetStatus: 1, 
          HoleCards: [], 
          Chip: 1000, 
          BetChip: 0 
        },
        SeatUserIds: [1, 2, 3, 4, 5, 6],
        Game: {
          CurrentBlindLv: 1,
          NextBlindUnixSeconds: 0,
          Ante: 0,
          SmallBlind: 50,
          BigBlind: 100,
          ButtonSeat: 0,
          SmallBlindSeat: 1,
          BigBlindSeat: 2
        },
        OtherPlayers: [
          { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
          { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
          { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
          { SeatIndex: 4, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
          { SeatIndex: 5, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
        ],
        Progress: {
          Phase: 0,
          NextActionSeat: 0,
          NextActionTypes: [2, 3, 4, 5],
          NextExtraLimitSeconds: 0,
          MinRaise: 0,
          Pot: 0,
          SidePot: []
        },
        timestamp: Date.now(),
      } as ApiEvent<ApiType.EVT_DEAL>,
    }

    act(() => {
      const event = new CustomEvent('PokerChaseServiceEvent', {
        detail: statsDataWithHero,
      })
      window.dispatchEvent(event)
    })

    await waitFor(() => {
      // ヒーロー（元席2のプレイヤー3）が席0に配置される
      expect(screen.getByTestId('hud-0')).toHaveTextContent('Player: 3')
      // 他のプレイヤーも回転される
      expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 4')
      expect(screen.getByTestId('hud-2')).toHaveTextContent('Player: 5')
    })
  })

  it('リアルタイム統計が席0（ヒーロー）にのみ表示される', async () => {
    render(<App />)
    
    await waitFor(() => {
      expect(screen.getByTestId('hud-0')).toBeInTheDocument()
    })

    const statsDataWithRealTime: StatsData = {
      stats: mockStatsData.stats,
      realTimeStats: {
        heroStats: { potOdds: {} as any, handImprovement: {} as any },
        playerStats: {},
      },
    }

    act(() => {
      const event = new CustomEvent('PokerChaseServiceEvent', {
        detail: statsDataWithRealTime,
      })
      window.dispatchEvent(event)
    })

    await waitFor(() => {
      // 席0のみリアルタイム統計を持つ
      expect(screen.getByTestId('hud-0')).toHaveTextContent('RealTime: yes')
      expect(screen.getByTestId('hud-1')).toHaveTextContent('RealTime: no')
    })
  })

  it('HandLogイベントでエントリが追加される', async () => {
    render(<App />)
    
    await waitFor(() => {
      expect(screen.getByTestId('hand-log')).toBeInTheDocument()
    })

    const handLogEvent: HandLogEvent = {
      type: 'add',
      entries: [
        { id: '1', timestamp: Date.now(), handId: 1, text: 'Hand 1', type: HandLogEntryType.HEADER },
        { id: '2', timestamp: Date.now(), handId: 2, text: 'Hand 2', type: HandLogEntryType.HEADER },
      ],
    }

    act(() => {
      const event = new CustomEvent('handLogEvent', {
        detail: handLogEvent,
      })
      window.dispatchEvent(event)
    })

    await waitFor(() => {
      expect(screen.getByTestId('hand-log')).toHaveTextContent('Entries: 2')
    })
  })

  it('HandLogイベントでエントリが更新される', async () => {
    render(<App />)
    
    await waitFor(() => {
      expect(screen.getByTestId('hand-log')).toBeInTheDocument()
    })

    // 初期エントリを追加
    act(() => {
      const event = new CustomEvent('handLogEvent', {
        detail: {
          type: 'add',
          entries: [
            { id: '1', timestamp: Date.now(), handId: undefined, text: 'Incomplete', type: HandLogEntryType.ACTION },
            { id: '2', timestamp: Date.now(), handId: 1, text: 'Hand 1', type: HandLogEntryType.HEADER },
          ],
        } as HandLogEvent,
      })
      window.dispatchEvent(event)
    })

    await waitFor(() => {
      expect(screen.getByTestId('hand-log')).toHaveTextContent('Entries: 2')
    })

    // handId: 1を更新
    act(() => {
      const event = new CustomEvent('handLogEvent', {
        detail: {
          type: 'update',
          handId: 1,
          entries: [
            { id: '2', timestamp: Date.now(), handId: 1, text: 'Hand 1 Updated', type: HandLogEntryType.HEADER },
          ],
        } as HandLogEvent,
      })
      window.dispatchEvent(event)
    })

    await waitFor(() => {
      // update時は、undefined handIdとhandId: 1のエントリが削除され、新しいエントリが追加される
      expect(screen.getByTestId('hand-log')).toHaveTextContent('Entries: 1')
    })
  })

  it('Chrome runtime messageでUIConfigが更新される', async () => {
    render(<App />)
    
    await waitFor(() => {
      expect(screen.getByTestId('hud-0')).toBeInTheDocument()
    })

    // 初期スケールは1
    expect(screen.getByTestId('hud-0')).toHaveTextContent('Scale: 1')

    // chrome.runtime.onMessage.addListenerのコールバックを取得
    const addListenerCalls = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls
    const messageHandler = addListenerCalls[0][0]

    // UIConfig更新メッセージを送信
    act(() => {
      messageHandler({
        action: 'updateUIConfig',
        config: { ...DEFAULT_UI_CONFIG, scale: 1.5 },
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('hud-0')).toHaveTextContent('Scale: 1.5')
    })
  })

  it('ウィンドウイベントでconfigが更新される', async () => {
    render(<App />)
    
    await waitFor(() => {
      expect(screen.getByTestId('hand-log')).toBeInTheDocument()
    })

    const newConfig: HandLogConfig = {
      ...DEFAULT_HAND_LOG_CONFIG,
      enabled: false,
    }

    act(() => {
      const event = new CustomEvent('updateHandLogConfig', {
        detail: newConfig,
      })
      window.dispatchEvent(event)
    })

    await waitFor(() => {
      expect(screen.getByTestId('hand-log')).toHaveTextContent('Enabled: no')
    })
  })

  it('コンポーネントのクリーンアップ時にイベントリスナーが削除される', () => {
    const { unmount } = render(<App />)

    const removeEventListenerSpy = jest.spyOn(window, 'removeEventListener')
    const removeMessageListenerSpy = chrome.runtime.onMessage.removeListener as jest.Mock

    unmount()

    // Windowイベントリスナーが削除される
    expect(removeEventListenerSpy).toHaveBeenCalledWith('PokerChaseServiceEvent', expect.any(Function))
    expect(removeEventListenerSpy).toHaveBeenCalledWith('handLogEvent', expect.any(Function))
    expect(removeEventListenerSpy).toHaveBeenCalledWith('updateHandLogConfig', expect.any(Function))
    expect(removeEventListenerSpy).toHaveBeenCalledWith('updateUIConfig', expect.any(Function))
    
    // Chrome messageリスナーが削除される
    expect(removeMessageListenerSpy).toHaveBeenCalled()
  })
})