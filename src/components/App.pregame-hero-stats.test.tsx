/**
 * App.tsx - pre-game hero stats takeover
 *
 * Covers the delivery + takeover half of the pre-game hero stats feature
 * (the fallback computation itself is tested in
 * src/background/import-export.pregame-hero-stats.test.ts):
 *
 * 1. The 'latestStats' chrome message carrying the padded 6-element
 *    fallback array (hero's real stats at index 0, {playerId:-1} sentinels
 *    for seats 1-5, see getLatestSessionStats()) renders exactly like any
 *    other stats push -- App.tsx applies no special-casing, it just calls
 *    setStats(message.stats) same as the post-import refreshStats path.
 * 2. When a real EVT_DEAL later arrives (the live pipeline, via the
 *    PokerChaseServiceEvent window CustomEvent), the hero's panel is
 *    replaced *in place* -- same DOM node, no remount/duplicate -- because
 *    App.tsx keys every seat panel by `seat-${actualSeatIndex}` (a pure
 *    function of array position, 0-5), never by playerId. Seat 0 stays
 *    seat 0 across the swap.
 */
import { render, screen, waitFor, act } from '@testing-library/react'
import { ApiType } from '../app'
import App from './App'
import type { StatsData } from '../content_script'
import { DEFAULT_HAND_LOG_CONFIG, DEFAULT_UI_CONFIG } from '../types/hand-log'
import type { ApiEvent } from '../types'
import type { ChromeMessage } from '../types/messages'

jest.mock('./Hud', () => ({
  __esModule: true,
  default: ({ actualSeatIndex, stat }: any) => (
    <div data-testid={`hud-${actualSeatIndex}`}>
      Player: {stat.playerId}
      {'statResults' in stat && stat.statResults ? ` Hands: ${stat.statResults.find((r: any) => r.id === 'hands')?.value ?? 'n/a'}` : ''}
    </div>
  ),
}))

jest.mock('./HandLog', () => ({
  __esModule: true,
  default: () => <div data-testid="hand-log" />,
}))

const HERO_ID = 1

const heroPreGameStats: StatsData['stats'] = [
  { playerId: HERO_ID, statResults: [{ id: 'hands', name: 'HAND', value: 42, formatted: '42' } as any] },
  { playerId: -1 },
  { playerId: -1 },
  { playerId: -1 },
  { playerId: -1 },
  { playerId: -1 },
]

describe('App - pre-game hero stats takeover', () => {
  beforeEach(() => {
    (global.chrome.storage.sync.get as jest.Mock).mockImplementation((_, callback) => {
      callback({
        handLogConfig: DEFAULT_HAND_LOG_CONFIG,
        uiConfig: DEFAULT_UI_CONFIG,
        options: { filterOptions: { statDisplayConfigs: [] } },
      })
    })
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('renders the hero panel from a latestStats message pre-game, seats 1-5 stay empty', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByTestId('hud-0')).toBeInTheDocument()
    })

    const messageHandler = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0]

    act(() => {
      messageHandler({ action: 'latestStats', stats: heroPreGameStats } as ChromeMessage)
    })

    await waitFor(() => {
      expect(screen.getByTestId('hud-0')).toHaveTextContent('Player: 1')
      expect(screen.getByTestId('hud-0')).toHaveTextContent('Hands: 42')
    })
    for (let i = 1; i < 6; i++) {
      expect(screen.getByTestId(`hud-${i}`)).toHaveTextContent('Player: -1')
    }
  })

  it('seamlessly takes over when a real EVT_DEAL arrives: same DOM node for the hero seat, other seats populate', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByTestId('hud-0')).toBeInTheDocument()
    })

    const messageHandler = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0]
    act(() => {
      messageHandler({ action: 'latestStats', stats: heroPreGameStats } as ChromeMessage)
    })
    await waitFor(() => {
      expect(screen.getByTestId('hud-0')).toHaveTextContent('Player: 1')
    })

    const heroNodeBefore = screen.getByTestId('hud-0')

    // Hero (playerId 1) is dealt into seat index 2 this hand -- SeatUserIds
    // is index-parallel with the live `stats` array the real pipeline sends.
    const liveStats: StatsData['stats'] = [
      { playerId: 3, statResults: [] },
      { playerId: 4, statResults: [] },
      { playerId: HERO_ID, statResults: [{ id: 'hands', name: 'HAND', value: 43, formatted: '43' } as any] },
      { playerId: 5, statResults: [] },
      { playerId: 6, statResults: [] },
      { playerId: 2, statResults: [] },
    ]
    const evtDeal = {
      ApiTypeId: ApiType.EVT_DEAL as const,
      Player: { SeatIndex: 2, BetStatus: 1, HoleCards: [], Chip: 1000, BetChip: 0 },
      SeatUserIds: [3, 4, HERO_ID, 5, 6, 2],
      Game: {
        CurrentBlindLv: 1, NextBlindUnixSeconds: 0, Ante: 0,
        SmallBlind: 50, BigBlind: 100, ButtonSeat: 0, SmallBlindSeat: 1, BigBlindSeat: 2
      },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
        { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
        { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
        { SeatIndex: 4, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
        { SeatIndex: 5, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
      ],
      Progress: { Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 0, SidePot: [] },
      timestamp: Date.now(),
    } as ApiEvent<ApiType.EVT_DEAL>

    act(() => {
      const event = new CustomEvent('PokerChaseServiceEvent', {
        detail: { stats: liveStats, evtDeal } as StatsData,
      })
      window.dispatchEvent(event)
    })

    await waitFor(() => {
      expect(screen.getByTestId('hud-0')).toHaveTextContent('Hands: 43')
    })

    // Rotated so hero (dealt at seat 2) lands back at seat-0.
    expect(screen.getByTestId('hud-0')).toHaveTextContent('Player: 1')
    // Seats that were empty pre-game now show the real dealt-in players.
    expect(screen.getByTestId('hud-1')).toHaveTextContent('Player: 5')
    expect(screen.getByTestId('hud-2')).toHaveTextContent('Player: 6')
    expect(screen.getByTestId('hud-3')).toHaveTextContent('Player: 2')
    expect(screen.getByTestId('hud-4')).toHaveTextContent('Player: 3')
    expect(screen.getByTestId('hud-5')).toHaveTextContent('Player: 4')

    // No duplicate hero panel was created -- same seat-0 key, same DOM node,
    // just updated content (this is what "seamless takeover" means: no
    // unmount/remount flicker).
    expect(screen.getByTestId('hud-0')).toBe(heroNodeBefore)
  })
})
