import {
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
  releaseActivePort
} from './active-port'

const makePort = (name: string): chrome.runtime.Port =>
  ({ name } as chrome.runtime.Port)

describe('active-port token', () => {
  let tabA: chrome.runtime.Port
  let tabB: chrome.runtime.Port

  beforeEach(() => {
    __resetActivePortStateForTests()
    tabA = makePort('tab-a')
    tabB = makePort('tab-b')
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('最後にgame eventを届けたportがtokenを持ち、handoverはactivityをunknownへ戻す', () => {
    expect(claimActivePort(tabA, 1_000)).toBe(true)
    markActivePortSessionInactive(tabA)
    expect(getActivePort()).toBe(tabA)
    expect(getActivePortActivity()).toBe('inactive')

    expect(claimActivePort(tabB, 20_000)).toBe(true)
    expect(getActivePort()).toBe(tabB)
    expect(getActivePortActivity()).toBe('unknown')

    // 同じportの次イベントはhandoverではなく、既知activityを保つ。
    markActivePortSessionActive(tabB)
    expect(claimActivePort(tabB, 21_000)).toBe(false)
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

    expect(releaseActivePort(tabA)).toBe(false)
    expect(getActivePort()).toBe(tabB)

    expect(releaseActivePort(tabB)).toBe(true)
    expect(getActivePort()).toBeUndefined()
    expect(isActivePortOutsideSession()).toBe(true)
  })

  test('synthetic violation fixture: 10秒未満に別portが届けるとsentinelだけが発火する', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    claimActivePort(tabA, 1_000)

    expect(claimActivePort(tabB, 1_000 + ACTIVE_PORT_VIOLATION_WINDOW_MS - 1)).toBe(true)
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
