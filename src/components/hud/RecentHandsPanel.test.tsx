import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RecentHandsPanel, formatNetBigBlinds, formatPostflopLines } from './RecentHandsPanel'
import { Position } from '../../types/game'
import { SUIT_COLORS } from '../../utils/card-utils'
import type { RecentHandsResult } from '../../types/stats'
import {
  DEFAULT_RECENT_HANDS_LIMIT,
  DEFAULT_RECENT_HANDS_PARTICIPATION_ONLY,
  RECENT_HANDS_LIMIT_OPTIONS,
  RECENT_HANDS_LIMIT_STORAGE_KEY,
  RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY,
} from '../../utils/recent-hands-config'

const NOW = 1_700_000_000_000

const buildResult = (overrides: Partial<RecentHandsResult> = {}): RecentHandsResult => ({
  computedAt: NOW,
  hands: [
    { handId: 3, approxTimestamp: NOW - 3 * 60_000, bigBlind: 200, position: Position.BTN, holeCards: ['As', 'Ah'], holeCardsSource: 'results', preflopLine: 'Open', postflopLines: { flop: 'XC', turn: 'B!', river: null }, sawFlop: true, wentToShowdown: true, won: true, netChips: 1240 },
    { handId: 2, approxTimestamp: NOW - 2 * 3600_000, bigBlind: 200, position: Position.BB, holeCards: null, holeCardsSource: null, preflopLine: 'Check', postflopLines: { flop: 'X', turn: null, river: 'F' }, sawFlop: true, wentToShowdown: false, won: false, netChips: -640 },
    { handId: 1, approxTimestamp: NOW - 26 * 3600_000, bigBlind: 200, position: null, holeCards: null, holeCardsSource: null, preflopLine: 'Fold', postflopLines: { flop: null, turn: null, river: null }, sawFlop: false, wentToShowdown: false, won: false, netChips: 0 },
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
    expect(rows[0]).toHaveTextContent('Open')
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
        ? buildResult({ hands: [{ handId: 4, approxTimestamp: NOW, bigBlind: 200, position: Position.CO, holeCards: null, holeCardsSource: null, preflopLine: 'Open', postflopLines: { flop: null, turn: null, river: null }, sawFlop: false, wentToShowdown: false, won: false, netChips: null }, ...buildResult().hands] })
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
      // flop='XC', turn='B!', river=null -> 末尾の空ストリートは落とす
      expect(rows[0]!.querySelector('[data-testid="recent-hands-streets"]')).toHaveTextContent('XC/B!')
      // flop='X', turn=null, river='F' -> 途中の空ストリートは'-'で残す
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

  // #353: ヒーロー自身の配札カードは source='dealt' で届く
  it("ショーダウン以外でも自分の配札カード（source='dealt'）を表示する", async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      callback({
        success: true,
        recentHands: buildResult({
          hands: [{
            handId: 9, approxTimestamp: NOW, bigBlind: 200, position: Position.CO,
            holeCards: ['Jh', 'Ac'], holeCardsSource: 'dealt',
            preflopLine: 'ColdCall', postflopLines: { flop: 'F', turn: null, river: null },
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
    postflopLines: { flop: null, turn: null, river: null },
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
})

describe('formatPostflopLines', () => {
  test('3ストリート全て動いた場合は"/"で連結する', () => {
    expect(formatPostflopLines({ flop: 'XC', turn: 'B', river: 'R!' })).toBe('XC/B/R!')
  })

  test('末尾のアクション無しストリートは落とす', () => {
    expect(formatPostflopLines({ flop: 'XC', turn: 'B', river: null })).toBe('XC/B')
    expect(formatPostflopLines({ flop: 'F', turn: null, river: null })).toBe('F')
  })

  test('途中のアクション無しストリートは"-"で残す（詰めると意味が変わるため）', () => {
    expect(formatPostflopLines({ flop: 'X', turn: null, river: 'B' })).toBe('X/-/B')
    expect(formatPostflopLines({ flop: null, turn: null, river: 'B' })).toBe('-/-/B')
  })

  test('全ストリート空はnull（呼び出し側がem dashへ倒す）', () => {
    expect(formatPostflopLines({ flop: null, turn: null, river: null })).toBeNull()
  })

  // #127方針: backgroundが古い形のまま応答してもHUDを落とさない。
  test('フィールド自体が欠けている応答でもnullへ倒す', () => {
    expect(formatPostflopLines(undefined)).toBeNull()
    expect(formatPostflopLines(null)).toBeNull()
  })
})

