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
 *
 * EVT_DEAL is further gated on the raw `Player` field's presence (P2, codex
 * review 2026-07-21): docs/api-events.md "EVT_DEAL: Playerフィールドの欠落"
 * documents spectator-mode deals (hero not seated, e.g. after busting out
 * but the client keeps receiving another table) as having no `Player` field
 * at all. Arming keepalive on those would keep it running through a
 * spectated session that may never see another 309.
 *
 * ApiTypeId 203 (参加取消申込, entry cancellation -- see src/types/api.ts)
 * also disarms keepalive, alongside 309 (P2, codex review 2026-07-20
 * pass-3): entering matchmaking (201) and cancelling before any hand starts
 * never produces a 309, so 203 is the only signal that the pending
 * entry -- and the keepalive it armed -- is moot.
 */
import { ApiType } from './types'
import {
  POKER_CHASE_INVALID_API_EVENT,
  POKER_CHASE_ORIGIN,
  POKER_CHASE_SESSION_START_EVENT
} from './constants/runtime'

const KEEPALIVE_INTERVAL_MS = 25000

describe('content_script keepalive (session-activity triggers)', () => {
  let mockPort: any
  let receiveBackgroundMessage: (message: unknown) => void

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
    receiveBackgroundMessage = mockPort.onMessage.addListener.mock.calls[0][0]
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

  test('EVT_ENTRY_QUEUED (201) starts keepalive, but only background notification creates the UI boundary', () => {
    const sessionStart = jest.fn()
    window.addEventListener(POKER_CHASE_SESSION_START_EVENT, sessionStart)
    dispatchGameMessage({ ApiTypeId: ApiType.EVT_ENTRY_QUEUED, timestamp: 1 })

    jest.advanceTimersByTime(KEEPALIVE_INTERVAL_MS)

    expect(sessionStart).not.toHaveBeenCalled()
    expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'keepalive' })
    receiveBackgroundMessage({ type: POKER_CHASE_SESSION_START_EVENT, timestamp: 1 })
    expect(sessionStart).toHaveBeenCalledTimes(1)
    expect((sessionStart.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ timestamp: 1 })
    window.removeEventListener(POKER_CHASE_SESSION_START_EVENT, sessionStart)
  })

  test('an explicit EVT_ENTRY_QUEUED error response does not start keepalive', () => {
    const sessionStart = jest.fn()
    window.addEventListener(POKER_CHASE_SESSION_START_EVENT, sessionStart)
    dispatchGameMessage({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 1,
      Code: 5205,
      Error: {
        Status: 1,
        Message: 'text_sync_error_message_code_5205',
        AddParam: '',
        Replaces: []
      }
    })

    jest.advanceTimersByTime(KEEPALIVE_INTERVAL_MS)

    expect(sessionStart).not.toHaveBeenCalled()
    expect(mockPort.postMessage).not.toHaveBeenCalledWith({ type: 'keepalive' })
    window.removeEventListener(POKER_CHASE_SESSION_START_EVENT, sessionStart)
  })

  test('an intercepted payload with an invalid ApiTypeId reaches background diagnostics', () => {
    const payload = { ApiTypeId: '303', timestamp: 10 }
    dispatchGameMessage({
      type: POKER_CHASE_INVALID_API_EVENT,
      payload
    })

    expect(mockPort.postMessage).toHaveBeenCalledWith(payload)
  })

  test('an envelope cannot bypass session handling for a numeric ApiTypeId', () => {
    const payload = {
      ApiTypeId: ApiType.EVT_SESSION_RESULTS,
      timestamp: 11
    }
    dispatchGameMessage({
      type: POKER_CHASE_INVALID_API_EVENT,
      payload
    })

    expect(mockPort.postMessage).not.toHaveBeenCalledWith(payload)
  })

  test.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MIN_SAFE_INTEGER - 1
  ])('an envelope preserves non-safe numeric ApiTypeId %p for diagnostics', invalidApiTypeId => {
    const payload = {
      ApiTypeId: invalidApiTypeId,
      timestamp: 12
    }
    dispatchGameMessage({
      type: POKER_CHASE_INVALID_API_EVENT,
      payload
    })

    expect(mockPort.postMessage).toHaveBeenCalledWith(payload)
  })

  test('an envelope without ApiTypeId reaches background diagnostics', () => {
    const payload = { timestamp: 14, UnexpectedRoot: true }
    dispatchGameMessage({
      type: POKER_CHASE_INVALID_API_EVENT,
      payload
    })

    expect(mockPort.postMessage).toHaveBeenCalledWith(payload)
  })

  test('a flat event with a non-safe numeric ApiTypeId is ignored', () => {
    const payload = {
      ApiTypeId: Number.POSITIVE_INFINITY,
      timestamp: 13
    }
    dispatchGameMessage(payload)

    expect(mockPort.postMessage).not.toHaveBeenCalledWith(payload)
  })

  test('EVT_DEAL (303) with Player present alone starts keepalive without a prior 308', () => {
    dispatchGameMessage({ ApiTypeId: ApiType.EVT_DEAL, timestamp: 2, Player: { SeatIndex: 0 } })

    jest.advanceTimersByTime(KEEPALIVE_INTERVAL_MS)

    expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'keepalive' })
  })

  test('EVT_DEAL (303) with Player absent (spectator mode) does NOT start keepalive (P2, codex review 2026-07-21)', () => {
    dispatchGameMessage({ ApiTypeId: ApiType.EVT_DEAL, timestamp: 2 }) // no Player field

    jest.advanceTimersByTime(KEEPALIVE_INTERVAL_MS)

    expect(mockPort.postMessage).not.toHaveBeenCalledWith({ type: 'keepalive' })
  })

  test('raw sequence 309 -> 201 -> 303[Player present] (no intervening 308) keeps keepalive armed (release-blocker audit exact scenario)', () => {
    // beforeEach already sent a 309 baseline; repeat explicitly so the
    // scenario reads standalone.
    dispatchGameMessage({ ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 3 })
    mockPort.postMessage.mockClear()

    dispatchGameMessage({ ApiTypeId: ApiType.EVT_ENTRY_QUEUED, timestamp: 4 })
    dispatchGameMessage({ ApiTypeId: ApiType.EVT_DEAL, timestamp: 5, Player: { SeatIndex: 0 } })

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

  test('ApiTypeId 203 (参加取消申込, entry cancellation) stops keepalive when no hand ever started (P2, codex review 2026-07-20 pass-3)', () => {
    dispatchGameMessage({ ApiTypeId: ApiType.EVT_ENTRY_QUEUED, timestamp: 8 })
    // 203 is not part of the `ApiType` enum -- use the raw literal, matching
    // event-ingestion.ts's own EVT_ENTRY_CANCELLED_API_TYPE_ID.
    dispatchGameMessage({ ApiTypeId: 203, timestamp: 9 })
    mockPort.postMessage.mockClear()

    jest.advanceTimersByTime(KEEPALIVE_INTERVAL_MS * 2)

    expect(mockPort.postMessage).not.toHaveBeenCalled()
  })
})
