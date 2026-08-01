import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RecentHandsPanel, formatRelativeTime, formatPostflopLines } from './RecentHandsPanel'
import { Position } from '../../types/game'
import type { RecentHandsResult } from '../../types/stats'
import {
  DEFAULT_RECENT_HANDS_LIMIT,
  RECENT_HANDS_LIMIT_OPTIONS,
  RECENT_HANDS_LIMIT_STORAGE_KEY,
} from '../../utils/recent-hands-config'

const NOW = 1_700_000_000_000

const buildResult = (overrides: Partial<RecentHandsResult> = {}): RecentHandsResult => ({
  computedAt: NOW,
  hands: [
    { handId: 3, approxTimestamp: NOW - 3 * 60_000, position: Position.BTN, holeCards: ['As', 'Ah'], holeCardsSource: 'results', preflopLine: 'Open', postflopLines: { flop: 'XC', turn: 'B!', river: null }, sawFlop: true, wentToShowdown: true, won: true, netChips: 1240 },
    { handId: 2, approxTimestamp: NOW - 2 * 3600_000, position: Position.BB, holeCards: null, holeCardsSource: null, preflopLine: 'Check', postflopLines: { flop: 'X', turn: null, river: 'F' }, sawFlop: true, wentToShowdown: false, won: false, netChips: -640 },
    { handId: 1, approxTimestamp: NOW - 26 * 3600_000, position: null, holeCards: null, holeCardsSource: null, preflopLine: 'Fold', postflopLines: { flop: null, turn: null, river: null }, sawFlop: false, wentToShowdown: false, won: false, netChips: 0 },
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
        { action: 'getRecentHands', playerId: 999, limit: DEFAULT_RECENT_HANDS_LIMIT },
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
    // 1行目はhandId=3（won行）
    expect(rows[0]).toHaveTextContent('+1,240')
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
    // handId=2, 1: 非公開
    expect(rows[1]!.querySelector('[data-testid="recent-hands-cards"]')).toHaveTextContent('—')
    expect(rows[2]!.querySelector('[data-testid="recent-hands-cards"]')).toHaveTextContent('—')
  })

  it('signed netを +N / -N / 0 で表示し、正負を色分けする', async () => {
    mockSendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      callback({ success: true, recentHands: buildResult() })
    })

    render(<RecentHandsPanel playerId={123} />)

    const rows = await screen.findAllByTestId('recent-hands-row')
    expect(rows[0]).toHaveTextContent('+1,240')
    expect(rows[0]).toHaveTextContent('●')
    expect(rows[1]).not.toHaveTextContent('●')
    expect(rows[1]).toHaveTextContent('-640')
    expect(rows[1]!.querySelector('td:last-child span')).toHaveStyle({ color: '#ff6b6b' })
    expect(rows[2]).toHaveTextContent('0')
    expect(rows[2]!.querySelector('td:last-child span')).toHaveStyle({ color: '#b8b8b8' })
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

    await waitFor(() => {
      expect(screen.getByText('No hands yet')).toBeInTheDocument()
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
      { action: 'getRecentHands', playerId: 2, limit: DEFAULT_RECENT_HANDS_LIMIT },
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
        ? buildResult({ hands: [{ handId: 4, approxTimestamp: NOW, position: Position.CO, holeCards: null, holeCardsSource: null, preflopLine: 'Open', postflopLines: { flop: null, turn: null, river: null }, sawFlop: false, wentToShowdown: false, won: false, netChips: null }, ...buildResult().hands] })
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
          { action: 'getRecentHands', playerId: 123, limit: 100 },
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
        { action: 'getRecentHands', playerId: 123, limit: 50 },
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

describe('formatRelativeTime', () => {
  test('直近1分未満は"now"', () => {
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe('now')
  })

  test('分単位（1分〜59分）', () => {
    expect(formatRelativeTime(NOW - 3 * 60_000, NOW)).toBe('3m')
    expect(formatRelativeTime(NOW - 59 * 60_000, NOW)).toBe('59m')
  })

  test('時間単位（1時間〜23時間）', () => {
    expect(formatRelativeTime(NOW - 2 * 3600_000, NOW)).toBe('2h')
    expect(formatRelativeTime(NOW - 23 * 3600_000, NOW)).toBe('23h')
  })

  test('24〜48時間は"昨日"', () => {
    expect(formatRelativeTime(NOW - 25 * 3600_000, NOW)).toBe('昨日')
    expect(formatRelativeTime(NOW - 47 * 3600_000, NOW)).toBe('昨日')
  })

  test('48時間以降は日数', () => {
    expect(formatRelativeTime(NOW - 5 * 24 * 3600_000, NOW)).toBe('5d')
  })

  test('nullは"—"', () => {
    expect(formatRelativeTime(null, NOW)).toBe('—')
  })
})
