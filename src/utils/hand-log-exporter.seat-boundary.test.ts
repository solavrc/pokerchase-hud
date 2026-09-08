import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { trackServiceForTeardown } from './test-service-teardown'
import type { HandLogEvent } from '../types/hand-log'
import { EntityConverter } from '../entity-converter'
import { ApiType, BattleType, type ApiEvent } from '../types'
import { apiEventSchemas } from '../types/api'
import { mergeApiEvents, type RawApiEvent } from './api-event-key'
import { HandLogExporter } from './hand-log-exporter'

test.each(['normal', 'before-deal', 'after-deal'] as const)(
  '実IndexedDBのsingle/batch exportが%sの席交代境界を会計前に読む', async order => {
    const events: ApiEvent[] = readFileSync(join(process.cwd(), 'e2e/fixtures/hand-ring-seat-replacement.ndjson'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line))
    const deal = events.find(event => event.ApiTypeId === ApiType.EVT_DEAL)!
    const boundary = events.find(event => event.ApiTypeId === ApiType.EVT_PLAYER_JOIN)!
    if (order !== 'normal') {
      boundary.timestamp = deal.timestamp
      events.splice(events.indexOf(boundary), 1)
      events.splice(events.indexOf(deal) + Number(order === 'after-deal'), 0, boundary)
    }
    for (const event of events) expect(apiEventSchemas[event.ApiTypeId].safeParse(event).success).toBe(true)
    const bundle = new EntityConverter({ battleType: BattleType.RING_GAME, players: new Map(), reset() {} })
      .convertEventsToEntities(events)
    const db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    HandLogExporter.clearCache()
    try {
      await mergeApiEvents(db, events as RawApiEvent[])
      await db.hands.bulkPut(bundle.hands)
      const single = await HandLogExporter.exportHand(db, bundle.hands[0]!.id)
      const batch = await HandLogExporter.exportMultipleHands(db, [bundle.hands[0]!.id])
      expect(batch).toBe(single)
      const summary = single.split('\n').find(line => line.startsWith('Total pot'))
      expect(summary).toBe(order === 'normal'
        ? 'Total pot 50 | Rake 0'
        : 'Total pot unknown (net payout 50) | Rake unknown')
      expect(bundle.hands[0]!.playerChipAccounting!['3101']).toEqual(order === 'normal'
        ? { grossPayout: 0, totalContribution: 0, netChips: 0 } : null)
      expect(bundle.hands[0]!.playerChipAccounting!['3104']).toEqual({ grossPayout: 75, totalContribution: 50, netChips: 25 })
    } finally {
      HandLogExporter.clearCache()
      db.close()
      await db.delete()
    }
  })


test.each(['cleared', 'replaced', 'late-names'] as const)('完成301再評価: 名簿が%sでも旧ハンドの名前を保つ', async rosterState => {
  const events: ApiEvent[] = readFileSync(join(process.cwd(), 'e2e/fixtures/hand-ring-seat-replacement.ndjson'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line))
  const entry = events.find(event => event.ApiTypeId === ApiType.EVT_ENTRY_QUEUED)!
  const deal = events.find(event => event.ApiTypeId === ApiType.EVT_DEAL)!
  const result = events.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)!
  const boundary = events.find(event => event.ApiTypeId === ApiType.EVT_PLAYER_JOIN)!
  const roster = events.find(event => event.ApiTypeId === ApiType.EVT_PLAYER_SEAT_ASSIGNED)!
  const nextRoster = structuredClone(roster)
  nextRoster.timestamp = result.timestamp
  nextRoster.TableUsers = nextRoster.TableUsers!.map(user => ({ ...user, UserName: `Next${user.UserName}` }))
  if (rosterState === 'late-names') {
    events.splice(events.indexOf(roster), 1)
    roster.timestamp = deal.timestamp
    events.splice(events.indexOf(deal) + 1, 0, roster)
  }
  const details = (readFileSync(join(process.cwd(), 'e2e/fixtures/session-3hands.ndjson'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line)) as ApiEvent[])
    .find(event => event.ApiTypeId === ApiType.EVT_SESSION_DETAILS)!
  entry.Id = 'OLD_ID'
  events.splice(1, 0, { ...details, Name: 'OLD_SESSION', timestamp: entry.timestamp! + 1 })
  events.splice(events.indexOf(boundary), 1)
  boundary.timestamp = result.timestamp
  events.push(
    { ...entry, Id: 'NEXT_ID', BattleType: BattleType.SIT_AND_GO, timestamp: result.timestamp },
    { ...details, Name: 'NEXT_SESSION', timestamp: result.timestamp },
    ...(rosterState === 'replaced' ? [nextRoster] : []),
    boundary,
    ...(rosterState !== 'replaced' ? [nextRoster] : []),
  )
  const nextDeal = structuredClone(deal)
  nextDeal.timestamp! += 10000
  events.push(nextDeal)
  for (const event of events) expect(apiEventSchemas[event.ApiTypeId].safeParse(event).success).toBe(true)
  await chrome.storage.local.remove(PokerChaseService.STORAGE_KEY)
  const db = new PokerChaseDB(indexedDB, IDBKeyRange)
  await db.open()
  const service = trackServiceForTeardown(new PokerChaseService({ db }))
  await service.ready
  const warmupCount = jest.spyOn(db.hands, 'count').mockResolvedValue(0)
  const outputs: HandLogEvent[] = []
  service.handLogStream.on('data', event => outputs.push(event))
  try {
    for (const event of events) {
      // 実ingestion同様、HandLogが先・Aggregateが後。完了再評価も実streamを通す。
      service.handLogStream.write(event)
      service.handAggregateStream.write(event)
      await Promise.all([service.handLogStream.whenIdle(), service.handAggregateStream.whenIdle()])
    }
    const updates = outputs.filter(event => event.type === 'update' && event.handId === result.HandId)
    expect(updates).toHaveLength(2)
    expect(updates[0]!.entries!.map(entry => entry.text)).toContain('Player1: folds')
    for (const update of rosterState === 'late-names' ? updates.slice(1) : updates) {
      const lines = update.entries!.map(entry => entry.text)
      expect(lines[0]).not.toContain('Tournament')
      expect(lines).toContain("Table 'OLD_SESSION' 6-max Seat #3 is the button")
      expect(lines).toContain('Seat 1: Player1 (3491 in chips)')
      expect(lines).toContain('Player1: folds')
      expect(lines).toContain('Player3: posts small blind 25')
      expect(lines).toContain('Player4 collected 50 from pot')
      expect(lines).toContain('Seat 1: Player1 folded before Flop (didn\'t bet)')
      expect(lines.join('\n')).not.toMatch(/Player310[1-4]|NextPlayer/)
    }
    expect(updates.at(-1)!.entries!.map(entry => entry.text)).toContain('Total pot unknown (net payout 50) | Rake unknown')
    const nextHeader = outputs.at(-1)!.entries!.map(entry => entry.text)
    expect(nextHeader[0]).toContain('Tournament')
    expect(nextHeader[0]).toContain('NEXT_SESSION')
    expect(nextHeader).toContain('Seat 1: NextPlayer1 (3491 in chips)')
    expect((await db.hands.get(result.HandId))!.session).toEqual({ id: 'OLD_ID', battleType: BattleType.RING_GAME, name: 'OLD_SESSION' })
  } finally {
    warmupCount.mockRestore()
    service.cancelPendingPersist()
    db.close()
    await db.delete()
  }
})
