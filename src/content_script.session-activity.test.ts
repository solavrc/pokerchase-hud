/**
 * content_script.ts - keepalive session-activity trigger set
 *
 * Mirrors event-ingestion.ts's expanded ACTIVE trigger set (release-blocker
 * audit finding B): EVT_SESSION_DETAILS (308) alone is not a reliable
 * "game started" signal -- docs/api-events.md:99 documents its absence as a
 * normal variant (an observation gap in the capture), so a new game can
 * legitimately start 201 (EVT_ENTRY_QUEUED)/303 (EVT_DEAL)-first with no 308
 * at all. Before this fix, content_script's keepalive gate (`isGameActive`)
 * only armed on 308, so that (normal) scenario left keepalive never
 * starting, silently increasing the risk of the Service Worker suspending
 * mid-game (no keepalive pings to keep the port/SW alive).
 *
 * Only EVT_SESSION_RESULTS (309) may disarm it again -- the tri-state stays
 * conservative (inactive only on an explicit session-end signal).
 */
import { ApiType } from './types'
import { POKER_CHASE_ORIGIN } from './constants/runtime'

const KEEPALIVE_INTERVAL_MS = 25000

describe('content_script keepalive (session-activity triggers)', () => {
  let mockPort: any

  const dispatchGameMessage = (data: unknown) => {
    window.dispatchEvent(new MessageEvent('message', { data, origin: POKER_CHASE_ORIGIN, source: window }))
  }

  beforeAll(async () => {
    mockPort = {
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn() },
      postMessage: jest.fn(),
      disconnect: jest.fn()
    }
    ;(chrome.runtime as any).connect = jest.fn(() => mockPort)
    jest.useFakeTimers()
    // content_script.ts registers its window/document listeners and connects
    // its port as *import-time* side effects (no exported init function), so
    // importing it once here is the only way to exercise this file -- see
    // module docblock above for why every test in this suite shares that one
    // import instead of re-importing per test.
    await import('./content_script')
  })

  afterAll(() => {
    jest.useRealTimers()
  })

  beforeEach(() => {
    // Force a known baseline (session inactive, keepalive stopped) before
    // each test without re-importing the module.
    dispatchGameMessage({ ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 0 })
    mockPort.postMessage.mockClear()
  })

  test('EVT_ENTRY_QUEUED (201) alone starts keepalive without a prior 308', () => {
    dispatchGameMessage({ ApiTypeId: ApiType.EVT_ENTRY_QUEUED, timestamp: 1 })

    jest.advanceTimersByTime(KEEPALIVE_INTERVAL_MS)

    expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'keepalive' })
  })

  test('EVT_DEAL (303) alone starts keepalive without a prior 308', () => {
    dispatchGameMessage({ ApiTypeId: ApiType.EVT_DEAL, timestamp: 2 })

    jest.advanceTimersByTime(KEEPALIVE_INTERVAL_MS)

    expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'keepalive' })
  })

  test('raw sequence 309 -> 201 -> 303 (no intervening 308) keeps keepalive armed (release-blocker audit exact scenario)', () => {
    // beforeEach already sent a 309 baseline; repeat explicitly so the
    // scenario reads standalone.
    dispatchGameMessage({ ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 3 })
    mockPort.postMessage.mockClear()

    dispatchGameMessage({ ApiTypeId: ApiType.EVT_ENTRY_QUEUED, timestamp: 4 })
    dispatchGameMessage({ ApiTypeId: ApiType.EVT_DEAL, timestamp: 5 })

    jest.advanceTimersByTime(KEEPALIVE_INTERVAL_MS)

    expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'keepalive' })
  })

  test('EVT_SESSION_RESULTS (309) stops keepalive', () => {
    dispatchGameMessage({ ApiTypeId: ApiType.EVT_ENTRY_QUEUED, timestamp: 6 })
    dispatchGameMessage({ ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 7 })
    mockPort.postMessage.mockClear()

    jest.advanceTimersByTime(KEEPALIVE_INTERVAL_MS * 2)

    expect(mockPort.postMessage).not.toHaveBeenCalled()
  })
})
