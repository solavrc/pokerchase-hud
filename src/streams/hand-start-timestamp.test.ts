import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { EntityConverter } from '../entity-converter'
import { MTT_TABLE_MOVE_FIXTURE } from '../test-fixtures/mtt-table-move-lifecycle'
import type { Session } from '../types'
import { HandLogExporter } from '../utils/hand-log-exporter'

const EMPTY_SESSION: Session = {
  id: undefined,
  battleType: undefined,
  name: undefined,
  players: new Map(),
  reset: () => { }
}

const formatJst = (timestamp: number): string => {
  const date = new Date(timestamp + 9 * 60 * 60 * 1000)
  return `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')} ` +
    `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}:${String(date.getUTCSeconds()).padStart(2, '0')} JST`
}

describe('hand start timestamps', () => {
  let db: PokerChaseDB

  beforeEach(async () => {
    HandLogExporter.clearCache()
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
  })

  afterEach(async () => {
    db.close()
    await db.delete()
    HandLogExporter.clearCache()
  })

  test('live writes, rebuilds, and exported logs use EVT_DEAL rather than EVT_HAND_RESULTS time', async () => {
    const events = MTT_TABLE_MOVE_FIXTURE.events.slice(0, 6)
    const handId = MTT_TABLE_MOVE_FIXTURE.handIds.oldAccepted
    const dealTimestamp = MTT_TABLE_MOVE_FIXTURE.timestamps.oldAcceptedDeal

    await db.apiEvents.bulkPut(events.map(event => ({ ...event, sequence: 0 })))

    const service = new PokerChaseService({ db })
    await service.ready
    for (const event of events) service.handAggregateStream.write(event)
    await service.handAggregateStream.whenIdle()

    expect((await db.hands.get(handId))?.approxTimestamp).toBe(dealTimestamp)

    const rebuilt = new EntityConverter(EMPTY_SESSION).convertEventsToEntities(events)
    expect(rebuilt.hands).toEqual([
      expect.objectContaining({ id: handId, approxTimestamp: dealTimestamp })
    ])

    const exported = await HandLogExporter.exportHand(db, handId)
    expect(exported).toContain(`- ${formatJst(dealTimestamp)}`)
  })
})
