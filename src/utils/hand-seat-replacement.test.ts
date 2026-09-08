import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ApiType, validateApiEvent, isApplicationApiEvent, type ApiEvent, type ApiHandEvent } from '../types/api'
import { ActionType, BattleType } from '../types/game'
import { deriveHandRakeAccounting, deriveHandSettlement, deriveMidHandChipInflow } from './hand-chip-accounting'
import { HandLogProcessor } from './hand-log-processor'

const fixture = (): ApiEvent[] => readFileSync(join(process.cwd(), 'e2e/fixtures/hand-ring-seat-replacement.ndjson'), 'utf8')
  .trim().split('\n').map(line => JSON.parse(line))

const hand = () => {
  const events = fixture().slice(2) as ApiHandEvent[]
  const deal = events.find(event => event.ApiTypeId === ApiType.EVT_DEAL)!
  const results = events.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)!
  const joinEvent = events.find(event => event.ApiTypeId === ApiType.EVT_PLAYER_JOIN)!
  const fold = events.find(event => event.ApiTypeId === ApiType.EVT_ACTION && event.SeatIndex === 0)! as ApiEvent<ApiType.EVT_ACTION>
  const settle = () => deriveHandSettlement(deal, results, BattleType.RING_GAME, events)
  return { events, deal, results, joinEvent, fold, settle }
}

test('席交代fixtureは全行が実際の入口schemaを通る', () => {
  for (const event of fixture()) {
    expect(validateApiEvent(event).success).toBe(true)
    expect(isApplicationApiEvent(event)).toBe(true)
  }
})

test.each([0, 100, 2950, 3491, 10000])('新しい人物の残高%sを旧人の投入にも買い足しにも使わない', chip => {
  const { events, deal, results, joinEvent, settle } = hand()
  joinEvent.JoinPlayer.Chip = chip
  results.OtherPlayers.find(player => player.SeatIndex === 0)!.Chip = chip
  const settlement = settle()
  expect(settlement.playerChipAccounting).toEqual({
    '3101': { grossPayout: 0, totalContribution: 0, netChips: 0 },
    '3102': { grossPayout: 0, totalContribution: 0, netChips: 0 },
    '3103': { grossPayout: 0, totalContribution: 25, netChips: -25 },
    '3104': { grossPayout: 75, totalContribution: 50, netChips: 25 },
  })
  expect(settlement.playerSettlements['3104']).toEqual({ contestedAward: 50, uncalledReturn: 25 })
  expect(settlement.winningPlayerIds).toEqual([3104])
  expect(deriveMidHandChipInflow(deal, results, events, BattleType.RING_GAME)?.get(0)).toBe(0)
  expect(deriveHandRakeAccounting(deal, results, BattleType.RING_GAME, events)).toEqual({ totalContribution: 75, totalPayout: 75, rake: 0 })
})

test('同一人物の301は席交代にせず、同一人の買い足しを維持する', () => {
  const { joinEvent, results, settle } = hand()
  joinEvent.JoinUser.UserId = 3101
  results.OtherPlayers.find(player => player.SeatIndex === 0)!.Chip = 4491
  expect(settle().playerChipAccounting['3101']).toEqual({ grossPayout: 0, totalContribution: 0, netChips: 0 })
  expect(settle().winningPlayerIds).toEqual([3104])
})

test('交代前FOLDがない席の残高はnullとし、legacy勝者fallbackも使わない', () => {
  const { events, fold, results, settle } = hand()
  events.splice(events.indexOf(fold), 1)
  results.OtherPlayers = results.OtherPlayers.filter(player => player.SeatIndex !== 0)
  expect(settle().playerChipAccounting['3101']).toBeNull()
  expect(settle().winningPlayerIds).toEqual([])
})

test('交代前の観測列に説明不能な減少があれば投入を復元しない', () => {
  const { fold, settle } = hand()
  fold.Chip -= 1
  expect(settle().playerChipAccounting['3101']).toBeNull()
  expect(settle().winningPlayerIds).toEqual([])
})

test('交代先の終点snapshotがなくても旧人のFOLDが確定すればhand会計だけを解決する', () => {
  const { events, deal, results, settle } = hand()
  results.OtherPlayers = results.OtherPlayers.filter(player => player.SeatIndex !== 0)
  expect(settle().playerChipAccounting['3101']).toEqual({ grossPayout: 0, totalContribution: 0, netChips: 0 })
  expect(settle().winningPlayerIds).toEqual([3104])
  expect(deriveHandRakeAccounting(deal, results, BattleType.RING_GAME, events)?.rake).toBe(0)
})

test('anteも交代前に払ったhand投入へ含める', () => {
  const { deal, results, settle } = hand()
  deal.Game.Ante = 10
  results.Pot += 40
  results.Results[0]!.RewardChip += 40
  results.OtherPlayers.find(player => player.SeatIndex === 5)!.Chip += 40
  expect(settle().playerChipAccounting['3101']).toEqual({ grossPayout: 0, totalContribution: 10, netChips: -10 })
  expect(settle().winningPlayerIds).toEqual([3104])
})

test('前streetの投入とFOLD前の買い足しを分離し、FOLD後の買い足しは投入へ混ぜない', () => {
  const { events, deal, fold, joinEvent, results, settle } = hand()
  const call = structuredClone(fold)
  Object.assign(call, { ActionType: ActionType.CALL, Chip: 3441, BetChip: 50 })
  call.Progress.Pot = 125
  const flop: ApiEvent<ApiType.EVT_DEAL_ROUND> = {
    ApiTypeId: ApiType.EVT_DEAL_ROUND, timestamp: 1733100004500,
    CommunityCards: [0, 1, 2],
    Progress: { ...call.Progress, MinRaise: 0, NextActionTypes: [ActionType.CHECK, ActionType.ALL_IN, ActionType.BET], Phase: 1, NextActionSeat: 0 },
    Player: { ...deal.Player!, BetChip: 0 },
    OtherPlayers: deal.OtherPlayers.map(player => ({ ...player, Status: 0, BetChip: 0, Chip: player.SeatIndex === 0 ? 4441 : player.Chip })),
  }
  Object.assign(fold, { Chip: 4441, BetChip: 0, Progress: { ...fold.Progress, Phase: 1 } })
  const later = structuredClone(flop)
  later.Progress.Phase = 2
  later.OtherPlayers.find(player => player.SeatIndex === 0)!.Chip += 500
  later.OtherPlayers.find(player => player.SeatIndex === 0)!.BetStatus = 2
  events.splice(0, events.length, deal, call, flop, fold, later, joinEvent, results)
  events.forEach((event, i) => { event.timestamp = 1733100003000 + i * 1000 })
  results.Pot = 125
  results.Results[0]!.RewardChip = 125
  results.OtherPlayers.find(player => player.SeatIndex === 5)!.Chip = 5000
  expect(settle().playerChipAccounting['3101']).toEqual({ grossPayout: 0, totalContribution: 50, netChips: -50 })
  expect(settle().winningPlayerIds).toEqual([3104])
})

test('交代で終点table保存則が使えなくても、投入を超える支払は拒否する', () => {
  const { results, settle } = hand()
  results.Pot += 100
  results.Results[0]!.RewardChip += 100
  results.OtherPlayers.find(player => player.SeatIndex === 5)!.Chip += 100
  expect(Object.values(settle().playerChipAccounting).every(entry => entry === null)).toBe(true)
  expect(settle().winningPlayerIds).toEqual([])
})

test('FOLD前の買い足しだけを控除し、別人の着席後に旧UserIdが戻っても接続し直さない', () => {
  const { events, fold, joinEvent, results, settle } = hand()
  fold.Chip += 1000
  const rejoin = structuredClone(joinEvent)
  rejoin.JoinUser.UserId = 3101
  rejoin.JoinPlayer.Chip = 9000
  events.splice(events.indexOf(joinEvent) + 1, 0, rejoin)
  results.OtherPlayers.find(player => player.SeatIndex === 0)!.Chip = 9000
  expect(settle().playerChipAccounting['3101']).toEqual({ grossPayout: 0, totalContribution: 0, netChips: 0 })
})

test('交代後の同席行動は旧人の続行と区別できずunknownにする', () => {
  const { events, joinEvent, results, settle } = hand()
  events.splice(events.indexOf(joinEvent), 1)
  results.OtherPlayers.find(player => player.SeatIndex === 0)!.Chip = 3491
  joinEvent.JoinPlayer.SeatIndex = 3
  events.splice(events.length - 1, 0, joinEvent)
  const newAction = structuredClone(events.find(event => event.ApiTypeId === ApiType.EVT_ACTION)!) as ApiEvent<ApiType.EVT_ACTION>
  Object.assign(newAction, { SeatIndex: 3, ActionType: ActionType.FOLD, Chip: 9999, BetChip: 0 })
  events.splice(events.length - 1, 0, newAction)
  results.Player!.Chip = 9999
  expect(settle().playerChipAccounting['3103']).toBeNull()
  expect(settle().winningPlayerIds).toEqual([])
})

test('交代が未観測なら人物の同一性をendpointだけから推定しない', () => {
  const { events, joinEvent, results, settle } = hand()
  events.splice(events.indexOf(joinEvent), 1)
  // 301を失った保存列だけでは、残高減少を交代と断定できない。tier矛盾は未解決を維持。
  expect(settle().winningPlayerIds).toEqual([])
  results.OtherPlayers.find(player => player.SeatIndex === 0)!.Chip = 3491
  expect(settle().winningPlayerIds).toEqual([3104])
})

test('ハンドログも新しい人物の残高をrakeにせず元の名前を維持する', () => {
  const events = fixture()
  const players = new Map([3101, 3102, 3103, 3104].map(id => [id, { name: `Player${id - 3100}`, rank: 'diamond' }]))
  const processor = new HandLogProcessor({ session: { battleType: BattleType.RING_GAME, players, reset() {} } })
  const lines = processor.processEvents(events).map(entry => entry.text)
  expect(lines).toContain('Total pot 50 | Rake 0')
  expect(lines).toContain('Player1: folds')
  expect(lines.some(line => line.includes('Player5'))).toBe(false)
})

test.each([0, 4])('初期inactive status%sが交代まで不参加ならFOLDを作らず投入0を確定する', status => {
  const { events, deal, fold, settle } = hand()
  deal.OtherPlayers.find(player => player.SeatIndex === 0)!.BetStatus = status
  events.splice(events.indexOf(fold), 1)
  expect(settle().playerChipAccounting['3101']).toEqual({ grossPayout: 0, totalContribution: 0, netChips: 0 })
  expect(settle().winningPlayerIds).toEqual([3104])
})

test('初期inactiveへの5000買い足しを投入にせず、参加状態が出た場合は証明を撤回する', () => {
  const { events, deal, fold, joinEvent, results, settle } = hand()
  deal.OtherPlayers.find(player => player.SeatIndex === 0)!.BetStatus = 0
  events.splice(events.indexOf(fold), 1)
  const round: ApiEvent<ApiType.EVT_DEAL_ROUND> = {
    ApiTypeId: ApiType.EVT_DEAL_ROUND, timestamp: joinEvent.timestamp! - 1,
    CommunityCards: [0, 1, 2], Progress: { ...deal.Progress, MinRaise: 0, Phase: 1, NextActionTypes: [ActionType.CHECK, ActionType.ALL_IN, ActionType.BET] },
    Player: { ...deal.Player!, BetChip: 0, BetStatus: 2 },
    OtherPlayers: deal.OtherPlayers.map(player => ({ ...player, Status: 0, BetChip: 0,
      Chip: player.SeatIndex === 0 ? player.Chip + 5000 : player.Chip,
      BetStatus: player.SeatIndex === 0 ? 0 : 2 })),
  }
  events.splice(events.indexOf(joinEvent), 0, round)
  expect(settle().playerChipAccounting['3101']?.totalContribution).toBe(0)
  expect(deriveMidHandChipInflow(deal, results, events, BattleType.RING_GAME)?.get(0)).toBe(5000)
  round.OtherPlayers.find(player => player.SeatIndex === 0)!.BetStatus = 1
  expect(settle().playerChipAccounting['3101']).toBeNull()
})

test('交代しないFOLD済み人物の終了snapshot欠落もhand投入だけを確定する', () => {
  const { events, deal, results, settle } = hand()
  results.OtherPlayers = results.OtherPlayers.filter(player => player.SeatIndex !== 2)
  expect(settle().playerChipAccounting['3102']).toEqual({ grossPayout: 0, totalContribution: 0, netChips: 0 })
  expect(settle().winningPlayerIds).toEqual([3104])
  expect(deriveHandRakeAccounting(deal, results, BattleType.RING_GAME, events)?.rake).toBe(0)
})

test('初期snapshot欠落と境界後の旧UserId名簿継続をunknownに保つ', () => {
  const { events, deal, joinEvent, results, settle } = hand()
  const roster = fixture().find(event => event.ApiTypeId === ApiType.EVT_PLAYER_SEAT_ASSIGNED)!
  roster.timestamp = joinEvent.timestamp! + 1
  events.splice(events.indexOf(results), 0, roster)
  expect(settle().playerChipAccounting['3101']).toBeNull()
  events.splice(events.indexOf(roster), 1)
  deal.OtherPlayers = deal.OtherPlayers.filter(player => player.SeatIndex !== 0)
  expect(settle().playerChipAccounting['3101']).toBeNull()
  expect(settle().winningPlayerIds).toEqual([])
})

test('別席の開始欠落は卓の流入をunknownにするが、本人の観測が完結した2人のFOLD投入は保持する', () => {
  const { events, deal, results, joinEvent, fold, settle } = hand()
  const smallBlindFold = events.find(event => event.ApiTypeId === ApiType.EVT_ACTION && event.SeatIndex === 3)! as ApiEvent<ApiType.EVT_ACTION>
  deal.Game.SmallBlind = 125
  deal.Game.BigBlind = 250
  deal.Progress.Pot = 375
  deal.OtherPlayers.find(player => player.SeatIndex === 0)!.Chip = 10000
  deal.OtherPlayers = deal.OtherPlayers.filter(player => player.SeatIndex !== 2)
  Object.assign(deal.Player!, { Chip: 19875, BetChip: 125 })
  Object.assign(deal.OtherPlayers.find(player => player.SeatIndex === 5)!, { Chip: 4750, BetChip: 250 })
  Object.assign(fold, { Chip: 8375, BetChip: 1625 })
  Object.assign(smallBlindFold, { Chip: 19875, BetChip: 125 })
  // 片方は交代なしの終点欠落、もう片方はFOLD後の別人着席。
  events.splice(events.indexOf(joinEvent), 1)
  joinEvent.JoinPlayer.SeatIndex = 3
  joinEvent.timestamp = smallBlindFold.timestamp! + 1
  events.splice(events.indexOf(results), 0, joinEvent)
  results.OtherPlayers = results.OtherPlayers.filter(player => player.SeatIndex === 2)
  results.Player!.Chip = joinEvent.JoinPlayer.Chip
  results.Pot = 2000
  results.Results[0]!.RewardChip = 2000
  for (const event of events) expect(validateApiEvent(event).success).toBe(true)

  expect(deriveMidHandChipInflow(deal, results, events, BattleType.RING_GAME)).toBeNull()
  expect(settle().playerChipAccounting).toEqual({
    '3101': { grossPayout: 0, totalContribution: 1625, netChips: -1625 },
    '3102': null,
    '3103': { grossPayout: 0, totalContribution: 125, netChips: -125 },
    '3104': null,
  })
  expect(settle().winningPlayerIds).toEqual([])
  expect(deriveHandRakeAccounting(deal, results, BattleType.RING_GAME, events)).toBeNull()

  // 本人の不整合は本人の証明を撤回する。別人の確定FOLDは巻き込まない。
  fold.Chip -= 1
  expect(settle().playerChipAccounting['3101']).toBeNull()
  expect(settle().playerChipAccounting['3103']?.totalContribution).toBe(125)
  expect(deriveMidHandChipInflow(deal, results, events, BattleType.RING_GAME)).toBeNull()
  expect(settle().winningPlayerIds).toEqual([])
})

test('初期不参加0の証明は別席の矛盾時に従来どおりunknownを維持する', () => {
  const { events, deal, fold, results, settle } = hand()
  deal.OtherPlayers.find(player => player.SeatIndex === 0)!.BetStatus = 4
  events.splice(events.indexOf(fold), 1)
  const otherFold = events.find(event => event.ApiTypeId === ApiType.EVT_ACTION && event.SeatIndex === 2)! as ApiEvent<ApiType.EVT_ACTION>
  otherFold.Chip -= 1
  expect(deriveMidHandChipInflow(deal, results, events, BattleType.RING_GAME)).toBeNull()
  expect(settle().playerChipAccounting['3101']).toBeNull()
  expect(settle().winningPlayerIds).toEqual([])
})
