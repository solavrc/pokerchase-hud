import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { trackServiceForTeardown } from './test-service-teardown'
import type { HandLogEvent } from '../types/hand-log'
import { EntityConverter } from '../entity-converter'
import { ActionType, ApiType, BattleType, BetStatusType, PhaseType, RankType, type ApiEvent } from '../types'
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

test.each([false, true])(
  '保存済みOLD Ring handのsingle/batch exportは次session通知=%sでも文脈を固定しlate名簿を使う',
  async withNextSession => {
    const events: ApiEvent[] = readFileSync(
      join(process.cwd(), 'e2e/fixtures/hand-ring-seat-replacement.ndjson'),
      'utf8'
    ).trim().split('\n').map(line => JSON.parse(line))
    const entry = events.find(event => event.ApiTypeId === ApiType.EVT_ENTRY_QUEUED)!
    const roster = events.find(event => event.ApiTypeId === ApiType.EVT_PLAYER_SEAT_ASSIGNED)!
    const deal = events.find(event => event.ApiTypeId === ApiType.EVT_DEAL)!
    const result = events.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)!
    const details = (readFileSync(join(process.cwd(), 'e2e/fixtures/session-3hands.ndjson'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line)) as ApiEvent[])
      .find(event => event.ApiTypeId === ApiType.EVT_SESSION_DETAILS)!

    entry.Id = 'OLD_ID'
    const oldDetails = { ...structuredClone(details), Name: 'OLD_SESSION', timestamp: entry.timestamp! + 1 }
    events.splice(events.indexOf(entry) + 1, 0, oldDetails)

    // 名前はDEAL後の313だけで補完し、保存handのsession metadataとは分けて検証する。
    events.splice(events.indexOf(roster), 1)
    roster.timestamp = deal.timestamp
    roster.TableUsers = roster.TableUsers!.map(player => ({
      ...player,
      UserName: `Late${player.UserName}`,
    }))
    events.splice(events.indexOf(deal) + 1, 0, roster)

    for (const event of events) expect(apiEventSchemas[event.ApiTypeId].safeParse(event).success).toBe(true)
    const hand = new EntityConverter({ players: new Map(), reset() {} })
      .convertEventsToEntities(structuredClone(events)).hands[0]!
    expect(hand.session).toEqual({
      id: 'OLD_ID',
      battleType: BattleType.RING_GAME,
      name: 'OLD_SESSION',
    })
    expect(hand.playerChipAccounting!['3101']).toEqual({
      grossPayout: 0,
      totalContribution: 0,
      netChips: 0,
    })
    expect(hand.playerChipAccounting!['3104']).toEqual({
      grossPayout: 75,
      totalContribution: 50,
      netChips: 25,
    })

    const rawEvents = structuredClone(events)
    if (withNextSession) {
      const resultIndex = rawEvents.findIndex(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)
      rawEvents.splice(
        resultIndex,
        0,
        { ...structuredClone(entry), Id: 'NEXT_ID', BattleType: BattleType.SIT_AND_GO,
          timestamp: result.timestamp! - 1 },
        { ...structuredClone(details), Name: 'NEXT_SESSION', timestamp: result.timestamp! - 1 },
      )
    }

    const db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    try {
      await mergeApiEvents(db, rawEvents as RawApiEvent[])
      await db.hands.put(hand)
      HandLogExporter.clearCache()
      const single = await HandLogExporter.exportHand(db, hand.id)
      HandLogExporter.clearCache()
      const batch = await HandLogExporter.exportMultipleHands(db, [hand.id])
      expect(batch).toBe(single)

      for (const exported of [single, batch]) {
        const lines = exported.split('\n')
        expect(lines[0]).not.toContain('Tournament')
        expect(lines).toContain("Table 'OLD_SESSION' 6-max Seat #3 is the button")
        expect(lines).toContain('Seat 1: LatePlayer1 (3491 in chips)')
        expect(lines).toContain('LatePlayer1: folds')
        expect(lines).toContain('LatePlayer3: posts small blind 25')
        expect(lines).toContain('LatePlayer4 collected 50 from pot')
        expect(lines).toContain('Total pot 50 | Rake 0')
        expect(exported).not.toMatch(/NEXT_SESSION|Player310[1-4]/)
      }
    } finally {
      HandLogExporter.clearCache()
      db.close()
      await db.delete()
    }
  }
)


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
      // live ingestion同様、Aggregateのserialized callbackだけからHandLogへ渡す。
      service.handAggregateStream.write(event)
      await service.handAggregateStream.whenIdle()
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

test.each([
  ['replaced', true], ['replaced', false], ['cleared', true], ['cleared', false],
] as const)('完成301再評価: 名簿%s・river bet=%sでもBB checkとshowdown順を保つ', async (rosterState, riverBet) => {
  const fixture: ApiEvent[] = readFileSync(join(process.cwd(), 'e2e/fixtures/hand-ring-seat-replacement.ndjson'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line))
  const entry = fixture.find(event => event.ApiTypeId === ApiType.EVT_ENTRY_QUEUED)!
  const roster = fixture.find(event => event.ApiTypeId === ApiType.EVT_PLAYER_SEAT_ASSIGNED)!
  const deal = fixture.find(event => event.ApiTypeId === ApiType.EVT_DEAL)!
  const folds = fixture.filter(event => event.ApiTypeId === ApiType.EVT_ACTION && event.SeatIndex !== 3)
  const template = fixture.filter(event => event.ApiTypeId === ApiType.EVT_ACTION).find(event => event.SeatIndex === 3)!
  const result = fixture.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)!
  const boundary = fixture.find(event => event.ApiTypeId === ApiType.EVT_PLAYER_JOIN)!
  const events: ApiEvent[] = [entry, roster, deal, ...folds]
  let timestamp = folds.at(-1)!.timestamp!
  const action = (seat: number, type: ActionType, phase: PhaseType, chip: number, bet: number, pot: number, next: number) => {
    events.push({ ...structuredClone(template), timestamp: ++timestamp, SeatIndex: seat, ActionType: type, Chip: chip, BetChip: bet,
      Progress: { ...template.Progress, Phase: phase, Pot: pot, NextActionSeat: next,
        NextActionTypes: next < 0 ? [] : type === ActionType.BET
          ? [ActionType.FOLD, ActionType.CALL, ActionType.RAISE, ActionType.ALL_IN]
          : [ActionType.CHECK, ActionType.BET, ActionType.ALL_IN] },
    } as ApiEvent<ApiType.EVT_ACTION>)
  }
  // SBがlimpしてBBは省略CHECK。以後は実際の305/304を通り、riverだけ任意にBET/CALLする。
  action(3, ActionType.CALL, PhaseType.PREFLOP, 8050, 50, 100, -1)
  for (const phase of [PhaseType.FLOP, PhaseType.TURN, PhaseType.RIVER] as const) {
    events.push({ ApiTypeId: ApiType.EVT_DEAL_ROUND, timestamp: ++timestamp,
      CommunityCards: phase === PhaseType.FLOP ? [0, 5, 10] : phase === PhaseType.TURN ? [15] : [20],
      Player: { ...deal.Player!, Chip: 8050, BetChip: 0 },
      OtherPlayers: deal.OtherPlayers.map(player => ({ ...player, BetChip: 0, Status: 0,
        BetStatus: player.SeatIndex === 5 ? BetStatusType.BET_ABLE : BetStatusType.FOLDED })),
      Progress: { MinRaise: 0, NextActionSeat: 3, NextActionTypes: [ActionType.CHECK, ActionType.BET],
        NextExtraLimitSeconds: 0, Phase: phase, Pot: 100, SidePot: [] },
    })
    const betting = phase === PhaseType.RIVER && riverBet
    action(3, betting ? ActionType.BET : ActionType.CHECK, phase, betting ? 8000 : 8050, betting ? 50 : 0, betting ? 150 : 100, 5)
    action(5, betting ? ActionType.CALL : ActionType.CHECK, phase, betting ? 4825 : 4875, betting ? 50 : 0, betting ? 200 : 100,
      phase === PhaseType.RIVER ? -2 : -1)
  }
  result.timestamp = ++timestamp
  result.Pot = riverBet ? 200 : 100
  result.CommunityCards = []
  result.Player!.Chip = (riverBet ? 8000 : 8050) + result.Pot
  result.OtherPlayers.find(player => player.SeatIndex === 5)!.Chip = riverBet ? 4825 : 4875
  result.Results = [
    { UserId: 3104, RankType: RankType.HIGH_CARD, HandRanking: 2, Hands: [], HoleCards: [6, 32], Ranking: -2, RewardChip: 0 },
    { UserId: 3103, RankType: RankType.ONE_PAIR, HandRanking: 1, Hands: [], HoleCards: [4, 31], Ranking: -2, RewardChip: result.Pot },
  ]
  boundary.timestamp = result.timestamp
  const nextRoster = structuredClone(roster)
  nextRoster.timestamp = result.timestamp
  nextRoster.TableUsers = nextRoster.TableUsers.map(user => ({ ...user, UserName: `Next${user.UserName}` }))
  events.push(result, { ...entry, Id: 'NEXT_ID', timestamp: result.timestamp },
    ...(rosterState === 'replaced' ? [nextRoster] : []), boundary)
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
      service.handAggregateStream.write(event)
      await service.handAggregateStream.whenIdle()
    }
    const updates = outputs.filter(event => event.type === 'update' && event.handId === result.HandId)
    expect(updates).toHaveLength(2)
    const first = updates[0]!.entries!.map(item => item.text)
    const second = updates[1]!.entries!.map(item => item.text)
    expect(first.filter(text => text === 'Player4: checks').length).toBeGreaterThan(riverBet ? 2 : 3)
    expect(second.filter(text => text === 'Player4: checks')).toEqual(first.filter(text => text === 'Player4: checks'))
    const shows = (lines: string[]) => lines.filter(text => text.includes(': shows ['))
    expect(shows(first)[0]).toMatch(riverBet ? /^Player3:/ : /^Player4:/)
    expect(shows(second)).toEqual(shows(first))
    expect(second.join('\n')).not.toContain('NextPlayer')
    expect((await db.hands.get(result.HandId))?.id).toBe(result.HandId)
  } finally {
    warmupCount.mockRestore()
    service.cancelPendingPersist()
    db.close()
    await db.delete()
  }
})
