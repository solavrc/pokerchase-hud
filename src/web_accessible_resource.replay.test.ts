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

/**
 * 実測(2026-08-01)した `/replay/detail` の応答エンベロープ。
 * 拒否もHTTP 200で返り、成否は`result`/`status`で表される。
 * WebSocket側の`Code`はこのAPIには存在しない ―― 実データを見ずに作った
 * フィクスチャがそれを持っていたため、成否判定の取り違えがテストを素通りした。
 */
const SUCCESS_ENVELOPE = {
  result: 0,
  date: 1785554587,
  dataVer: '2_06_0_test',
  appVer: '2.06',
  masterVer: 'master-test',
  trace: '',
  emsg: '',
  status: 0,
  behavior: '0',
  message: '',
  session: 'rotated-secret',
  param: {
    CardOpenEndDate: 0,
    Game: { PlayerNum: 6, CommunityCardList: [39, 17, 11, 44, 24] },
    Player: { SeatIndex: 5, UserId: 561384657, HoleCardList: [40, 41] },
    OtherPlayerList: [{ SeatIndex: 0, UserId: 686412100, HoleCardList: [] }]
  }
}

/** 拡張側へ渡る形。`session`だけが落ちる。 */
const { session: _strippedSession, ...SUCCESS_DETAIL } = SUCCESS_ENVELOPE

/** 取得できないhandIdの実測応答。`param`自体が無い。 */
const REJECTED_ENVELOPE = {
  result: 1,
  date: 1785554587,
  dataVer: '2_06_0_test',
  appVer: '2.06',
  masterVer: 'master-test',
  trace: '',
  emsg: '',
  status: 2302,
  behavior: '0',
  message: 'text_error_message_code_2302'
}

/**
 * `result: 0`だが`param`が無い形。実測はしていない防御的ケースだが、
 * ここを素通りさせると中身の無い応答が成功として保存経路へ流れる。
 */
const MISSING_PARAM_ENVELOPE = { ...REJECTED_ENVELOPE, result: 0, status: 0, message: '' }

describe('main-world experimental replay bridge', () => {
  test('captures a Unity XHR envelope, builds sequential detail requests, and strips credentials', async () => {
    class FakeWebSocket {
      addEventListener = jest.fn()
    }
    ;(window as any).WebSocket = FakeWebSocket

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: jest.fn().mockResolvedValue(arrayBufferOf(SUCCESS_ENVELOPE))
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

    // Unity can issue its first API request before the content script's
    // asynchronous storage lookup supplies the initial enabled config.
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
      data: { type: REPLAY_BRIDGE_CONFIG, enabled: true }
    }))

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
        detail: SUCCESS_DETAIL
      }]
    }, POKER_CHASE_ORIGIN)
    expect(JSON.stringify(postMessageSpy.mock.calls)).not.toContain('page-only-secret')
    expect(JSON.stringify(postMessageSpy.mock.calls)).not.toContain('rotated-secret')

    XMLHttpRequest.prototype.open = originalOpen
    XMLHttpRequest.prototype.send = originalSend
  })

  // 拒否はHTTP 200で返るため、本文の`result`/`status`を見ない限り
  // 中身の無い応答が`ok: true`として保存経路へ流れる。実測では同一バッチに
  // 拒否と成功が混在したので、拒否1件でバッチが止まらないことも押さえる。
  test('rejects a result!=0 envelope without stopping the rest of the batch', async () => {
    class FakeWebSocket {
      addEventListener = jest.fn()
    }
    ;(window as any).WebSocket = FakeWebSocket

    const responseOf = (envelope: unknown) => ({
      ok: true,
      status: 200,
      arrayBuffer: jest.fn().mockResolvedValue(arrayBufferOf(envelope))
    })
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(responseOf(REJECTED_ENVELOPE))
      .mockResolvedValueOnce(responseOf(MISSING_PARAM_ENVELOPE))
      .mockResolvedValueOnce(responseOf(SUCCESS_ENVELOPE))
    ;(window as any).fetch = fetchMock

    const originalOpen = XMLHttpRequest.prototype.open
    const originalSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.open = jest.fn() as any
    XMLHttpRequest.prototype.send = jest.fn() as any
    const postMessageSpy = jest.spyOn(window, 'postMessage')

    jest.isolateModules(() => {
      require('./web_accessible_resource')
    })

    const xhr = new XMLHttpRequest()
    xhr.open('POST', 'https://production.api-poker-chase.com/user/status')
    xhr.send(encode({
      param: {},
      session: 'page-only-secret',
      platform: 2,
      appVer: '2.06',
      dataVer: '2_06_0_test',
      masterVer: 'master-test',
      requestKey: 'original-key'
    }))
    await Promise.resolve()

    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: POKER_CHASE_ORIGIN,
      data: { type: REPLAY_BRIDGE_CONFIG, enabled: true }
    }))
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: POKER_CHASE_ORIGIN,
      data: { type: REPLAY_BRIDGE_FETCH, requestId: 'request-2', handIds: [777, 779, 778] }
    }))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(postMessageSpy).toHaveBeenCalledWith({
      type: REPLAY_BRIDGE_RESULT,
      requestId: 'request-2',
      results: [
        { handId: 777, ok: false, error: 'API result 1 status 2302', retryable: false },
        { handId: 779, ok: false, error: 'missing-param', retryable: false },
        { handId: 778, ok: true, detail: SUCCESS_DETAIL }
      ]
    }, POKER_CHASE_ORIGIN)

    XMLHttpRequest.prototype.open = originalOpen
    XMLHttpRequest.prototype.send = originalSend
  })
})
