import { TextDecoder, TextEncoder } from 'util'
import { POKER_CHASE_ORIGIN } from './constants/runtime'
import {
  REPLAY_BRIDGE_CONFIG,
  REPLAY_BRIDGE_FETCH,
  REPLAY_BRIDGE_LEDGER,
  REPLAY_BRIDGE_RESULT,
  REPLAY_DETAIL_URL,
  REPLAY_FETCH_INTERVAL_MS
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

/** 実測した `/replay/list` の応答。台帳とエンベロープ側のフィールドが同じ1本に乗る。 */
const LIST_ENVELOPE = {
  ...SUCCESS_ENVELOPE,
  session: 'list-response-secret',
  param: {
    HandList: [{
      Hand: {
        HandId: 533933335,
        BattleType: 0,
        Name: 'text_rank_room_name_legend',
        StartTime: 1785500000,
        HoleCardList: [40, 41],
        CommunityCardList: [39, 17, 11, 44, 24],
        ChipDiff: -6436
      },
      IsFavorite: false
    }],
    CardOpenEndDate: 1786000000,
    IsExpiredCardOpen: false,
    Limit: 100,
    FavoriteCount: 100,
    BattleType: 0
  }
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

    // 取得の間隔待ちを実時間で待つとテストが数秒止まるため、時間だけ偽装する。
    // マイクロタスクは偽装されないので、フラッシュと時間送りを交互に回す。
    jest.useFakeTimers()
    jest.isolateModules(() => {
      require('./web_accessible_resource')
    })
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) await Promise.resolve()
    }

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
    // 間隔を空けずに次を出していないことを、時間を送らずに確かめる。
    // ここで2件目が出ていたらペーシングが効いていない。
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(REPLAY_FETCH_INTERVAL_MS)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    jest.advanceTimersByTime(REPLAY_FETCH_INTERVAL_MS)
    await flush()

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

    jest.useRealTimers()
    XMLHttpRequest.prototype.open = originalOpen
    XMLHttpRequest.prototype.send = originalSend
  })

  // 受動取得: 拡張はリクエストを出さず、ユーザーがリプレイ画面を開いたときに
  // ゲーム自身が出した `/replay/list` の応答を読むだけ。
  test('passively forwards the /replay/list ledger without issuing a request', async () => {
    class FakeWebSocket {
      addEventListener = jest.fn()
    }
    ;(window as any).WebSocket = FakeWebSocket
    const fetchMock = jest.fn()
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
    xhr.open('POST', 'https://production.api-poker-chase.com/replay/list')
    Object.defineProperty(xhr, 'response', {
      value: arrayBufferOf(LIST_ENVELOPE),
      configurable: true
    })
    xhr.send(encode({
      param: { BattleType: 0 },
      session: 'page-only-secret',
      platform: 2,
      appVer: '2.06',
      dataVer: '2_06_0_test',
      masterVer: 'master-test',
      requestKey: 'original-key'
    }))
    await Promise.resolve()
    xhr.dispatchEvent(new Event('loadend'))
    await new Promise(resolve => setTimeout(resolve, 0))

    // 取得は一切していない
    expect(fetchMock).not.toHaveBeenCalled()

    expect(postMessageSpy).toHaveBeenCalledWith({
      type: REPLAY_BRIDGE_LEDGER,
      battleType: 0,
      cardOpenEndDate: 1786000000,
      isExpiredCardOpen: false,
      hands: [{ handId: 533933335, startTime: 1785500000, chipDiff: -6436 }]
    }, POKER_CHASE_ORIGIN)
    expect(JSON.stringify(postMessageSpy.mock.calls)).not.toContain('page-only-secret')
    expect(JSON.stringify(postMessageSpy.mock.calls)).not.toContain('list-response-secret')

    XMLHttpRequest.prototype.open = originalOpen
    XMLHttpRequest.prototype.send = originalSend
  })

  // Codexレビュー指摘: 応答待ちの最中に無効化されたら、次の1件から止まる
  // 必要がある。バッチ完了まで最大99件を撃ち続けてはいけない。
  test('stops the batch and does not resurrect credentials when disabled mid-flight', async () => {
    class FakeWebSocket {
      addEventListener = jest.fn()
    }
    ;(window as any).WebSocket = FakeWebSocket

    const fetchMock = jest.fn().mockImplementation(async () => {
      // 1件目の応答が返る直前に無効化される
      window.dispatchEvent(new MessageEvent('message', {
        source: window,
        origin: POKER_CHASE_ORIGIN,
        data: { type: REPLAY_BRIDGE_CONFIG, enabled: false }
      }))
      return {
        ok: true,
        status: 200,
        arrayBuffer: jest.fn().mockResolvedValue(arrayBufferOf(SUCCESS_ENVELOPE))
      }
    })
    ;(window as any).fetch = fetchMock

    const originalOpen = XMLHttpRequest.prototype.open
    const originalSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.open = jest.fn() as any
    XMLHttpRequest.prototype.send = jest.fn() as any
    const postMessageSpy = jest.spyOn(window, 'postMessage')
    postMessageSpy.mockClear()

    jest.useFakeTimers()
    jest.isolateModules(() => {
      require('./web_accessible_resource')
    })
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) await Promise.resolve()
    }

    const xhr = new XMLHttpRequest()
    xhr.open('POST', 'https://production.api-poker-chase.com/user/status')
    xhr.send(encode({
      param: {}, session: 'page-only-secret', platform: 2,
      appVer: '2.06', dataVer: '2_06_0_test', masterVer: 'master-test'
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
      data: { type: REPLAY_BRIDGE_FETCH, requestId: 'request-3', handIds: [1, 2, 3, 4, 5] }
    }))
    for (let step = 0; step < 8; step++) {
      await flush()
      jest.advanceTimersByTime(REPLAY_FETCH_INTERVAL_MS)
    }
    await flush()

    // 1件目だけが走り、無効化後は追撃しない。
    // fetchMock の回数は「消した資格情報を復活させない」ガードが守り、
    // results の件数は「無効化で残りを中断する」break が守る。
    // 片方だけだと 99 件の無駄な待ちループ、もう片方だけだと実POSTが続く。
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const posted = postMessageSpy.mock.calls
      .map(call => call[0] as { type?: string, results?: unknown[] })
      .find(m => m.type === REPLAY_BRIDGE_RESULT)
    expect(posted?.results).toHaveLength(1)

    jest.useRealTimers()
    XMLHttpRequest.prototype.open = originalOpen
    XMLHttpRequest.prototype.send = originalSend
  })

  // Codexレビュー指摘: 受動傍受（通常API通信）の経路にも同じガードが要る。
  // 旧応答が後から完了した時点で、現在のエンベロープへ旧世代のsessionを
  // 無条件に合成していた。
  test('does not merge a stale passive response session into a newer envelope', async () => {
    class FakeWebSocket {
      addEventListener = jest.fn()
    }
    ;(window as any).WebSocket = FakeWebSocket
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      arrayBuffer: jest.fn().mockResolvedValue(arrayBufferOf(SUCCESS_ENVELOPE))
    })
    ;(window as any).fetch = fetchMock

    const originalOpen = XMLHttpRequest.prototype.open
    const originalSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.open = jest.fn() as any
    XMLHttpRequest.prototype.send = jest.fn() as any

    jest.isolateModules(() => {
      require('./web_accessible_resource')
    })
    window.dispatchEvent(new MessageEvent('message', {
      source: window, origin: POKER_CHASE_ORIGIN,
      data: { type: REPLAY_BRIDGE_CONFIG, enabled: true }
    }))

    const send = (session: string, dataVer: string) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', 'https://production.api-poker-chase.com/user/status')
      xhr.send(encode({ param: {}, session, platform: 2, appVer: '2.06', dataVer, masterVer: 'm' }))
      return xhr
    }

    const stale = send('sess-A', 'ver-A')
    await Promise.resolve(); await Promise.resolve()
    // 旧リクエストの応答を待つ間に、新しいエンベロープを捕獲する
    send('sess-B', 'ver-B')
    await Promise.resolve(); await Promise.resolve()

    // ここで旧リクエストが完了（応答は回転済みsessionを持つ）
    Object.defineProperty(stale, 'response', {
      value: arrayBufferOf({ ...SUCCESS_ENVELOPE, session: 'stale-rotated' }),
      configurable: true
    })
    stale.dispatchEvent(new Event('loadend'))
    await new Promise(resolve => setTimeout(resolve, 0))

    window.dispatchEvent(new MessageEvent('message', {
      source: window, origin: POKER_CHASE_ORIGIN,
      data: { type: REPLAY_BRIDGE_FETCH, requestId: 'r-p', handIds: [9] }
    }))
    await new Promise(resolve => setTimeout(resolve, 0))
    const body = decode(fetchMock.mock.calls[0]![1].body) as Record<string, unknown>
    expect(body.dataVer).toBe('ver-B')
    expect(body.session).toBe('sess-B')

    XMLHttpRequest.prototype.open = originalOpen
    XMLHttpRequest.prototype.send = originalSend
  })

  // Codexレビュー指摘: 「消えていないこと」だけでは足りない。無効化→再有効化で
  // 新しいエンベロープを捕獲した後に旧リクエストが完了すると、旧応答の session を
  // 新しいエンベロープへ混ぜてしまう。
  test('does not merge a stale response session into a re-captured envelope', async () => {
    class FakeWebSocket {
      addEventListener = jest.fn()
    }
    ;(window as any).WebSocket = FakeWebSocket

    let resolveFetch!: (value: unknown) => void
    const fetchMock = jest.fn().mockImplementation(() => new Promise(r => { resolveFetch = r }))
    ;(window as any).fetch = fetchMock

    const originalOpen = XMLHttpRequest.prototype.open
    const originalSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.open = jest.fn() as any
    XMLHttpRequest.prototype.send = jest.fn() as any

    jest.isolateModules(() => {
      require('./web_accessible_resource')
    })

    const sendEnvelope = (session: string, dataVer: string) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', 'https://production.api-poker-chase.com/user/status')
      xhr.send(encode({
        param: {}, session, platform: 2, appVer: '2.06', dataVer, masterVer: 'm'
      }))
      return xhr
    }
    const setEnabled = (enabled: boolean) => window.dispatchEvent(new MessageEvent('message', {
      source: window, origin: POKER_CHASE_ORIGIN,
      data: { type: REPLAY_BRIDGE_CONFIG, enabled }
    }))

    sendEnvelope('old-secret', 'old-ver')
    await Promise.resolve()
    setEnabled(true)
    window.dispatchEvent(new MessageEvent('message', {
      source: window, origin: POKER_CHASE_ORIGIN,
      data: { type: REPLAY_BRIDGE_FETCH, requestId: 'r-stale', handIds: [1] }
    }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // 取得中に無効化→再有効化し、新しいエンベロープを捕獲する
    setEnabled(false)
    setEnabled(true)
    sendEnvelope('new-secret', 'new-ver')
    await new Promise(resolve => setTimeout(resolve, 0))

    // ここで旧リクエストが完了する（応答は回転済みsessionを含む）
    resolveFetch({
      ok: true, status: 200,
      arrayBuffer: jest.fn().mockResolvedValue(arrayBufferOf({
        ...SUCCESS_ENVELOPE, session: 'stale-rotated'
      }))
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    // 次の取得は、旧応答のsessionを混ぜていないエンベロープで出る
    fetchMock.mockClear()
    fetchMock.mockImplementation(async () => ({
      ok: true, status: 200,
      arrayBuffer: jest.fn().mockResolvedValue(arrayBufferOf(SUCCESS_ENVELOPE))
    }))
    window.dispatchEvent(new MessageEvent('message', {
      source: window, origin: POKER_CHASE_ORIGIN,
      data: { type: REPLAY_BRIDGE_FETCH, requestId: 'r-next', handIds: [2] }
    }))
    await new Promise(resolve => setTimeout(resolve, 0))
    const body = decode(fetchMock.mock.calls[0]![1].body) as Record<string, unknown>
    expect(body.dataVer).toBe('new-ver')
    expect(body.session).toBe('new-secret')

    XMLHttpRequest.prototype.open = originalOpen
    XMLHttpRequest.prototype.send = originalSend
  })

  // Codexレビュー指摘: 認証エンベロープの観測は「設定未受信＝有効」で
  // fail-openにしているが、台帳は拡張側へ渡って永続化されるので同じ緩さを
  // 適用してはいけない。フラグを一度も有効化していないユーザーの監査が
  // 走ってしまう。
  test('does not forward the ledger before the enabled config has arrived', async () => {
    class FakeWebSocket {
      addEventListener = jest.fn()
    }
    ;(window as any).WebSocket = FakeWebSocket
    ;(window as any).fetch = jest.fn()

    const originalOpen = XMLHttpRequest.prototype.open
    const originalSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.open = jest.fn() as any
    XMLHttpRequest.prototype.send = jest.fn() as any
    // 不在を検証するテストなので、前のテストが残したスパイ履歴を必ず消す
    // （`jest.spyOn`は既存スパイがあればそれを返し、`mock.calls`は累積する）。
    const postMessageSpy = jest.spyOn(window, 'postMessage')
    postMessageSpy.mockClear()

    jest.isolateModules(() => {
      require('./web_accessible_resource')
    })

    // 設定を送らないまま `/replay/list` の応答が返る
    const xhr = new XMLHttpRequest()
    xhr.open('POST', 'https://production.api-poker-chase.com/replay/list')
    Object.defineProperty(xhr, 'response', {
      value: arrayBufferOf(LIST_ENVELOPE),
      configurable: true
    })
    xhr.send(encode({ param: {}, session: 's', platform: 2, appVer: '2.06', dataVer: 'd', masterVer: 'm' }))
    await Promise.resolve()
    xhr.dispatchEvent(new Event('loadend'))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(postMessageSpy.mock.calls.some(
      call => (call[0] as { type?: string })?.type === REPLAY_BRIDGE_LEDGER
    )).toBe(false)

    XMLHttpRequest.prototype.open = originalOpen
    XMLHttpRequest.prototype.send = originalSend
  })

  // Codexレビュー指摘: 台帳は拡張側へ渡って永続化され、受信時点の playerId と
  // 突き合わされる。旧世代（＝別アカウントでありうる）の応答を転送すると、
  // 偽の未キャプチャ・偽のチップ不一致が監査結果として残る。
  test('drops a ledger whose response belongs to a superseded auth generation', async () => {
    class FakeWebSocket {
      addEventListener = jest.fn()
    }
    ;(window as any).WebSocket = FakeWebSocket
    ;(window as any).fetch = jest.fn()

    const originalOpen = XMLHttpRequest.prototype.open
    const originalSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.open = jest.fn() as any
    XMLHttpRequest.prototype.send = jest.fn() as any
    const postMessageSpy = jest.spyOn(window, 'postMessage')
    postMessageSpy.mockClear()

    jest.isolateModules(() => {
      require('./web_accessible_resource')
    })
    window.dispatchEvent(new MessageEvent('message', {
      source: window, origin: POKER_CHASE_ORIGIN,
      data: { type: REPLAY_BRIDGE_CONFIG, enabled: true }
    }))

    // アカウントAの `/replay/list` が応答待ちのまま
    const stale = new XMLHttpRequest()
    stale.open('POST', 'https://production.api-poker-chase.com/replay/list')
    Object.defineProperty(stale, 'response', {
      value: arrayBufferOf(LIST_ENVELOPE),
      configurable: true
    })
    stale.send(encode({
      param: { BattleType: 0 }, session: 'sess-A', platform: 2,
      appVer: '2.06', dataVer: 'ver-A', masterVer: 'm'
    }))
    await Promise.resolve(); await Promise.resolve()

    // その間にアカウントBのエンベロープを捕獲する（別リクエスト）
    const fresh = new XMLHttpRequest()
    fresh.open('POST', 'https://production.api-poker-chase.com/user/status')
    fresh.send(encode({
      param: {}, session: 'sess-B', platform: 2,
      appVer: '2.06', dataVer: 'ver-B', masterVer: 'm'
    }))
    await Promise.resolve(); await Promise.resolve()

    // ここでAの応答が返る
    stale.dispatchEvent(new Event('loadend'))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(postMessageSpy.mock.calls.some(
      call => (call[0] as { type?: string })?.type === REPLAY_BRIDGE_LEDGER
    )).toBe(false)

    XMLHttpRequest.prototype.open = originalOpen
    XMLHttpRequest.prototype.send = originalSend
  })

  // Codexレビュー指摘: 間隔待ちの最中に無効化されると、待機前のチェックは
  // 通過済みなので `fetchReplayDetail` が呼ばれる。資格情報は消えているので
  // 実POSTは起きないが、偽の `auth-envelope-unavailable`（retryable）が
  // 結果に積まれ、「無効化は次の1件から効く」という返却契約が崩れる。
  test('does not append a result for a hand disabled during the inter-request delay', async () => {
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
    postMessageSpy.mockClear()

    jest.isolateModules(() => {
      require('./web_accessible_resource')
    })

    const xhr = new XMLHttpRequest()
    xhr.open('POST', 'https://production.api-poker-chase.com/user/status')
    xhr.send(encode({
      param: {}, session: 'page-only-secret', platform: 2,
      appVer: '2.06', dataVer: '2_06_0_test', masterVer: 'master-test'
    }))
    await Promise.resolve()
    window.dispatchEvent(new MessageEvent('message', {
      source: window, origin: POKER_CHASE_ORIGIN,
      data: { type: REPLAY_BRIDGE_CONFIG, enabled: true }
    }))
    window.dispatchEvent(new MessageEvent('message', {
      source: window, origin: POKER_CHASE_ORIGIN,
      data: { type: REPLAY_BRIDGE_FETCH, requestId: 'request-delay', handIds: [11, 12] }
    }))

    // 1件目が終わり、2件目の間隔待ちに入るまで進める
    for (let i = 0; i < 30; i++) await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // 待機中に無効化する
    window.dispatchEvent(new MessageEvent('message', {
      source: window, origin: POKER_CHASE_ORIGIN,
      data: { type: REPLAY_BRIDGE_CONFIG, enabled: false }
    }))
    await new Promise(resolve => setTimeout(resolve, REPLAY_FETCH_INTERVAL_MS + 50))
    for (let i = 0; i < 30; i++) await Promise.resolve()

    // 無効化の後に実POSTは起きない
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // 2件目は結果に一切現れない ―― 偽の `auth-envelope-unavailable` を積まない。
    // （`jest.isolateModules`で読み直した過去のインスタンスも同じmessageを
    // 受けて結果を返すので、requestIdごとに1件へ絞らず全件を検査する。）
    const postedForRequest = postMessageSpy.mock.calls
      .map(call => call[0] as { type?: string, requestId?: string, results?: Array<{ handId: number }> })
      .filter(m => m.type === REPLAY_BRIDGE_RESULT && m.requestId === 'request-delay')
    expect(postedForRequest.length).toBeGreaterThan(0)
    for (const message of postedForRequest) {
      expect(message.results?.some(result => result.handId === 12)).toBe(false)
    }

    XMLHttpRequest.prototype.open = originalOpen
    XMLHttpRequest.prototype.send = originalSend
  }, 15_000)
})
