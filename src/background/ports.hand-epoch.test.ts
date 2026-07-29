/**
 * ports.ts -- handCompletionEpoch gating (audit finding 11 follow-up, P2)
 *
 * Regression test for a P2 codex review comment on PR #200
 * (https://github.com/solavrc/pokerchase-hud/pull/200#discussion_r3617053535,
 * posted 2026-07-20T19:40:03Z): the first pass stamped `handEpoch` from
 * `liveBroadcastSequence`, which is bumped by EVERY `statsOutputStream` 'data'
 * emission -- not just genuine hand completions. That stream also fires for:
 *  - the hand-start "warmup" broadcast (aggregate-events-stream.ts's EVT_DEAL
 *    handler, when the DB already has hands for the newly-dealt lineup --
 *    `service.statsOutputStream.write(event.SeatUserIds)` called directly)
 *  - filter-change/import/auto-sync-restore rebroadcasts (message-router.ts's
 *    `updateBattleTypeFilter`, `recalculateStats()`/`recalculateAllStats()`,
 *    import-export.ts, auto-sync-service.ts -- all call
 *    `service.statsOutputStream.write()` directly, bypassing the live
 *    hand-aggregation pipeline entirely)
 * None of those are "a hand just completed", so bumping handEpoch on them
 * would cause an open drill-down panel to refetch (and the backend caches to
 * invalidate) at times that aren't hand completions.
 *
 * Fix: `handCompletionEpoch` is now a separate counter, bumped only by
 * `service.writeEntityStream`'s 'data' event -- the one true completion
 * signal, reached exclusively via the live pipeline
 * (`handAggregateStream.pipe(writeEntityStream)`) after a hand's events have
 * actually been detected as complete (EVT_HAND_RESULTS) and successfully
 * persisted to DB.
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { ApiType, BattleType } from '../types'
import type { ApiEvent } from '../app'
import { registerStreamSubscriptions, connectedPorts, setLastKnownStats } from './ports'
import {
  setEventSessionScope,
  setLineupSessionScope,
} from '../utils/session-event-scope'

const GAME_URL_PATTERN = 'https://example.com/*'

/** Minimal valid EVT_DEAL -> EVT_ACTION -> EVT_HAND_RESULTS sequence for a single
 * hand, mirroring aggregate-events-stream.test.ts's fixture -- enough for
 * WriteEntityStream.toHandState() to accept it and persist a real hand (not a
 * chimera), so `writeEntityStream`'s 'data' fires for real. */
function makeHandEvents(handId: number, seatUserIds: [number, number, number]): ApiEvent[] {
  return [
    {
      ApiTypeId: ApiType.EVT_DEAL,
      SeatUserIds: seatUserIds,
      Game: { CurrentBlindLv: 1, NextBlindUnixSeconds: 0, Ante: 0, SmallBlind: 100, BigBlind: 200, ButtonSeat: 0, SmallBlindSeat: 1, BigBlindSeat: 2 },
      Player: { SeatIndex: 0, BetStatus: 1, HoleCards: [0, 1], Chip: 5000, BetChip: 0 },
      OtherPlayers: [
        { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 100, IsSafeLeave: false },
        { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 200, IsSafeLeave: false },
      ],
      Progress: { Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 400, Pot: 300, SidePot: [] },
      timestamp: handId * 1000,
    },
    {
      ApiTypeId: ApiType.EVT_ACTION,
      SeatIndex: 0,
      ActionType: 2,
      Chip: 5000,
      BetChip: 0,
      Progress: { Phase: 3, NextActionSeat: -2, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 300, SidePot: [] },
      timestamp: handId * 1000 + 1,
    },
    {
      ApiTypeId: ApiType.EVT_HAND_RESULTS,
      CommunityCards: [],
      Pot: 300,
      SidePot: [],
      ResultType: 0,
      DefeatStatus: 0,
      HandId: handId,
      HandLog: '',
      Results: [{ UserId: seatUserIds[0], HoleCards: [], RankType: 10, Hands: [], HandRanking: 1, Ranking: -2, RewardChip: 300 }],
      Player: { SeatIndex: 0, BetStatus: -1, Chip: 5000, BetChip: 0 },
      OtherPlayers: [
        { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
        { SeatIndex: 2, Status: 0, BetStatus: -1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
      ],
      timestamp: handId * 1000 + 2,
    },
  ]
}

describe('ports.ts handCompletionEpoch (audit finding 11 follow-up, P2)', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let fakePort: { postMessage: jest.Mock }

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = new PokerChaseService({ db })
    await service.ready

    fakePort = { postMessage: jest.fn() }
    connectedPorts.add(fakePort as unknown as chrome.runtime.Port)

    registerStreamSubscriptions(service, GAME_URL_PATTERN)
  })

  afterEach(async () => {
    connectedPorts.clear()
    setLastKnownStats([])
    db.close()
    await db.delete()
  })

  /** handEpoch stamped on the most recent broadcastMessage() postMessage call (any of
   * this test's fakePort calls -- both statsOutputStream's and realTimeStatsStream's
   * broadcasts carry the field). */
  function lastBroadcastHandEpoch(): number | undefined {
    const lastCall = fakePort.postMessage.mock.calls.at(-1)
    return lastCall?.[0]?.handEpoch
  }

  test('a direct statsOutputStream broadcast (hand-start warmup / filter-change / import rebroadcast shape) does NOT bump handEpoch', async () => {
    // handCompletionEpoch is module-scoped in ports.ts (shared across this file's
    // tests), so read the current value as a baseline rather than assuming 0 --
    // only the *delta* across these calls is under test here.
    service.statsOutputStream.write([1, 2, 3])
    await service.statsOutputStream.whenIdle()
    const baseline = lastBroadcastHandEpoch()

    // This is exactly what aggregate-events-stream.ts's EVT_DEAL warmup branch and
    // message-router.ts's updateBattleTypeFilter/recalculateStats() do: call
    // statsOutputStream.write() directly, without ever touching writeEntityStream.
    service.statsOutputStream.write([1, 2, 3])
    await service.statsOutputStream.whenIdle()
    expect(lastBroadcastHandEpoch()).toBe(baseline)

    // Repeating it (simulating another filter change / a second warmup broadcast)
    // still doesn't move the needle.
    service.statsOutputStream.write([1, 2, 3])
    await service.statsOutputStream.whenIdle()
    expect(lastBroadcastHandEpoch()).toBe(baseline)
  })

  test('a stats broadcast keeps the DEAL that produced it when liveEvtDeal changes', async () => {
    const originatingDeal = makeHandEvents(600, [1, 2, 3])[0] as ApiEvent<ApiType.EVT_DEAL>
    const newerDeal = makeHandEvents(601, [10, 20, 30])[0] as ApiEvent<ApiType.EVT_DEAL>
    setLineupSessionScope(
      originatingDeal.SeatUserIds,
      undefined,
      originatingDeal
    )
    service.liveEvtDeal = newerDeal

    service.statsOutputStream.write(originatingDeal.SeatUserIds)
    await service.statsOutputStream.whenIdle()

    expect(fakePort.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stats: originatingDeal.SeatUserIds.map(playerId =>
          expect.objectContaining({ playerId })
        ),
        evtDeal: originatingDeal,
      })
    )
  })

  test('a genuine hand completion (through the live handAggregateStream -> writeEntityStream -> statsOutputStream pipeline) bumps handEpoch by exactly 1', async () => {
    service.statsOutputStream.write([1, 2, 3])
    await service.statsOutputStream.whenIdle()
    const baseline = lastBroadcastHandEpoch()!

    for (const event of makeHandEvents(555, [1, 2, 3])) {
      service.handAggregateStream.write(event)
    }
    await service.handAggregateStream.whenIdle()

    expect(lastBroadcastHandEpoch()).toBe(baseline + 1)

    // A subsequent direct statsOutputStream broadcast (e.g. a filter change right
    // after this hand) stamps the new value but does NOT bump it further.
    service.statsOutputStream.write([1, 2, 3])
    await service.statsOutputStream.whenIdle()
    expect(lastBroadcastHandEpoch()).toBe(baseline + 1)

    // A second genuine completion bumps it again, by exactly 1.
    for (const event of makeHandEvents(556, [1, 2, 3])) {
      service.handAggregateStream.write(event)
    }
    await service.handAggregateStream.whenIdle()
    expect(lastBroadcastHandEpoch()).toBe(baseline + 2)
  })

  test('a non-authoritative completion refreshes the authoritative all-period lineup and bumps handEpoch', async () => {
    const contextA = {
      scopeKey: 'run-a',
      id: 'tab-a',
      battleType: BattleType.SIT_AND_GO,
      startedAt: 1000,
      originId: 'origin-a',
    }
    const contextB = {
      scopeKey: 'run-b',
      id: 'tab-b',
      battleType: BattleType.RING_GAME,
      startedAt: 2000,
      originId: 'origin-b',
    }
    const lineup: [number, number, number] = [1, 2, 3]
    const authoritativeDeal =
      structuredClone(makeHandEvents(600, lineup)[0]!) as ApiEvent<ApiType.EVT_DEAL>
    setEventSessionScope(authoritativeDeal, contextB)
    service.setSessionOriginReconciler(() => contextB)
    service.startSession(
      contextB.id,
      contextB.battleType,
      contextB.startedAt,
      contextB.scopeKey
    )
    service.playerId = lineup[0]
    service.latestEvtDeal = authoritativeDeal
    service.sessionOnlyFilter = false
    setLineupSessionScope(lineup, contextB, authoritativeDeal)
    service.statsOutputStream.write(lineup)
    await service.statsOutputStream.whenIdle()
    const baseline = lastBroadcastHandEpoch()!
    fakePort.postMessage.mockClear()

    const refreshed = new Promise<any>(resolve =>
      service.statsOutputStream.once('data', resolve)
    )
    for (const event of makeHandEvents(555, lineup)) {
      setEventSessionScope(event, contextA)
      service.handAggregateStream.write(event)
    }
    await service.handAggregateStream.whenIdle()
    await service.writeEntityStream.whenIdle()
    const stats = await refreshed

    expect(await db.hands.get(555)).toBeDefined()
    expect(stats.map((player: { playerId: number }) => player.playerId))
      .toEqual(lineup)
    expect(fakePort.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        evtDeal: authoritativeDeal,
        handEpoch: baseline + 1,
      })
    )
  })
})
