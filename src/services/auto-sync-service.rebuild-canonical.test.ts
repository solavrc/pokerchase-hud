/**
 * Canonical cloud-rebuild cleanup regressions.
 *
 * A download merges cloud rows into the local Raw Event Lake, then replays the
 * whole Lake. The replay output is authoritative: cloud-only events can fill a
 * local gap and invalidate an entity that an earlier incomplete replay emitted.
 * These tests use a real Dexie database so stale primary keys cannot be hidden
 * by mocked bulkPut behavior.
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { PhaseType, type ApiEvent } from '../types'
import { AutoSyncService } from './auto-sync-service'

const FIRST_HAND_ID = 384370064
const FIRST_HAND_EVENTS = [
  {
    ApiTypeId: 303,
    SeatUserIds: [2, 4, 3, 1],
    Game: { CurrentBlindLv: 1, NextBlindUnixSeconds: -1, Ante: 50, SmallBlind: 100, BigBlind: 200, ButtonSeat: 3, SmallBlindSeat: 0, BigBlindSeat: 1 },
    Player: { SeatIndex: 1, BetStatus: 1, HoleCards: [5, 21], Chip: 5750, BetChip: 200 },
    OtherPlayers: [
      { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 5850, BetChip: 100, IsSafeLeave: false },
      { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 5950, BetChip: 0, IsSafeLeave: false },
      { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 5950, BetChip: 0, IsSafeLeave: false }
    ],
    Progress: { Phase: 0, NextActionSeat: 2, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 400, Pot: 500, SidePot: [] },
    timestamp: 1000
  },
  {
    ApiTypeId: 306,
    CommunityCards: [], Pot: 500, SidePot: [], ResultType: 0, DefeatStatus: 0,
    HandId: FIRST_HAND_ID, HandLog: '',
    Results: [{ UserId: 4, HoleCards: [], RankType: 10, Hands: [], HandRanking: 1, Ranking: -2, RewardChip: 500 }],
    Player: { SeatIndex: 1, BetStatus: -1, Chip: 6250, BetChip: 0 },
    OtherPlayers: [
      { SeatIndex: 0, Status: 0, BetStatus: -1, Chip: 5850, BetChip: 0, IsSafeLeave: false },
      { SeatIndex: 2, Status: 0, BetStatus: -1, Chip: 5950, BetChip: 0, IsSafeLeave: false },
      { SeatIndex: 3, Status: 0, BetStatus: -1, Chip: 5950, BetChip: 0, IsSafeLeave: false }
    ],
    timestamp: 2000
  }
] as unknown as ApiEvent[]

describe('AutoSyncService.rebuildLocalEntities() canonical replacement', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let autoSyncService: AutoSyncService

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = new PokerChaseService({ db })
    await service.ready
    ;(globalThis as any).service = service
    autoSyncService = new AutoSyncService(db)
  })

  afterEach(async () => {
    delete (globalThis as any).service
    db.close()
    await db.delete()
  })

  test('removes a formerly-derived hand when a cloud-only event makes canonical replay reject it', async () => {
    await db.apiEvents.bulkAdd(structuredClone(FIRST_HAND_EVENTS))
    await (autoSyncService as any).rebuildLocalEntities()
    expect(await db.hands.get(FIRST_HAND_ID)).toBeDefined()

    const originalDeal = FIRST_HAND_EVENTS[0] as any
    const result = FIRST_HAND_EVENTS.at(-1)!
    const interveningTableMoveDeal = {
      ...structuredClone(originalDeal),
      timestamp: result.timestamp! - 1,
      SeatUserIds: [10, 20, 30, 40]
    }
    await db.apiEvents.add(interveningTableMoveDeal)

    // The newly complete Lake is DEAL(old) -> DEAL(new table) -> RESULTS(old
    // table). EntityConverter rejects both sides of this table-move chimera,
    // so the hand emitted by the earlier incomplete replay must disappear.
    await (autoSyncService as any).rebuildLocalEntities()

    expect(await db.hands.get(FIRST_HAND_ID)).toBeUndefined()
    expect(await db.phases.where('handId').equals(FIRST_HAND_ID).count()).toBe(0)
    expect(await db.actions.where('handId').equals(FIRST_HAND_ID).count()).toBe(0)
  })

  test('replaces child rows for a regenerated hand instead of leaving obsolete keys', async () => {
    await db.apiEvents.bulkAdd(structuredClone(FIRST_HAND_EVENTS))
    await (autoSyncService as any).rebuildLocalEntities()

    const preflop = await db.phases.get([FIRST_HAND_ID, PhaseType.PREFLOP])
    expect(preflop).toBeDefined()
    await db.phases.put({ ...preflop!, phase: PhaseType.FLOP })
    expect(await db.phases.get([FIRST_HAND_ID, PhaseType.FLOP])).toBeDefined()

    await (autoSyncService as any).rebuildLocalEntities()

    expect(await db.phases.get([FIRST_HAND_ID, PhaseType.FLOP])).toBeUndefined()
  })
})
