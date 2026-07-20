/**
 * App.tsx - pre-mount 'latestStats' delivery race
 *
 * Regression test for a P2 review finding on PR #158 (pre-game hero stats):
 * on a warm Service Worker with a small local DB, the pre-game hero stats
 * fallback (`requestLatestStats` with `preGame: true`, sent right after
 * `createRoot(...).render(...)` in content_script.ts's mountApp()) can
 * resolve and be dispatched as a `POKER_CHASE_SERVICE_EVENT` window
 * CustomEvent before App's mount effect has registered its listener for it
 * (React flushes effects asynchronously after the initial commit). Without a
 * fix, that dispatch has no listener yet and is lost -- the HUD stays on
 * "Waiting for Hand..." until the next live stats broadcast.
 *
 * content_script.ts now caches every 'latestStats' delivery via
 * pending-stats-cache.ts (setPendingStats), and App's mount effect consumes
 * it (consumePendingStats) right after registering its window listener. This
 * test simulates the race directly at that cache boundary: it populates the
 * cache *before* rendering App (standing in for "delivered before the
 * listener existed") and asserts the hero panel is showing pre-game data
 * immediately, with no window event dispatched after mount.
 */
import { render, screen, waitFor } from '@testing-library/react'
import App from './App'
import { setPendingStats, consumePendingStats } from '../utils/pending-stats-cache'
import type { StatsData } from '../content_script'
import { DEFAULT_HAND_LOG_CONFIG, DEFAULT_UI_CONFIG } from '../types/hand-log'

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
  { playerId: HERO_ID, statResults: [{ id: 'hands', name: 'HAND', value: 7, formatted: '7' } as any] },
  { playerId: -1 },
  { playerId: -1 },
  { playerId: -1 },
  { playerId: -1 },
  { playerId: -1 },
]

describe('App - pre-mount latestStats delivery race', () => {
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
    consumePendingStats() // drain any leftover cache entry so tests can't bleed into each other
  })

  test('a latestStats delivery cached before mount is rendered immediately, no post-mount event needed', async () => {
    // Stand-in for "content_script.ts's chrome.runtime.onMessage listener
    // received and dispatched this before App's mount effect had registered
    // its window listener" -- the dispatch itself is unobservable after the
    // fact, but the cache write it makes (setPendingStats) is exactly what
    // survives that gap.
    setPendingStats({ stats: heroPreGameStats })

    render(<App />)

    await waitFor(() => {
      expect(screen.getByTestId('hud-0')).toHaveTextContent('Player: 1')
      expect(screen.getByTestId('hud-0')).toHaveTextContent('Hands: 7')
    })
    for (let i = 1; i < 6; i++) {
      expect(screen.getByTestId(`hud-${i}`)).toHaveTextContent('Player: -1')
    }
  })

  test('mounting with nothing cached still renders the empty-seats default (no crash, no stale replay)', async () => {
    expect(consumePendingStats()).toBeUndefined() // sanity: cache starts empty

    render(<App />)

    await waitFor(() => {
      expect(screen.getByTestId('hud-0')).toBeInTheDocument()
    })
    for (let i = 0; i < 6; i++) {
      expect(screen.getByTestId(`hud-${i}`)).toHaveTextContent('Player: -1')
    }
  })

  test('the cache is consumed (cleared) on mount -- a second App instance does not replay a stale delivery', async () => {
    setPendingStats({ stats: heroPreGameStats })

    const first = render(<App />)
    await waitFor(() => {
      expect(screen.getByTestId('hud-0')).toHaveTextContent('Player: 1')
    })
    first.unmount()

    render(<App />)
    await waitFor(() => {
      expect(screen.getByTestId('hud-0')).toBeInTheDocument()
    })
    // Nothing left in the cache for this second mount -- stays on the empty default.
    expect(screen.getByTestId('hud-0')).toHaveTextContent('Player: -1')
  })
})
