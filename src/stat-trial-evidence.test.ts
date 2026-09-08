import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EntityConverter } from './entity-converter'
import { defaultRegistry } from './stats'
import { derivePlayerHandStatContribution, getStatCounter, NUMERIC_STAT_IDS, statValueFromCounterVector } from './stats/hand-contribution'
import { runOracle } from './tools/verify-stats/oracle'
import { ActionType, ApiType, PhaseType, type ApiEvent } from './types'
import { apiEventSchemas } from './types/api'

type Fraction = [number, number]
interface EvidenceCase {
  hand_id: number
  name: string
  target_user_id: number
  expected: {
    preflop: { asserted: false } | {
      asserted: true
      is_big_blind: boolean
      has_unattributed_preflop_action: boolean
      has_preflop_action: boolean
      has_preflop_fold: boolean
      is_walk: boolean
      vpip: Fraction
      pfr: Fraction
    }
    flop: {
      flop_participation_unproven: boolean
      saw_flop: boolean | null
      went_to_showdown: boolean
      wtsd: Fraction
    }
  }
}

const events: ApiEvent[] = readFileSync(join(process.cwd(), 'e2e/fixtures/identity-stat-evidence.ndjson'), 'utf8')
  .trim().split('\n').map((line, index) => {
    const event: ApiEvent = JSON.parse(line)
    if (!apiEventSchemas[event.ApiTypeId]?.safeParse(event).success) throw new Error(`Invalid fixture event at line ${index + 1}`)
    return event
  })
const fixture: { cases: EvidenceCase[] } = JSON.parse(readFileSync(
  join(process.cwd(), 'e2e/fixtures/identity-stat-evidence.expected.json'), 'utf8'))
const session = { players: new Map(), reset() {} }
const bundle = new EntityConverter(session).convertEventsToEntities(events)
const oracle = runOracle(events)

test('有限18対照の全raw行は現行wire schemaを満たす', () => {
  expect(fixture.cases).toHaveLength(18)
  expect(bundle.hands).toHaveLength(18)
  for (const event of events) expect(apiEventSchemas[event.ApiTypeId].safeParse(event).success).toBe(true)
})

test.each(fixture.cases)('$name: 人物の根拠と統計ごとの分子・分母を保持する', async item => {
  const playerId = item.target_user_id
  const hand = bundle.hands.find(row => row.id === item.hand_id)!
  const actions = bundle.actions.filter(row => row.handId === hand.id && row.playerId === playerId)
  const phases = bundle.phases.filter(row => row.handId === hand.id && row.seatUserIds.includes(playerId))
  const preflop = actions.filter(action => action.phase === PhaseType.PREFLOP)
  const counters = derivePlayerHandStatContribution(hand, bundle.actions, bundle.phases, playerId)!.counters
  const omitted = hand.preflopIdentityUnprovenPlayerIds?.includes(playerId) ?? false
  const isBigBlind = hand.bigBlindUserId === playerId
  const flopUnproven = hand.flopParticipationUnprovenPlayerIds?.includes(playerId) ?? false
  if (item.expected.preflop.asserted) {
    expect(isBigBlind).toBe(item.expected.preflop.is_big_blind)
    expect(omitted).toBe(item.expected.preflop.has_unattributed_preflop_action)
    expect(preflop.length > 0).toBe(item.expected.preflop.has_preflop_action)
    expect(preflop.some(action => action.actionType === ActionType.FOLD)).toBe(item.expected.preflop.has_preflop_fold)
    // 数値が同じ0/0でも、BBのwalkと人物帰属不明は保存した根拠で区別できる。
    expect(isBigBlind && preflop.length === 0 && !omitted).toBe(item.expected.preflop.is_walk)
    expect(getStatCounter(counters, 'vpip')).toEqual(item.expected.preflop.vpip)
    expect(getStatCounter(counters, 'pfr')).toEqual(item.expected.preflop.pfr)
  }
  expect(flopUnproven).toBe(item.expected.flop.flop_participation_unproven)
  expect(phases.some(phase => phase.phase === PhaseType.FLOP) ? true : flopUnproven ? null : false)
    .toBe(item.expected.flop.saw_flop)
  expect(phases.some(phase => phase.phase === PhaseType.SHOWDOWN)).toBe(item.expected.flop.went_to_showdown)
  expect(getStatCounter(counters, 'wtsd')).toEqual(item.expected.flop.wtsd)
  expect(oracle.get(playerId)?.stats.wtsd).toEqual(item.expected.flop.wtsd)

  const result = events.find((event): event is ApiEvent<ApiType.EVT_HAND_RESULTS> =>
    event.ApiTypeId === ApiType.EVT_HAND_RESULTS && event.HandId === hand.id)!
  // 参加が未知でも、直接UIDで届いた公開カードとpayoutは消さない。
  expect(hand.results).toEqual(result.Results)
  for (const id of NUMERIC_STAT_IDS) {
    const legacy = await defaultRegistry.get(id)!.calculate({ playerId, actions, phases, hands: [hand],
      allPlayerActions: actions, allPlayerPhases: phases, session,
      winningHandIds: new Set(hand.winningPlayerIds.includes(playerId) && phases.some(phase =>
        phase.phase === PhaseType.FLOP || phase.phase === PhaseType.SHOWDOWN) ? [hand.id] : []) })
    expect({ id, value: legacy }).toEqual({ id, value: statValueFromCounterVector(counters, id) })
  }
})
