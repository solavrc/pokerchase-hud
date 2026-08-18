import { decode } from '@msgpack/msgpack'
import {
  POKER_CHASE_INVALID_API_EVENT,
  POKER_CHASE_ORIGIN,
  REPLAY_PAGE_SESSION_ACTIVITY_EVENT,
  REPLAY_PAGE_SESSION_ACTIVITY_KEY,
  type ReplayPageSessionActivity
} from './constants/runtime'

jest.mock('@msgpack/msgpack', () => ({
  decode: jest.fn()
}))

class FakeWebSocket extends EventTarget {
  constructor(public readonly url: string) {
    super()
  }
}

const emitFrame = (
  socket: WebSocket,
  decoded: Record<string, unknown>
): void => {
  ;(decode as jest.Mock).mockReturnValueOnce(decoded)
  socket.dispatchEvent(new MessageEvent('message', {
    data: new ArrayBuffer(1)
  }))
}

const strongDealAnchor = {
  ApiTypeId: 303,
  Game: { BigBlind: 200 },
  OtherPlayers: [{}],
  Progress: { Phase: 0, Pot: 300 },
  SeatUserIds: [1, 2, 3, 4]
}

describe('page-world WebSocket classification', () => {
  const originalWebSocket = window.WebSocket
  const pageState = window as unknown as Record<PropertyKey, unknown>
  const replayActivity = (): ReplayPageSessionActivity =>
    pageState[REPLAY_PAGE_SESSION_ACTIVITY_KEY] as ReplayPageSessionActivity

  beforeAll(async () => {
    ;(window as unknown as { WebSocket: typeof WebSocket }).WebSocket =
      FakeWebSocket as unknown as typeof WebSocket
    await import('./web_accessible_resource')
  })

  beforeEach(() => {
    pageState[REPLAY_PAGE_SESSION_ACTIVITY_KEY] = 'unknown'
    jest.spyOn(window, 'postMessage').mockImplementation(() => undefined)
    ;(window.postMessage as jest.Mock).mockClear()
    jest.spyOn(Date, 'now').mockReturnValue(123)
  })

  afterAll(() => {
    window.WebSocket = originalWebSocket
  })

  it('forwards invalid objects only after the same socket proves it is the API', () => {
    const unrelatedSocket = new window.WebSocket('wss://example.test/aux')
    emitFrame(unrelatedSocket, { ApiTypeId: 308, BattleType: 1 })
    emitFrame(unrelatedSocket, { Message: 'auxiliary payload' })
    expect(window.postMessage).not.toHaveBeenCalled()

    const apiSocket = new window.WebSocket('wss://example.test/api')
    emitFrame(apiSocket, { ApiTypeId: '303', Player: {} })
    expect(window.postMessage).not.toHaveBeenCalled()

    emitFrame(apiSocket, strongDealAnchor)

    expect(window.postMessage).toHaveBeenNthCalledWith(1, {
      type: POKER_CHASE_INVALID_API_EVENT,
      payload: {
        ApiTypeId: '303',
        Player: {},
        timestamp: 123
      }
    }, POKER_CHASE_ORIGIN)
    expect(window.postMessage).toHaveBeenNthCalledWith(2, {
      ...strongDealAnchor,
      timestamp: 123
    }, POKER_CHASE_ORIGIN)

    emitFrame(apiSocket, { ApiTypeId: null, Results: [] })
    expect(window.postMessage).toHaveBeenNthCalledWith(3, {
      type: POKER_CHASE_INVALID_API_EVENT,
      payload: {
        ApiTypeId: null,
        Results: [],
        timestamp: 123
      }
    }, POKER_CHASE_ORIGIN)
  })

  it('trusts the official API endpoint before inspecting ApiTypeId', () => {
    const apiSocket = new window.WebSocket(
      'wss://production.api-poker-chase.com/sync'
    )

    for (let index = 0; index < 7; index += 1) {
      emitFrame(apiSocket, { RenamedApiTypeId: `broken-${index}` })
    }

    expect(window.postMessage).toHaveBeenCalledTimes(7)
    expect(window.postMessage).toHaveBeenNthCalledWith(7, {
      type: POKER_CHASE_INVALID_API_EVENT,
      payload: {
        RenamedApiTypeId: 'broken-6',
        timestamp: 123
      }
    }, POKER_CHASE_ORIGIN)
  })

  it('trusted WSの201/303/308/309をbridge注入前からpage activityへ保持する', () => {
    const apiSocket = new window.WebSocket(
      'wss://production.api-poker-chase.com/sync'
    )
    const activityEvent = jest.fn()
    window.addEventListener(REPLAY_PAGE_SESSION_ACTIVITY_EVENT, activityEvent)

    expect(replayActivity()).toBe('unknown')
    emitFrame(apiSocket, { ApiTypeId: 201, Code: 1 })
    expect(replayActivity()).toBe('unknown')
    emitFrame(apiSocket, { ApiTypeId: 201 })
    expect(replayActivity()).toBe('active')

    emitFrame(apiSocket, { ApiTypeId: 309 })
    expect(replayActivity()).toBe('inactive')
    emitFrame(apiSocket, { ApiTypeId: 303 })
    expect(replayActivity()).toBe('inactive')
    emitFrame(apiSocket, { ApiTypeId: 303, Player: { SeatIndex: 0 } })
    expect(replayActivity()).toBe('active')

    emitFrame(apiSocket, { ApiTypeId: 309 })
    expect(replayActivity()).toBe('inactive')
    emitFrame(apiSocket, { ApiTypeId: 308 })
    expect(replayActivity()).toBe('active')
    // 201後に着席せず参加取消した経路では309が来ない。成功したCode=0だけを
    // 終了境界にし、取消失敗または未知schemaでは安全側のactiveを維持する。
    emitFrame(apiSocket, { ApiTypeId: 203, Code: 5003 })
    expect(replayActivity()).toBe('active')
    emitFrame(apiSocket, { ApiTypeId: 203 })
    expect(replayActivity()).toBe('active')
    emitFrame(apiSocket, { ApiTypeId: 203, Code: 0 })
    expect(replayActivity()).toBe('inactive')
    expect(activityEvent.mock.calls.map(([event]) =>
      (event as CustomEvent<ReplayPageSessionActivity>).detail
    )).toEqual(['active', 'inactive', 'active', 'inactive', 'active', 'inactive'])
    window.removeEventListener(REPLAY_PAGE_SESSION_ACTIVITY_EVENT, activityEvent)
  })

  it('does not trust a lookalike API hostname', () => {
    const unrelatedSocket = new window.WebSocket(
      'wss://production.api-poker-chase.com.evil.test/sync'
    )
    emitFrame(unrelatedSocket, { RenamedApiTypeId: 'private-auxiliary' })

    expect(window.postMessage).not.toHaveBeenCalled()
  })

  it('bounds pre-identification buffering to five objects', () => {
    const apiSocket = new window.WebSocket('wss://example.test/api')
    for (let index = 0; index < 6; index += 1) {
      emitFrame(apiSocket, { ApiTypeId: `invalid-${index}` })
    }
    emitFrame(apiSocket, strongDealAnchor)

    expect(window.postMessage).toHaveBeenCalledTimes(6)
    expect(window.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ ApiTypeId: 'invalid-5' })
      }),
      POKER_CHASE_ORIGIN
    )
  })

  it.each([
    { ApiTypeId: 1305, FriendId: 123 },
    { ApiTypeId: 1304, Status: 0, UserId: 123 },
    { ApiTypeId: 1301, Message: {} },
    {
      ApiTypeId: 308,
      DefaultChip: -1,
      BlindStructures: [],
      CoinNum: -1,
      IsReplay: false,
      Name: '',
      Name2: '',
      LimitSeconds: 8
    }
  ])('does not trust a socket from a weak near-match %#', nearMatch => {
    const unrelatedSocket = new window.WebSocket('wss://example.test/aux')
    emitFrame(unrelatedSocket, nearMatch)
    emitFrame(unrelatedSocket, { PrivateAuxiliaryPayload: true })

    expect(window.postMessage).not.toHaveBeenCalled()
  })

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MIN_SAFE_INTEGER - 1
  ])('does not trust a socket from non-safe ApiTypeId %p', invalidApiTypeId => {
    const unrelatedSocket = new window.WebSocket('wss://example.test/aux')
    emitFrame(unrelatedSocket, { ApiTypeId: invalidApiTypeId })
    emitFrame(unrelatedSocket, { PrivateAuxiliaryPayload: true })

    expect(window.postMessage).not.toHaveBeenCalled()
  })
})
