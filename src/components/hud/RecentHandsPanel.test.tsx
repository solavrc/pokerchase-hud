import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  RecentHandsPanel,
  formatBigBlinds,
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
  DEFAULT_RECENT_HANDS_PARTICIPATION_ONLY,
  RECENT_HANDS_LIMIT_OPTIONS,
  RECENT_HANDS_LIMIT_STORAGE_KEY,
  RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY,
} from '../../utils/recent-hands-config'

const NOW = 1_700_000_000_000

/** StreetAction fixture helper. */
const sa = (letter: string, extra: Partial<StreetAction> = {}): StreetAction => ({
  letter, allIn: false, increment: null, potBefore: null, potPercent: null, ...extra,
})

const buildResult = (overrides: Partial<RecentHandsResult> = {}): RecentHandsResult => ({
  computedAt: NOW,
  hands: [
    { handId: 3, approxTimestamp: NOW - 3 * 60_000, bigBlind: 200, position: Position.BTN, holeCards: ['As', 'Ah'], holeCardsSource: 'results', preflopLine: 'Open', preflopRaiseToBB: 2.2, preflopRaiseToChips: 440, postflopLines: { flop: [sa('X'), sa('C')], turn: [sa('B', { potPercent: 75, allIn: true, increment: 900, potBefore: 1200 })], river: [] }, sawFlop: true, wentToShowdown: true, won: true, netChips: 1240 },
    { handId: 2, approxTimestamp: NOW - 2 * 3600_000, bigBlind: 200, position: Position.BB, holeCards: null, holeCardsSource: null, preflopLine: 'Check', preflopRaiseToBB: null, preflopRaiseToChips: null, postflopLines: { flop: [sa('X')], turn: [], river: [sa('F')] }, sawFlop: true, wentToShowdown: false, won: false, netChips: -640 },
    { handId: 1, approxTimestamp: NOW - 26 * 3600_000, bigBlind: 200, position: null, holeCards: null, holeCardsSource: null, preflopLine: 'Fold', preflopRaiseToBB: null, preflopRaiseToChips: null, postflopLines: { flop: [], turn: [], river: [] }, sawFlop: false, wentToShowdown: false, won: false, netChips: 0 },
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
    mockSendMessage.mockImplementation(() => {})

    render(<RecentHandsPanel playerId={999} />)

    const panel = screen.getByRole('region', { name: 'Player 999の直近ハンド' })
    expect(panel).toHaveAttribute('id', 'recent-hands-panel-999')
    expect(panel).toHaveAttribute('data-player-id', '999')
    // 保存済み件数の解決（非同期）が終わってからテストを抜ける。
    await waitFor(() => expect(mockSendMessage).toHaveBeenCalled())
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
    // handId=3: 公開
    expect(rows[0]!.querySelector('[data-testid="recent-hands-cards"]')).toHaveTextContent('As')
    expect(rows[0]!.querySelector('[data-testid="recent-hands-cards"]')).toHaveTextContent('Ah')
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
    expect(rows[0]).toHaveTextContent('●')
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
    expect(screen.getByText('損益(BB)')).toBeInTheDocument()
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
    expect(rows[0]!.querySelector('[data-testid="recent-hands-preflop"]')).toHaveTextContent('Open2.2')
    expect(rows[0]!.querySelector('[data-testid="recent-hands-preflop"]'))
      .toHaveAttribute('title', expect.stringContaining('440') as any)
    expect(rows[0]).toHaveTextContent('BTN')
    expect(rows[2]).toHaveTextContent('Fold')
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
    mockSendMessage.mockImplementation(() => {})

    render(<RecentHandsPanel playerId={123} />)

    expect(screen.getByText('Loading hands…')).toBeInTheDocument()

    // 保存済み件数（chrome.storage.local）の解決を待ってから時計を進める。
    // 解決前はフェッチ自体が始まらないので、タイムアウトタイマーもまだ無い。
    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled()
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
    expect(mockSendMessage).toHaveBeenCalledTimes(1)

    rerender(<RecentHandsPanel playerId={2} />)

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledTimes(2)
    })
    expect(mockSendMessage).toHaveBeenLastCalledWith(
      { action: 'getRecentHands', playerId: 2, limit: DEFAULT_RECENT_HANDS_LIMIT, participationOnly: DEFAULT_RECENT_HANDS_PARTICIPATION_ONLY },
      expect.any(Function)
    )
  })

  // 監査指摘11（P2）「開いたドリルダウンパネルが無期限に古くなる」対応:
  // playerIdが同じままでもhandEpochが変わればフェッチeffectを再発火する。
  it('playerIdが同じでもhandEpochが変わると再フェッチする(監査指摘11)', async () => {
    let callCount = 0
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      callCount++
      // 2回目の応答は1回目と区別できるよう新しいハンドを1件追加する
      // （新しいハンドが完了して初めて反映されるべきデータ）
      const result = callCount === 2
        ? buildResult({ hands: [{ handId: 4, approxTimestamp: NOW, bigBlind: 200, position: Position.CO, holeCards: null, holeCardsSource: null, preflopLine: 'Open', preflopRaiseToBB: 2.2, preflopRaiseToChips: 440, postflopLines: { flop: [], turn: [], river: [] }, sawFlop: false, wentToShowdown: false, won: false, netChips: null }, ...buildResult().hands] })
        : buildResult()
      callback({ success: true, recentHands: result })
    })

    const { rerender } = render(<RecentHandsPanel playerId={1} handEpoch={1} />)
    await waitFor(() => {
      expect(screen.getAllByTestId('recent-hands-row')).toHaveLength(3)
    })
    expect(mockSendMessage).toHaveBeenCalledTimes(1)

    // 実況の1アクションごとの更新はhandEpochを変えない想定 -- 同じepochでの
    // 再レンダーは再フェッチを引き起こさない。
    rerender(<RecentHandsPanel playerId={1} handEpoch={1} />)
    expect(mockSendMessage).toHaveBeenCalledTimes(1)

    // ハンドが1件完了してhandEpochが増える
    rerender(<RecentHandsPanel playerId={1} handEpoch={2} />)

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledTimes(2)
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
      expect(rows[0]!.querySelector('[data-testid="recent-hands-streets"]')).toHaveTextContent('XC/B75!')
      // 実額は列を増やさずツールチップへ（#354）。
      expect(rows[0]!.querySelector('[data-testid="recent-hands-streets"]'))
        .toHaveAttribute('title', expect.stringContaining('B75!=900（ポット1,200）') as any)
      // flop='X', turn=なし, river='F' -> 途中の空ストリートは'-'で残す
      expect(rows[1]!.querySelector('[data-testid="recent-hands-streets"]')).toHaveTextContent('X/-/F')
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

    it('件数を変えると新しいlimitで再フェッチし、選択を端末ローカルへ保存する', async () => {
      const user = userEvent.setup()
      render(<RecentHandsPanel playerId={123} />)

      await screen.findAllByTestId('recent-hands-row')
      expect(mockSendMessage).toHaveBeenCalledTimes(1)

      await user.click(screen.getByRole('button', { name: '直近100ハンドを表示' }))

      await waitFor(() => {
        expect(mockSendMessage).toHaveBeenLastCalledWith(
          { action: 'getRecentHands', playerId: 123, limit: 100, participationOnly: DEFAULT_RECENT_HANDS_PARTICIPATION_ONLY },
          expect.any(Function)
        )
      })
      expect(chrome.storage.local.set).toHaveBeenCalledWith({ [RECENT_HANDS_LIMIT_STORAGE_KEY]: 100 })
    })

    it('保存済みの件数があればそれで最初のフェッチを行う（既定値での二度手間フェッチをしない）', async () => {
      await chrome.storage.local.set({ [RECENT_HANDS_LIMIT_STORAGE_KEY]: 50 })
      mockSendMessage.mockClear()

      render(<RecentHandsPanel playerId={123} />)

      await screen.findAllByTestId('recent-hands-row')
      expect(mockSendMessage).toHaveBeenCalledTimes(1)
      expect(mockSendMessage).toHaveBeenCalledWith(
        { action: 'getRecentHands', playerId: 123, limit: 50, participationOnly: DEFAULT_RECENT_HANDS_PARTICIPATION_ONLY },
        expect.any(Function)
      )
      await chrome.storage.local.remove(RECENT_HANDS_LIMIT_STORAGE_KEY)
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

    it('OFFにするとparticipationOnly: falseで再フェッチし、選択を端末ローカルへ保存する', async () => {
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
      expect(chrome.storage.local.set).toHaveBeenCalledWith({ [RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY]: false })
      expect(screen.getByRole('button', { name: '参加のみ表示' })).toHaveAttribute('aria-pressed', 'false')
      await chrome.storage.local.remove(RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY)
    })

    // codexレビュー指摘（P3）: 自分の書き込みが起こすstorage通知で、同じ条件の
    // フェッチが二度走らないこと。
    it('トグル操作は1回しか再フェッチしない（storage通知の反響で二重に走らない）', async () => {
      const user = userEvent.setup()
      render(<RecentHandsPanel playerId={123} />)

      await screen.findAllByTestId('recent-hands-row')
      expect(mockSendMessage).toHaveBeenCalledTimes(1)

      await user.click(screen.getByRole('button', { name: '参加のみ表示' }))

      await waitFor(() => {
        expect(mockSendMessage).toHaveBeenLastCalledWith(
          expect.objectContaining({ participationOnly: false }),
          expect.any(Function)
        )
      })
      // 1回目（初回）＋2回目（トグル）だけ。storage通知による3回目は起きない。
      expect(mockSendMessage).toHaveBeenCalledTimes(2)
      await chrome.storage.local.remove(RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY)
    })

    it('保存済みのOFFがあればそれで最初のフェッチを行う', async () => {
      await chrome.storage.local.set({ [RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY]: false })
      mockSendMessage.mockClear()

      render(<RecentHandsPanel playerId={123} />)

      await screen.findAllByTestId('recent-hands-row')
      expect(mockSendMessage).toHaveBeenCalledTimes(1)
      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ participationOnly: false }),
        expect.any(Function)
      )
      await chrome.storage.local.remove(RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY)
    })

    it('OFFのときの0件は「参加のみ」由来ではないので従来の文言を出す', async () => {
      await chrome.storage.local.set({ [RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY]: false })
      mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
        callback({ success: true, recentHands: buildResult({ hands: [] }) })
      })

      render(<RecentHandsPanel playerId={123} />)

      await waitFor(() => {
        expect(screen.getByText('No hands yet')).toBeInTheDocument()
      })
      await chrome.storage.local.remove(RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY)
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
    expect(row.querySelector('td:last-child')).not.toHaveAttribute('title')
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
            preflopLine: 'ColdCall', preflopRaiseToBB: null, preflopRaiseToChips: null, postflopLines: { flop: [sa('F')], turn: [], river: [] },
            sawFlop: true, wentToShowdown: false, won: false, netChips: -420,
          }],
        }),
      })
    })

    render(<RecentHandsPanel playerId={123} />)

    const row = await screen.findByTestId('recent-hands-row')
    const cards = row.querySelector('[data-testid="recent-hands-cards"]')
    expect(cards).toHaveTextContent('Jh')
    expect(cards).toHaveTextContent('Ac')
    expect(cards).not.toHaveTextContent('—')
  })
})

describe('formatNetBigBlinds', () => {
  const entry = (netChips: number | null, bigBlind: number | null) => ({
    handId: 1, approxTimestamp: null, bigBlind, position: null, holeCards: null,
    holeCardsSource: null, preflopLine: null,
    preflopRaiseToBB: null, preflopRaiseToChips: null,
    postflopLines: { flop: [], turn: [], river: [] },
    sawFlop: false, wentToShowdown: false, won: false, netChips,
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
  const entry = (preflopLine: string | null, preflopRaiseToBB: number | null) => ({
    handId: 1, approxTimestamp: null, bigBlind: 200, position: null, holeCards: null,
    holeCardsSource: null, preflopLine, preflopRaiseToBB, preflopRaiseToChips: 440,
    postflopLines: { flop: [], turn: [], river: [] },
    sawFlop: false, wentToShowdown: false, won: false, netChips: null,
  })

  test('OpenはBB倍数を小数第1位で付ける', () => {
    expect(formatPreflopLine(entry('Open', 2.2))).toBe('Open2.2')
    // 丸めて整数になる場合は`.0`を落とす（表記規則は全ラベル共通）。
    expect(formatPreflopLine(entry('Open', 3))).toBe('Open3')
  })

  test('3Bet以上はレイズto額をBBで付ける', () => {
    expect(formatPreflopLine(entry('3Bet', 9))).toBe('3Bet9')
    expect(formatPreflopLine(entry('4Bet', 22))).toBe('4Bet22')
    // 10未満で端数があるときは小数を残す（意味が消えないように）。
    expect(formatPreflopLine(entry('3Bet', 8.75))).toBe('3Bet8.8')
  })

  test('-Fサフィックスは数字の後ろへ回す', () => {
    expect(formatPreflopLine(entry('Open-F', 2.2))).toBe('Open2.2-F')
    expect(formatPreflopLine(entry('3Bet-F', 9))).toBe('3Bet9-F')
  })

  test('アグレッシブでないラベルには数字を付けない', () => {
    for (const line of ['ColdCall', 'Limp', 'Call', 'Check', 'Fold', 'Walk', 'ColdCall-F', 'Check-F']) {
      expect(formatPreflopLine(entry(line, 9))).toBe(line)
    }
  })

  test('レイズto額が無ければラベルだけ（ショートオールイン・bigBlind不能）', () => {
    // サービス側がショートオールイン（実質コール）と`bigBlind`不能を
    // どちらもnullにして寄越す。表示側は数字を捏造しない。
    expect(formatPreflopLine(entry('3Bet', null))).toBe('3Bet')
    expect(formatPreflopLine(entry('Open-F', null))).toBe('Open-F')
    expect(formatPreflopLine(entry('Open', 0))).toBe('Open')
    expect(formatPreflopLine(entry('Open', Number.NaN))).toBe('Open')
    expect(formatPreflopLine({ ...entry('Open', 2.2), preflopRaiseToBB: undefined } as any)).toBe('Open')
  })

  test('ラインそのものが無ければem dash', () => {
    expect(formatPreflopLine(entry(null, 2.2))).toBe('—')
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
    })).toBe('XC/B50/R120')
  })

  test('末尾のアクション無しストリートは落とす', () => {
    expect(formatPostflopLines({ flop: [sa2('X'), sa2('C')], turn: [sa2('B', 50)], river: [] })).toBe('XC/B50')
    expect(formatPostflopLines({ flop: [sa2('F')], turn: [], river: [] })).toBe('F')
  })

  test('途中のアクション無しストリートは"-"で残す（詰めると意味が変わるため）', () => {
    expect(formatPostflopLines({ flop: [sa2('X')], turn: [], river: [sa2('B', 66)] })).toBe('X/-/B66')
    expect(formatPostflopLines({ flop: [], turn: [], river: [sa2('B', 66)] })).toBe('-/-/B66')
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
    expect(tooltip).not.toContain('ターン')
  })

  test('実額の無いアクションだけならツールチップを出さない', () => {
    expect(formatPostflopTooltip({
      flop: [{ letter: 'X', allIn: false, increment: 0, potBefore: null, potPercent: null }],
      turn: [], river: [],
    })).toBeUndefined()
    expect(formatPostflopTooltip(undefined)).toBeUndefined()
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
