import { decode } from '@msgpack/msgpack'
import { POKER_CHASE_ORIGIN } from './constants/runtime'

jest.mock('@msgpack/msgpack', () => ({ decode: jest.fn() }))

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly readyState = FakeWebSocket.OPEN
  readonly constructedWith: Function

  constructor(
    readonly url: string,
    readonly protocols?: string | string[]
  ) {
    super()
    this.constructedWith = new.target
  }

  send(_data: string): void {}
  close(): void {}
}

describe('WebSocket差し替えの互換性', () => {
  const original = window.WebSocket

  beforeAll(async () => {
    window.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    await import('./web_accessible_resource')
  })

  afterAll(() => { window.WebSocket = original })
  afterEach(() => { jest.restoreAllMocks() })

  test('静的定数とprototypeを保持する', () => {
    expect([
      window.WebSocket.CONNECTING, window.WebSocket.OPEN,
      window.WebSocket.CLOSING, window.WebSocket.CLOSED
    ]).toEqual([0, 1, 2, 3])
    expect(window.WebSocket.prototype).toBe(FakeWebSocket.prototype)
    expect(window.WebSocket.prototype.send).toBe(FakeWebSocket.prototype.send)
    expect(Object.getOwnPropertyDescriptor(window.WebSocket, 'OPEN'))
      .toEqual(Object.getOwnPropertyDescriptor(FakeWebSocket, 'OPEN'))
  })

  test('instanceofとコンストラクター引数を保持する', () => {
    const protocols = ['poker-test']
    const socket = new window.WebSocket('wss://example.test/socket', protocols)
    expect(socket).toBeInstanceOf(window.WebSocket)
    expect(socket).toBeInstanceOf(FakeWebSocket)
    expect(socket.readyState).toBe(window.WebSocket.OPEN)
    expect((socket as unknown as FakeWebSocket).protocols).toBe(protocols)
  })

  test('サブクラスのnew.targetとプロトタイプを保持する', () => {
    class GameSocket extends window.WebSocket {
      readonly marker = 'game'
    }
    const socket = new GameSocket('wss://example.test/socket')
    expect(socket).toBeInstanceOf(GameSocket)
    expect(socket).toBeInstanceOf(window.WebSocket)
    expect(socket).toBeInstanceOf(FakeWebSocket)
    expect(socket.marker).toBe('game')
    expect((socket as unknown as FakeWebSocket).constructedWith).toBe(GameSocket)
  })

  test('newなしの呼出しを許可しない', () => {
    expect(() => Reflect.apply(window.WebSocket, undefined, ['wss://example.test/socket']))
      .toThrow(TypeError)
  })

  test('サブクラスでも受信イベントを一度だけ転送する', () => {
    class GameSocket extends window.WebSocket {}
    const postMessage = jest.spyOn(window, 'postMessage').mockImplementation(() => {})
    ;(decode as jest.Mock).mockReturnValueOnce({ ApiTypeId: 309 })
    const socket = new GameSocket('wss://production.api-poker-chase.com/sync')
    socket.dispatchEvent(new MessageEvent('message', { data: new ArrayBuffer(1) }))
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith(
      { ApiTypeId: 309, timestamp: expect.any(Number) }, POKER_CHASE_ORIGIN
    )
  })
})
