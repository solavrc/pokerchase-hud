/**
 * event-ingestion.ts / ports.ts / message-router.ts - session-end
 * invalidation of `lastKnownStats`
 *
 * Regression test for a P2 review finding on PR #179 round3: the busted-
 * player-dim mute cache clear on EVT_SESSION_RESULTS (App.tsx's
 * handleSessionEnd) is a purely local React-state reset. The *background*'s
 * `lastKnownStats` (ports.ts) is not part of that reset and survives across
 * sessions for the life of the Service Worker. If the user changes the
 * battle-type filter (Popup) after a session has ended but before any new
 * hand starts, message-router.ts's `updateBattleTypeFilter` handler reads
 * `getLastKnownStats()` (still the *ended* session's lineup) and re-triggers
 * `service.statsOutputStream.write(...)`, rebroadcasting that stale lineup
 * to every connected tab -- repopulating the HUD panels App.tsx had just
 * cleared, with the previous (now-departed) session's players.
 *
 * Fix: hook `setLastKnownStats([])` alongside the existing raw-ApiTypeId
 * session-end tracking in event-ingestion.ts (same raw-first pattern
 * `markSessionInactive()` already uses -- see
 * event-ingestion.update-manager-trigger.test.ts -- so this isn't affected
 * by the season3 EVT_SESSION_RESULTS payload breakage documented in
 * docs/postmortems/2026-07-session-results-drop.md; the raw numeric
 * ApiTypeId is checked before Zod parsing). With `lastKnownStats` empty,
 * `updateBattleTypeFilter`'s `lastKnownStats.length > 0` guard is false, so
 * a post-session filter change behaves like pre-session: no rebroadcast.
 *
 * The pre-game hero-stats fallback (#158, `requestLatestStats` ->
 * `getLatestSessionStats`) is a separate DB-backed code path
 * (import-export.ts) that never reads `lastKnownStats`, so it's unaffected
 * by this change -- verified directly below rather than via a nonexistent
 * `e2e:playerid` scenario (no such npm script or e2e/scenarios file exists
 * in this repo; import-export.pregame-hero-stats.test.ts already covers
 * that path in isolation and is untouched by this change).
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { ApiType } from '../types'
import { registerEventIngestion } from './event-ingestion'
import { registerMessageRouter } from './message-router'
import { registerStreamSubscriptions, connectedPorts, getLastKnownStats, setLastKnownStats } from './ports'
import * as ports from './ports'
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

describe('session end (309) invalidates background lastKnownStats', () => {
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
    service = new PokerChaseService({ db })
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

  test('raw EVT_SESSION_RESULTS (309) clears lastKnownStats via the raw-ApiTypeId path', async () => {
    const setLastKnownStatsSpy = jest.spyOn(ports, 'setLastKnownStats')
    setLastKnownStats([{ playerId: 2, statResults: [] } as any])
    expect(getLastKnownStats()).toHaveLength(1)

    await onMessageHandler(sessionResultsEvent)

    expect(setLastKnownStatsSpy).toHaveBeenCalledWith([])
    expect(getLastKnownStats()).toEqual([])
  })

  test('a malformed EVT_SESSION_RESULTS still clears lastKnownStats (raw ApiTypeId, unaffected by Zod parse failures)', async () => {
    setLastKnownStats([{ playerId: 2, statResults: [] } as any])

    // Missing every required field -- fails Zod validation, same shape as
    // event-ingestion.update-manager-trigger.test.ts's malformed-309 case.
    await onMessageHandler({ ApiTypeId: ApiType.EVT_SESSION_RESULTS, timestamp: 1000 })

    expect(getLastKnownStats()).toEqual([])
  })

  test('filter change after session end does not rebroadcast the ended lineup (309 -> filter change -> no repopulation)', async () => {
    // Simulate an ended session's lineup still cached from before the fix's
    // trigger point in this test (i.e. what would have lingered pre-fix).
    setLastKnownStats([{ playerId: 2, statResults: [] } as any, { playerId: 3, statResults: [] } as any])

    // The real session-end signal: raw 309 through the actual ingestion path.
    await onMessageHandler(sessionResultsEvent)
    expect(getLastKnownStats()).toEqual([])

    const sendResponse = jest.fn()
    messageListener(
      { action: 'updateBattleTypeFilter', filterOptions: FILTER_OPTIONS } as unknown as ChromeMessage,
      {} as chrome.runtime.MessageSender,
      sendResponse
    )
    await new Promise(resolve => setTimeout(resolve, 0))

    // No rebroadcast: lastKnownStats was empty, so the ended lineup can't
    // resurrect into App.tsx's already-cleared HUD panels.
    expect(writeSpy).not.toHaveBeenCalled()
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

  test('#158 pre-game hero stats fallback is unaffected: requestLatestStats(preGame) still delivers from the DB after 309 cleared lastKnownStats', async () => {
    // Seed a persisted hero-only hand so getLatestSessionStats() has
    // something to compute from (same shape as
    // import-export.pregame-hero-stats.test.ts).
    const hand = makeHand({ id: 1, seatUserIds: [HERO_ID, -1, -1, -1, -1, -1] })
    await db.hands.put(hand)

    await onMessageHandler(sessionResultsEvent)
    expect(getLastKnownStats()).toEqual([])

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
