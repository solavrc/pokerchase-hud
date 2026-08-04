/**
 * `lastKnownStats`はフィルター再計算に使うService Worker生存期間のキャッシュ。
 * 終了したセッションの集計lineupはHUDと直近ハンドの振り返りに使うため、
 * EVT_SESSION_RESULTSで無効化してはならない（MUST NOT）。セッション状態、
 * 自動同期、リプレイ取り込み、生イベント保存はevent-ingestion.tsで独立して309を扱う。
 *
 * 壊れた309がZod検証を通らない場合も同じ保持を保証する。プリゲームのヒーロー
 * フォールバックはIndexedDBを読む別経路のまま。
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { trackServiceForTeardown } from '../utils/test-service-teardown'
import { ApiType } from '../types'
import { registerEventIngestion } from './event-ingestion'
import { registerMessageRouter } from './message-router'
import {
  connectedPorts,
  getLastKnownStats,
  registerStreamSubscriptions,
  setLastKnownStats,
} from './ports'
import { BattleType } from '../types/game'
import type { ChromeMessage, MessageResponse } from '../types/messages'
import type { Hand } from '../types/entities'

const HERO_ID = 1

const FILTER_OPTIONS = {
  gameTypes: { sng: true, mtt: true, ring: true }
}

/**
 * Polls `condition` until true, or throws after `timeoutMs`. The DB-backed
 * getLatestSessionStats() promise chain (service.ready/filtersRestored ->
 * Dexie query -> sendResponse) can take more than one macrotask tick to
 * settle under full-suite load -- same flake `message-router.pregame-live-
 * clobber-guard.test.ts`'s `waitUntil` was added to avoid.
 */
const waitUntil = async (condition: () => boolean, timeoutMs = 2000): Promise<void> => {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitUntil timed out after ${timeoutMs}ms`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function makeHand(overrides: Partial<Hand> & { id: number, seatUserIds: number[] }): Hand {
  return {
    bigBlindUserId: overrides.seatUserIds[1] ?? -1,
    winningPlayerIds: [],
    smallBlind: 100,
    bigBlind: 200,
    session: { battleType: BattleType.TOURNAMENT },
    results: [],
    ...overrides
  }
}

describe('session end (309) retains background lastKnownStats', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let onMessageHandler: (message: any) => Promise<void>
  let disconnectHandlers: Array<() => void>
  let mockPort: any
  let messageListener: (request: ChromeMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: MessageResponse) => void) => boolean | void
  let sendMessageMock: jest.Mock
  let writeSpy: jest.SpyInstance

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = trackServiceForTeardown(new PokerChaseService({ db }))
    await service.ready
    service.playerId = HERO_ID

    setLastKnownStats([])

    sendMessageMock = jest.fn()
    ;(global as any).chrome.tabs = {
      sendMessage: sendMessageMock,
      query: jest.fn((_query, callback) => callback([])),
    }

    ;(chrome.runtime as any).onConnect = { addListener: jest.fn() }
    ;(chrome.runtime.onMessage.addListener as jest.Mock).mockClear()

    registerEventIngestion(service)
    registerStreamSubscriptions(service, 'https://example.com/*')
    registerMessageRouter(service, db, 'https://example.com/*')

    const connectListener = (chrome.runtime as any).onConnect.addListener.mock.calls[0][0]
    disconnectHandlers = []
    mockPort = {
      name: PokerChaseService.POKER_CHASE_SERVICE_EVENT,
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn((fn: () => void) => disconnectHandlers.push(fn)) },
      postMessage: jest.fn()
    }
    connectListener(mockPort)
    onMessageHandler = mockPort.onMessage.addListener.mock.calls[0][0]

    messageListener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0]

    writeSpy = jest.spyOn(service.statsOutputStream, 'write').mockImplementation(() => true)
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    disconnectHandlers.forEach(fn => fn())
    connectedPorts.clear()
    delete (global as any).chrome.tabs
    setLastKnownStats([])
    db.close()
    await db.delete()
  })

  const sessionResultsEvent = {
    ApiTypeId: ApiType.EVT_SESSION_RESULTS,
    timestamp: 1000,
    Ranking: 3,
    IsLeave: false,
    IsRebuy: false,
    TotalMatch: 100,
    RankReward: {
      IsSeasonal: true,
      RankPoint: 10,
      RankPointDiff: 1,
      Rank: { RankId: 'gold', RankName: 'ゴールド', RankLvId: 'gold', RankLvName: 'ゴールド' },
      SeasonalRanking: 0
    },
    Rewards: [],
    EventRewards: [],
    Charas: [],
    Costumes: [],
    Decos: [],
    Items: [],
    Money: { FreeMoney: -1, PaidMoney: -1 },
    Emblems: []
  }

  test('raw EVT_SESSION_RESULTS (309) retains lastKnownStats', async () => {
    const retainedLineup = [{ playerId: 2, statResults: [] } as any]
    setLastKnownStats(retainedLineup)
    await onMessageHandler(sessionResultsEvent)

    expect(getLastKnownStats()).toBe(retainedLineup)
  })

  test('a malformed EVT_SESSION_RESULTS also retains lastKnownStats when Zod rejects the payload', async () => {
    const retainedLineup = [{ playerId: 2, statResults: [] } as any]
    setLastKnownStats(retainedLineup)
    // Missing every required field -- fails Zod validation, same shape as
    // event-ingestion.update-manager-trigger.test.ts's malformed-309 case.
    await onMessageHandler({ ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 1000 })

    expect(getLastKnownStats()).toBe(retainedLineup)
  })

  test('filter change after session end can recompute the retained lineup through getLastKnownStats()', async () => {
    const retainedLineup = [
      { playerId: 2, statResults: [] } as any,
      { playerId: 3, statResults: [] } as any,
    ]
    setLastKnownStats(retainedLineup)

    await onMessageHandler(sessionResultsEvent)
    expect(getLastKnownStats()).toBe(retainedLineup)

    const sendResponse = jest.fn()
    messageListener(
      { action: 'updateBattleTypeFilter', filterOptions: FILTER_OPTIONS } as unknown as ChromeMessage,
      {} as chrome.runtime.MessageSender,
      sendResponse
    )
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(writeSpy).toHaveBeenCalledWith([2, 3])
  })

  test('control: filter change with a live (non-ended) lineup still re-triggers recompute as before', async () => {
    setLastKnownStats([{ playerId: 2, statResults: [] } as any])

    const sendResponse = jest.fn()
    messageListener(
      { action: 'updateBattleTypeFilter', filterOptions: FILTER_OPTIONS } as unknown as ChromeMessage,
      {} as chrome.runtime.MessageSender,
      sendResponse
    )
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(writeSpy).toHaveBeenCalledWith([2])
  })

  test('#158 pre-game hero stats fallback still reads IndexedDB independently of the retained lineup', async () => {
    // Seed a persisted hero-only hand so getLatestSessionStats() has
    // something to compute from (same shape as
    // import-export.pregame-hero-stats.test.ts).
    const hand = makeHand({ id: 1, seatUserIds: [HERO_ID, -1, -1, -1, -1, -1] })
    await db.hands.put(hand)

    const retainedLineup = [{ playerId: 2, statResults: [] } as any]
    setLastKnownStats(retainedLineup)
    await onMessageHandler(sessionResultsEvent)
    expect(getLastKnownStats()).toBe(retainedLineup)

    const sendResponse = jest.fn()
    const TAB_ID = 42
    messageListener(
      { action: 'requestLatestStats', preGame: true } as unknown as ChromeMessage,
      { tab: { id: TAB_ID } } as chrome.runtime.MessageSender,
      sendResponse
    )
    await waitUntil(() => sendMessageMock.mock.calls.length > 0)

    expect(sendMessageMock).toHaveBeenCalledWith(TAB_ID, expect.objectContaining({
      action: 'latestStats',
      stats: expect.arrayContaining([expect.objectContaining({ playerId: HERO_ID })])
    }))
  })
})
