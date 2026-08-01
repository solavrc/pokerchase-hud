import { connectedPorts } from './ports'
import {
  REPLAY_PORT_FETCH,
  REPLAY_PORT_RESULT,
  REPLAY_FETCH_BATCH_LIMIT
} from '../replay/protocol'
import {
  __resetReplayFetchBridgeForTests,
  exposeReplayFetchForDevtools,
  handleReplayPortMessage,
  releaseReplayRequestsForPort,
  requestReplayDetails
} from './replay-fetch-bridge'

const makePort = () => ({ postMessage: jest.fn() }) as unknown as chrome.runtime.Port

const sentRequestId = (port: chrome.runtime.Port): string =>
  (port.postMessage as jest.Mock).mock.calls[0]![0].requestId

describe('replay-fetch-bridge（開発用の取得入口）', () => {
  beforeEach(() => {
    __resetReplayFetchBridgeForTests()
    connectedPorts.clear()
  })

  it('接続中のゲームタブへ取得を依頼し、応答で解決する', async () => {
    const port = makePort()
    connectedPorts.add(port)

    const pending = requestReplayDetails([1, 2])
    await Promise.resolve()

    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: REPLAY_PORT_FETCH, handIds: [1, 2] })
    )

    handleReplayPortMessage({
      type: REPLAY_PORT_RESULT,
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
    const port = makePort()
    const other = makePort()
    connectedPorts.add(port)

    const pending = requestReplayDetails([1])
    await Promise.resolve()
    const requestId = sentRequestId(port)

    // 別タブが同じrequestIdを騙っても、依頼元のポートでなければ無視する
    handleReplayPortMessage({
      type: REPLAY_PORT_RESULT,
      requestId,
      results: [{ handId: 1, ok: true, detail: 'from-other-tab' }]
    }, other)

    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    handleReplayPortMessage({
      type: REPLAY_PORT_RESULT,
      requestId,
      results: [{ handId: 1, ok: true, detail: 'from-origin' }]
    }, port)
    const outcome = await pending
    expect(outcome).toEqual({
      success: true,
      results: [{ handId: 1, ok: true, detail: 'from-origin' }]
    })
  })

  it('ポート切断で待ちを解放する（応答が来ないまま待ち続けない）', async () => {
    const port = makePort()
    connectedPorts.add(port)

    const pending = requestReplayDetails([1])
    await Promise.resolve()
    releaseReplayRequestsForPort(port)

    expect(await pending).toEqual({ success: true, results: [] })
  })

  it('接続が無ければ即座に失敗を返す', async () => {
    expect(await requestReplayDetails([1])).toEqual({
      success: false,
      error: 'no connected game tab'
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
