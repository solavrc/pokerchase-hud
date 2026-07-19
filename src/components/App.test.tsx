import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiType } from '../app'
import App from './App'
import type { StatsData } from '../content_script'
import type { HandLogConfig, HandLogEvent } from '../types/hand-log'
import { DEFAULT_HAND_LOG_CONFIG, DEFAULT_UI_CONFIG, HandLogEntryType } from '../types/hand-log'
import type { ApiEvent } from '../types'

// Mock components
jest.mock('./Hud', () => ({
  __esModule: true,
  default: ({ actualSeatIndex, stat, scale, statDisplayConfigs, realTimeStats, playerPotOdds, isPositionalPanelOpen, onTogglePositionalPanel, hudDisplayMode, hudColorCoding }: any) => (
    <div data-testid={`hud-${actualSeatIndex}`}>
      Player: {stat.playerId}
      Scale: {scale}
      Stats: {statDisplayConfigs?.length || 0}
      RealTime: {realTimeStats ? 'yes' : 'no'}
      PotOdds: {playerPotOdds ? 'yes' : 'no'}
      PositionalPanelOpen: {isPositionalPanelOpen ? 'yes' : 'no'}
      DisplayMode: {hudDisplayMode ?? 'undefined'}
      ColorCoding: {hudColorCoding === undefined ? 'undefined' : hudColorCoding ? 'yes' : 'no'}
      {onTogglePositionalPanel && (
        <button onClick={onTogglePositionalPanel}>toggle-{stat.playerId}</button>
      )}
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

  it('uiConfigにhudDisplayMode/hudColorCodingが渡された場合、そのままHudへ伝播する', async () => {
    (global.chrome.storage.sync.get as jest.Mock).mockImplementation((_, callback) => {
      callback({
        uiConfig: { ...DEFAULT_UI_CONFIG, hudDisplayMode: 'full', hudColorCoding: false },
      })
    })

    render(<App />)

    await waitFor(() => {
      expect(screen.getByTestId('hud-0')).toBeInTheDocument()
    })

    expect(screen.getByTestId('hud-0')).toHaveTextContent('DisplayMode: full')
    expect(screen.getByTestId('hud-0')).toHaveTextContent('ColorCoding: no')
  })

  it('旧storageのuiConfigにhudDisplayMode/hudColorCodingキーが無い場合、DEFAULT_UI_CONFIGとマージしてcompact+カラーONになる（グレースフルなマイグレーション, #143）', async () => {
    (global.chrome.storage.sync.get as jest.Mock).mockImplementation((_, callback) => {
      callback({
        // #143以前に保存されたuiConfig相当（新フィールドが無い）
        uiConfig: { displayEnabled: true, scale: 1.0 },
      })
    })

    render(<App />)

    await waitFor(() => {
      expect(screen.getByTestId('hud-0')).toBeInTheDocument()
    })

    expect(screen.getByTestId('hud-0')).toHaveTextContent('DisplayMode: compact')
    expect(screen.getByTestId('hud-0')).toHaveTextContent('ColorCoding: yes')
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

  /**
   * codexレビュー指摘（#109）への対応: マウント時の一括get()は一度きりのため、
   * background起動時のマージ書き戻しやPopupでの保存がその後に発生した場合、
   * 開きっぱなしのゲームタブのHUDには反映されなかった。
   * 平坦'options'キーのstorage.onChanged購読で反映されることを検証する。
   */
  it('storage.onChangedのoptions変更でstatDisplayConfigsがHUDへ反映される（開いているタブへの追随）', async () => {
    const addListenerMock = chrome.storage.onChanged.addListener as jest.Mock
    const removeListenerMock = chrome.storage.onChanged.removeListener as jest.Mock
    addListenerMock.mockClear()
    removeListenerMock.mockClear()

    const { unmount } = render(<App />)

    // HUDを表示させる（Hudモックは statDisplayConfigs の要素数を描画する）
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('PokerChaseServiceEvent', { detail: mockStatsData })
      )
    })
    expect(screen.getByTestId('hud-0')).toHaveTextContent('Stats: 0')

    // マウント時にoptions変更リスナーが登録されている
    expect(addListenerMock).toHaveBeenCalledWith(expect.any(Function))
    const listener = addListenerMock.mock.calls[0][0]

    // sync領域のoptions変更 → HUDの統計列設定に反映される
    await act(async () => {
      listener(
        {
          options: {
            newValue: {
              filterOptions: {
                statDisplayConfigs: [{ id: 'vpip', enabled: true, order: 0 }],
              },
            },
          },
        },
        'sync'
      )
    })
    expect(screen.getByTestId('hud-0')).toHaveTextContent('Stats: 1')

    // 対象外の領域・キーは無視される（値が変わらずクラッシュもしない）
    await act(async () => {
      listener({ rebuildAdvisory: { newValue: {} } }, 'local')
      listener({ uiConfig: { newValue: {} } }, 'sync')
    })
    expect(screen.getByTestId('hud-0')).toHaveTextContent('Stats: 1')

    // アンマウント時に同一の関数で解除される
    unmount()
    expect(removeListenerMock).toHaveBeenCalledWith(listener)
  })

  describe('ポジション別ドリルダウン: 開閉はApp側で一元管理', () => {
    it('別プレイヤーのパネルを開くと、開いていたパネルは閉じる', async () => {
      const user = userEvent.setup()

      render(<App />)

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('PokerChaseServiceEvent', { detail: mockStatsData })
        )
      })

      expect(screen.getByTestId('hud-0')).toHaveTextContent('PositionalPanelOpen: no')
      expect(screen.getByTestId('hud-1')).toHaveTextContent('PositionalPanelOpen: no')

      // 席0を開く
      await user.click(screen.getByText('toggle-1'))
      expect(screen.getByTestId('hud-0')).toHaveTextContent('PositionalPanelOpen: yes')
      expect(screen.getByTestId('hud-1')).toHaveTextContent('PositionalPanelOpen: no')

      // 席1を開くと、席0は自動的に閉じる
      await user.click(screen.getByText('toggle-2'))
      expect(screen.getByTestId('hud-0')).toHaveTextContent('PositionalPanelOpen: no')
      expect(screen.getByTestId('hud-1')).toHaveTextContent('PositionalPanelOpen: yes')

      // 同じトリガーをもう一度クリックすると閉じる
      await user.click(screen.getByText('toggle-2'))
      expect(screen.getByTestId('hud-1')).toHaveTextContent('PositionalPanelOpen: no')
    })
  })
})