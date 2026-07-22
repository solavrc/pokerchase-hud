import { TextDecoder, TextEncoder } from 'util'
import { POKER_CHASE_ORIGIN } from './constants/runtime'
import {
  REPLAY_BRIDGE_CONFIG,
  REPLAY_BRIDGE_FETCH,
  REPLAY_BRIDGE_RESULT,
  REPLAY_DETAIL_URL
} from './replay/protocol'

Object.assign(global, { TextEncoder, TextDecoder })
const { decode, encode } = require('@msgpack/msgpack') as typeof import('@msgpack/msgpack')

const arrayBufferOf = (value: unknown): ArrayBuffer => {
  const bytes = encode(value)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

describe('main-world experimental replay bridge', () => {
  test('captures a Unity XHR envelope, builds sequential detail requests, and strips credentials', async () => {
    class FakeWebSocket {
      addEventListener = jest.fn()
    }
    ;(window as any).WebSocket = FakeWebSocket

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: jest.fn().mockResolvedValue(arrayBufferOf({
        Code: 0,
        session: 'rotated-secret',
        Replay: { HandId: 777, HoleCardList: [1, 2] }
      }))
    })
    ;(window as any).fetch = fetchMock

    const originalOpen = XMLHttpRequest.prototype.open
    const originalSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.open = jest.fn() as any
    XMLHttpRequest.prototype.send = jest.fn() as any
    const postMessageSpy = jest.spyOn(window, 'postMessage')

    jest.isolateModules(() => {
      require('./web_accessible_resource')
    })

    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: POKER_CHASE_ORIGIN,
      data: { type: REPLAY_BRIDGE_CONFIG, enabled: true }
    }))

    const xhr = new XMLHttpRequest()
    xhr.open('POST', 'https://production.api-poker-chase.com/user/status')
    xhr.send(encode({
      param: {},
      session: 'page-only-secret',
      platform: 2,
      appVer: '2.05',
      dataVer: '2_05_0_test',
      masterVer: 'master-test',
      requestKey: 'original-key'
    }))
    await Promise.resolve()

    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: POKER_CHASE_ORIGIN,
      data: { type: REPLAY_BRIDGE_FETCH, requestId: 'request-1', handIds: [777] }
    }))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(REPLAY_DETAIL_URL)
    const request = decode(fetchMock.mock.calls[0][1].body) as Record<string, unknown>
    expect(request).toEqual(expect.objectContaining({
      param: { HandId: 777 },
      session: 'page-only-secret',
      platform: 2,
      appVer: '2.05',
      dataVer: '2_05_0_test',
      masterVer: 'master-test'
    }))
    expect(request.requestKey).toEqual(expect.any(String))

    expect(postMessageSpy).toHaveBeenCalledWith({
      type: REPLAY_BRIDGE_RESULT,
      requestId: 'request-1',
      results: [{
        handId: 777,
        ok: true,
        detail: { Code: 0, Replay: { HandId: 777, HoleCardList: [1, 2] } }
      }]
    }, POKER_CHASE_ORIGIN)
    expect(JSON.stringify(postMessageSpy.mock.calls)).not.toContain('page-only-secret')
    expect(JSON.stringify(postMessageSpy.mock.calls)).not.toContain('rotated-secret')

    XMLHttpRequest.prototype.open = originalOpen
    XMLHttpRequest.prototype.send = originalSend
  })
})
