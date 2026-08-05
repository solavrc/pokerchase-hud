/**
 * ports.ts -- `replayDetailEpoch` (post-session replay-detail drain -> open
 * recent-hands panels).
 *
 * The drain writes `replayDetails` / Lake 90001 rows 1.5s apart after a
 * session ends, but nothing on that path reached an open recent-hands panel:
 * the panel only refetches when its `handEpoch` prop changes, and that counter
 * is deliberately bumped by hand completions alone. This file pins the wire
 * half of the fix:
 *  - the notification is a dedicated, minimal message (`{ replayEpoch }`) --
 *    it must NOT re-send `stats` / `realTimeStats` / `handEpoch`, because
 *    nothing about the lineup, the current hand or hand completion changed
 *  - it goes to the ACTIVE port only (Design Principles #19): post-session the
 *    ACTIVE port is the tab that just played, which is where the panels are.
 *    Relics receive nothing.
 */
import { connectedPorts, notifyReplayDetailsStored } from './ports'
import { __resetActivePortStateForTests, claimActivePort } from './active-port'

const portOf = () => ({ postMessage: jest.fn() })

describe('ports.ts replayDetailEpoch', () => {
  let active: ReturnType<typeof portOf>

  beforeEach(() => {
    active = portOf()
    connectedPorts.add(active as unknown as chrome.runtime.Port)
    claimActivePort(active as unknown as chrome.runtime.Port)
  })

  afterEach(() => {
    connectedPorts.clear()
    __resetActivePortStateForTests()
  })

  test('ACTIVEポートへ`replayEpoch`だけを送り、呼ぶたびに1つ進む', () => {
    notifyReplayDetailsStored()
    notifyReplayDetailsStored()

    expect(active.postMessage).toHaveBeenCalledTimes(2)
    const [first] = active.postMessage.mock.calls[0]!
    const [second] = active.postMessage.mock.calls[1]!
    expect(typeof first.replayEpoch).toBe('number')
    expect(second.replayEpoch).toBe(first.replayEpoch + 1)
    // lineup・現在ハンド専用値・ハンド完了epochは載せない。
    expect(Object.keys(first)).toEqual(['replayEpoch'])
  })

  test('relicポートは受け取らない（ACTIVEだけ、Design Principles #19）', () => {
    const successor = portOf()
    connectedPorts.add(successor as unknown as chrome.runtime.Port)
    // 別tabがゲームイベントを届けてtokenを引き継ぐ -> `active`はrelicになる。
    claimActivePort(successor as unknown as chrome.runtime.Port)
    active.postMessage.mockClear()

    notifyReplayDetailsStored()

    expect(successor.postMessage).toHaveBeenCalledTimes(1)
    expect(active.postMessage).not.toHaveBeenCalled()
  })

  test('ACTIVEポートが無ければ何も送らない（connected fallbackはしない）', () => {
    __resetActivePortStateForTests()

    expect(() => notifyReplayDetailsStored()).not.toThrow()
    expect(active.postMessage).not.toHaveBeenCalled()
  })
})
