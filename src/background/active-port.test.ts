import {
  ACTIVE_PORT_RECONNECT_WINDOW_MS,
  ACTIVE_PORT_VIOLATION_WINDOW_MS,
  __resetActivePortStateForTests,
  claimActivePort,
  findActivePortForPlayer,
  getActivePort,
  getActivePortActivity,
  isActivePortOutsideSession,
  markActivePortPlayerId,
  markActivePortSessionActive,
  markActivePortSessionInactive,
  readActivePortPlayerId,
  registerActivePortConnection,
  releaseActivePort
} from './active-port'

const makePort = (name: string, tabId: number, documentId: string): chrome.runtime.Port =>
  ({ name, sender: { tab: { id: tabId }, documentId } } as chrome.runtime.Port)

describe('active-port token', () => {
  let tabA: chrome.runtime.Port
  let tabB: chrome.runtime.Port

  beforeEach(() => {
    __resetActivePortStateForTests()
    tabA = makePort('tab-a', 1, 'document-a')
    tabB = makePort('tab-b', 2, 'document-b')
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('最後にgame eventを届けたportがtokenを持ち、handoverはactivityをunknownへ戻す', () => {
    expect(claimActivePort(tabA, 1_000)).toBe('handover')
    markActivePortSessionInactive(tabA)
    expect(getActivePort()).toBe(tabA)
    expect(getActivePortActivity()).toBe('inactive')

    expect(claimActivePort(tabB, 20_000)).toBe('handover')
    expect(getActivePort()).toBe(tabB)
    expect(getActivePortActivity()).toBe('unknown')

    // 同じportの次イベントはhandoverではなく、既知activityを保つ。
    markActivePortSessionActive(tabB)
    expect(claimActivePort(tabB, 21_000)).toBe('same-port')
    expect(getActivePortActivity()).toBe('active')
  })

  test('旧portが再利用されるとtokenと、そのportで観測済みのaccountを取り戻す', () => {
    claimActivePort(tabA, 1_000)
    markActivePortPlayerId(tabA, 111)

    claimActivePort(tabB, 20_000)
    markActivePortPlayerId(tabB, 222)
    expect(readActivePortPlayerId()).toBe(222)

    claimActivePort(tabA, 40_000)
    expect(getActivePort()).toBe(tabA)
    expect(readActivePortPlayerId()).toBe(111)
    expect(findActivePortForPlayer(111)).toBe(tabA)
    expect(findActivePortForPlayer(222)).toBeUndefined()
  })

  test('fairness gateはACTIVE sessionだけを見て、unknown/activeを止める', () => {
    // tokenが無ければsessionも無い。送信先解決は別に失敗する。
    expect(isActivePortOutsideSession()).toBe(true)
    expect(findActivePortForPlayer(111)).toBeUndefined()

    claimActivePort(tabA, 1_000)
    expect(getActivePortActivity()).toBe('unknown')
    expect(isActivePortOutsideSession()).toBe(false)

    markActivePortSessionActive(tabA)
    expect(isActivePortOutsideSession()).toBe(false)

    markActivePortSessionInactive(tabA)
    expect(isActivePortOutsideSession()).toBe(true)
  })

  test('account不明またはキューaccount不一致ならACTIVE portへも依頼しない', () => {
    claimActivePort(tabA, 1_000)
    markActivePortSessionInactive(tabA)
    expect(findActivePortForPlayer(undefined)).toBeUndefined()

    markActivePortPlayerId(tabA, 111)
    expect(findActivePortForPlayer(undefined)).toBe(tabA)
    expect(findActivePortForPlayer(111)).toBe(tabA)
    expect(findActivePortForPlayer(222)).toBeUndefined()
  })

  test('ACTIVE portの切断はtokenを空にし、relicの切断はtokenを変えない', () => {
    claimActivePort(tabA, 1_000)
    claimActivePort(tabB, 20_000)

    expect(releaseActivePort(tabA)).toBe('relic')
    expect(getActivePort()).toBe(tabB)

    expect(releaseActivePort(tabB, 21_000)).toBe('reconnect-pending')
    expect(getActivePort()).toBeUndefined()
    expect(isActivePortOutsideSession()).toBe(true)
  })

  test('同一tab/documentのRuntimePortManager再接続はactivityとaccountを引き継ぐ', () => {
    const replacement = makePort('tab-a-reconnected', 1, 'document-a')
    claimActivePort(tabA, 1_000)
    markActivePortSessionActive(tabA)
    markActivePortPlayerId(tabA, 111)

    expect(releaseActivePort(tabA, 2_000)).toBe('reconnect-pending')
    expect(registerActivePortConnection(replacement, 2_500)).toBe(true)
    expect(claimActivePort(replacement, 12_000)).toBe('same-tab-reconnect')
    expect(getActivePortActivity()).toBe('active')
    expect(readActivePortPlayerId()).toBe(111)
  })

  test.each([
    ['別tab', makePort('other-tab', 2, 'document-a'), 2_500],
    ['別document', makePort('reloaded-tab', 1, 'document-new'), 2_500],
    ['再接続窓超過', makePort('late-tab', 1, 'document-a'), 2_000 + ACTIVE_PORT_RECONNECT_WINDOW_MS + 1]
  ])('%sは同一content script再接続として扱わない', (_label, replacement, connectedAt) => {
    claimActivePort(tabA, 1_000)
    markActivePortSessionActive(tabA)
    releaseActivePort(tabA, 2_000)

    expect(registerActivePortConnection(replacement, connectedAt)).toBe(false)
    expect(claimActivePort(replacement, 20_000)).toBe('handover')
    expect(getActivePortActivity()).toBe('unknown')
  })

  test('synthetic violation fixture: 10秒未満に別portが届けるとsentinelだけが発火する', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    claimActivePort(tabA, 1_000)

    expect(claimActivePort(tabB, 1_000 + ACTIVE_PORT_VIOLATION_WINDOW_MS - 1)).toBe('handover')
    expect(warn).toHaveBeenCalledWith(
      '[background] Active-port axiom sentinel: different ports delivered game events within 10 seconds'
    )
    // violationを支える分岐は作らず、最新portがそのままtokenを持つ。
    expect(getActivePort()).toBe(tabB)
  })

  test('sentinel window以上の通常handoverでは警告しない', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    claimActivePort(tabA, 1_000)
    claimActivePort(tabB, 1_000 + ACTIVE_PORT_VIOLATION_WINDOW_MS)
    expect(warn).not.toHaveBeenCalled()
  })
})
