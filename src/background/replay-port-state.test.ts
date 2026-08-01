/**
 * ポートごとのセッション状態とアカウント。
 *
 * 畳んだ `sessionActivity`（forced update と共有）は最後に届いたイベントしか
 * 表さないので、複数タブでは「どのタブも対局していない」ことを保証できない。
 * ここはその不足を取得側だけで埋めるための最小の器で、判定の性質
 * （不明は対局中扱い・接続ゼロは撃たない）を固定する。
 */
import { connectedPorts } from './ports'
import {
  __resetReplayPortStateForTests,
  allConnectedPortsInactive,
  findPortForPlayer,
  markPortPlayerId,
  markPortSessionActive,
  markPortSessionInactive
} from './replay-port-state'

const portOf = (name: string): chrome.runtime.Port =>
  ({ name } as unknown as chrome.runtime.Port)

describe('replay port state', () => {
  const tabA = portOf('tab-a')
  const tabB = portOf('tab-b')

  beforeEach(() => {
    __resetReplayPortStateForTests()
    connectedPorts.clear()
  })

  afterEach(() => {
    connectedPorts.clear()
  })

  describe('allConnectedPortsInactive', () => {
    test('接続が1つも無ければ偽（そもそも撃てない）', () => {
      expect(allConnectedPortsInactive()).toBe(false)
    })

    test('状態不明のポートは対局中として扱う', () => {
      connectedPorts.add(tabA)
      expect(allConnectedPortsInactive()).toBe(false)
    })

    test('全ポートがinactiveのときだけ真', () => {
      connectedPorts.add(tabA)
      connectedPorts.add(tabB)
      markPortSessionInactive(tabA)
      expect(allConnectedPortsInactive()).toBe(false)

      markPortSessionInactive(tabB)
      expect(allConnectedPortsInactive()).toBe(true)

      // 片方が対局を始めたら再び偽
      markPortSessionActive(tabB)
      expect(allConnectedPortsInactive()).toBe(false)
    })

    test('対局中のタブが閉じれば真に戻る', () => {
      connectedPorts.add(tabA)
      connectedPorts.add(tabB)
      markPortSessionInactive(tabA)
      markPortSessionActive(tabB)
      expect(allConnectedPortsInactive()).toBe(false)

      connectedPorts.delete(tabB)
      expect(allConnectedPortsInactive()).toBe(true)
    })
  })

  describe('findPortForPlayer', () => {
    test('そのアカウントを観測したポートを選ぶ', () => {
      connectedPorts.add(tabA)
      connectedPorts.add(tabB)
      markPortPlayerId(tabA, 111)
      markPortPlayerId(tabB, 222)

      expect(findPortForPlayer(111)).toBe(tabA)
      expect(findPortForPlayer(222)).toBe(tabB)
    })

    test('一致するポートが無ければ undefined（別アカウントへ投げない）', () => {
      connectedPorts.add(tabA)
      markPortPlayerId(tabA, 111)
      expect(findPortForPlayer(999)).toBeUndefined()
    })

    test('アカウント不明のキューは、観測アカウントが1つのときだけ通す', () => {
      connectedPorts.add(tabA)
      connectedPorts.add(tabB)
      markPortPlayerId(tabA, 111)
      markPortPlayerId(tabB, 111)
      expect(findPortForPlayer(undefined)).toBe(tabA)

      markPortPlayerId(tabB, 222)
      expect(findPortForPlayer(undefined)).toBeUndefined()
    })

    test('アカウントを1つも観測していなければ、単一接続に限って通す', () => {
      connectedPorts.add(tabA)
      expect(findPortForPlayer(undefined)).toBe(tabA)

      connectedPorts.add(tabB)
      expect(findPortForPlayer(undefined)).toBeUndefined()
    })
  })
})
