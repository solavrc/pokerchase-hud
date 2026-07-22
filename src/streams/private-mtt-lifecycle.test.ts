import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { PokerChaseDB } from '../db/poker-chase-db'
import { EntityConverter } from '../entity-converter'
import PokerChaseService from '../services/poker-chase-service'
import { clearRecentHandsCache, getRecentHands } from '../services/recent-hands-service'
import { PRIVATE_MTT_LIFECYCLE_FIXTURE } from '../test-fixtures/private-mtt-lifecycle'
import {
  ApiType,
  BattleType,
  parseApiEvent,
} from '../types'
import type { ApiEvent, PlayerStats, Session, StatResult } from '../types'
import { HandLogExporter } from '../utils/hand-log-exporter'

const EMPTY_SESSION: Session = {
  id: undefined,
  battleType: undefined,
  name: undefined,
  players: new Map(),
  reset: () => {},
}

function handsStat(stats: PlayerStats[], playerId: number): StatResult | undefined {
  const player = stats.find(stat => stat.playerId === playerId)
  if (!player || !('statResults' in player) || !player.statResults) return undefined
  return player.statResults.find(stat => stat.id === 'hands')
}

describe('private MTT rebuy/table-move lifecycle (audit_ref b1feff03635a)', () => {
  let db: PokerChaseDB

  beforeEach(async () => {
    clearRecentHandsCache()
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
  })

  afterEach(async () => {
    db.close()
    await db.delete()
    clearRecentHandsCache()
  })

  test('keeps only structural evidence and remains schema-valid', () => {
    const { events, intermediateResults, finalResult } = PRIVATE_MTT_LIFECYCLE_FIXTURE

    expect(events.filter(event => parseApiEvent(event) === null).map(event => event.ApiTypeId)).toEqual([])
    expect(events.filter(event => event.ApiTypeId === ApiType.EVT_ENTRY_QUEUED)).toHaveLength(3)
    expect(events.filter(event => event.ApiTypeId === ApiType.EVT_SESSION_DETAILS)).toHaveLength(3)
    expect(events.filter(event => event.ApiTypeId === ApiType.EVT_PLAYER_SEAT_ASSIGNED)).toHaveLength(2)
    expect(events.filter(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)).toHaveLength(5)
    expect(events.filter(event => event.ApiTypeId === ApiType.EVT_SESSION_RESULTS)).toHaveLength(3)

    const entries = events.filter((event): event is ApiEvent<ApiType.EVT_ENTRY_QUEUED> =>
      event.ApiTypeId === ApiType.EVT_ENTRY_QUEUED
    )
    expect(new Set(entries.map(event => event.Id))).toEqual(new Set([
      PRIVATE_MTT_LIFECYCLE_FIXTURE.tournamentId,
    ]))
    expect(entries.every(event => event.BattleType === BattleType.TOURNAMENT)).toBe(true)
    expect(entries.every(event => event.BattleType !== BattleType.FRIEND_SIT_AND_GO)).toBe(true)
    expect(entries.every(event => event.BattleType !== BattleType.CLUB_MATCH)).toBe(true)

    expect(intermediateResults.map(event => [event.IsRebuy, event.Ranking])).toEqual([
      [true, -1],
      [true, -1],
    ])
    expect([finalResult.IsRebuy, finalResult.Ranking]).toEqual([false, 3])

    const tableUsers = events
      .filter((event): event is ApiEvent<ApiType.EVT_PLAYER_SEAT_ASSIGNED> =>
        event.ApiTypeId === ApiType.EVT_PLAYER_SEAT_ASSIGNED
      )
      .flatMap(event => event.TableUsers)
    expect(tableUsers.every(user => user.UserName === '')).toBe(true)
    expect(events.some(event => JSON.stringify(event).includes('ticket'))).toBe(false)
  })

  test('continues after rebuy results, re-anchors seats, and preserves one tournament grouping', async () => {
    const fixture = PRIVATE_MTT_LIFECYCLE_FIXTURE
    const service = new PokerChaseService({ db })
    await service.ready

    const completedLineups: number[][] = []
    service.writeEntityStream.on('data', lineup => completedLineups.push([...lineup]))

    await db.apiEvents.bulkPut(fixture.events.map(event => ({ ...event, sequence: 0 })))

    const writeThrough = async (events: readonly ApiEvent[]) => {
      for (const event of events) {
        service.handAggregateStream.write(event)
        await service.handAggregateStream.whenIdle()
        await service.writeEntityStream.whenIdle()
      }
    }

    const firstRebuyIndex = fixture.events.indexOf(fixture.intermediateResults[0])
    const secondRebuyIndex = fixture.events.indexOf(fixture.intermediateResults[1])

    await writeThrough(fixture.events.slice(0, firstRebuyIndex + 1))
    expect((await db.hands.toArray()).map(hand => hand.id)).toEqual([fixture.handIds[0]])
    expect(service.session.battleType).toBe(BattleType.TOURNAMENT)

    await writeThrough(fixture.events.slice(firstRebuyIndex + 1, secondRebuyIndex + 1))
    expect((await db.hands.toArray()).map(hand => hand.id).sort((a, b) => a - b)).toEqual(
      fixture.handIds.slice(0, 3).sort((a, b) => a - b)
    )
    expect(service.session.battleType).toBe(BattleType.TOURNAMENT)

    await writeThrough(fixture.events.slice(secondRebuyIndex + 1))

    const hands = await db.hands.toArray()
    expect(hands).toHaveLength(5)
    expect(new Set(hands.map(hand => hand.id))).toEqual(new Set(fixture.handIds))
    expect(completedLineups).toEqual([
      fixture.lineups.first,
      fixture.lineups.second,
      fixture.lineups.secondPreMove,
      fixture.lineups.final,
      fixture.lineups.final,
    ])

    const handsById = new Map(hands.map(hand => [hand.id, hand]))
    expect(handsById.get(fixture.handIds[0])?.seatUserIds).toEqual(fixture.lineups.first)
    expect(handsById.get(fixture.handIds[1])?.seatUserIds).toEqual(fixture.lineups.second)
    expect(handsById.get(fixture.handIds[2])?.seatUserIds).toEqual(fixture.lineups.secondPreMove)
    expect(handsById.get(fixture.handIds[3])?.seatUserIds).toEqual(fixture.lineups.final)
    expect(handsById.get(fixture.handIds[4])?.seatUserIds).toEqual(fixture.lineups.final)
    for (const hand of hands) {
      expect(hand.results.every(result => hand.seatUserIds.includes(result.UserId))).toBe(true)
      expect(hand.session.id).toBe(fixture.tournamentId)
      expect(hand.session.battleType).toBe(BattleType.TOURNAMENT)
      expect(hand.session.name).toBe(fixture.tournamentName)
    }

    const phases = await db.phases.toArray()
    expect(phases).toHaveLength(5)
    expect(new Set(phases.map(phase => phase.handId))).toEqual(new Set(fixture.handIds))

    expect(service.playerId).toBe(fixture.heroId)
    expect(service.latestEvtDeal).toEqual(fixture.finalDeal)
    expect(service.latestEvtDeal?.Player?.SeatIndex).toBe(2)
    expect(service.liveEvtDeal?.SeatUserIds).toEqual(fixture.lineups.final)
    expect([...service.session.players.keys()].sort((a, b) => a - b)).toEqual(
      [...fixture.lineups.final].sort((a, b) => a - b)
    )
    for (const oldPlayerId of fixture.lineups.first) {
      if (oldPlayerId !== fixture.heroId) expect(service.session.players.has(oldPlayerId)).toBe(false)
    }

    service.battleTypeFilter = [BattleType.TOURNAMENT]
    expect(handsStat(await service.statsOutputStream.calcStats([fixture.heroId]), fixture.heroId)?.value).toBe(5)

    service.battleTypeFilter = [BattleType.FRIEND_SIT_AND_GO, BattleType.CLUB_MATCH]
    const nonMttStats = await service.statsOutputStream.calcStats([fixture.heroId])
    expect(nonMttStats[0] && 'statResults' in nonMttStats[0] ? nonMttStats[0].statResults : undefined).toEqual([])

    service.battleTypeFilter = [BattleType.TOURNAMENT]
    const recent = await getRecentHands(db, service, fixture.heroId, 5)
    expect(recent.hands.map(hand => hand.handId)).toEqual([...fixture.handIds].reverse())

    const exported = await HandLogExporter.exportRecentHands(db, undefined, 5)
    for (const handId of fixture.handIds) {
      expect(exported.match(new RegExp(`PokerStars Hand #${handId}`, 'g'))).toHaveLength(1)
    }
    const exportOffsets = [...fixture.handIds].reverse().map(handId => exported.indexOf(`PokerStars Hand #${handId}`))
    expect(exportOffsets.every(offset => offset >= 0)).toBe(true)
    expect(exportOffsets).toEqual([...exportOffsets].sort((a, b) => a - b))

    // Batch parser/sessionizer parity: repeated 201/308/313 and intermediate
    // IsRebuy=true results must not duplicate hands or split one private MTT
    // into Friend/Club SNG sessions.
    const rebuilt = new EntityConverter(EMPTY_SESSION).convertEventsToEntities(fixture.events)
    expect(rebuilt.hands).toHaveLength(5)
    expect(rebuilt.hands.map(hand => hand.id)).toEqual(fixture.handIds)
    expect(rebuilt.hands.map(hand => hand.seatUserIds)).toEqual(completedLineups)
    expect(rebuilt.hands.every(hand => hand.session.id === fixture.tournamentId)).toBe(true)
    expect(rebuilt.hands.every(hand => hand.session.battleType === BattleType.TOURNAMENT)).toBe(true)
    expect(rebuilt.hands.every(hand => hand.session.name === fixture.tournamentName)).toBe(true)
  })
})
