import { decode } from '@msgpack/msgpack'
import {
  POKER_CHASE_INVALID_API_EVENT,
  POKER_CHASE_ORIGIN
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

describe('page-world WebSocket classification', () => {
  const originalWebSocket = window.WebSocket

  beforeAll(async () => {
    ;(window as unknown as { WebSocket: typeof WebSocket }).WebSocket =
      FakeWebSocket as unknown as typeof WebSocket
    await import('./web_accessible_resource')
  })

  beforeEach(() => {
    jest.spyOn(window, 'postMessage').mockImplementation(() => undefined)
    ;(window.postMessage as jest.Mock).mockClear()
    jest.spyOn(Date, 'now').mockReturnValue(123)
  })

  afterAll(() => {
    window.WebSocket = originalWebSocket
  })

  it('forwards invalid objects only after the same socket proves it is the API', () => {
    const unrelatedSocket = new window.WebSocket('wss://example.test/aux')
    emitFrame(unrelatedSocket, { Message: 'auxiliary payload' })
    expect(window.postMessage).not.toHaveBeenCalled()

    const apiSocket = new window.WebSocket('wss://example.test/api')
    emitFrame(apiSocket, { ApiTypeId: '303', Player: {} })
    expect(window.postMessage).not.toHaveBeenCalled()

    emitFrame(apiSocket, { ApiTypeId: 308, BattleType: 1 })

    expect(window.postMessage).toHaveBeenNthCalledWith(1, {
      type: POKER_CHASE_INVALID_API_EVENT,
      payload: {
        ApiTypeId: '303',
        Player: {},
        timestamp: 123
      }
    }, POKER_CHASE_ORIGIN)
    expect(window.postMessage).toHaveBeenNthCalledWith(2, {
      ApiTypeId: 308,
      BattleType: 1,
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

  it('bounds pre-identification buffering to five objects', () => {
    const apiSocket = new window.WebSocket('wss://example.test/api')
    for (let index = 0; index < 6; index += 1) {
      emitFrame(apiSocket, { ApiTypeId: `invalid-${index}` })
    }
    emitFrame(apiSocket, { ApiTypeId: 308 })

    expect(window.postMessage).toHaveBeenCalledTimes(6)
    expect(window.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ ApiTypeId: 'invalid-5' })
      }),
      POKER_CHASE_ORIGIN
    )
  })

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1.5,
    Number.MAX_SAFE_INTEGER + 1
  ])('does not trust a socket from non-safe ApiTypeId %p', invalidApiTypeId => {
    const unrelatedSocket = new window.WebSocket('wss://example.test/aux')
    emitFrame(unrelatedSocket, { ApiTypeId: invalidApiTypeId })
    emitFrame(unrelatedSocket, { PrivateAuxiliaryPayload: true })

    expect(window.postMessage).not.toHaveBeenCalled()
  })
})
