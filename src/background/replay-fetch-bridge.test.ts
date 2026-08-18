import { connectedPorts } from './ports'
import {
  REPLAY_PORT_CANCEL,
  REPLAY_PORT_FETCH,
  REPLAY_PORT_RESULT,
  REPLAY_PORT_STARTED,
  REPLAY_PORT_VERIFY,
  REPLAY_PORT_VERIFY_RESULT,
  REPLAY_FETCH_BATCH_LIMIT,
  REPLAY_VERIFY_IN_SESSION,
  replayFetchBatchTimeoutMs
} from '../replay/protocol'
import {
  __resetReplayFetchBridgeForTests,
  cancelReplayRequestsForSessionStart,
  exposeReplayFetchForDevtools,
  handleReplayPortMessage,
  releaseReplayRequestsForPort,
  requestReplayDetails,
  requestReplayVerification
} from './replay-fetch-bridge'
import {
  __resetActivePortStateForTests,
  claimActivePort,
  markActivePortSessionActive,
  markActivePortSessionInactive,
  resolveGeneration
} from './active-port'

const makePort = () => ({ postMessage: jest.fn() }) as unknown as chrome.runtime.Port

const makeInactiveActivePort = (): chrome.runtime.Port => {
  const port = makePort()
  connectedPorts.add(port)
  claimActivePort(port)
  markActivePortSessionInactive(resolveGeneration(port)!)
  return port
}

const sentRequest = (port: chrome.runtime.Port): { epoch: string, requestId: string } =>
  (port.postMessage as jest.Mock).mock.calls[0]![0]

const sentRequestId = (port: chrome.runtime.Port): string => sentRequest(port).requestId

/** 依頼は`dispatchQueue`の順番待ちを挟むので、複数回のmicrotaskで送信まで進める。 */
const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 10; index++) await Promise.resolve()
}

describe('replay-fetch-bridge（開発用の取得入口）', () => {
  beforeEach(() => {
    __resetReplayFetchBridgeForTests()
    __resetActivePortStateForTests()
    connectedPorts.clear()
  })

  // Codexレビュー指摘（3周にわたる同じ論点）: 期限を片方の尺度だけで計ると
  // 必ずどちらかが足りない。自分の件数だけでは先行バッチの間隔待ちの最中に
  // 切れ、上限件数だけでは先行バッチを吸収した後に自分の所要が残らない。
  // 開始通知を境に尺度を切り替える。
  it('開始通知を受けたら期限を自分のバッチの所要へ張り直す', async () => {
    jest.useFakeTimers()
    try {
      const port = makeInactiveActivePort()

      let settled = false
      const pending = requestReplayDetails([1]).then(outcome => { settled = true; return outcome })
      await Promise.resolve()
      const requestId = sentRequestId(port)
      const epoch = sentRequest(port).epoch

      // 開始通知の前は「先行バッチが最大構成でも待ち切れる」長さ。
      // 自分の件数(1件)の期限を大きく超えても、まだ切れてはいけない。
      jest.advanceTimersByTime(replayFetchBatchTimeoutMs(1) * 2)
      await Promise.resolve()
      expect(settled).toBe(false)

      expect(handleReplayPortMessage({ type: REPLAY_PORT_STARTED, epoch, requestId }, port)).toBe(true)

      // 張り直された後は自分の件数で切れる
      jest.advanceTimersByTime(replayFetchBatchTimeoutMs(1) + 1000)
      await Promise.resolve()
      await Promise.resolve()
      expect(await pending).toEqual({ success: true, results: [] })
    } finally {
      jest.useRealTimers()
    }
  })

  it('接続中のゲームタブへ取得を依頼し、応答で解決する', async () => {
    const port = makeInactiveActivePort()

    const pending = requestReplayDetails([1, 2])
    await Promise.resolve()

    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: REPLAY_PORT_FETCH, handIds: [1, 2] })
    )

    handleReplayPortMessage({
      type: REPLAY_PORT_RESULT,
      epoch: sentRequest(port).epoch,
      requestId: sentRequestId(port),
      results: [{ handId: 1, ok: true, detail: { a: 1 } }]
    }, port)

    const outcome = await pending
    expect(outcome).toEqual({
      success: true,
      results: [{ handId: 1, ok: true, detail: { a: 1 } }]
    })
  })

  it('依頼していないポートからの応答では解決しない', async () => {
    const port = makeInactiveActivePort()
    const other = makePort()

    const pending = requestReplayDetails([1])
    await Promise.resolve()
    const requestId = sentRequestId(port)
    const epoch = sentRequest(port).epoch

    // 別タブが同じrequestIdを騙っても、依頼元のポートでなければ無視する
    handleReplayPortMessage({
      type: REPLAY_PORT_RESULT,
      epoch,
      requestId,
      results: [{ handId: 1, ok: true, detail: 'from-other-tab' }]
    }, other)

    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    handleReplayPortMessage({
      type: REPLAY_PORT_RESULT,
      epoch,
      requestId,
      results: [{ handId: 1, ok: true, detail: 'from-origin' }]
    }, port)
    const outcome = await pending
    expect(outcome).toEqual({
      success: true,
      results: [{ handId: 1, ok: true, detail: 'from-origin' }]
    })
  })

  it('同じrequestIdでも異なるSW epochの応答では解決しない', async () => {
    const port = makeInactiveActivePort()
    const pending = requestReplayDetails([1])
    await Promise.resolve()
    const { epoch, requestId } = sentRequest(port)

    handleReplayPortMessage({
      type: REPLAY_PORT_RESULT,
      epoch: 'terminated-sw-epoch',
      requestId,
      results: [{ handId: 1, ok: true, detail: 'stale' }]
    }, port)
    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    handleReplayPortMessage({
      type: REPLAY_PORT_RESULT,
      epoch,
      requestId,
      results: [{ handId: 1, ok: true, detail: 'current' }]
    }, port)
    expect(await pending).toEqual({
      success: true,
      results: [{ handId: 1, ok: true, detail: 'current' }]
    })
  })

  it('ポート切断で待ちを解放する（応答が来ないまま待ち続けない）', async () => {
    const port = makeInactiveActivePort()

    const pending = requestReplayDetails([1])
    await Promise.resolve()
    releaseReplayRequestsForPort(port)

    expect(await pending).toEqual({ success: true, results: [] })
  })

  it('dedup済み開始は全game pageへ補助cancelを送り、現在の待ちを解放する', async () => {
    const port = makeInactiveActivePort()
    const relic = makePort()
    connectedPorts.add(relic)
    const pending = requestReplayDetails([1])
    await Promise.resolve()

    expect(cancelReplayRequestsForSessionStart()).toBe(1)
    expect(port.postMessage).toHaveBeenCalledWith({ type: REPLAY_PORT_CANCEL })
    expect(relic.postMessage).toHaveBeenCalledWith({ type: REPLAY_PORT_CANCEL })
    expect(await pending).toEqual({ success: true, results: [] })
  })

  it('SW再起動直後のtoken未生成はunknownとして即座に拒否する', async () => {
    expect(await requestReplayDetails([1])).toEqual({
      success: false,
      error: 'active game session'
    })
  })

  it('ACTIVE portがセッション中ならpostMessageしない', async () => {
    const port = makeInactiveActivePort()
    markActivePortSessionActive(resolveGeneration(port)!)

    expect(await requestReplayDetails([1])).toEqual({
      success: false,
      error: 'active game session'
    })
    expect(port.postMessage).not.toHaveBeenCalled()
  })

  it('セッション外のACTIVEへ/list検証を依頼し、期限フィールドだけで解決する', async () => {
    const port = makeInactiveActivePort()
    const pending = requestReplayVerification(port)
    await flushMicrotasks()
    // 検証も詳細取得と同じepochを載せる。
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: REPLAY_PORT_VERIFY,
      epoch: expect.any(String)
    }))

    handleReplayPortMessage({
      type: REPLAY_PORT_VERIFY_RESULT,
      epoch: sentRequest(port).epoch,
      requestId: sentRequestId(port),
      ok: true,
      entitlement: { cardOpenEndDate: 1_786_000_000, isExpiredCardOpen: false }
    }, port)

    await expect(pending).resolves.toEqual({
      success: true,
      entitlement: { cardOpenEndDate: 1_786_000_000, isExpiredCardOpen: false }
    })
  })

  it('epochの違う/list検証応答では解決しない', async () => {
    const port = makeInactiveActivePort()
    const pending = requestReplayVerification(port)
    await flushMicrotasks()

    handleReplayPortMessage({
      type: REPLAY_PORT_VERIFY_RESULT,
      epoch: 'other-service-worker-epoch',
      requestId: sentRequestId(port),
      ok: true,
      entitlement: { cardOpenEndDate: 1_786_000_000, isExpiredCardOpen: false }
    }, port)
    releaseReplayRequestsForPort(port)

    await expect(pending).resolves.toEqual({ success: false, error: 'game tab disconnected' })
  })

  // #361のfairness gateは token未生成・unknown・reconnect猶予をすべて対局中と
  // して扱う。検証だけを「ACTIVE未確定なら接続portで代替してよい」と緩めると、
  // その不変条件を検証経路の側から破ることになる。
  it('ACTIVE未確定のホーム画面では/list検証も撃たない', async () => {
    const port = makePort()
    connectedPorts.add(port)

    await expect(requestReplayVerification(port)).resolves.toEqual({
      success: false,
      error: REPLAY_VERIFY_IN_SESSION
    })
    expect(port.postMessage).not.toHaveBeenCalled()
  })

  it('ACTIVE portがセッション中なら/list検証もpostMessageしない', async () => {
    const port = makeInactiveActivePort()
    markActivePortSessionActive(resolveGeneration(port)!)

    await expect(requestReplayVerification(port)).resolves.toEqual({
      success: false,
      error: REPLAY_VERIFY_IN_SESSION
    })
    expect(port.postMessage).not.toHaveBeenCalled()
  })

  it('セッション開始の一括CANCELは進行中の/list検証も畳む', async () => {
    const port = makeInactiveActivePort()
    const pending = requestReplayVerification(port)
    await flushMicrotasks()
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: REPLAY_PORT_VERIFY }))

    cancelReplayRequestsForSessionStart()

    await expect(pending).resolves.toEqual({
      success: false,
      error: REPLAY_VERIFY_IN_SESSION
    })
  })

  it.each([
    [[], 'handIds must be a non-empty array'],
    [[0], 'handIds must be positive safe integers'],
    [[-1], 'handIds must be positive safe integers'],
    [[1.5], 'handIds must be positive safe integers'],
    [['1'], 'handIds must be positive safe integers'],
  ])('不正なhandIds(%p)を拒否する', async (handIds, error) => {
    connectedPorts.add(makePort())
    expect(await requestReplayDetails(handIds)).toEqual({ success: false, error })
  })

  it('バッチ上限を超える依頼を拒否する', async () => {
    connectedPorts.add(makePort())
    const tooMany = Array.from({ length: REPLAY_FETCH_BATCH_LIMIT + 1 }, (_, i) => i + 1)

    expect(await requestReplayDetails(tooMany)).toEqual({
      success: false,
      error: `handIds exceeds ${REPLAY_FETCH_BATCH_LIMIT}`
    })
  })

  it('SWのグローバルへ取得関数を生やす', () => {
    // 入口をchrome.runtime.sendMessageにすると、SWのDevToolsコンソールから
    // 叩いたときに送信元自身のonMessageへは配送されず
    // "Could not establish connection. Receiving end does not exist." になる。
    // 唯一の想定利用者がSWコンソールなので、グローバルに生やす。
    delete (globalThis as unknown as Record<string, unknown>).pokerChaseReplayFetch
    exposeReplayFetchForDevtools()

    expect((globalThis as unknown as Record<string, unknown>).pokerChaseReplayFetch)
      .toBe(requestReplayDetails)
  })

  it('リプレイ以外のポートメッセージは横取りしない', () => {
    const port = makePort()
    expect(handleReplayPortMessage({ ApiTypeId: 303, timestamp: 1 }, port)).toBe(false)
    expect(handleReplayPortMessage({ type: 'keepalive' }, port)).toBe(false)
    expect(handleReplayPortMessage(null, port)).toBe(false)
  })
})
