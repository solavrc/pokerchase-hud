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
import { ApiType, BattleType, PhaseType, type ApiEvent } from '../types'
import { AutoSyncService } from './auto-sync-service'
import { MTT_TABLE_MOVE_FIXTURE } from '../test-fixtures/mtt-table-move-lifecycle'

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

  test('restores active latest-session boundaries and closes them on replayed results', async () => {
    const entry = {
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 5000,
      Code: 0,
      BattleType: BattleType.RING_GAME,
      Id: 'cloud-active-ring',
      IsRetire: false,
    } as ApiEvent
    await db.apiEvents.add(entry)

    await (autoSyncService as any).rebuildLocalEntities()
    expect(service.getCurrentSessionScope()).toEqual({
      id: 'cloud-active-ring',
      startedAt: 5000,
    })

    await db.apiEvents.add({
      ApiTypeId: ApiType.EVT_SESSION_RESULTS,
      timestamp: 6000,
    } as ApiEvent)
    await (autoSyncService as any).rebuildLocalEntities()
    expect(service.getCurrentSessionScope()).toBeUndefined()
    expect(service.session.active).toBe(false)
  })

  test('restores the previous active scope when interleaved replay results close the latest one', async () => {
    await db.apiEvents.bulkAdd([
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        timestamp: 1000,
        Code: 0,
        BattleType: BattleType.SIT_AND_GO,
        Id: 'tab-a',
        IsRetire: false,
      },
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        timestamp: 2000,
        Code: 0,
        BattleType: BattleType.RING_GAME,
        Id: 'tab-b',
        IsRetire: false,
      },
      {
        ApiTypeId: ApiType.EVT_SESSION_RESULTS,
        timestamp: 3000,
      },
    ] as ApiEvent[])

    await (autoSyncService as any).rebuildLocalEntities()

    expect(service.getCurrentSessionScope()).toEqual({ id: 'tab-a', startedAt: 1000 })
    expect(service.session.battleType).toBe(BattleType.SIT_AND_GO)
  })

  test('uses persisted origin context when an earlier concurrent scope ends first', async () => {
    const contextA = {
      scopeKey: 'run:0:tab-a:1000',
      id: 'tab-a',
      battleType: BattleType.SIT_AND_GO,
      startedAt: 1000,
    }
    const contextB = {
      scopeKey: 'run:4:tab-b:2000',
      id: 'tab-b',
      battleType: BattleType.RING_GAME,
      startedAt: 2000,
    }
    const detailsB = {
      ...structuredClone(MTT_TABLE_MOVE_FIXTURE.events[1]!),
      timestamp: 2100,
      Name: 'Table B',
      __pokerChaseHudSessionContext: contextB,
    }
    const seatsB = {
      ...structuredClone(MTT_TABLE_MOVE_FIXTURE.events[2]!),
      timestamp: 2200,
      __pokerChaseHudSessionContext: contextB,
    }
    await db.apiEvents.bulkAdd([
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        timestamp: 1000,
        Code: 0,
        BattleType: BattleType.SIT_AND_GO,
        Id: 'tab-a',
        IsRetire: false,
        __pokerChaseHudSessionContext: contextA,
      },
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        timestamp: 2000,
        Code: 0,
        BattleType: BattleType.RING_GAME,
        Id: 'tab-b',
        IsRetire: false,
        __pokerChaseHudSessionContext: contextB,
      },
      detailsB,
      seatsB,
      {
        ApiTypeId: ApiType.EVT_SESSION_RESULTS,
        timestamp: 3000,
        __pokerChaseHudSessionContext: contextA,
      },
    ] as ApiEvent[])

    await (autoSyncService as any).rebuildLocalEntities()

    expect(service.getCurrentSessionScope()).toEqual({ id: 'tab-b', startedAt: 2000 })
    expect(service.session.battleType).toBe(BattleType.RING_GAME)
    expect(service.session.name).toBe('Table B')
    expect(service.session.players.size).toBeGreaterThan(0)
  })

  test('restores metadata when the latest replay scope ends and an older scope survives', async () => {
    const contextA = {
      scopeKey: 'run:0:tab-a:1000',
      id: 'tab-a',
      battleType: BattleType.SIT_AND_GO,
      startedAt: 1000,
    }
    const contextB = {
      scopeKey: 'run:4:tab-b:2000',
      id: 'tab-b',
      battleType: BattleType.RING_GAME,
      startedAt: 2000,
    }
    const detailsA = {
      ...structuredClone(MTT_TABLE_MOVE_FIXTURE.events[1]!),
      timestamp: 1100,
      Name: 'Table A',
      __pokerChaseHudSessionContext: contextA,
    }
    const seatsA = {
      ...structuredClone(MTT_TABLE_MOVE_FIXTURE.events[2]!),
      timestamp: 1200,
      __pokerChaseHudSessionContext: contextA,
    }
    await db.apiEvents.bulkAdd([
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        timestamp: 1000,
        Code: 0,
        BattleType: BattleType.SIT_AND_GO,
        Id: 'tab-a',
        IsRetire: false,
        __pokerChaseHudSessionContext: contextA,
      },
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        timestamp: 2000,
        Code: 0,
        BattleType: BattleType.RING_GAME,
        Id: 'tab-b',
        IsRetire: false,
        __pokerChaseHudSessionContext: contextB,
      },
      // Shared raw history can interleave metadata from A after B became the
      // selected scope. Replay must retain it under A instead of discarding it.
      detailsA,
      seatsA,
      {
        ApiTypeId: ApiType.EVT_SESSION_RESULTS,
        timestamp: 3000,
        __pokerChaseHudSessionContext: contextB,
      },
    ] as ApiEvent[])

    await (autoSyncService as any).rebuildLocalEntities()

    expect(service.getCurrentSessionScope()).toEqual({ id: 'tab-a', startedAt: 1000 })
    expect(service.session.name).toBe('Table A')
    expect([...service.session.players.values()]).not.toHaveLength(0)
  })

  test('a durable tab-close tombstone keeps its scope closed after browser restart', async () => {
    const context = {
      scopeKey: 'run:0:closed-tab:1000',
      id: 'closed-tab',
      battleType: BattleType.SIT_AND_GO,
      startedAt: 1000,
      originId: 'origin-a',
    }
    await db.apiEvents.bulkAdd([
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        timestamp: 1000,
        Code: 0,
        BattleType: BattleType.SIT_AND_GO,
        Id: 'closed-tab',
        IsRetire: false,
        __pokerChaseHudSessionContext: context,
      },
      {
        ApiTypeId: 203,
        timestamp: 2000,
        __pokerChaseHudClosureReason: 'tab-removed',
        __pokerChaseHudSessionContext: context,
      },
    ] as ApiEvent[])

    await (autoSyncService as any).rebuildLocalEntities()

    expect(service.getCurrentSessionScope()).toBeUndefined()
    expect(service.session.active).toBe(false)
  })

  test('a newer run supersedes an unmatched older run from the same origin', async () => {
    const firstContext = {
      scopeKey: 'run:4:shared-room:1000',
      id: 'shared-room',
      battleType: BattleType.RING_GAME,
      startedAt: 1000,
      originId: 'origin-a',
    }
    const secondContext = {
      ...firstContext,
      scopeKey: 'run:4:shared-room:2000',
      startedAt: 2000,
    }
    await db.apiEvents.bulkAdd([
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        timestamp: 1000,
        Code: 0,
        BattleType: BattleType.RING_GAME,
        Id: 'shared-room',
        IsRetire: false,
        __pokerChaseHudSessionContext: firstContext,
      },
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        timestamp: 2000,
        Code: 0,
        BattleType: BattleType.RING_GAME,
        Id: 'shared-room',
        IsRetire: false,
        __pokerChaseHudSessionContext: secondContext,
      },
      {
        ApiTypeId: ApiType.EVT_SESSION_RESULTS,
        timestamp: 3000,
        __pokerChaseHudSessionContext: secondContext,
      },
    ] as ApiEvent[])

    await (autoSyncService as any).rebuildLocalEntities()

    expect(service.getCurrentSessionScope()).toBeUndefined()
    expect(service.session.active).toBe(false)
  })

  test('canonical rebuild preserves a completed hand origin across concurrent sessions', async () => {
    const contextA = {
      scopeKey: 'run:0:tab-a:100',
      id: 'tab-a',
      battleType: BattleType.SIT_AND_GO,
      startedAt: 100,
    }
    const contextB = {
      scopeKey: 'run:4:tab-b:200',
      id: 'tab-b',
      battleType: BattleType.RING_GAME,
      startedAt: 200,
    }
    const scopedHand = structuredClone(FIRST_HAND_EVENTS).map(event => ({
      ...event,
      __pokerChaseHudSessionContext: contextA,
    }))
    await db.apiEvents.bulkAdd([
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        timestamp: 100,
        Code: 0,
        BattleType: BattleType.SIT_AND_GO,
        Id: 'tab-a',
        IsRetire: false,
        __pokerChaseHudSessionContext: contextA,
      },
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        timestamp: 200,
        Code: 0,
        BattleType: BattleType.RING_GAME,
        Id: 'tab-b',
        IsRetire: false,
        __pokerChaseHudSessionContext: contextB,
      },
      ...scopedHand,
    ] as ApiEvent[])

    await (autoSyncService as any).rebuildLocalEntities()

    expect((await db.hands.get(FIRST_HAND_ID))?.session).toMatchObject({
      id: 'tab-a',
      battleType: BattleType.SIT_AND_GO,
    })
  })

  test('restores the latest seated deal from the surviving concurrent scope', async () => {
    const contextA = {
      scopeKey: 'run:0:tab-a:100',
      id: 'tab-a',
      battleType: BattleType.SIT_AND_GO,
      startedAt: 100,
    }
    const contextB = {
      scopeKey: 'run:4:tab-b:200',
      id: 'tab-b',
      battleType: BattleType.RING_GAME,
      startedAt: 200,
    }
    const dealB = {
      ...structuredClone(FIRST_HAND_EVENTS[0]),
      timestamp: 300,
      SeatUserIds: [10, 20, 30, 40],
      __pokerChaseHudSessionContext: contextB,
    }
    const dealA = {
      ...structuredClone(FIRST_HAND_EVENTS[0]),
      timestamp: 400,
      SeatUserIds: [1, 2, 3, 4],
      __pokerChaseHudSessionContext: contextA,
    }
    await db.apiEvents.bulkAdd([
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        timestamp: 100,
        Code: 0,
        BattleType: BattleType.SIT_AND_GO,
        Id: 'tab-a',
        IsRetire: false,
        __pokerChaseHudSessionContext: contextA,
      },
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        timestamp: 200,
        Code: 0,
        BattleType: BattleType.RING_GAME,
        Id: 'tab-b',
        IsRetire: false,
        __pokerChaseHudSessionContext: contextB,
      },
      dealB,
      dealA,
      {
        ApiTypeId: ApiType.EVT_SESSION_RESULTS,
        timestamp: 500,
        __pokerChaseHudSessionContext: contextA,
      },
    ] as ApiEvent[])

    await (autoSyncService as any).rebuildLocalEntities()

    expect(service.getCurrentSessionScope()).toEqual({ id: 'tab-b', startedAt: 200 })
    expect(service.latestEvtDeal?.SeatUserIds).toEqual(dealB.SeatUserIds)
  })

  test('does not resurrect a replayed scope closed by the live tab tracker', async () => {
    const context = {
      scopeKey: 'run:0:closed-tab:100',
      id: 'closed-tab',
      battleType: BattleType.SIT_AND_GO,
      startedAt: 100,
    }
    await db.apiEvents.add({
      ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
      timestamp: 100,
      Code: 0,
      BattleType: BattleType.SIT_AND_GO,
      Id: 'closed-tab',
      IsRetire: false,
      __pokerChaseHudSessionContext: context,
    } as ApiEvent)
    service.setSessionOriginReconciler(() => null)

    await (autoSyncService as any).rebuildLocalEntities()

    expect(service.getCurrentSessionScope()).toBeUndefined()
    expect(service.session.active).toBe(false)
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

  test('does not let a failed 201 overwrite the last successful session during cloud rebuild', async () => {
    await db.apiEvents.bulkAdd([
      {
        ApiTypeId: 201,
        Code: 0,
        BattleType: BattleType.TOURNAMENT,
        Id: '6078',
        IsRetire: false,
        timestamp: 100,
        sequence: 0
      },
      {
        ApiTypeId: 201,
        Code: 5205,
        Error: {
          Status: 1,
          Message: 'text_sync_error_message_code_5205',
          AddParam: '',
          Replaces: []
        },
        BattleType: BattleType.SIT_AND_GO,
        Id: '',
        IsRetire: false,
        timestamp: 200,
        sequence: 0
      }
    ])

    await (autoSyncService as any).rebuildLocalEntities()

    expect(service.session.id).toBe('6078')
    expect(service.session.battleType).toBe(BattleType.TOURNAMENT)
  })
})
