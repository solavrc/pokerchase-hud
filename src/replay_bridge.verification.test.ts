import { TextDecoder, TextEncoder } from 'util'
import {
  POKER_CHASE_ORIGIN,
  REPLAY_PAGE_SESSION_ACTIVITY_KEY
} from './constants/runtime'
import {
  REPLAY_BRIDGE_CONFIG,
  REPLAY_BRIDGE_VERIFY,
  REPLAY_BRIDGE_VERIFY_RESULT,
  REPLAY_LIST_URL,
  REPLAY_VERIFY_IN_SESSION
} from './replay/protocol'

Object.assign(global, { TextEncoder, TextDecoder })
const { decode, encode } = require('@msgpack/msgpack') as typeof import('@msgpack/msgpack')

const SW_EPOCH = 'service-worker-epoch-verify'

const arrayBufferOf = (value: unknown): ArrayBuffer => {
  const bytes = encode(value)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

const LIST_ENVELOPE = {
  result: 0,
  status: 0,
  session: 'rotated-secret',
  param: {
    HandList: [],
    CardOpenEndDate: 1_786_000_000,
    IsExpiredCardOpen: false,
    BattleType: 0
  }
}

/**
 * ブリッジを読み込み、通常API通信で認証エンベロープを捕獲させるところまで。
 * 実際のPokerChaseと同じく、捕獲はページ自身のXHRから起きる。
 */
const loadBridgeWithEnvelope = async (): Promise<void> => {
  jest.isolateModules(() => {
    require('./replay_bridge')
  })
  window.dispatchEvent(new MessageEvent('message', {
    source: window,
    origin: POKER_CHASE_ORIGIN,
    data: { type: REPLAY_BRIDGE_CONFIG, enabled: true }
  }))
  const xhr = new XMLHttpRequest()
  xhr.open('POST', 'https://production.api-poker-chase.com/home/index')
  xhr.send(encode({
    param: {},
    session: 'page-only-secret',
    platform: 2,
    appVer: '2.06',
    dataVer: '2_06_0_test',
    masterVer: 'master-test'
  }))
  await Promise.resolve()
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 20; index++) await Promise.resolve()
}

describe('公開リプレイ取り込みの/list検証ブリッジ', () => {
  const pageState = window as unknown as Record<PropertyKey, unknown>
  let originalOpen: typeof XMLHttpRequest.prototype.open
  let originalSend: typeof XMLHttpRequest.prototype.send

  beforeEach(() => {
    pageState[REPLAY_PAGE_SESSION_ACTIVITY_KEY] = 'inactive'
    originalOpen = XMLHttpRequest.prototype.open
    originalSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.open = jest.fn() as any
    XMLHttpRequest.prototype.send = jest.fn() as any
  })

  afterEach(() => {
    XMLHttpRequest.prototype.open = originalOpen
    XMLHttpRequest.prototype.send = originalSend
    jest.restoreAllMocks()
  })

  // このテストを先頭に置く（MUST）。各テストは`isolateModules`でブリッジを
  // 読み直すが、`window`のmessageリスナーは前のインスタンスの分も残る。後続の
  // 位置に置くと、旧インスタンスが読み込み時に掴んだ**そのテストのfetch mock**
  // で同じ依頼を処理し、遅延応答の検証を先に解決してしまう。
  test('応答が返る間に対局が始まったら資格の判定結果を返さない', async () => {
    let releaseResponse!: () => void
    const responseGate = new Promise<void>(resolve => { releaseResponse = resolve })
    const fetchMock = jest.fn().mockImplementation(async () => {
      await responseGate
      return {
        ok: true,
        status: 200,
        arrayBuffer: jest.fn().mockResolvedValue(arrayBufferOf(LIST_ENVELOPE))
      }
    })
    ;(window as any).fetch = fetchMock
    const postMessageSpy = jest.spyOn(window, 'postMessage')

    await loadBridgeWithEnvelope()
    postMessageSpy.mockClear()

    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: POKER_CHASE_ORIGIN,
      data: { type: REPLAY_BRIDGE_VERIFY, epoch: SW_EPOCH, requestId: 'verify-race' }
    }))
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // WSが対局開始を観測した ―― bridgeは自律的にabortへ向かう。
    pageState[REPLAY_PAGE_SESSION_ACTIVITY_KEY] = 'active'
    releaseResponse()
    await flush()

    expect(postMessageSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: REPLAY_BRIDGE_VERIFY_RESULT, ok: true }),
      POKER_CHASE_ORIGIN
    )
  })

  test('認証エンベロープを使い/listを1発だけ送り、期限フィールドだけを返す', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: jest.fn().mockResolvedValue(arrayBufferOf(LIST_ENVELOPE))
    })
    ;(window as any).fetch = fetchMock
    const postMessageSpy = jest.spyOn(window, 'postMessage')

    await loadBridgeWithEnvelope()

    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: POKER_CHASE_ORIGIN,
      data: { type: REPLAY_BRIDGE_VERIFY, epoch: SW_EPOCH, requestId: 'verify-1' }
    }))
    await flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(REPLAY_LIST_URL)
    const requestBody = decode(new Uint8Array(fetchMock.mock.calls[0][1].body)) as any
    expect(requestBody.param).toEqual({ BattleType: 0 })
    expect(requestBody.session).toBe('page-only-secret')
    expect(postMessageSpy).toHaveBeenCalledWith({
      type: REPLAY_BRIDGE_VERIFY_RESULT,
      epoch: SW_EPOCH,
      requestId: 'verify-1',
      ok: true,
      entitlement: {
        cardOpenEndDate: 1_786_000_000,
        isExpiredCardOpen: false
      }
    }, POKER_CHASE_ORIGIN)
    expect(JSON.stringify(postMessageSpy.mock.calls)).not.toContain('rotated-secret')
  })

  // 詳細取得と同じ不変条件を検証経路にも掛ける。`unknown`もfail-closed。
  test.each(['active', 'unknown'])(
    'page activityが%sなら/listを撃たず、pending-sessionとして返す',
    async activity => {
      const fetchMock = jest.fn()
      ;(window as any).fetch = fetchMock
      const postMessageSpy = jest.spyOn(window, 'postMessage')

      await loadBridgeWithEnvelope()
      pageState[REPLAY_PAGE_SESSION_ACTIVITY_KEY] = activity
      postMessageSpy.mockClear()

      window.dispatchEvent(new MessageEvent('message', {
        source: window,
        origin: POKER_CHASE_ORIGIN,
        data: { type: REPLAY_BRIDGE_VERIFY, epoch: SW_EPOCH, requestId: `verify-${activity}` }
      }))
      await flush()

      expect(fetchMock).not.toHaveBeenCalled()
      expect(postMessageSpy).toHaveBeenCalledWith({
        type: REPLAY_BRIDGE_VERIFY_RESULT,
        epoch: SW_EPOCH,
        requestId: `verify-${activity}`,
        ok: false,
        error: REPLAY_VERIFY_IN_SESSION,
        retryable: true
      }, POKER_CHASE_ORIGIN)
    }
  )

  test('epochの無い検証依頼は転送されても撃たない', async () => {
    const fetchMock = jest.fn()
    ;(window as any).fetch = fetchMock

    await loadBridgeWithEnvelope()

    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: POKER_CHASE_ORIGIN,
      data: { type: REPLAY_BRIDGE_VERIFY, requestId: 'verify-no-epoch' }
    }))
    await flush()

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
