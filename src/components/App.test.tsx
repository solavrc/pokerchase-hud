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
  default: ({ actualSeatIndex, stat, scale, statDisplayConfigs, realTimeStats, playerPotOdds, isPositionalPanelOpen, onTogglePositionalPanel, isRecentHandsPanelOpen, onToggleRecentHandsPanel, hudDisplayMode, hudColorCoding, isDimmed }: any) => (
    <div data-testid={`hud-${actualSeatIndex}`}>
      Player: {stat.playerId}
      Scale: {scale}
      Stats: {statDisplayConfigs?.length || 0}
      RealTime: {realTimeStats ? 'yes' : 'no'}
      PotOdds: {playerPotOdds ? 'yes' : 'no'}
      PositionalPanelOpen: {isPositionalPanelOpen ? 'yes' : 'no'}
      RecentHandsPanelOpen: {isRecentHandsPanelOpen ? 'yes' : 'no'}
      DisplayMode: {hudDisplayMode ?? 'undefined'}
      ColorCoding: {hudColorCoding === undefined ? 'undefined' : hudColorCoding ? 'yes' : 'no'}
      Dimmed: {isDimmed ? 'yes' : 'no'}
      {onTogglePositionalPanel && (
        <button onClick={onTogglePositionalPanel}>toggle-{stat.playerId}</button>
      )}
      {onToggleRecentHandsPanel && (
        <button onClick={onToggleRecentHandsPanel}>toggle-recent-{stat.playerId}</button>
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

    it('ポジション別パネルと直近ハンドパネルは互いに排他（同一プレイヤーでも別プレイヤーでも）', async () => {
      const user = userEvent.setup()

      render(<App />)

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('PokerChaseServiceEvent', { detail: mockStatsData })
        )
      })

      expect(screen.getByTestId('hud-0')).toHaveTextContent('PositionalPanelOpen: no')
      expect(screen.getByTestId('hud-0')).toHaveTextContent('RecentHandsPanelOpen: no')

      // 席0のポジション別を開く
      await user.click(screen.getByText('toggle-1'))
      expect(screen.getByTestId('hud-0')).toHaveTextContent('PositionalPanelOpen: yes')
      expect(screen.getByTestId('hud-0')).toHaveTextContent('RecentHandsPanelOpen: no')

      // 同じプレイヤーの直近ハンドを開くと、ポジション別は自動的に閉じる
      await user.click(screen.getByText('toggle-recent-1'))
      expect(screen.getByTestId('hud-0')).toHaveTextContent('PositionalPanelOpen: no')
      expect(screen.getByTestId('hud-0')).toHaveTextContent('RecentHandsPanelOpen: yes')

      // 別プレイヤーのポジション別を開くと、席0の直近ハンドも自動的に閉じる
      await user.click(screen.getByText('toggle-2'))
      expect(screen.getByTestId('hud-0')).toHaveTextContent('RecentHandsPanelOpen: no')
      expect(screen.getByTestId('hud-1')).toHaveTextContent('PositionalPanelOpen: yes')

      // 同じトリガーをもう一度クリックすると閉じる
      await user.click(screen.getByText('toggle-2'))
      expect(screen.getByTestId('hud-1')).toHaveTextContent('PositionalPanelOpen: no')
    })
  })

  describe('bustしたプレイヤーの薄暗い表示（sola仕様）', () => {
    const dispatchStats = async (stats: StatsData['stats']) => {
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('PokerChaseServiceEvent', { detail: { stats } })
        )
      })
    }

    it('座席がSeatUserIds=-1になっても、直前の統計をミュート表示のまま保持する（bust→dim）', async () => {
      render(<App />)
      await dispatchStats(mockStatsData.stats)
      expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 2')
      expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: no')

      // 席1のプレイヤー(2)がbustして次のlineupから消える
      const bustedLineup: StatsData['stats'] = mockStatsData.stats.map((s, i) => (i === 1 ? { playerId: -1 } : s))
      await dispatchStats(bustedLineup)

      // "Waiting for Hand..."へ即クリアされず、プレイヤー2の直近統計のままミュート表示
      expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 2')
      expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: yes')
      // 他の席は無関係に影響を受けない
      expect(screen.getByTestId('hud-0')).toHaveTextContent('Dimmed: no')
    })

    it('bust後の席に新しいプレイヤーが着席したら、ミュートキャッシュに隠されずただちに新プレイヤーへ切り替わる（席の乗っ取り）', async () => {
      render(<App />)
      await dispatchStats(mockStatsData.stats)

      const bustedLineup: StatsData['stats'] = mockStatsData.stats.map((s, i) => (i === 1 ? { playerId: -1 } : s))
      await dispatchStats(bustedLineup)
      expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 2')
      expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: yes')

      // 同じ席(1)に別のプレイヤー(99)が着席した新しいlineup
      const takeoverLineup: StatsData['stats'] = mockStatsData.stats.map((s, i) =>
        i === 1 ? { playerId: 99, statResults: [] } : s
      )
      await dispatchStats(takeoverLineup)

      expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 99')
      expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: no')
    })

    it('bust前と同じプレイヤーIDが同じ席に戻ると、ミュートが解除される（リバイ/再接続）', async () => {
      render(<App />)
      await dispatchStats(mockStatsData.stats)

      const bustedLineup: StatsData['stats'] = mockStatsData.stats.map((s, i) => (i === 1 ? { playerId: -1 } : s))
      await dispatchStats(bustedLineup)
      expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: yes')

      // 同じプレイヤー(2)が同じ席に戻ってくる
      await dispatchStats(mockStatsData.stats)

      expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 2')
      expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: no')
    })

    it('セッション終了(EVT_SESSION_RESULTS)でhero以外の全パネル（ミュート中含む）がクリアされ、heroパネルはそのまま残る', async () => {
      render(<App />)
      await dispatchStats(mockStatsData.stats)

      // 席1をbustさせてミュート状態にする
      const bustedLineup: StatsData['stats'] = mockStatsData.stats.map((s, i) => (i === 1 ? { playerId: -1 } : s))
      await dispatchStats(bustedLineup)
      expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: yes')
      expect(screen.getByTestId('hud-0')).toHaveTextContent('Player: 1')

      await act(async () => {
        window.dispatchEvent(new CustomEvent('PokerChaseSessionEndEvent'))
      })

      // hero(席0)はそのまま残る
      expect(screen.getByTestId('hud-0')).toHaveTextContent('Player: 1')
      // hero以外は空席へクリアされ、ミュートも解除される
      for (let i = 1; i < 6; i++) {
        expect(screen.getByTestId(`hud-${i}`)).toHaveTextContent('Player: -1')
        expect(screen.getByTestId(`hud-${i}`)).toHaveTextContent('Dimmed: no')
      }

      // セッション終了後、同じ席に新しいプレイヤーが着席したlineupが来れば
      // 通常通り表示される（クリアが以降のライブ更新を壊さない）
      await dispatchStats(mockStatsData.stats)
      expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 2')
      expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: no')
    })

    it('インポート後のバッチ再計算（latestStatsのchromeメッセージ）はミュート状態を持ち込まない', async () => {
      render(<App />)
      await dispatchStats(mockStatsData.stats)

      // 席1をbustさせてミュート状態にする
      const bustedLineup: StatsData['stats'] = mockStatsData.stats.map((s, i) => (i === 1 ? { playerId: -1 } : s))
      await dispatchStats(bustedLineup)
      expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: yes')

      // background/import-export.tsのrefreshStats往復相当: chrome.runtime.onMessageで
      // 'latestStats'が来る（DB再計算の一括結果。席1は改めて空席として届く）
      const addListenerCalls = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls
      const messageHandler = addListenerCalls[0][0]
      const batchLineup: StatsData['stats'] = mockStatsData.stats.map((s, i) => (i === 1 ? { playerId: -1 } : s))

      await act(async () => {
        messageHandler({ action: 'latestStats', stats: batchLineup })
      })

      // バッチ更新はミュート状態を経由しない: 空席はそのまま空席として表示される
      expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: -1')
      expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: no')
    })

    describe('テーブル移動時のミュートキャッシュ無効化（#179 codex P2指摘）', () => {
      it('lineupがhero以外まるごと入れ替わったら、旧テーブルの空席ゴーストは出ない（テーブル移動）', async () => {
        render(<App />)
        await dispatchStats(mockStatsData.stats)

        // 席1のプレイヤー(2)がbustして次のlineupから消える（旧テーブルでの出来事）
        const bustedLineup: StatsData['stats'] = mockStatsData.stats.map((s, i) => (i === 1 ? { playerId: -1 } : s))
        await dispatchStats(bustedLineup)
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 2')
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: yes')

        // MTT/cashでテーブル移動。新テーブルの席1はたまたま空席のままだが、
        // hero以外の在席者(20,21,22,23)は旧テーブル(2,3,4,5,6)と完全に不連続
        const tableMoveLineup: StatsData['stats'] = [
          { playerId: 1, statResults: [] },   // hero, 同一人物なので変わらない
          { playerId: -1 },                    // 新テーブルでも空席（旧テーブルの席1とindexが偶然一致）
          { playerId: 20, statResults: [] },
          { playerId: 21, statResults: [] },
          { playerId: 22, statResults: [] },
          { playerId: 23, statResults: [] },
        ]
        await dispatchStats(tableMoveLineup)

        // 旧テーブルのプレイヤー(2)がミュート表示のまま蘇ってはいけない
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: -1')
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: no')
        // 新テーブルの在席者はそのまま表示される
        expect(screen.getByTestId('hud-2')).toHaveTextContent('Player: 20')
        expect(screen.getByTestId('hud-2')).toHaveTextContent('Dimmed: no')
      })

      it('lineupに一部重複があれば同一テーブルとみなし、bustミュートは継続する（部分重複）', async () => {
        render(<App />)
        await dispatchStats(mockStatsData.stats)

        // 席1(プレイヤー2)がbust
        const bustedLineup: StatsData['stats'] = mockStatsData.stats.map((s, i) => (i === 1 ? { playerId: -1 } : s))
        await dispatchStats(bustedLineup)
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: yes')

        // 続けて席2(プレイヤー3)もbust。他の席(4,5,6)は同一プレイヤーのまま
        // なので、hero以外の在席者集合は{4,5,6}⊂{2,3,4,5,6}で重複あり=同一テーブル
        const secondBustLineup: StatsData['stats'] = mockStatsData.stats.map((s, i) =>
          (i === 1 || i === 2) ? { playerId: -1 } : s
        )
        await dispatchStats(secondBustLineup)

        // どちらの席も旧プレイヤーのままミュート表示が継続する（誤ってキャッシュが
        // クリアされていない証拠）
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 2')
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: yes')
        expect(screen.getByTestId('hud-2')).toHaveTextContent('Player: 3')
        expect(screen.getByTestId('hud-2')).toHaveTextContent('Dimmed: yes')
      })

      it('hero以外が同一ハンドで全員同時bustした直後（hero単独lineup）はテーブル移動と誤判定せず、キャッシュはそのまま全員分ミュート継続する（不連続-空集合の境界）', async () => {
        render(<App />)
        await dispatchStats(mockStatsData.stats)

        // レアなオールインで、hero以外(2,3,4,5,6)が同一ハンド内で同時にbust。
        // 次のlineupはhero単独になり、hero以外の在席者集合は空集合になる
        const allBustedLineup: StatsData['stats'] = mockStatsData.stats.map((s, i) => (
          i === 0 ? s : { playerId: -1 }
        ))
        await dispatchStats(allBustedLineup)

        // 空集合との比較は判定不能として何もしない -- 全員分が引き続き
        // ミュート表示される（テーブル移動ではなく同一テーブルの出来事のため）
        for (let i = 1; i < 6; i++) {
          expect(screen.getByTestId(`hud-${i}`)).toHaveTextContent(`Player: ${i + 1}`)
          expect(screen.getByTestId(`hud-${i}`)).toHaveTextContent('Dimmed: yes')
        }

        // その後、実際にテーブル移動して新しい在席者が届けば通常通り検知される
        const tableMoveLineup: StatsData['stats'] = [
          { playerId: 1, statResults: [] },
          { playerId: 30, statResults: [] },
          { playerId: 31, statResults: [] },
          { playerId: -1 },
          { playerId: -1 },
          { playerId: -1 },
        ]
        await dispatchStats(tableMoveLineup)

        expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 30')
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: no')
        // 旧テーブルの残骸(3,4,5,6)は蘇らずただの空席になる
        for (let i = 3; i < 6; i++) {
          expect(screen.getByTestId(`hud-${i}`)).toHaveTextContent('Player: -1')
          expect(screen.getByTestId(`hud-${i}`)).toHaveTextContent('Dimmed: no')
        }
      })

      it('無関係な空席への新規着席では、既存のbustミュートを巻き込んでクリアしない（#179 round2 codex反例: ショートハンドで別プレイヤーが未使用の席に座っただけ）', async () => {
        render(<App />)

        // ショートハンドテーブル: hero(1)と席1のA(2)だけが在席、他の席(2-5)は
        // 一度も誰も座ったことがない(常に-1)
        const shortHandedLineup: StatsData['stats'] = [
          { playerId: 1, statResults: [] },
          { playerId: 2, statResults: [] },
          { playerId: -1 },
          { playerId: -1 },
          { playerId: -1 },
          { playerId: -1 },
        ]
        await dispatchStats(shortHandedLineup)

        // Aがbustして席1が空席になり、直近統計がミュート表示のまま残る
        const bustedLineup: StatsData['stats'] = shortHandedLineup.map((s, i) => (i === 1 ? { playerId: -1 } : s))
        await dispatchStats(bustedLineup)
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 2')
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: yes')

        // 別プレイヤーB(99)が、これまで誰も座ったことのない席2へ新規着席する。
        // Aの席1は引き続き空席のまま(判断材料なし)なので、
        // 「hero以外の在席者集合が丸ごと不連続({2}→{99})」という初版ヒューリスティック
        // だと同一テーブルのはずなのに誤ってテーブル移動と判定しキャッシュ全体を
        // クリアしてしまっていた
        const newJoinLineup: StatsData['stats'] = bustedLineup.map((s, i) => (
          i === 2 ? { playerId: 99, statResults: [] } : s
        ))
        await dispatchStats(newJoinLineup)

        // Aは同一テーブルのまま席1でミュート表示を継続する（誤クリアされていない証拠）
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 2')
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: yes')
        // Bは通常通りその場で表示される
        expect(screen.getByTestId('hud-2')).toHaveTextContent('Player: 99')
        expect(screen.getByTestId('hud-2')).toHaveTextContent('Dimmed: no')
      })

      it('単発の席の乗っ取り(conflict1件)は他の席のbustミュートを巻き込まない（#179 round3 codex反例: ショートハンドで席2だけがA→Bへ入れ替わり席1は無関係にミュート中）', async () => {
        render(<App />)

        // ショートハンドテーブル: hero(1)、席1にX(2)、席2にA(3)が在席。
        // 他の席(3-5)は一度も誰も座ったことがない
        const shortHandedLineup: StatsData['stats'] = [
          { playerId: 1, statResults: [] },
          { playerId: 2, statResults: [] },
          { playerId: 3, statResults: [] },
          { playerId: -1 },
          { playerId: -1 },
          { playerId: -1 },
        ]
        await dispatchStats(shortHandedLineup)

        // Xがbustして席1が空席になり、直近統計がミュート表示のまま残る（席2のAは無関係に在席継続）
        const bustedLineup: StatsData['stats'] = shortHandedLineup.map((s, i) => (i === 1 ? { playerId: -1 } : s))
        await dispatchStats(bustedLineup)
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 2')
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: yes')

        // 席2で通常の乗っ取りが起きる: A(3)がbustし、その場に別プレイヤーB(4)が
        // 直接着席する。conflictは席2の1件のみ(cached=3, incoming=4)で、
        // continuityは0件（席1はincomingが空席で判断材料なし、席2は不一致）。
        // 「conflictが1件でもあればクリア」という旧ルールだと、これをテーブル
        // 移動と誤判定して席1の正当なミュートまで巻き込んで消してしまっていた
        const seatTurnoverLineup: StatsData['stats'] = bustedLineup.map((s, i) => (
          i === 2 ? { playerId: 4, statResults: [] } : s
        ))
        await dispatchStats(seatTurnoverLineup)

        // 席1(X)は同一テーブルのままミュート表示を継続する（誤って巻き込みクリアされていない証拠）
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 2')
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: yes')
        // 席2は通常通り乗っ取りが反映される
        expect(screen.getByTestId('hud-2')).toHaveTextContent('Player: 4')
        expect(screen.getByTestId('hud-2')).toHaveTextContent('Dimmed: no')
      })
    })

    describe('曖昧な境界での挙動（観戦モードdeal・フィルター変更・リロード。PR #191、オーナー承認の縮小スコープ）', () => {
      // baseSchema/EVT_DEALスキーマ（src/types/api.ts）を満たす最小限のEVT_DEAL。
      // playerOverrideを渡さなければPlayerフィールド自体を省略する（観戦モード
      // ＝Player不在をisApiEventType()のZod検証込みで再現するため）。
      const makeEvtDeal = (playerOverride?: Record<string, unknown>): ApiEvent<ApiType.EVT_DEAL> => ({
        ApiTypeId: ApiType.EVT_DEAL as const,
        ...(playerOverride ? { Player: playerOverride } : {}),
        SeatUserIds: [1, 2, 3, 4, 5, 6],
        Game: {
          CurrentBlindLv: 1, NextBlindUnixSeconds: 0, Ante: 0,
          SmallBlind: 50, BigBlind: 100, ButtonSeat: 0, SmallBlindSeat: 1, BigBlindSeat: 2,
        },
        OtherPlayers: [
          { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
          { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
          { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
          { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
          { SeatIndex: 4, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
        ],
        Progress: { Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 0, SidePot: [] },
        timestamp: Date.now(),
      } as ApiEvent<ApiType.EVT_DEAL>)

      const heroDeal = () => makeEvtDeal({ SeatIndex: 0, BetStatus: 1, HoleCards: [], Chip: 1000, BetChip: 0 })

      it('観戦モードdeal（EVT_DEAL.Player不在）ではdimCacheを適用せず、生のlineupをそのまま表示する（旧テーブルの空席ゴーストが蘇らない）', async () => {
        render(<App />)

        // ヒーロー在籍のhandで席1(プレイヤー2)がbustしてミュート表示になる
        await dispatchStats(mockStatsData.stats)
        const bustedLineup: StatsData['stats'] = mockStatsData.stats.map((s, i) => (i === 1 ? { playerId: -1 } : s))
        await act(async () => {
          window.dispatchEvent(new CustomEvent('PokerChaseServiceEvent', {
            detail: { stats: bustedLineup, evtDeal: heroDeal() } as StatsData,
          }))
        })
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 2')
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: yes')

        // ヒーロー敗退後、観戦モードdealが届く: Playerがundefinedで、生の
        // （ヒーロー自身のテーブルとすら限らない）別テーブルの席順が来る。
        // 座席1はたまたま空席、座席2・3には観戦先の別プレイヤーが在席
        const spectatorLineup: StatsData['stats'] = [
          { playerId: -1 },
          { playerId: -1 },
          { playerId: 900, statResults: [] },
          { playerId: 901, statResults: [] },
          { playerId: -1 },
          { playerId: -1 },
        ]
        await act(async () => {
          window.dispatchEvent(new CustomEvent('PokerChaseServiceEvent', {
            detail: { stats: spectatorLineup, evtDeal: makeEvtDeal() } as StatsData,
          }))
        })

        // 旧テーブルのプレイヤー(2)がミュート表示のまま蘇ってはいけない --
        // dimCacheは適用されず観戦テーブルの生の席順がそのまま出る
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: -1')
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: no')
        expect(screen.getByTestId('hud-2')).toHaveTextContent('Player: 900')
        expect(screen.getByTestId('hud-2')).toHaveTextContent('Dimmed: no')
        expect(screen.getByTestId('hud-3')).toHaveTextContent('Player: 901')
        expect(screen.getByTestId('hud-3')).toHaveTextContent('Dimmed: no')
      })

      it('直前が観戦モードdealでも、セッション終了時に本物のヒーローが保持される（観戦先の生の席0で上書きされない）', async () => {
        render(<App />)
        await act(async () => {
          window.dispatchEvent(new CustomEvent('PokerChaseServiceEvent', {
            detail: { stats: mockStatsData.stats, evtDeal: heroDeal() } as StatsData,
          }))
        })
        expect(screen.getByTestId('hud-0')).toHaveTextContent('Player: 1')

        // 観戦モードdeal: 生のテーブルの席0はヒーロー(1)ではなく無関係な
        // プレイヤー(999)
        const spectatorLineup: StatsData['stats'] = [
          { playerId: 999, statResults: [] },
          { playerId: -1 }, { playerId: -1 }, { playerId: -1 }, { playerId: -1 }, { playerId: -1 },
        ]
        await act(async () => {
          window.dispatchEvent(new CustomEvent('PokerChaseServiceEvent', {
            detail: { stats: spectatorLineup, evtDeal: makeEvtDeal() } as StatsData,
          }))
        })
        expect(screen.getByTestId('hud-0')).toHaveTextContent('Player: 999')

        await act(async () => {
          window.dispatchEvent(new CustomEvent('PokerChaseSessionEndEvent'))
        })

        // hero(1)が保持される -- 観戦先の生の席0(999)に上書きされてはいけない
        expect(screen.getByTestId('hud-0')).toHaveTextContent('Player: 1')
      })

      it('フィルター変更(updateBattleTypeFilter)で、ミュート表示中の座席のキャッシュが無効化される', async () => {
        render(<App />)
        await dispatchStats(mockStatsData.stats)

        // 席1(プレイヤー2)がbustしてミュート表示になる
        const bustedLineup: StatsData['stats'] = mockStatsData.stats.map((s, i) => (i === 1 ? { playerId: -1 } : s))
        await dispatchStats(bustedLineup)
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 2')
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: yes')

        // content_script.tsが'updateBattleTypeFilter'メッセージ受信時に
        // dispatchする同名のwindowイベント
        await act(async () => {
          window.dispatchEvent(new CustomEvent('updateBattleTypeFilter', {
            detail: { gameTypes: { sng: true, mtt: false, ring: true } },
          }))
        })

        // ミュート表示中だった座席は古いフィルターの統計を出し続けず
        // 「Waiting for Hand...」へクリアされる
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: -1')
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: no')
        // ライブ在籍中のhero・他の座席は無関係に影響を受けない
        expect(screen.getByTestId('hud-0')).toHaveTextContent('Player: 1')
        expect(screen.getByTestId('hud-0')).toHaveTextContent('Dimmed: no')

        // クリア後、席1に同じプレイヤー(2)が戻ってきたら通常通り表示される
        // （キャッシュのクリアが以降のライブ更新を壊さない）
        await dispatchStats(mockStatsData.stats)
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 2')
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: no')
      })

      it('フィルター変更時、ミュート中の座席がなければ何もしない（不要な再レンダリングを避ける）', async () => {
        render(<App />)
        await dispatchStats(mockStatsData.stats)
        expect(screen.getByTestId('hud-0')).toHaveTextContent('Player: 1')

        await act(async () => {
          window.dispatchEvent(new CustomEvent('updateBattleTypeFilter', {
            detail: { gameTypes: { sng: true, mtt: false, ring: true } },
          }))
        })

        // 全席ライブ在籍中で誰もミュートされていないので、フィルター変更は
        // 何も変えない
        for (let i = 0; i < 6; i++) {
          expect(screen.getByTestId(`hud-${i}`)).toHaveTextContent(`Player: ${i + 1}`)
          expect(screen.getByTestId(`hud-${i}`)).toHaveTextContent('Dimmed: no')
        }
      })

      it('フィルター変更は今まさにライブ在籍中の座席のキャッシュを消さない -- 変更直後にその席がbustしても正しくdim表示される（post-merge review descope pass1「Avoid clearing freshly rebuilt live-seat cache」）', async () => {
        render(<App />)
        await dispatchStats(mockStatsData.stats)
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 2')
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: no')

        // 誰もミュートされていない状態でフィルターが変わる（message-router.ts
        // の再計算ブロードキャストが、このwindowイベント転送より先に届いて
        // dimCacheを打ち直した直後、というシナリオを模す -- 実際にはタイミング
        // 非決定だが、App.tsx側はどちらの順序でも安全でなければならない）
        await act(async () => {
          window.dispatchEvent(new CustomEvent('updateBattleTypeFilter', {
            detail: { gameTypes: { sng: true, mtt: false, ring: true } },
          }))
        })

        // 席1(プレイヤー2)がまだライブ在籍中のうちにbustする。フィルター
        // 変更が席1のキャッシュを無条件で消していたら、この時点でキャッシュが
        // 空になっており、dim表示されず素の「Waiting for Hand...」に
        // 落ちてしまう
        const bustedLineup: StatsData['stats'] = mockStatsData.stats.map((s, i) => (i === 1 ? { playerId: -1 } : s))
        await dispatchStats(bustedLineup)
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 2')
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: yes')
      })

      it('観戦モードdealを挟んだ後のフィルター変更は、観戦先の生の座席インデックスが偶然在席していても「ライブ在籍中」とは扱わず、hero自身のテーブルの古いキャッシュを正しくクリアする（post-merge review descope pass2「Clear spectator-context caches on filter updates」）', async () => {
        render(<App />)
        // ヒーロー在籍のhandで席1(プレイヤー2)がbustしてミュート表示になる
        await act(async () => {
          window.dispatchEvent(new CustomEvent('PokerChaseServiceEvent', {
            detail: { stats: mockStatsData.stats, evtDeal: heroDeal() } as StatsData,
          }))
        })
        const bustedLineup: StatsData['stats'] = mockStatsData.stats.map((s, i) => (i === 1 ? { playerId: -1 } : s))
        await act(async () => {
          window.dispatchEvent(new CustomEvent('PokerChaseServiceEvent', {
            detail: { stats: bustedLineup, evtDeal: heroDeal() } as StatsData,
          }))
        })
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 2')
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: yes')

        // ヒーロー敗退後、観戦モードdealが届く。観戦先の生の座席1には
        // 偶然別の在席者(777)がいる -- これはhero自身のテーブルの席1とは
        // 無関係の別空間の座席
        const spectatorLineup: StatsData['stats'] = [
          { playerId: -1 },
          { playerId: 777, statResults: [] },
          { playerId: -1 }, { playerId: -1 }, { playerId: -1 }, { playerId: -1 },
        ]
        await act(async () => {
          window.dispatchEvent(new CustomEvent('PokerChaseServiceEvent', {
            detail: { stats: spectatorLineup, evtDeal: makeEvtDeal() } as StatsData,
          }))
        })
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 777')

        // この観戦中にフィルターが変わる。席1(数値インデックス)には観戦先の
        // 777が在席しているが、これはhero自身のテーブルの「ライブ在籍中」
        // ではないので、旧テーブルのプレイヤー2の古いキャッシュはクリア
        // されなければならない
        await act(async () => {
          window.dispatchEvent(new CustomEvent('updateBattleTypeFilter', {
            detail: { gameTypes: { sng: true, mtt: false, ring: true } },
          }))
        })

        // ヒーロー在籍dealに戻り、hero自身のテーブルの席1は引き続き空席
        const stillBustedLineup: StatsData['stats'] = mockStatsData.stats.map((s, i) => (i === 1 ? { playerId: -1 } : s))
        await act(async () => {
          window.dispatchEvent(new CustomEvent('PokerChaseServiceEvent', {
            detail: { stats: stillBustedLineup, evtDeal: heroDeal() } as StatsData,
          }))
        })

        // プレイヤー2の古いキャッシュがクリアされていれば、席1は
        // 「Waiting for Hand...」のまま -- クリアされていなければ、
        // 観戦を挟んでも古いプレイヤー2がミュート表示のまま蘇ってしまう
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: -1')
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: no')
      })

      it('座席数が縮んだ更新（4-maxなど）の後のフィルター変更は、6-max時代のキャッシュを「存在しない座席=ライブ在籍中」と誤認せず正しくクリアする（post-merge review descope pass2「Treat missing seats as empty when clearing caches」）', async () => {
        render(<App />)
        await dispatchStats(mockStatsData.stats)

        // 席4(プレイヤー5)がbustしてミュート表示になる(6-max)
        const bustedLineup: StatsData['stats'] = mockStatsData.stats.map((s, i) => (i === 4 ? { playerId: -1 } : s))
        await dispatchStats(bustedLineup)
        expect(screen.getByTestId('hud-4')).toHaveTextContent('Player: 5')
        expect(screen.getByTestId('hud-4')).toHaveTextContent('Dimmed: yes')

        // 4-maxへ縮小したlineupが届く(配列長4、座席4/5に対応する要素自体が
        // 無い)。この更新のmapループはindex 0-3しか処理しないため、席4の
        // 古いキャッシュには一切触れられない
        const fourMaxLineup: StatsData['stats'] = [
          { playerId: 1, statResults: [] },
          { playerId: 2, statResults: [] },
          { playerId: 3, statResults: [] },
          { playerId: 4, statResults: [] },
        ]
        await dispatchStats(fourMaxLineup)

        // この状態でフィルターが変わる。席4は現在の表示に存在しない
        // （currentStats[4]がundefined）ので「ライブ在籍中」ではなく、
        // 古いキャッシュはクリアされなければならない
        await act(async () => {
          window.dispatchEvent(new CustomEvent('updateBattleTypeFilter', {
            detail: { gameTypes: { sng: true, mtt: false, ring: true } },
          }))
        })

        // 6-maxに戻り、席4が引き続き空席のlineupが届く
        await dispatchStats(bustedLineup)

        // プレイヤー5の古いキャッシュがクリアされていれば、席4は
        // 「Waiting for Hand...」のまま
        expect(screen.getByTestId('hud-4')).toHaveTextContent('Player: -1')
        expect(screen.getByTestId('hud-4')).toHaveTextContent('Dimmed: no')
      })

      it('latestStats(バッチ再計算)でdimmedSeatIndicesが空にリセットされた後でも、フィルター変更は取り残されたdimCacheエントリを無効化する（post-merge review P2「Clear cached muted seats even after dim state resets」）', async () => {
        render(<App />)
        await dispatchStats(mockStatsData.stats)

        // 席1(プレイヤー2)がbustしてミュート表示になる
        const bustedLineup: StatsData['stats'] = mockStatsData.stats.map((s, i) => (i === 1 ? { playerId: -1 } : s))
        await dispatchStats(bustedLineup)
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 2')
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: yes')

        // インポート後のrefreshStats往復相当: chrome.runtime.onMessageで
        // 'latestStats'が来る（席1は改めて空席として届く）。この経路は
        // dimmedSeatIndicesを空にリセットするが、dimCacheRef自体には
        // 触れない -- 席1の"プレイヤー2"のキャッシュは取り残されたまま
        const addListenerCalls = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls
        const messageHandler = addListenerCalls[0][0]
        const batchLineup: StatsData['stats'] = mockStatsData.stats.map((s, i) => (i === 1 ? { playerId: -1 } : s))
        await act(async () => {
          messageHandler({ action: 'latestStats', stats: batchLineup })
        })
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: -1')
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: no')

        // この時点でdimmedSeatIndicesは空 -- 旧実装(dimmedSeatIndicesRef基準の
        // クリア)だと、フィルター変更ハンドラーは「クリアすべき座席なし」と
        // 誤認して早期returnし、取り残されたdimCacheの席1エントリを見逃す
        await act(async () => {
          window.dispatchEvent(new CustomEvent('updateBattleTypeFilter', {
            detail: { gameTypes: { sng: true, mtt: false, ring: true } },
          }))
        })

        // 席1が引き続き空席のライブ更新が届いても、取り残された古いフィルター
        // 統計(プレイヤー2)がdimCacheから復活してミュート表示されてはいけない
        const stillBustedLineup: StatsData['stats'] = mockStatsData.stats.map((s, i) => (i === 1 ? { playerId: -1 } : s))
        await dispatchStats(stillBustedLineup)
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: -1')
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: no')
      })

      it('リロード/再マウント境界: 事前状態やセッション開始シグナルを一切必要とせず、新しいマウントは空の状態から通常通りライブ更新を受け付ける（縮小スコープの下では特別なガードを持たない）', async () => {
        const { unmount } = render(<App />)
        await dispatchStats(mockStatsData.stats)
        const bustedLineup: StatsData['stats'] = mockStatsData.stats.map((s, i) => (i === 1 ? { playerId: -1 } : s))
        await dispatchStats(bustedLineup)
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: yes')

        // タブのリロード/拡張機能の再読み込みを模す -- 古いReactツリーの
        // dimCache/dimmedSeatIndicesは新しいマウントに一切引き継がれない
        // （新しいuseRef/useState、モジュールスコープの状態も持たない）
        unmount()
        render(<App />)

        // 新しいマウントは、以前のセッションについて何も知らない状態から
        // 即座に通常通りライブ更新を受け付ける -- セッション開始シグナルを
        // 待つ必要も、以前の状態を復元する必要もない（pregameのhero単独
        // フォールバックは別経路の`latestStats`chromeメッセージが担当し、
        // ここでは検証しない）
        await dispatchStats(mockStatsData.stats)
        expect(screen.getByTestId('hud-0')).toHaveTextContent('Player: 1')
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 2')
        expect(screen.getByTestId('hud-1')).toHaveTextContent('Dimmed: no')
      })
    })
  })
})