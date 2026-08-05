import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  RecentHandsPanel,
  describePreflopLabel,
  formatBigBlinds,
  formatBoardTooltip,
  formatCardsTooltip,
  formatPreflopLine,
  formatNetBigBlinds,
  formatPostflopLines,
  formatPostflopTooltip,
  formatStreetAction,
} from './RecentHandsPanel'
import { Position } from '../../types/game'
import { SUIT_COLORS } from '../../utils/card-utils'
import type { RecentHandsResult, StreetAction } from '../../types/stats'
import {
  DEFAULT_RECENT_HANDS_LIMIT,
  DEFAULT_RECENT_HANDS_PANEL_CONFIG,
  DEFAULT_RECENT_HANDS_PARTICIPATION_ONLY,
  RECENT_HANDS_LIMIT_OPTIONS,
  RECENT_HANDS_PANEL_CONFIG_EVENT,
} from '../../utils/recent-hands-config'
import type { RecentHandsPanelConfig } from '../../utils/recent-hands-config'

const NOW = 1_700_000_000_000

/** StreetAction fixture helper. */
const sa = (letter: string, extra: Partial<StreetAction> = {}): StreetAction => ({
  letter, allIn: false, increment: null, potBefore: null, potPercent: null, ...extra,
})

const buildResult = (overrides: Partial<RecentHandsResult> = {}): RecentHandsResult => ({
  computedAt: NOW,
  hands: [
    { handId: 3, approxTimestamp: NOW - 3 * 60_000, bigBlind: 200, position: Position.BTN, holeCards: ['As', 'Ah'], holeCardsSource: 'results', preflopLine: 'OR', preflopLineAmountBB: 2.2, preflopLineAmountChips: 440, postflopLines: { flop: [sa('X'), sa('C')], turn: [sa('B', { potPercent: 75, allIn: true, increment: 900, potBefore: 1200 })], river: [] }, board: ['8h','9h','6h','2s','Ad'], sawFlop: true, wentToShowdown: true, won: true, netChips: 1240 },
    { handId: 2, approxTimestamp: NOW - 2 * 3600_000, bigBlind: 200, position: Position.BB, holeCards: null, holeCardsSource: null, preflopLine: 'X', preflopLineAmountBB: null, preflopLineAmountChips: null, postflopLines: { flop: [sa('X')], turn: [], river: [sa('F')] }, board: ['8h','9h','6h'], sawFlop: true, wentToShowdown: false, won: false, netChips: -640 },
    { handId: 1, approxTimestamp: NOW - 26 * 3600_000, bigBlind: 200, position: null, holeCards: null, holeCardsSource: null, preflopLine: 'F', preflopLineAmountBB: null, preflopLineAmountChips: null, postflopLines: { flop: [], turn: [], river: [] }, board: [], sawFlop: false, wentToShowdown: false, won: false, netChips: 0 },
  ],
  ...overrides,
})

describe('RecentHandsPanel', () => {
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

  // パネルは設定読み取り（getRecentHandsPanelConfig）とハンド取得
  // （getRecentHands）の両方をchrome.runtime.sendMessageで送る。フェッチ回数の
  // アサーションはこのフィルタで数える（設定読み取りを混ぜない）。
  const recentHandsCalls = () =>
    mockSendMessage.mock.calls.filter(
      ([message]) => (message as { action?: string } | undefined)?.action === 'getRecentHands'
    )

  /**
   * 保存済み設定がある状態を模す: getRecentHandsPanelConfigへは指定configで、
   * getRecentHandsへはrecentHandsで応答する。
   */
  const respondWithConfig = (
    config: Partial<RecentHandsPanelConfig>,
    recentHands: RecentHandsResult = buildResult()
  ) => {
    mockSendMessage.mockImplementation((message: { action?: string }, callback: (response: unknown) => void) => {
      if (message?.action === 'getRecentHandsPanelConfig') {
        callback({ success: true, config: { ...DEFAULT_RECENT_HANDS_PANEL_CONFIG, ...config } })
        return
      }
      callback({ success: true, recentHands })
    })
  }

  it('ロード中はローディング表示、応答が来るとテーブルに切り替わる', async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      Promise.resolve().then(() => callback({ success: true, recentHands: buildResult() }))
    })

    render(<RecentHandsPanel playerId={123} />)

    expect(screen.getByText('Loading hands…')).toHaveStyle({ color: '#b8b8b8' })

    await waitFor(() => {
      expect(screen.getAllByTestId('recent-hands-row')).toHaveLength(3)
    })

    expect(screen.queryByText('Loading hands…')).not.toBeInTheDocument()
  })

  it('リクエストはgetRecentHandsアクションでplayerIdを渡す', async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      callback({ success: true, recentHands: buildResult() })
    })

    render(<RecentHandsPanel playerId={999} />)

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith(
        { action: 'getRecentHands', playerId: 999, limit: DEFAULT_RECENT_HANDS_LIMIT, participationOnly: DEFAULT_RECENT_HANDS_PARTICIPATION_ONLY },
        expect.any(Function)
      )
    })
  })

  it('triggerから参照できるplayer固有regionとして公開する', async () => {
    // 設定読み取りには応答し、getRecentHandsは未応答のまま（このテストの
    // 関心はregion属性なので、フェッチ結果は要らない）。
    mockSendMessage.mockImplementation((message: { action?: string }, callback: (response: unknown) => void) => {
      if (message?.action === 'getRecentHandsPanelConfig') {
        callback({ success: true, config: DEFAULT_RECENT_HANDS_PANEL_CONFIG })
      }
    })

    render(<RecentHandsPanel playerId={999} />)

    const panel = screen.getByRole('region', { name: 'Player 999の直近ハンド' })
    expect(panel).toHaveAttribute('id', 'recent-hands-panel-999')
    expect(panel).toHaveAttribute('data-player-id', '999')
    // 保存済み設定の解決（非同期）とフェッチ開始が終わってからテストを抜ける。
    await waitFor(() => expect(recentHandsCalls().length).toBeGreaterThan(0))
  })

  it('新しい順（ハンドID降順）に表示する', async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      callback({ success: true, recentHands: buildResult() })
    })

    render(<RecentHandsPanel playerId={123} />)

    const rows = await screen.findAllByTestId('recent-hands-row')
    expect(rows).toHaveLength(3)
    // 1行目はhandId=3（won行、+1240チップ = BB200で+6.2BB）
    expect(rows[0]).toHaveTextContent('+6.2')
  })

  it('公開されたホールカードは表示し、非公開のハンドは"—"にする', async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      callback({ success: true, recentHands: buildResult() })
    })

    render(<RecentHandsPanel playerId={123} />)

    const rows = await screen.findAllByTestId('recent-hands-row')
    // handId=3: 公開。#356でスート文字は落とし、色で判別する。
    const cardsCell = rows[0]!.querySelector('[data-testid="recent-hands-cards"]')
    expect(cardsCell).toHaveTextContent('AA')
    // 正確な表記はツールチップから到達できる（色だけが頼りにならないように）。
    expect(cardsCell).toHaveAttribute('title', 'ホールカード: As Ah')
    // #353: 4色デッキ -- スペードとハートは別色で描かれる。
    const cardSpans = rows[0]!.querySelectorAll('[data-testid="recent-hands-cards"] span')
    expect(cardSpans[0]).toHaveStyle({ color: SUIT_COLORS.s })
    expect(cardSpans[1]).toHaveStyle({ color: SUIT_COLORS.h })
    // handId=2, 1: 非公開
    expect(rows[1]!.querySelector('[data-testid="recent-hands-cards"]')).toHaveTextContent('—')
    expect(rows[2]!.querySelector('[data-testid="recent-hands-cards"]')).toHaveTextContent('—')
  })

  it('signed netをBB単位（小数第1位）で表示し、正負を色分けする', async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      callback({ success: true, recentHands: buildResult() })
    })

    render(<RecentHandsPanel playerId={123} />)

    const rows = await screen.findAllByTestId('recent-hands-row')
    // bigBlind=200: +1240 -> +6.2 / -640 -> -3.2 / 0 -> 0.0
    expect(rows[0]).toHaveTextContent('+6.2')
    // #357: ショーダウン到達を示す黄色い`●`は表示しない（sola指定）。
    // `wentToShowdown`はデータとしては残るが、この列には出さない。
    expect(rows[0]).not.toHaveTextContent('●')
    expect(rows[1]).not.toHaveTextContent('●')
    expect(rows[1]).toHaveTextContent('-3.2')
    expect(rows[1]!.querySelector('td:last-child span')).toHaveStyle({ color: '#ff6b6b' })
    expect(rows[2]).toHaveTextContent('0.0')
    expect(rows[2]!.querySelector('td:last-child span')).toHaveStyle({ color: '#b8b8b8' })
    // チップ実額は列を増やさずツールチップで残す。
    expect(rows[0]!.querySelector('td:last-child')).toHaveAttribute('title', expect.stringContaining('+1,240') as any)
  })

  it('時刻列は表示しない（sola: 時刻は不要）', async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      callback({ success: true, recentHands: buildResult() })
    })

    render(<RecentHandsPanel playerId={123} />)

    await screen.findAllByTestId('recent-hands-row')
    expect(screen.queryByText('時刻')).not.toBeInTheDocument()
  })

  it('列ヘッダー行は表示しない（#357、sola「見ればわかるし」）', async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      callback({ success: true, recentHands: buildResult() })
    })

    const { container } = render(<RecentHandsPanel playerId={123} />)

    await screen.findAllByTestId('recent-hands-row')
    expect(container.querySelector('thead')).toBeNull()
    expect(container.querySelectorAll('th')).toHaveLength(0)
    for (const label of ['Pos', 'カード', 'ライン', 'ボード', 'F/T/R', '損益(BB)']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    }
    // ヘッダーが担っていた説明は、各セルのツールチップから辿れること。
    const rows = await screen.findAllByTestId('recent-hands-row')
    // F/T/R: 記号の凡例。アグレッシブなアクションが無い行にも必ず付く。
    expect(rows[1]!.querySelector('[data-testid="recent-hands-streets"]'))
      .toHaveAttribute('title', expect.stringContaining('X=チェック') as any)
    // 損益: 単位（BB）を名乗る。
    expect(rows[0]!.querySelector('td:last-child'))
      .toHaveAttribute('title', expect.stringContaining('BB') as any)
  })

  it('source accountingが不明なら推測せず"-"を表示する', async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      callback({
        success: true,
        recentHands: buildResult({ hands: [{ ...buildResult().hands[0]!, won: false, netChips: null }] })
      })
    })

    render(<RecentHandsPanel playerId={123} />)

    const row = await screen.findByTestId('recent-hands-row')
    expect(row.querySelector('td:last-child')).toHaveTextContent('-')
    expect(row.querySelector('td:last-child span')).toHaveStyle({ color: '#b8b8b8' })
  })

  it('プリフロップ・ラインとポジションを表示する（nullは"—"）', async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      callback({ success: true, recentHands: buildResult() })
    })

    render(<RecentHandsPanel playerId={123} />)

    const rows = await screen.findAllByTestId('recent-hands-row')
    // #354: アグレッシブなラインにはBB倍数がインラインで付く。
    expect(rows[0]!.querySelector('[data-testid="recent-hands-preflop"]')).toHaveTextContent('OR2.2')
    expect(rows[0]!.querySelector('[data-testid="recent-hands-preflop"]'))
      .toHaveAttribute('title', expect.stringContaining('440') as any)
    expect(rows[0]).toHaveTextContent('BTN')
    expect(rows[2]!.querySelector('[data-testid="recent-hands-preflop"]')).toHaveTextContent('F')
    expect(rows[2]).toHaveTextContent('—') // position: null
  })

  it('ハンドが0件の場合は専用プレースホルダーを表示', async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      callback({ success: true, recentHands: buildResult({ hands: [] }) })
    })

    render(<RecentHandsPanel playerId={123} />)

    // 既定は「参加のみ」ONなので、0件の理由がフィルターだと分かる文言になる。
    await waitFor(() => {
      expect(screen.getByText('参加したハンドなし')).toBeInTheDocument()
    })
  })

  it('success:falseの応答はフェイルオープンでプレースホルダーを表示', async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      callback({ success: false, error: 'boom' })
    })

    render(<RecentHandsPanel playerId={123} />)

    await waitFor(() => {
      expect(screen.getByText('—')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('recent-hands-row')).not.toBeInTheDocument()
  })

  it('タイムアウト（応答なし）はフェイルオープンでプレースホルダーを表示し、HUDをクラッシュさせない', async () => {
    jest.useFakeTimers()
    // 設定読み取りには即応答し、getRecentHandsだけを無応答（タイムアウト）に
    // する。設定読み取り自体のタイムアウトはrecent-hands-config.test.tsが持つ。
    mockSendMessage.mockImplementation((message: { action?: string }, callback: (response: unknown) => void) => {
      if (message?.action === 'getRecentHandsPanelConfig') {
        callback({ success: true, config: DEFAULT_RECENT_HANDS_PANEL_CONFIG })
      }
    })

    render(<RecentHandsPanel playerId={123} />)

    expect(screen.getByText('Loading hands…')).toBeInTheDocument()

    // 保存済み設定（background経由）の解決を待ってから時計を進める。
    // 解決前はフェッチ自体が始まらないので、タイムアウトタイマーもまだ無い。
    await waitFor(() => {
      expect(recentHandsCalls().length).toBeGreaterThan(0)
    })

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

    render(<RecentHandsPanel playerId={123} />)

    await waitFor(() => {
      expect(screen.getByText('—')).toBeInTheDocument()
    })
  })

  it('playerIdが変わると再フェッチする', async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      callback({ success: true, recentHands: buildResult() })
    })

    const { rerender } = render(<RecentHandsPanel playerId={1} />)
    await screen.findAllByTestId('recent-hands-row')
    expect(recentHandsCalls()).toHaveLength(1)

    rerender(<RecentHandsPanel playerId={2} />)

    await waitFor(() => {
      expect(recentHandsCalls()).toHaveLength(2)
    })
    expect(mockSendMessage).toHaveBeenLastCalledWith(
      { action: 'getRecentHands', playerId: 2, limit: DEFAULT_RECENT_HANDS_LIMIT, participationOnly: DEFAULT_RECENT_HANDS_PARTICIPATION_ONLY },
      expect.any(Function)
    )
  })

  // 監査指摘11（P2）「開いたドリルダウンパネルが無期限に古くなる」対応:
  // playerIdが同じままでもhandEpochが変わればフェッチeffectを再発火する。
  it('playerIdが同じでもhandEpochが変わると再フェッチする(監査指摘11)', async () => {
    let fetchCount = 0
    mockSendMessage.mockImplementation((message: { action?: string }, callback: (response: unknown) => void) => {
      if (message?.action === 'getRecentHandsPanelConfig') {
        callback({ success: true, config: DEFAULT_RECENT_HANDS_PANEL_CONFIG })
        return
      }
      fetchCount++
      // 2回目の応答は1回目と区別できるよう新しいハンドを1件追加する
      // （新しいハンドが完了して初めて反映されるべきデータ）
      const result = fetchCount === 2
        ? buildResult({ hands: [{ handId: 4, approxTimestamp: NOW, bigBlind: 200, position: Position.CO, holeCards: null, holeCardsSource: null, preflopLine: 'OR', preflopLineAmountBB: 2.2, preflopLineAmountChips: 440, postflopLines: { flop: [], turn: [], river: [] }, board: [], sawFlop: false, wentToShowdown: false, won: false, netChips: null }, ...buildResult().hands] })
        : buildResult()
      callback({ success: true, recentHands: result })
    })

    const { rerender } = render(<RecentHandsPanel playerId={1} handEpoch={1} />)
    await waitFor(() => {
      expect(screen.getAllByTestId('recent-hands-row')).toHaveLength(3)
    })
    expect(recentHandsCalls()).toHaveLength(1)

    // 実況の1アクションごとの更新はhandEpochを変えない想定 -- 同じepochでの
    // 再レンダーは再フェッチを引き起こさない。
    rerender(<RecentHandsPanel playerId={1} handEpoch={1} />)
    expect(recentHandsCalls()).toHaveLength(1)

    // ハンドが1件完了してhandEpochが増える
    rerender(<RecentHandsPanel playerId={1} handEpoch={2} />)

    await waitFor(() => {
      expect(recentHandsCalls()).toHaveLength(2)
    })
    await waitFor(() => {
      expect(screen.getAllByTestId('recent-hands-row')).toHaveLength(4)
    })
  })

  // #341-3「各ストリートでのアクション表示」
  describe('ストリート別アクション列', () => {
    it('ポストフロップの省略記法を表示し、アクションが無いハンドは"—"にする', async () => {
      mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
        callback({ success: true, recentHands: buildResult() })
      })

      render(<RecentHandsPanel playerId={123} />)

      const rows = await screen.findAllByTestId('recent-hands-row')
      // flop=XC, turn=B75!(all-in), river=なし -> 末尾の空ストリートは落とす
      expect(rows[0]!.querySelector('[data-testid="recent-hands-streets"]')).toHaveTextContent('XC / B75!')
      // 実額は列を増やさずツールチップへ（#354）。
      expect(rows[0]!.querySelector('[data-testid="recent-hands-streets"]'))
        .toHaveAttribute('title', expect.stringContaining('B75!=900（ポット1,200）') as any)
      // flop='X', turn=なし, river='F' -> 途中の空ストリートは'-'で残す
      expect(rows[1]!.querySelector('[data-testid="recent-hands-streets"]')).toHaveTextContent('X / - / F')
      // 全ストリートnull（プリフロップで終わったハンド）
      expect(rows[2]!.querySelector('[data-testid="recent-hands-streets"]')).toHaveTextContent('—')
    })
  })

  // #341-1「表示ハンド数の拡大」
  describe('件数スイッチャー', () => {
    beforeEach(() => {
      mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
        callback({ success: true, recentHands: buildResult() })
      })
    })

    it('選択肢を全て出し、既定値をアクティブにする', async () => {
      render(<RecentHandsPanel playerId={123} />)

      await screen.findAllByTestId('recent-hands-row')
      for (const option of RECENT_HANDS_LIMIT_OPTIONS) {
        expect(screen.getByRole('button', { name: `直近${option}ハンドを表示` })).toBeInTheDocument()
      }
      expect(screen.getByRole('button', { name: `直近${DEFAULT_RECENT_HANDS_LIMIT}ハンドを表示` }))
        .toHaveAttribute('aria-pressed', 'true')
    })

    it('件数を変えると新しいlimitで再フェッチし、選択の保存をbackgroundへ送る', async () => {
      const user = userEvent.setup()
      render(<RecentHandsPanel playerId={123} />)

      await screen.findAllByTestId('recent-hands-row')
      expect(recentHandsCalls()).toHaveLength(1)

      await user.click(screen.getByRole('button', { name: '直近100ハンドを表示' }))

      await waitFor(() => {
        expect(mockSendMessage).toHaveBeenLastCalledWith(
          { action: 'getRecentHands', playerId: 123, limit: 100, participationOnly: DEFAULT_RECENT_HANDS_PARTICIPATION_ONLY },
          expect.any(Function)
        )
      })
      // 永続化はbackground経由（storage.localはcontent scriptから遮断されている）。
      expect(mockSendMessage).toHaveBeenCalledWith(
        { action: 'setRecentHandsPanelConfig', patch: { limit: 100 } },
        expect.any(Function)
      )
    })

    it('保存済みの件数があればそれで最初のフェッチを行う（既定値での二度手間フェッチをしない）', async () => {
      respondWithConfig({ limit: 50 })

      render(<RecentHandsPanel playerId={123} />)

      await screen.findAllByTestId('recent-hands-row')
      expect(recentHandsCalls()).toHaveLength(1)
      expect(mockSendMessage).toHaveBeenCalledWith(
        { action: 'getRecentHands', playerId: 123, limit: 50, participationOnly: DEFAULT_RECENT_HANDS_PARTICIPATION_ONLY },
        expect.any(Function)
      )
    })

    it('他パネル／他タブの変更broadcastに追従して再フェッチする', async () => {
      render(<RecentHandsPanel playerId={123} />)

      await screen.findAllByTestId('recent-hands-row')
      expect(recentHandsCalls()).toHaveLength(1)

      // backgroundのbroadcastをcontent_script.tsがwindowイベントへ変換した
      // 状態を模す（subscribeRecentHandsPanelConfigの購読経路）。
      act(() => {
        window.dispatchEvent(new CustomEvent(RECENT_HANDS_PANEL_CONFIG_EVENT, { detail: { limit: 50 } }))
      })

      await waitFor(() => {
        expect(recentHandsCalls()).toHaveLength(2)
      })
      expect(mockSendMessage).toHaveBeenLastCalledWith(
        { action: 'getRecentHands', playerId: 123, limit: 50, participationOnly: DEFAULT_RECENT_HANDS_PARTICIPATION_ONLY },
        expect.any(Function)
      )
    })

    it('ロード中・0件・エラーのいずれでもスイッチャーは操作できる', async () => {
      mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
        callback({ success: false, error: 'boom' })
      })

      render(<RecentHandsPanel playerId={123} />)

      await waitFor(() => {
        expect(screen.getByTestId('recent-hands-limit-switcher')).toBeInTheDocument()
      })
      expect(screen.getByRole('button', { name: '直近10ハンドを表示' })).toBeInTheDocument()
    })
  })

  // #353「参加のみ」
  describe('参加のみトグル', () => {
    beforeEach(() => {
      mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
        callback({ success: true, recentHands: buildResult() })
      })
    })

    it('既定はONで、初回フェッチにparticipationOnly: trueを渡す', async () => {
      render(<RecentHandsPanel playerId={123} />)

      await screen.findAllByTestId('recent-hands-row')
      expect(screen.getByRole('button', { name: '参加のみ表示' })).toHaveAttribute('aria-pressed', 'true')
      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ participationOnly: true }),
        expect.any(Function)
      )
    })

    it('OFFにするとparticipationOnly: falseで再フェッチし、選択の保存をbackgroundへ送る', async () => {
      const user = userEvent.setup()
      render(<RecentHandsPanel playerId={123} />)

      await screen.findAllByTestId('recent-hands-row')
      await user.click(screen.getByRole('button', { name: '参加のみ表示' }))

      await waitFor(() => {
        expect(mockSendMessage).toHaveBeenLastCalledWith(
          expect.objectContaining({ participationOnly: false }),
          expect.any(Function)
        )
      })
      // 永続化はbackground経由（storage.localはcontent scriptから遮断されている）。
      expect(mockSendMessage).toHaveBeenCalledWith(
        { action: 'setRecentHandsPanelConfig', patch: { participationOnly: false } },
        expect.any(Function)
      )
      expect(screen.getByRole('button', { name: '参加のみ表示' })).toHaveAttribute('aria-pressed', 'false')
    })

    // codexレビュー指摘（P3）: 自分の書き込みが起こす変更通知（いまは
    // backgroundのbroadcast経由）で、同じ条件のフェッチが二度走らないこと。
    it('トグル操作は1回しか再フェッチしない（broadcastの反響で二重に走らない）', async () => {
      const user = userEvent.setup()
      render(<RecentHandsPanel playerId={123} />)

      await screen.findAllByTestId('recent-hands-row')
      expect(recentHandsCalls()).toHaveLength(1)

      await user.click(screen.getByRole('button', { name: '参加のみ表示' }))

      await waitFor(() => {
        expect(mockSendMessage).toHaveBeenLastCalledWith(
          expect.objectContaining({ participationOnly: false }),
          expect.any(Function)
        )
      })
      expect(recentHandsCalls()).toHaveLength(2)

      // backgroundのbroadcastが自パネルへ反響しても（値は変わらないので）
      // 3回目のフェッチは起きない。
      act(() => {
        window.dispatchEvent(new CustomEvent(RECENT_HANDS_PANEL_CONFIG_EVENT, {
          detail: { participationOnly: false },
        }))
      })
      // 1回目（初回）＋2回目（トグル）だけ。反響による3回目は起きない。
      expect(recentHandsCalls()).toHaveLength(2)
    })

    it('保存済みのOFFがあればそれで最初のフェッチを行う', async () => {
      respondWithConfig({ participationOnly: false })

      render(<RecentHandsPanel playerId={123} />)

      await screen.findAllByTestId('recent-hands-row')
      expect(recentHandsCalls()).toHaveLength(1)
      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ participationOnly: false }),
        expect.any(Function)
      )
    })

    it('OFFのときの0件は「参加のみ」由来ではないので従来の文言を出す', async () => {
      respondWithConfig({ participationOnly: false }, buildResult({ hands: [] }))

      render(<RecentHandsPanel playerId={123} />)

      await waitFor(() => {
        expect(screen.getByText('No hands yet')).toBeInTheDocument()
      })
    })
  })

  // codexレビュー指摘（P2）: 旧backgroundの応答（bigBlind欠損）でHUDを落とさない
  it('bigBlindが欠けた応答でもクラッシュせず、チップ表記で描画する', async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      const { bigBlind, ...withoutBigBlind } = buildResult().hands[0]!
      void bigBlind
      callback({ success: true, recentHands: { computedAt: NOW, hands: [withoutBigBlind] } })
    })

    render(<RecentHandsPanel playerId={123} />)

    const row = await screen.findByTestId('recent-hands-row')
    expect(row).toHaveTextContent('+1,240')
    // #357: BB換算できずチップ表記へ倒れた行にもツールチップを出す。ヘッダー
    // （`損益(BB)`）を廃止したので、単位を名乗る場所がここしか無くなった。
    // BBは名乗れないので、チップであることだけを言う。
    expect(row.querySelector('td:last-child')).toHaveAttribute('title', '損益 +1,240チップ')
  })

  // #357レビュー指摘（P2）: 会計不明（netChips=null）の`-`行も、ヘッダー廃止後に
  // セルだけから「損益列・BB単位」へ到達できるようツールチップを持つ。
  it('会計不明の行にも損益列の意味を示すツールチップを出す', async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      const hand = { ...buildResult().hands[0]!, netChips: null }
      callback({ success: true, recentHands: { computedAt: NOW, hands: [hand] } })
    })

    render(<RecentHandsPanel playerId={123} />)

    const row = await screen.findByTestId('recent-hands-row')
    expect(row.querySelector('td:last-child')).toHaveTextContent('-')
    expect(row.querySelector('td:last-child')).toHaveAttribute('title', '損益（BB、会計不明）')
  })

  // #353: ヒーロー自身の配札カードは source='dealt' で届く
  it("ショーダウン以外でも自分の配札カード（source='dealt'）を表示する", async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      callback({
        success: true,
        recentHands: buildResult({
          hands: [{
            handId: 9, approxTimestamp: NOW, bigBlind: 200, position: Position.CO,
            holeCards: ['Jh', 'Ac'], holeCardsSource: 'dealt',
            preflopLine: 'CC', preflopLineAmountBB: null, preflopLineAmountChips: null, postflopLines: { flop: [sa('F')], turn: [], river: [] },
            board: ['8h','9h','6h'], sawFlop: true, wentToShowdown: false, won: false, netChips: -420,
          }],
        }),
      })
    })

    render(<RecentHandsPanel playerId={123} />)

    const row = await screen.findByTestId('recent-hands-row')
    const cards = row.querySelector('[data-testid="recent-hands-cards"]')
    // #356: 表示はランクのみ（スートは色）。正確な表記はツールチップ。
    expect(cards).toHaveTextContent('JA')
    expect(cards).toHaveAttribute('title', 'ホールカード: Jh Ac')
    expect(cards).not.toHaveTextContent('—')
  })
})

describe('formatNetBigBlinds', () => {
  const entry = (netChips: number | null, bigBlind: number | null) => ({
    handId: 1, approxTimestamp: null, bigBlind, position: null, holeCards: null,
    holeCardsSource: null, preflopLine: null,
    preflopLineAmountBB: null, preflopLineAmountChips: null,
    postflopLines: { flop: [], turn: [], river: [] },
    board: [], sawFlop: false, wentToShowdown: false, won: false, netChips,
  })

  test('そのハンド自身のBBで割る（ブラインドが上がっても比較できる）', () => {
    expect(formatNetBigBlinds(entry(1240, 200))).toBe('+6.2')
    // 同じ+1240でもレベルが上がっていればBB数は小さくなる。
    expect(formatNetBigBlinds(entry(1240, 800))).toBe('+1.6')
    expect(formatNetBigBlinds(entry(-3880, 200))).toBe('-19.4')
  })

  test('丸めて0になる損益は符号を付けない（-0.0を損に見せない）', () => {
    expect(formatNetBigBlinds(entry(0, 200))).toBe('0.0')
    expect(formatNetBigBlinds(entry(-8, 200))).toBe('0.0')
    expect(formatNetBigBlinds(entry(8, 200))).toBe('0.0')
  })

  test('会計未確定は従来どおり"-"', () => {
    expect(formatNetBigBlinds(entry(null, 200))).toBe('-')
  })

  test('BBが使えない行はチップ表記へフォールバックする（行を隠さない）', () => {
    expect(formatNetBigBlinds(entry(1240, null))).toBe('+1,240')
    expect(formatNetBigBlinds(entry(-640, 0))).toBe('-640')
  })

  // codexレビュー指摘（P2）: 更新切替中の旧background応答では新設フィールドが
  // 丸ごと欠ける。null判定だけではundefinedを取りこぼす。
  test('bigBlind/netChipsが欠損・非有限でも落ちない', () => {
    expect(formatNetBigBlinds({ ...entry(1240, 200), bigBlind: undefined } as any)).toBe('+1,240')
    expect(formatNetBigBlinds({ ...entry(1240, 200), bigBlind: Number.NaN } as any)).toBe('+1,240')
    expect(formatNetBigBlinds({ ...entry(1240, 200), bigBlind: -200 } as any)).toBe('+1,240')
    expect(formatNetBigBlinds({ ...entry(1240, 200), netChips: undefined } as any)).toBe('-')
  })
})

describe('formatPreflopLine', () => {
  const entry = (preflopLine: string | null, preflopLineAmountBB: number | null) => ({
    handId: 1, approxTimestamp: null, bigBlind: 200, position: null, holeCards: null,
    holeCardsSource: null, preflopLine, preflopLineAmountBB, preflopLineAmountChips: 440,
    postflopLines: { flop: [], turn: [], river: [] }, board: [],
    sawFlop: false, wentToShowdown: false, won: false, netChips: null,
  })

  test('OR（オープンレイズ）はBB倍数を小数第1位で付ける', () => {
    expect(formatPreflopLine(entry('OR', 2.2))).toBe('OR2.2')
    // 丸めて整数になる場合は`.0`を落とす（表記規則は全ラベル共通）。
    expect(formatPreflopLine(entry('OR', 3))).toBe('OR3')
  })

  test('3B以上はレイズto額をBBで付ける', () => {
    expect(formatPreflopLine(entry('3B', 9))).toBe('3B9')
    expect(formatPreflopLine(entry('4B', 22))).toBe('4B22')
    // 10未満で端数があるときは小数を残す（意味が消えないように）。
    expect(formatPreflopLine(entry('3B', 8.75))).toBe('3B8.8')
  })

  test('-Fサフィックスは数字の後ろへ回す', () => {
    expect(formatPreflopLine(entry('OR-F', 2.2))).toBe('OR2.2-F')
    expect(formatPreflopLine(entry('3B-F', 9))).toBe('3B9-F')
  })

  test('アグレッシブでないラベルには数字を付けない', () => {
    for (const line of ['L', 'C', 'X', 'F', 'W', 'L-F', 'X-F']) {
      expect(formatPreflopLine(entry(line, 9))).toBe(line)
    }
  })

  test('レイズto額が無ければラベルだけ（ショートオールイン・bigBlind不能）', () => {
    // サービス側がショートオールイン（実質コール）と`bigBlind`不能を
    // どちらもnullにして寄越す。表示側は数字を捏造しない。
    expect(formatPreflopLine(entry('3B', null))).toBe('3B')
    expect(formatPreflopLine(entry('OR-F', null))).toBe('OR-F')
    expect(formatPreflopLine(entry('OR', 0))).toBe('OR')
    expect(formatPreflopLine(entry('OR', Number.NaN))).toBe('OR')
    expect(formatPreflopLine({ ...entry('OR', 2.2), preflopLineAmountBB: undefined } as any)).toBe('OR')
  })

  test('ラインそのものが無ければem dash', () => {
    expect(formatPreflopLine(entry(null, 2.2))).toBe('—')
  })
})

// #356 ボード列
describe('board column', () => {
  let sendMessage: jest.Mock
  const renderBoard = async (board: string[]) => {
    sendMessage = jest.fn((_m: unknown, cb: (r: unknown) => void) => cb({
      success: true,
      recentHands: { computedAt: NOW, hands: [{ ...buildResult().hands[0]!, board }] },
    }))
    global.chrome = { ...global.chrome, runtime: { ...global.chrome.runtime, sendMessage } } as any
    render(<RecentHandsPanel playerId={7} />)
    const row = await screen.findByTestId('recent-hands-row')
    return row.querySelector('[data-testid="recent-hands-board"]')!
  }

  test('フロップのみ: ランクだけを繋げて出す', async () => {
    const cell = await renderBoard(['8h', '9h', '6h'])
    expect(cell).toHaveTextContent('896')
    expect(cell).toHaveAttribute('title', 'ボード: 8h 9h 6h')
  })

  test('フルランナウト: 区切り無しで5枚を詰めて出す', async () => {
    const cell = await renderBoard(['8h', '9h', '6h', '2s', 'Ad'])
    expect(cell).toHaveTextContent('8962A')
    // ストリート境界はツールチップ側だけが持つ（表示は詰める、#356）。
    expect(cell).toHaveAttribute('title', 'ボード: 8h 9h 6h | 2s | Ad')
    const spans = cell.querySelectorAll('span')
    expect(spans).toHaveLength(5)
    // どのカードにも間隔用のマージンは付けない。
    spans.forEach(span => expect(span).toHaveStyle({ marginLeft: '' }))
  })

  test('スートは4色で塗り分ける（文字を落とした分の判別手段）', async () => {
    const cell = await renderBoard(['8h', '2s', '3d', '4c'])
    const spans = cell.querySelectorAll('span')
    expect(spans[0]).toHaveStyle({ color: SUIT_COLORS.h })
    expect(spans[1]).toHaveStyle({ color: SUIT_COLORS.s })
    expect(spans[2]).toHaveStyle({ color: SUIT_COLORS.d })
    expect(spans[3]).toHaveStyle({ color: SUIT_COLORS.c })
  })

  test('フロップを見なかったハンドはem dashでツールチップ無し', async () => {
    const cell = await renderBoard([])
    expect(cell).toHaveTextContent('—')
    expect(cell).not.toHaveAttribute('title')
  })

  test('boardフィールドが欠けた応答でもクラッシュしない（旧background）', async () => {
    sendMessage = jest.fn((_m: unknown, cb: (r: unknown) => void) => {
      const { board, ...withoutBoard } = buildResult().hands[0]!
      void board
      cb({ success: true, recentHands: { computedAt: NOW, hands: [withoutBoard] } })
    })
    global.chrome = { ...global.chrome, runtime: { ...global.chrome.runtime, sendMessage } } as any
    render(<RecentHandsPanel playerId={7} />)
    const row = await screen.findByTestId('recent-hands-row')
    expect(row.querySelector('[data-testid="recent-hands-board"]')).toHaveTextContent('—')
  })
})

describe('formatBoardTooltip / formatCardsTooltip', () => {
  test('ボードはストリート境界を"|"で示す（"/"はF/T/R列の区切りなので使わない）', () => {
    expect(formatBoardTooltip(['8h', '9h', '6h'])).toBe('ボード: 8h 9h 6h')
    expect(formatBoardTooltip(['8h', '9h', '6h', '2s'])).toBe('ボード: 8h 9h 6h | 2s')
    expect(formatBoardTooltip(['8h', '9h', '6h', '2s', 'Ad'])).toBe('ボード: 8h 9h 6h | 2s | Ad')
  })

  test('空・欠損はツールチップ無し', () => {
    expect(formatBoardTooltip([])).toBeUndefined()
    expect(formatBoardTooltip(undefined)).toBeUndefined()
    expect(formatCardsTooltip(null)).toBeUndefined()
  })

  test('ホールカードは素直に並べる', () => {
    expect(formatCardsTooltip(['As', 'Ah'])).toBe('ホールカード: As Ah')
  })
})

// #356 短縮ラベルの読み下し
describe('describePreflopLabel', () => {
  test('短縮形を長い形へ読み下す', () => {
    expect(describePreflopLabel('OR')).toBe('オープンレイズ')
    expect(describePreflopLabel('3B')).toBe('3ベット')
    expect(describePreflopLabel('4B')).toBe('4ベット')
    expect(describePreflopLabel('CC')).toBe('オープンへコールドコール')
    expect(describePreflopLabel('3CC')).toBe('3ベットへコールドコール')
    expect(describePreflopLabel('L')).toBe('リンプ')
    expect(describePreflopLabel('C')).toBe('コール')
    expect(describePreflopLabel('X')).toBe('チェック')
    expect(describePreflopLabel('F')).toBe('フォールド')
    expect(describePreflopLabel('W')).toBe('ウォーク（BB不戦勝）')
  })

  test('-Fサフィックスは「後フォールド」として読み下す', () => {
    expect(describePreflopLabel('OR-F')).toBe('オープンレイズ後フォールド')
    expect(describePreflopLabel('3CC-F')).toBe('3ベットへコールドコール後フォールド')
  })

  test('未知のラベルはそのまま返す（表示を落とさない）', () => {
    expect(describePreflopLabel('???')).toBe('???')
  })
})

describe('formatStreetAction', () => {
  const sa2 = (letter: string, extra: Partial<StreetAction> = {}): StreetAction => ({
    letter, allIn: false, increment: null, potBefore: null, potPercent: null, ...extra,
  })

  test('B/Rにはポット比を付ける', () => {
    expect(formatStreetAction(sa2('B', { potPercent: 33 }))).toBe('B33')
    expect(formatStreetAction(sa2('R', { potPercent: 120 }))).toBe('R120')
  })

  test('X/C/Fには比率を付けない', () => {
    expect(formatStreetAction(sa2('X'))).toBe('X')
    expect(formatStreetAction(sa2('C'))).toBe('C')
    expect(formatStreetAction(sa2('F'))).toBe('F')
  })

  test('オールインは"!"を最後に付ける', () => {
    expect(formatStreetAction(sa2('B', { potPercent: 75, allIn: true }))).toBe('B75!')
    expect(formatStreetAction(sa2('C', { allIn: true }))).toBe('C!')
  })

  test('比率が出せなかったアグレッシブアクションは記号だけ（数字を捏造しない）', () => {
    expect(formatStreetAction(sa2('B'))).toBe('B')
  })
})

describe('formatPostflopLines', () => {
  const sa2 = (letter: string, potPercent: number | null = null): StreetAction => ({
    letter, allIn: false, increment: null, potBefore: null, potPercent,
  })

  test('3ストリート全て動いた場合は"/"で連結する', () => {
    expect(formatPostflopLines({
      flop: [sa2('X'), sa2('C')], turn: [sa2('B', 50)], river: [sa2('R', 120)],
    })).toBe('XC / B50 / R120')
  })

  test('末尾のアクション無しストリートは落とす', () => {
    expect(formatPostflopLines({ flop: [sa2('X'), sa2('C')], turn: [sa2('B', 50)], river: [] })).toBe('XC / B50')
    expect(formatPostflopLines({ flop: [sa2('F')], turn: [], river: [] })).toBe('F')
  })

  test('途中のアクション無しストリートは"-"で残す（詰めると意味が変わるため）', () => {
    expect(formatPostflopLines({ flop: [sa2('X')], turn: [], river: [sa2('B', 66)] })).toBe('X / - / B66')
    expect(formatPostflopLines({ flop: [], turn: [], river: [sa2('B', 66)] })).toBe('- / - / B66')
  })

  test('全ストリート空はnull（呼び出し側がem dashへ倒す）', () => {
    expect(formatPostflopLines({ flop: [], turn: [], river: [] })).toBeNull()
  })

  // #127方針: backgroundが古い形のまま応答してもHUDを落とさない。
  test('フィールド自体が欠けている応答でもnullへ倒す', () => {
    expect(formatPostflopLines(undefined)).toBeNull()
    expect(formatPostflopLines(null)).toBeNull()
    // 旧形式（文字列）が届いても配列として扱えないだけで落ちない。
    expect(formatPostflopLines({ flop: 'XC', turn: null, river: null } as any)).toBeNull()
  })
})

describe('formatPostflopTooltip', () => {
  const aggro = (letter: string, potPercent: number, increment: number, potBefore: number): StreetAction => ({
    letter, allIn: false, increment, potBefore, potPercent,
  })

  test('ストリートごとに実額と直前ポットを出す', () => {
    const tooltip = formatPostflopTooltip({
      flop: [aggro('B', 33, 100, 300)], turn: [], river: [aggro('R', 120, 1200, 1000)],
    })
    expect(tooltip).toContain('フロップ: B33=100（ポット300）')
    expect(tooltip).toContain('リバー: R120=1,200（ポット1,000）')
    // アクションの無いストリートの行は出さない。`ターン`単体は#357で足した
    // 凡例の文中にも現れるので、行頭の`ターン:`で判定する。
    expect(tooltip).not.toContain('ターン:')
  })

  test('実額が無くても記号の凡例だけは必ず返す（#357、ヘッダー廃止で唯一の説明）', () => {
    // #356まではこの説明が列ヘッダーの`title`にあった。ヘッダー行を廃止した
    // ので、実額の無い行でも読み方へ到達できなければならない。
    const noAmounts = formatPostflopTooltip({
      flop: [{ letter: 'X', allIn: false, increment: 0, potBefore: null, potPercent: null }],
      turn: [], river: [],
    })
    expect(noAmounts).toContain('X=チェック')
    expect(noAmounts).not.toContain('フロップ:')
    // ポストフロップそのものが無い行（引数なし）も同じ。
    expect(formatPostflopTooltip(undefined)).toContain('X=チェック')
  })

  test('実額があるときは凡例に続けて出す', () => {
    const tooltip = formatPostflopTooltip({
      flop: [aggro('B', 33, 100, 300)], turn: [], river: [],
    })
    expect(tooltip).toContain('X=チェック')
    expect(tooltip).toContain('フロップ: B33=100（ポット300）')
  })
})

describe('formatBigBlinds', () => {
  test('小数第1位で丸め、.0は落とす', () => {
    expect(formatBigBlinds(2.2)).toBe('2.2')
    expect(formatBigBlinds(9)).toBe('9')
    expect(formatBigBlinds(8.75)).toBe('8.8')
    expect(formatBigBlinds(22.04)).toBe('22')
  })
})
