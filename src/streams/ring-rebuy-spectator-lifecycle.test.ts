/**
 * Ring bust -> spectator -> rebuy lifecycle regression fixture.
 *
 * Evidence source: docs/battle-type-coverage-audit.md, audit_ref 8f34d5fc1c03.
 * The three HandIds and relative timing/stack transitions are retained for
 * correlation. Every player id, session id, card, and non-essential amount is
 * synthetic; names, observer/table/private ids, and raw payloads are omitted.
 *
 * Observed lifecycle inside one Ring EVT_ENTRY_QUEUED segment:
 *   306 hero Chip=0
 *   -> 303 Player absent (spectator hand)
 *   -> matching 306 Player Chip=50,000 (mid-hand rebuy state only)
 *   -> next 303 Player present, Chip=49,875 (rebuy participation begins)
 *
 * No EVT_ENTRY_QUEUED / EVT_SESSION_RESULTS boundary occurs between those
 * hands, and EVT_SESSION_RESULTS.IsRebuy is therefore unavailable. The deal
 * event, not the later result snapshot, is authoritative for whether the hero
 * was dealt into a hand.
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService from '../services/poker-chase-service'
import { PokerChaseDB } from '../db/poker-chase-db'
import { clearRecentHandsCache, getRecentHands } from '../services/recent-hands-service'
import {
  ApiType,
  BattleType,
  BetStatusType,
  parseApiEvent,
  RankType,
} from '../types'
import type { ApiEvent, PlayerStats, StatResult } from '../types'

const HERO_ID = 106
const SEATED_LINEUP = [101, 102, 103, 104, 105, HERO_ID]
const SPECTATOR_LINEUP = [101, 102, 103, 104, 105, -1]
const SESSION_ID = 'ring_fixture_redacted'
const T0 = 1_000_000
type SeatIndex = 0 | 1 | 2 | 3 | 4 | 5

const progress = {
  Phase: 0 as const,
  NextActionSeat: 0 as const,
  NextActionTypes: [2, 3, 4, 5] as const,
  NextExtraLimitSeconds: 1,
  MinRaise: 100,
  Pot: 75,
  SidePot: [],
}

function otherPlayers(lineup: number[], heroPresent: boolean) {
  return lineup.flatMap((userId, seatIndex) => {
    if (userId === -1 || (heroPresent && userId === HERO_ID)) return []
    return [{
      SeatIndex: seatIndex as SeatIndex,
      Status: 0 as const,
      BetStatus: BetStatusType.BET_ABLE,
      Chip: 50_000,
      BetChip: seatIndex === 0 ? 50 : (seatIndex === 5 ? 25 : 0),
    }]
  })
}

function dealEvent({
  timestamp,
  lineup,
  hero,
}: {
  timestamp: number
  lineup: number[]
  hero?: { chip: number, holeCards: [number, number] }
}): ApiEvent<ApiType.EVT_DEAL> {
  return {
    ApiTypeId: ApiType.EVT_DEAL,
    timestamp,
    SeatUserIds: lineup,
    Game: {
      CurrentBlindLv: 1,
      NextBlindUnixSeconds: -1,
      Ante: 0,
      SmallBlind: 25,
      BigBlind: 50,
      ButtonSeat: 4,
      SmallBlindSeat: 5,
      BigBlindSeat: 0,
    },
    ...(hero
      ? {
          Player: {
            SeatIndex: 5,
            BetStatus: BetStatusType.BET_ABLE,
            Chip: hero.chip,
            BetChip: 25,
            HoleCards: hero.holeCards,
          },
        }
      : {}),
    OtherPlayers: otherPlayers(lineup, hero !== undefined),
    Progress: { ...progress, NextActionTypes: [...progress.NextActionTypes] },
  }
}

function handResultsEvent({
  timestamp,
  handId,
  heroChip,
  includeHeroResult,
}: {
  timestamp: number
  handId: number
  heroChip: number
  includeHeroResult: boolean
}): ApiEvent<ApiType.EVT_HAND_RESULTS> {
  const results = [
    {
      UserId: 101,
      RankType: RankType.NO_CALL,
      HandRanking: 1 as const,
      Hands: [],
      HoleCards: [],
      Ranking: -2 as const,
      RewardChip: 75,
    },
    ...(includeHeroResult
      ? [{
          UserId: HERO_ID,
          RankType: RankType.SHOWDOWN_MUCK,
          HandRanking: -1 as const,
          Hands: [],
          HoleCards: [],
          Ranking: -2 as const,
          RewardChip: 0,
        }]
      : []),
  ]

  return {
    ApiTypeId: ApiType.EVT_HAND_RESULTS,
    timestamp,
    HandId: handId,
    CommunityCards: [],
    Pot: 75,
    SidePot: [],
    ResultType: 0,
    DefeatStatus: heroChip === 0 ? 1 : 0,
    HandLog: '',
    Results: results,
    // This field can reappear with a positive stack in the result for a hand
    // whose authoritative EVT_DEAL had no Player. It must not retroactively
    // turn that spectator hand into a hero-dealt hand.
    Player: {
      SeatIndex: 5,
      BetStatus: BetStatusType.HAND_ENDED,
      Chip: heroChip,
      BetChip: 0,
    },
    OtherPlayers: ([0, 1, 2, 3, 4] as const).map(SeatIndex => ({
      SeatIndex,
      Status: 0 as const,
      BetStatus: BetStatusType.HAND_ENDED as const,
      Chip: 50_000,
      BetChip: 0 as const,
    })),
  }
}

const ENTRY: ApiEvent<ApiType.EVT_ENTRY_QUEUED> = {
  ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
  timestamp: T0 - 1_000,
  BattleType: BattleType.RING_GAME,
  Code: 0,
  Id: SESSION_ID,
  IsRetire: false,
}

const BUST_DEAL = dealEvent({
  timestamp: T0,
  lineup: SEATED_LINEUP,
  hero: { chip: 109_848, holeCards: [0, 5] },
})
const BUST_RESULTS = handResultsEvent({
  timestamp: T0 + 34_000,
  handId: 287193536,
  heroChip: 0,
  includeHeroResult: true,
})
const SPECTATOR_DEAL = dealEvent({
  timestamp: T0 + 49_000,
  lineup: SPECTATOR_LINEUP,
})
const SPECTATOR_RESULTS = handResultsEvent({
  timestamp: T0 + 57_000,
  handId: 287193581,
  heroChip: 50_000,
  includeHeroResult: false,
})
const REBUY_DEAL = dealEvent({
  timestamp: T0 + 60_000,
  lineup: SEATED_LINEUP,
  hero: { chip: 49_875, holeCards: [10, 15] },
})
const REBUY_RESULTS = handResultsEvent({
  timestamp: T0 + 90_000,
  handId: 287193614,
  heroChip: 49_375,
  includeHeroResult: true,
})

const FIXTURE_EVENTS: ApiEvent[] = [
  ENTRY,
  BUST_DEAL,
  BUST_RESULTS,
  SPECTATOR_DEAL,
  SPECTATOR_RESULTS,
  REBUY_DEAL,
  REBUY_RESULTS,
]

function handsStat(stats: PlayerStats[], playerId: number): StatResult | undefined {
  const player = stats.find(stat => stat.playerId === playerId)
  if (!player || !('statResults' in player) || !player.statResults) return undefined
  return player.statResults.find(stat => stat.id === 'hands')
}

describe('Ring bust -> spectator -> rebuy lifecycle (audit_ref 8f34d5fc1c03)', () => {
  let db: PokerChaseDB

  beforeEach(async () => {
    clearRecentHandsCache()
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
  })

  afterEach(async () => {
    await db.delete()
    clearRecentHandsCache()
  })

  test('spectator hand is retained without inheriting hero participation; rebuy starts at the next Player-present deal', async () => {
    // The sanitized fixture remains valid at the same schema boundary used by
    // production ingestion. It contains one initial 201 and no 309/IsRebuy.
    expect(FIXTURE_EVENTS.map(parseApiEvent).every(event => event !== null)).toBe(true)
    expect(FIXTURE_EVENTS.filter(event => event.ApiTypeId === ApiType.EVT_ENTRY_QUEUED)).toHaveLength(1)
    expect(FIXTURE_EVENTS.filter(event => event.ApiTypeId === ApiType.EVT_SESSION_RESULTS)).toHaveLength(0)
    expect(FIXTURE_EVENTS.some(event => 'IsRebuy' in event)).toBe(false)

    const service = new PokerChaseService({ db })
    await service.ready

    const aggregatedHands: ApiEvent[][] = []
    const completedLineups: number[][] = []
    service.handAggregateStream.on('data', hand => aggregatedHands.push(hand))
    // WriteEntityStream's output is the exact lineup sent downstream to
    // ReadEntityStream/HUD after a successfully persisted hand.
    service.writeEntityStream.on('data', lineup => completedLineups.push(lineup))

    const write = async (event: ApiEvent) => {
      service.handAggregateStream.write(event)
      await service.handAggregateStream.whenIdle()
    }

    await write(ENTRY)
    await write(BUST_DEAL)
    await write(BUST_RESULTS)

    expect(service.session.id).toBe(SESSION_ID)
    expect(service.session.battleType).toBe(BattleType.RING_GAME)
    expect(service.playerId).toBe(HERO_ID)
    expect(service.latestEvtDeal).toEqual(BUST_DEAL)

    await write(SPECTATOR_DEAL)

    // Live HUD context follows the spectator table, but the durable hero
    // anchor and identity remain on the last Player-present deal.
    expect(service.liveEvtDeal).toEqual(SPECTATOR_DEAL)
    expect(service.liveEvtDeal?.Player).toBeUndefined()
    expect(service.latestEvtDeal).toEqual(BUST_DEAL)
    expect(service.playerId).toBe(HERO_ID)

    await write(SPECTATOR_RESULTS)

    // A positive Player stack in 306 is only a result-time snapshot. The
    // corresponding 303 remains authoritative: no stale hero seat/cards are
    // synthesized and the spectator hand is not promoted to hero history.
    expect(SPECTATOR_RESULTS.Player?.Chip).toBe(50_000)
    expect(aggregatedHands).toHaveLength(2)
    expect(aggregatedHands[1]![0]).toEqual(SPECTATOR_DEAL)
    expect((aggregatedHands[1]![0] as ApiEvent<ApiType.EVT_DEAL>).Player).toBeUndefined()

    const handsBeforeRebuy = await db.hands.orderBy('id').toArray()
    expect(handsBeforeRebuy.map(hand => hand.id)).toEqual([287193536, 287193581])
    expect(handsBeforeRebuy[1]!.seatUserIds).toEqual(SPECTATOR_LINEUP)
    expect(handsBeforeRebuy[1]!.seatUserIds).not.toContain(HERO_ID)
    expect(handsBeforeRebuy.every(hand => hand.session.id === SESSION_ID)).toBe(true)
    expect(completedLineups).toEqual([SEATED_LINEUP, SPECTATOR_LINEUP])
    expect(completedLineups[1]).not.toContain(HERO_ID)
    expect(handsStat(await service.statsOutputStream.calcStats([HERO_ID]), HERO_ID)?.value).toBe(1)
    expect((await getRecentHands(db, service, HERO_ID)).hands.map(hand => hand.handId)).toEqual([287193536])

    await write(REBUY_DEAL)

    // Participation resumes only now, at the next Player-present 303. No
    // session reset or rebuy flag was needed to re-anchor both HUD contexts.
    expect(service.session.id).toBe(SESSION_ID)
    expect(service.playerId).toBe(HERO_ID)
    expect(service.latestEvtDeal).toEqual(REBUY_DEAL)
    expect(service.liveEvtDeal).toEqual(REBUY_DEAL)
    expect(service.liveEvtDeal?.Player?.HoleCards).toEqual([10, 15])

    await write(REBUY_RESULTS)

    const allHands = await db.hands.orderBy('id').toArray()
    expect(allHands.map(hand => hand.id)).toEqual([287193536, 287193581, 287193614])
    expect(allHands.every(hand => hand.session.id === SESSION_ID)).toBe(true)
    expect(completedLineups).toEqual([SEATED_LINEUP, SPECTATOR_LINEUP, SEATED_LINEUP])
    expect(handsStat(await service.statsOutputStream.calcStats([HERO_ID]), HERO_ID)?.value).toBe(2)
    expect((await getRecentHands(db, service, HERO_ID)).hands.map(hand => hand.handId)).toEqual([
      287193614,
      287193536,
    ])
  })
})
