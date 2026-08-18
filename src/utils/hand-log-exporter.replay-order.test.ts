import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { PokerChaseDB } from '../app'
import { EntityConverter } from '../entity-converter'
import { ApiType, type ApiEvent, type Session } from '../types'
import { HandLogExporter } from './hand-log-exporter'

const readFixture = (): ApiEvent[] => readFileSync(
  join(process.cwd(), 'e2e/fixtures/session-3hands.ndjson'),
  'utf8'
).trim().split('\n').map(line => JSON.parse(line)) as ApiEvent[]

const makeEmptySession = (): Session => ({
  id: undefined,
  battleType: undefined,
  name: undefined,
  players: new Map(),
  reset: () => {},
})

describe('HandLogExporter replay order', () => {
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

  test('部分範囲外の前ハンドDEALをcontextにして同一ms境界を単体・複数exportで直す', async () => {
    const fixture = readFixture()
    const allDeals = fixture.filter(event => event.ApiTypeId === ApiType.EVT_DEAL)
    const allResults = fixture.filter(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)
    const firstDealIndex = fixture.indexOf(allDeals[1]!)
    const targetResultIndex = fixture.indexOf(allResults[2]!)
    const twoHandWindow = fixture.slice(firstDealIndex, targetResultIndex + 1)
    const previousResultIndex = twoHandWindow.findIndex(
      event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS
    )
    const targetDeal = twoHandWindow.find(
      (event, index) => event.ApiTypeId === ApiType.EVT_DEAL && index > 0
    )!
    const targetDealTimestamp = targetDeal.timestamp!

    // 前ハンドのDEAL～最終ACTIONを対象DEALの5分bufferより前へ置き、RESULTSだけを
    // 対象DEALと同一msへ寄せる。wire配列の因果順はRESULTS→次DEALのまま。
    const events = twoHandWindow.map((event, index) => {
      if (index < previousResultIndex) {
        return { ...event, timestamp: event.timestamp! - 400_000 }
      }
      if (index === previousResultIndex) {
        return { ...event, timestamp: targetDealTimestamp }
      }
      return event
    }) as ApiEvent[]

    const entities = new EntityConverter(makeEmptySession()).convertEventsToEntities(events)
    expect(entities.hands).toHaveLength(2)
    await db.apiEvents.bulkPut(events.map(event => ({ ...event, sequence: 0 })))
    await db.hands.bulkPut(entities.hands)

    const previousHandId = allResults[1]!.HandId
    const targetHandId = allResults[2]!.HandId
    const single = await HandLogExporter.exportHand(db, targetHandId)
    const multiple = await HandLogExporter.exportMultipleHands(db, [targetHandId])

    for (const exported of [single, multiple]) {
      expect(exported).toContain(`PokerStars Hand #${targetHandId}`)
      expect(exported).not.toContain(`PokerStars Hand #${previousHandId}`)
    }
  })

  test('範囲外context自身が圧縮境界でも、anchorまで辿って対象ハンドを復元する', async () => {
    const fixture = readFixture()
    let handIndex = -1
    const events = fixture.map((event, index) => {
      if (event.ApiTypeId === ApiType.EVT_DEAL) handIndex++

      let timestamp: number
      if (handIndex < 0) timestamp = 10 + index
      else if (handIndex === 0) {
        timestamp = event.ApiTypeId === ApiType.EVT_DEAL
          ? 100
          : event.ApiTypeId === ApiType.EVT_HAND_RESULTS ? 200 : 110 + index
      } else if (handIndex === 1) {
        timestamp = event.ApiTypeId === ApiType.EVT_DEAL
          ? 200
          : event.ApiTypeId === ApiType.EVT_HAND_RESULTS ? 600_000 : 300 + index * 10
      } else {
        timestamp = event.ApiTypeId === ApiType.EVT_DEAL ? 600_000 : 600_100 + index * 10
      }
      return { ...event, timestamp }
    }) as ApiEvent[]

    const entities = new EntityConverter(makeEmptySession()).convertEventsToEntities(events)
    expect(entities.hands).toHaveLength(3)
    await db.apiEvents.bulkPut(events.map(event => ({ ...event, sequence: 0 })))
    await db.hands.bulkPut(entities.hands)

    const handIds = fixture
      .filter(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)
      .map(event => event.HandId)
    const targetHandId = handIds[2]!
    const single = await HandLogExporter.exportHand(db, targetHandId)
    const multiple = await HandLogExporter.exportMultipleHands(db, [targetHandId])

    for (const exported of [single, multiple]) {
      expect(exported).toContain(`PokerStars Hand #${targetHandId}`)
      expect(exported).not.toContain(`PokerStars Hand #${handIds[0]}`)
      expect(exported).not.toContain(`PokerStars Hand #${handIds[1]}`)
    }
  })
})
