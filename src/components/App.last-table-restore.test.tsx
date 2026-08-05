/**
 * App.tsx —「最後の卓の復元」(last-table-storage.ts)
 *
 * #358の保持表示（離席ミュート・保持ラインナップ）はReactのメモリ上にしか
 * 無く、拡張のリロードやブラウザ再起動で消える。その結果、対局後に相手の
 * 統計や直近ハンドを見返すことが**次のライブDEALまで一切できない**という
 * のが元の課題（sola実例, 2026-08）。ここで検証するのは:
 *
 *  1. マウント時に、保存済みラインナップがヒーロー以外の席へミュート表示で戻る
 *  2. pregameヒーロー統計（`latestStats`）と共存する（既存挙動を壊さない）
 *  3. 最初の信頼済みヒーロー着席DEALが復元席を即座に置き換える
 *  4. セッション開始境界(#361)の破棄は、復元ラインナップにも同じく効く
 *  5. 観戦DEAL(#359)は復元ラインナップを上書きしない
 *  6. 壊れた/バージョン違いの記録は復元しない（フェイルクローズ）
 *  7. 復元席からドリルダウン（直近ハンド）がそのまま引ける
 *  8. ライブのラインナップは`chrome.storage.local`へ（デバウンスして）書かれる
 *
 * Hudはモックせず本物を描画する ―― 復元の目的は「相手のHUDとドリルダウンが
 * 実際に出ること」なので、そこをスタブに置き換えると検証にならない。
 */
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiType } from '../app'
import App from './App'
import type { StatsData } from '../content_script'
import type { ApiEvent } from '../types'
import type { ChromeMessage } from '../types/messages'
import { DEFAULT_HAND_LOG_CONFIG, DEFAULT_UI_CONFIG } from '../types/hand-log'
import {
  LAST_TABLE_SNAPSHOT_SAVE_DEBOUNCE_MS,
  LAST_TABLE_SNAPSHOT_VERSION,
  cancelPendingLastTableSnapshotSave,
  parseLastTableSnapshot,
  type LastTableSnapshot,
} from '../utils/last-table-storage'

jest.mock('./HandLog', () => ({
  __esModule: true,
  default: () => <div data-testid="hand-log" />,
}))

const HERO_ID = 1

const seatSnapshot = (seatIndex: number, playerId: number, name: string, hands: number) => ({
  seatIndex,
  playerId,
  playerName: name,
  statResults: [
    { id: 'playerName', name: 'Name', value: name, formatted: name },
    { id: 'hands', name: 'HAND', value: hands, formatted: String(hands) },
    { id: 'vpip', name: 'VPIP', value: [30, 100] as [number, number], formatted: '30.0% (30/100)' },
  ],
})

const validSnapshot: LastTableSnapshot = {
  version: LAST_TABLE_SNAPSHOT_VERSION,
  savedAt: 1_700_000_000_000,
  seats: [
    seatSnapshot(1, 201, 'オポーネントA', 214),
    seatSnapshot(2, 202, 'オポーネントB', 168),
  ],
}

/**
 * 保存済みスナップショットは`storage.local`ではなくbackground経由で読む
 * （`setAccessLevel('TRUSTED_CONTEXTS')`でcontent scriptからlocalは
 * 遮断されている、#274）。ここではその`getLastTableSnapshot`応答を差し込む。
 */
let storedSnapshot: unknown

const setStoredSnapshot = (snapshot: unknown) => {
  storedSnapshot = snapshot
}

/** ゲームタブが送った`setLastTableSnapshot`の中身。 */
const writtenSnapshots = (): LastTableSnapshot[] =>
  (chrome.runtime.sendMessage as jest.Mock).mock.calls
    .filter(([message]) => message?.action === 'setLastTableSnapshot')
    .map(([message]) => message.snapshot as LastTableSnapshot)

// App.test.tsx と同じ形。`isApiEventType`のZod検証を通る必要がある
// （通らないと「信頼済み着席DEAL」とも「観戦DEAL」とも判定されず、
//  検証したい分岐にそもそも入らない）。
const makeSeatedDeal = (seatUserIds: number[]): ApiEvent<ApiType.EVT_DEAL> => ({
  ApiTypeId: ApiType.EVT_DEAL,
  timestamp: Date.now(),
  SeatUserIds: seatUserIds,
  Player: { SeatIndex: 0, BetStatus: 1, HoleCards: [], Chip: 1000, BetChip: 0 },
  OtherPlayers: seatUserIds.slice(1).flatMap((playerId, index) => playerId > 0 ? [{
    SeatIndex: index + 1, Status: 0, BetStatus: 1, Chip: 1000, BetChip: 0
  }] : []),
  Game: {
    CurrentBlindLv: 1, NextBlindUnixSeconds: 0, Ante: 0,
    SmallBlind: 10, BigBlind: 20, ButtonSeat: 0, SmallBlindSeat: 0, BigBlindSeat: 1
  },
  Progress: {
    Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 3, 4, 5],
    NextExtraLimitSeconds: 30, MinRaise: 40, Pot: 30, SidePot: []
  }
} as ApiEvent<ApiType.EVT_DEAL>)

const liveStatsFor = (playerIds: number[]): StatsData['stats'] =>
  playerIds.map(playerId => ({
    playerId,
    statResults: [
      { id: 'playerName', name: 'Name', value: `ライブ${playerId}`, formatted: `ライブ${playerId}` },
      { id: 'hands', name: 'HAND', value: 7, formatted: '7' },
    ],
  })) as StatsData['stats']

const dispatchLiveStats = (stats: StatsData['stats'], evtDeal?: ApiEvent<ApiType.EVT_DEAL>) => {
  act(() => {
    window.dispatchEvent(new CustomEvent('PokerChaseServiceEvent', {
      detail: { stats, evtDeal } as StatsData,
    }))
  })
}

describe('App —「最後の卓の復元」', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['performance'] })
    ;(global.chrome.storage.sync.get as jest.Mock).mockImplementation((_: unknown, callback: any) => {
      callback({
        handLogConfig: DEFAULT_HAND_LOG_CONFIG,
        uiConfig: DEFAULT_UI_CONFIG,
        options: { filterOptions: { statDisplayConfigs: [] } },
      })
    })
    setStoredSnapshot(validSnapshot)
    ;(global.chrome.runtime.sendMessage as jest.Mock).mockImplementation(
      (message: any, callback?: any) => {
        if (message.action === 'getDeviceUILayout') {
          callback?.({ success: true, scale: DEFAULT_UI_CONFIG.scale })
          return
        }
        if (message.action === 'getLastTableSnapshot') {
          // backgroundと同じくフェイルクローズ: 壊れた記録はsnapshotを省く。
          const snapshot = parseLastTableSnapshot(storedSnapshot)
          callback?.({ success: true, ...(snapshot ? { snapshot } : {}) })
          return
        }
        callback?.({ success: true })
      }
    )
  })

  afterEach(() => {
    cancelPendingLastTableSnapshotSave()
    jest.runOnlyPendingTimers()
    jest.useRealTimers()
    jest.clearAllMocks()
  })

  it('マウント時に保存済みラインナップをヒーロー以外の席へミュート表示で戻す', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('オポーネントA')).toBeInTheDocument()
    })
    expect(screen.getByText('オポーネントB')).toBeInTheDocument()
    // 復元席は「今この卓にいる人」ではないので、離席と同じミュート表示にする。
    expect(screen.getAllByText('離席')).toHaveLength(2)
    // 記録に無い席は従来どおり空席のまま。
    expect(screen.getAllByText('Waiting for Hand...').length).toBeGreaterThan(0)
  })

  it('pregameヒーロー統計（latestStats）が届いても復元席は残り、ヒーロー席は従来どおり', async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.getByText('オポーネントA')).toBeInTheDocument()
    })

    const messageHandler = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0]
    act(() => {
      messageHandler({
        action: 'latestStats',
        stats: [
          {
            playerId: HERO_ID,
            statResults: [
              { id: 'playerName', name: 'Name', value: 'Hero', formatted: 'Hero' },
              { id: 'hands', name: 'HAND', value: 42, formatted: '42' },
            ],
          },
          { playerId: -1 }, { playerId: -1 }, { playerId: -1 }, { playerId: -1 }, { playerId: -1 },
        ],
      } as unknown as ChromeMessage)
    })

    await waitFor(() => {
      expect(screen.getByText('Hero')).toBeInTheDocument()
    })
    // pregameフォールバックはヒーロー以外が全て空席の配列。復元席を消してはならない。
    expect(screen.getByText('オポーネントA')).toBeInTheDocument()
    expect(screen.getByText('オポーネントB')).toBeInTheDocument()
  })

  it('最初の信頼済みヒーロー着席DEALが復元席を即座に置き換える', async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.getByText('オポーネントA')).toBeInTheDocument()
    })

    dispatchLiveStats(
      liveStatsFor([HERO_ID, 301, 302, 303, 304, 305]),
      makeSeatedDeal([HERO_ID, 301, 302, 303, 304, 305])
    )

    await waitFor(() => {
      expect(screen.getByText('ライブ301')).toBeInTheDocument()
    })
    expect(screen.queryByText('オポーネントA')).not.toBeInTheDocument()
    expect(screen.queryByText('オポーネントB')).not.toBeInTheDocument()
    expect(screen.queryByText('離席')).not.toBeInTheDocument()
  })

  it('観戦DEAL（Player無し）は復元ラインナップを上書きしない', async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.getByText('オポーネントA')).toBeInTheDocument()
    })

    const spectatorDeal = makeSeatedDeal([401, 402, 403, 404, 405, 406])
    delete (spectatorDeal as { Player?: unknown }).Player
    dispatchLiveStats(liveStatsFor([401, 402, 403, 404, 405, 406]), spectatorDeal)

    expect(screen.getByText('オポーネントA')).toBeInTheDocument()
    expect(screen.queryByText('ライブ401')).not.toBeInTheDocument()
  })

  it('セッション開始境界(#361)の破棄は復元ラインナップにも効く', async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.getByText('オポーネントA')).toBeInTheDocument()
    })

    // 201（新セッション）。この時点では保持表示は消さず、次の信頼済み着席DEALで捨てる。
    act(() => {
      window.dispatchEvent(new CustomEvent('PokerChaseSessionStartEvent', {
        detail: { timestamp: Date.now() },
      }))
    })
    expect(screen.getByText('オポーネントA')).toBeInTheDocument()

    // 新しい卓はHU（2人）。復元席が残っていると空席2つを旧卓の相手で埋めてしまう。
    dispatchLiveStats(
      [
        ...liveStatsFor([HERO_ID, 501]),
        { playerId: -1 }, { playerId: -1 }, { playerId: -1 }, { playerId: -1 },
      ] as StatsData['stats'],
      makeSeatedDeal([HERO_ID, 501, -1, -1, -1, -1])
    )

    await waitFor(() => {
      expect(screen.getByText('ライブ501')).toBeInTheDocument()
    })
    expect(screen.queryByText('オポーネントA')).not.toBeInTheDocument()
    expect(screen.queryByText('オポーネントB')).not.toBeInTheDocument()
  })

  it('壊れた/バージョン違いの記録は復元しない（フェイルクローズ）', async () => {
    setStoredSnapshot({
      version: LAST_TABLE_SNAPSHOT_VERSION + 1,
      savedAt: 1,
      seats: [seatSnapshot(1, 201, 'オポーネントA', 214)],
    })

    render(<App />)
    await waitFor(() => {
      expect(screen.getAllByText('Waiting for Hand...')).toHaveLength(6)
    })
    expect(screen.queryByText('オポーネントA')).not.toBeInTheDocument()
  })

  it('復元した相手席から直近ハンドのドリルダウンがそのまま引ける', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
    render(<App />)
    await waitFor(() => {
      expect(screen.getByText('オポーネントA')).toBeInTheDocument()
    })

    const triggers = screen.getAllByTitle('直近ハンド')
    await user.click(triggers[0]!)

    await waitFor(() => {
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'getRecentHands', playerId: 201 }),
        expect.any(Function)
      )
    })
  })

  it('ライブのラインナップをデバウンスしてstorage.localへ書く（ヒーロー席は除く）', async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.getByText('オポーネントA')).toBeInTheDocument()
    })
    ;(chrome.runtime.sendMessage as jest.Mock).mockClear()

    dispatchLiveStats(
      liveStatsFor([HERO_ID, 301, 302, 303, 304, 305]),
      makeSeatedDeal([HERO_ID, 301, 302, 303, 304, 305])
    )

    // デバウンス中はまだ書かない。
    expect(writtenSnapshots()).toHaveLength(0)
    act(() => {
      jest.advanceTimersByTime(LAST_TABLE_SNAPSHOT_SAVE_DEBOUNCE_MS)
    })

    const written = writtenSnapshots()
    expect(written).toHaveLength(1)
    const snapshot = written[0]!
    expect(snapshot.version).toBe(LAST_TABLE_SNAPSHOT_VERSION)
    expect(snapshot.seats.map(seat => seat.playerId)).toEqual([301, 302, 303, 304, 305])
    expect(snapshot.seats.map(seat => seat.seatIndex)).toEqual([1, 2, 3, 4, 5])
    expect(snapshot.seats[0]!.playerName).toBe('ライブ301')
  })

  it('pregameのヒーロー単独latestStatsでは保存しない（復元した記録を自分で消さない）', async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.getByText('オポーネントA')).toBeInTheDocument()
    })
    ;(chrome.runtime.sendMessage as jest.Mock).mockClear()

    const messageHandler = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0]
    act(() => {
      messageHandler({
        action: 'latestStats',
        stats: [
          { playerId: HERO_ID, statResults: [{ id: 'hands', name: 'HAND', value: 42, formatted: '42' }] },
          { playerId: -1 }, { playerId: -1 }, { playerId: -1 }, { playerId: -1 }, { playerId: -1 },
        ],
      } as unknown as ChromeMessage)
    })
    act(() => {
      jest.advanceTimersByTime(LAST_TABLE_SNAPSHOT_SAVE_DEBOUNCE_MS * 2)
    })

    expect(writtenSnapshots()).toHaveLength(0)
  })
})
