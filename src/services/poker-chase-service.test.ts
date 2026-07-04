/**
 * PokerChaseService - explicit session persistence tests
 *
 * Covers the refactor that replaced the implicit persistence triggers
 * (hand-written getter/setter pairs + a monkey-patched `session.players.set`)
 * with an explicit `SessionState` class. These tests pin down the observable
 * behavior that must not regress:
 *  - mutations schedule a single debounced `chrome.storage.local.set` call
 *  - restoring from storage never re-triggers persistence
 *  - the persisted shape is unchanged, so state written by the old
 *    implementation still hydrates correctly
 */
import PokerChaseService, { PokerChaseDB } from '../app'
import { SessionState } from './poker-chase-service'
import { ApiType } from '../types'
import type { ApiEvent } from '../types'
import { BattleType } from '../types/game'
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'

const STORAGE_KEY = PokerChaseService.STORAGE_KEY

const dealEvent: ApiEvent<ApiType.EVT_DEAL> = {
  ApiTypeId: ApiType.EVT_DEAL,
  SeatUserIds: [101, 102, 103],
  Game: { CurrentBlindLv: 1, NextBlindUnixSeconds: 0, Ante: 0, SmallBlind: 100, BigBlind: 200, ButtonSeat: 0, SmallBlindSeat: 1, BigBlindSeat: 2 },
  Player: { SeatIndex: 0, BetStatus: 1, HoleCards: [0, 1], Chip: 5000, BetChip: 0 },
  OtherPlayers: [
    { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 100, IsSafeLeave: false },
    { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 200, IsSafeLeave: false },
  ],
  Progress: { Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 400, Pot: 300, SidePot: [] },
  timestamp: 1000,
}

/** Clear the mocked chrome.storage.local state between tests */
async function clearStorage() {
  await chrome.storage.local.set({ [STORAGE_KEY]: undefined })
  jest.clearAllMocks()
}

function newService() {
  const db = new PokerChaseDB(indexedDB, IDBKeyRange)
  return new PokerChaseService({ db })
}

describe('PokerChaseService - explicit session persistence', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(async () => {
    jest.useRealTimers()
    await clearStorage()
  })

  test('N回の連続ミューテーションが1回のstorage.set呼び出しにデバウンスされる', async () => {
    const service = newService()
    await service.ready

    service.session.setId('session-1')
    service.session.setBattleType(BattleType.SIT_AND_GO)
    service.session.setName('Test Table')
    service.session.setPlayer(1, { name: 'Alice', rank: 'gold' })
    service.session.setPlayer(2, { name: 'Bob', rank: 'silver' })
    service.playerId = 1
    service.latestEvtDeal = dealEvent

    // Debounce window (500ms) hasn't elapsed yet
    expect(chrome.storage.local.set).not.toHaveBeenCalled()

    jest.advanceTimersByTime(500)
    // Allow the promise returned by chrome.storage.local.set to settle
    await Promise.resolve()

    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1)
    const [payload] = (chrome.storage.local.set as jest.Mock).mock.calls[0]
    const state = payload[STORAGE_KEY]
    expect(state.playerId).toBe(1)
    expect(state.latestEvtDeal).toEqual(dealEvent)
    expect(state.session.id).toBe('session-1')
    expect(state.session.battleType).toBe(BattleType.SIT_AND_GO)
    expect(state.session.name).toBe('Test Table')
    expect(state.session.players).toEqual([
      [1, { name: 'Alice', rank: 'gold' }],
      [2, { name: 'Bob', rank: 'silver' }],
    ])
  })

  test('restoreState()はストレージへの書き戻し（persist）をトリガーしない', async () => {
    // Pre-seed storage as if a previous session had persisted state
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        playerId: 42,
        latestEvtDeal: dealEvent,
        session: {
          id: 'restored-session',
          battleType: BattleType.TOURNAMENT,
          name: 'Restored Table',
          players: [[1, { name: 'Alice', rank: 'gold' }]],
        },
        lastUpdated: Date.now(),
      },
    })
    jest.clearAllMocks()

    const service = newService()
    await service.ready

    // Restoration applied the values...
    expect(service.playerId).toBe(42)
    expect(service.session.id).toBe('restored-session')
    expect(service.session.battleType).toBe(BattleType.TOURNAMENT)
    expect(service.session.name).toBe('Restored Table')
    expect(service.session.players.get(1)).toEqual({ name: 'Alice', rank: 'gold' })

    // ...but did NOT schedule/trigger any persistence
    jest.advanceTimersByTime(1000)
    await Promise.resolve()
    expect(chrome.storage.local.set).not.toHaveBeenCalled()
  })

  test('reset()はpersistをトリガーし、セッションをクリアする', async () => {
    const service = newService()
    await service.ready

    service.session.setId('session-1')
    service.session.setPlayer(1, { name: 'Alice', rank: 'gold' })
    jest.advanceTimersByTime(500)
    await Promise.resolve()
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1)

    service.resetSession()
    jest.advanceTimersByTime(500)
    await Promise.resolve()

    expect(chrome.storage.local.set).toHaveBeenCalledTimes(2)
    const [payload] = (chrome.storage.local.set as jest.Mock).mock.calls[1]
    const state = payload[STORAGE_KEY]
    expect(state.session.id).toBeUndefined()
    expect(state.session.battleType).toBeUndefined()
    expect(state.session.name).toBeUndefined()
    expect(state.session.players).toEqual([])

    expect(service.session.id).toBeUndefined()
    expect(service.session.players.size).toBe(0)
  })

  test('setPlayer()によるプレイヤー追加はpersistをトリガーする', async () => {
    const service = newService()
    await service.ready

    service.session.setPlayer(7, { name: 'Carol', rank: 'diamond' })
    jest.advanceTimersByTime(500)
    await Promise.resolve()

    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1)
    expect(service.session.players.get(7)).toEqual({ name: 'Carol', rank: 'diamond' })
  })

  test('players の読み取り（get/size/entries）は可能で、setPlayer()経由でのみ更新される', async () => {
    const service = newService()
    await service.ready

    expect(service.session.players.size).toBe(0)
    service.session.setPlayer(7, { name: 'Carol', rank: 'diamond' })
    expect(service.session.players.size).toBe(1)
    expect(service.session.players.get(7)).toEqual({ name: 'Carol', rank: 'diamond' })
    expect(Array.from(service.session.players.entries())).toEqual([[7, { name: 'Carol', rank: 'diamond' }]])
    // Note: `session.players.set(...)` is a *compile-time* error (ReadonlyMap) -
    // enforced by `npm run typecheck`, not something we can assert at runtime
    // without `any`-casting past the type system.
  })

  test('旧フォーマットで永続化されたstateが正しくhydrateされる（ストレージ形式の後方互換性）', async () => {
    // This mirrors exactly what the OLD implementation (pre-refactor) wrote to
    // chrome.storage.local: playerId, latestEvtDeal, session:{id,battleType,name,players:[[k,v]...]}, lastUpdated
    const oldFormatState = {
      playerId: 123,
      latestEvtDeal: dealEvent,
      session: {
        id: 'legacy-session-456',
        battleType: BattleType.RING_GAME,
        name: 'Legacy Ring Table',
        players: [
          [101, { name: 'Player101', rank: 'legend' }],
          [102, { name: 'Player102', rank: 'diamond' }],
        ],
      },
      lastUpdated: 1700000000000,
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: oldFormatState })
    jest.clearAllMocks()

    const service = newService()
    await service.ready

    expect(service.playerId).toBe(123)
    expect(service.latestEvtDeal).toEqual(dealEvent)
    expect(service.session.id).toBe('legacy-session-456')
    expect(service.session.battleType).toBe(BattleType.RING_GAME)
    expect(service.session.name).toBe('Legacy Ring Table')
    expect(service.session.players.size).toBe(2)
    expect(service.session.players.get(101)).toEqual({ name: 'Player101', rank: 'legend' })
    expect(service.session.players.get(102)).toEqual({ name: 'Player102', rank: 'diamond' })

    // And hydrating must not have scheduled a persist
    jest.advanceTimersByTime(1000)
    await Promise.resolve()
    expect(chrome.storage.local.set).not.toHaveBeenCalled()
  })
})

describe('SessionState (standalone unit tests)', () => {
  test('明示的なセッターは全てnotifyChangeを一度だけ呼ぶ', () => {
    const notifyChange = jest.fn()
    const session = new SessionState(notifyChange)

    session.setId('s1')
    session.setBattleType(BattleType.SIT_AND_GO)
    session.setName('Table')
    session.setPlayer(1, { name: 'Alice', rank: 'gold' })
    session.reset()

    expect(notifyChange).toHaveBeenCalledTimes(5)
  })

  test('hydrate()はnotifyChangeを呼ばない', () => {
    const notifyChange = jest.fn()
    const session = new SessionState(notifyChange)

    session.hydrate({
      id: 's1',
      battleType: BattleType.TOURNAMENT,
      name: 'Table',
      players: [[1, { name: 'Alice', rank: 'gold' }]],
    })

    expect(notifyChange).not.toHaveBeenCalled()
    expect(session.id).toBe('s1')
    expect(session.battleType).toBe(BattleType.TOURNAMENT)
    expect(session.name).toBe('Table')
    expect(session.players.get(1)).toEqual({ name: 'Alice', rank: 'gold' })
  })

  test('toJSON()は永続化形式（players配列化済み）を返す', () => {
    const session = new SessionState(() => { })
    session.setId('s1')
    session.setBattleType(BattleType.SIT_AND_GO)
    session.setName('Table')
    session.setPlayer(1, { name: 'Alice', rank: 'gold' })

    expect(session.toJSON()).toEqual({
      id: 's1',
      battleType: BattleType.SIT_AND_GO,
      name: 'Table',
      players: [[1, { name: 'Alice', rank: 'gold' }]],
    })
  })
})
