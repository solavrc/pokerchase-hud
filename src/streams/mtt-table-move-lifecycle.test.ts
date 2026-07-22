import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { getPositionalStats, clearPositionalStatsCache } from '../services/positional-stats-service'
import { getRecentHands, clearRecentHandsCache } from '../services/recent-hands-service'
import { MTT_TABLE_MOVE_FIXTURE } from '../test-fixtures/mtt-table-move-lifecycle'
import { ApiType, apiEventSchemas } from '../types/api'
import { Position } from '../types/game'
import type { ApiEvent } from '../types/api'
import { HandLogExporter } from '../utils/hand-log-exporter'

describe('sanitized MTT table-move lifecycle fixture', () => {
  let db: PokerChaseDB
  let service: PokerChaseService

  beforeEach(async () => {
    clearPositionalStatsCache()
    clearRecentHandsCache()
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = new PokerChaseService({ db })
    await service.ready
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    db.close()
    await db.delete()
  })

  test('contains schema-valid events with only synthetic/redacted identity fields', () => {
    for (const event of MTT_TABLE_MOVE_FIXTURE.events) {
      expect(() => apiEventSchemas[event.ApiTypeId]!.parse(event)).not.toThrow()
    }

    const entryIds = MTT_TABLE_MOVE_FIXTURE.events
      .filter((event): event is ApiEvent<ApiType.EVT_ENTRY_QUEUED> => event.ApiTypeId === ApiType.EVT_ENTRY_QUEUED)
      .map(event => event.Id)
    expect(entryIds).toEqual(['redacted', 'redacted', 'redacted'])

    const tableUsers = MTT_TABLE_MOVE_FIXTURE.events
      .filter((event): event is ApiEvent<ApiType.EVT_PLAYER_SEAT_ASSIGNED> => event.ApiTypeId === ApiType.EVT_PLAYER_SEAT_ASSIGNED)
      .flatMap(event => event.TableUsers)
    expect(tableUsers.every(user => user.UserName === '')).toBe(true)
    expect(tableUsers.every(user => user.UserId >= 1000 && user.UserId <= 4000)).toBe(true)
  })

  test('rejects the chimera, re-anchors HUD seat context, and retains receive chronology across HandId inversion', async () => {
    const acceptedLineups: number[][] = []
    service.writeEntityStream.on('data', lineup => acceptedLineups.push([...lineup]))
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})

    // HandLogExporter reads the raw event lake rather than the live stream.
    await db.apiEvents.bulkPut(MTT_TABLE_MOVE_FIXTURE.events.map(event => ({ ...event, sequence: 0 })))

    for (const event of MTT_TABLE_MOVE_FIXTURE.events) {
      service.handAggregateStream.write(event)
    }
    await service.handAggregateStream.whenIdle()

    const storedHands = await db.hands.toArray()
    expect(storedHands.map(hand => hand.id).sort((a, b) => a - b)).toEqual([
      MTT_TABLE_MOVE_FIXTURE.handIds.invertedAccepted,
      MTT_TABLE_MOVE_FIXTURE.handIds.oldAccepted,
      MTT_TABLE_MOVE_FIXTURE.handIds.newAccepted
    ].sort((a, b) => a - b))
    expect(await db.hands.get(MTT_TABLE_MOVE_FIXTURE.handIds.rejectedChimera)).toBeUndefined()
    expect(await db.actions.where('handId').equals(MTT_TABLE_MOVE_FIXTURE.handIds.rejectedChimera).count()).toBe(0)
    expect(await db.phases.where('handId').equals(MTT_TABLE_MOVE_FIXTURE.handIds.rejectedChimera).count()).toBe(0)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(
      `Rejected chimera hand (HandId=${MTT_TABLE_MOVE_FIXTURE.handIds.rejectedChimera})`
    ))

    expect(acceptedLineups).toEqual([
      MTT_TABLE_MOVE_FIXTURE.oldLineup,
      MTT_TABLE_MOVE_FIXTURE.middleLineup,
      MTT_TABLE_MOVE_FIXTURE.newLineup
    ])
    expect(service.playerId).toBe(MTT_TABLE_MOVE_FIXTURE.heroId)
    expect(service.latestEvtDeal?.SeatUserIds).toEqual(MTT_TABLE_MOVE_FIXTURE.newLineup)
    expect(service.latestEvtDeal?.Player?.SeatIndex).toBe(MTT_TABLE_MOVE_FIXTURE.newHeroSeat)
    expect(service.liveEvtDeal?.SeatUserIds).toEqual(MTT_TABLE_MOVE_FIXTURE.newLineup)
    expect(service.liveEvtDeal?.Player?.SeatIndex).toBe(MTT_TABLE_MOVE_FIXTURE.newHeroSeat)
    expect([...service.session.players.keys()].sort((a, b) => a - b)).toEqual(
      [...MTT_TABLE_MOVE_FIXTURE.newLineup].sort((a, b) => a - b)
    )
    for (const oldPlayerId of MTT_TABLE_MOVE_FIXTURE.oldLineup) {
      if (oldPlayerId !== MTT_TABLE_MOVE_FIXTURE.heroId) {
        expect(service.session.players.has(oldPlayerId)).toBe(false)
      }
    }

    // Recent means receive chronology, not numeric HandId order. In particular,
    // 288331101 arrived after 288331102 in this MTT table-move sequence.
    const recent = await getRecentHands(db, service, MTT_TABLE_MOVE_FIXTURE.heroId, 3)
    expect(recent.hands.map(hand => hand.handId)).toEqual([
      MTT_TABLE_MOVE_FIXTURE.handIds.newAccepted,
      MTT_TABLE_MOVE_FIXTURE.handIds.invertedAccepted,
      MTT_TABLE_MOVE_FIXTURE.handIds.oldAccepted
    ])

    // The newest two accepted hands were both played from the BB. Numeric
    // HandId sorting would incorrectly select the old-table CO hand (102)
    // instead of the later destination-table BB hand (101).
    service.handLimitFilter = 2
    clearPositionalStatsCache()
    const positional = await getPositionalStats(db, service, MTT_TABLE_MOVE_FIXTURE.heroId)
    expect(positional.positions.find(bucket => bucket.position === Position.BB)?.handsN).toBe(2)
    expect(positional.positions.find(bucket => bucket.position === Position.CO)?.handsN).toBe(0)

    const hudStats = await service.statsOutputStream.calcStats([MTT_TABLE_MOVE_FIXTURE.heroId])
    const heroStats = hudStats.find(stats => stats.playerId === MTT_TABLE_MOVE_FIXTURE.heroId)
    expect(heroStats && 'statResults' in heroStats
      ? heroStats.statResults?.find(stat => stat.id === 'vpip')?.value
      : undefined).toEqual([0, 2])

    const exported = await HandLogExporter.exportRecentHands(db, undefined, 3)
    const newestIndex = exported.indexOf(`PokerStars Hand #${MTT_TABLE_MOVE_FIXTURE.handIds.newAccepted}`)
    const invertedIndex = exported.indexOf(`PokerStars Hand #${MTT_TABLE_MOVE_FIXTURE.handIds.invertedAccepted}`)
    const oldIndex = exported.indexOf(`PokerStars Hand #${MTT_TABLE_MOVE_FIXTURE.handIds.oldAccepted}`)
    expect(newestIndex).toBeGreaterThanOrEqual(0)
    expect(invertedIndex).toBeGreaterThan(newestIndex)
    expect(oldIndex).toBeGreaterThan(invertedIndex)
  })
})
