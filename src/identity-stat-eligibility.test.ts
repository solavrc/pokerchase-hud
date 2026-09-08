import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from './app'
import { EntityConverter } from './entity-converter'
import { ActionDetail, ActionType, ApiType, BattleType, PhaseType, type ApiEvent } from './types'
import { apiEventSchemas } from './types/api'
import { defaultRegistry } from './stats'
import { derivePlayerHandStatContribution, getStatCounter, HAND_STAT_CONTRIBUTION_VERSION, NUMERIC_STAT_IDS } from './stats/hand-contribution'
import { StatsLedger, STATS_LEDGER_HEAD_META_ID } from './stats/stat-ledger'
import { makeIdentityActionFixture, makeIdentityWinnerFixture } from './utils/identity-stat-eligibility.fixtures'
import { trackServiceForTeardown } from './utils/test-service-teardown'

const convert = (events: ApiEvent[]) => {
  for (const event of events) expect(apiEventSchemas[event.ApiTypeId].safeParse(event).success).toBe(true)
  return new EntityConverter({ battleType: BattleType.RING_GAME, players: new Map(), reset() {} }).convertEventsToEntities(events)
}

const counter = (bundle: ReturnType<typeof convert>, playerId: number, id: Parameters<typeof getStatCounter>[1]) =>
  getStatCounter(derivePlayerHandStatContribution(bundle.hands[0]!, bundle.actions, bundle.phases, playerId)!.counters, id)

test('人物不明ACTION以前の確定stealを保ち、後続の6種の機会と推測3betを計上しない', () => {
  const bundle = convert(makeIdentityActionFixture({ knownRaiseBefore: true }))
  expect(bundle.hands).toHaveLength(1)
  expect(bundle.actions.filter(action => action.playerId === 3101)).toHaveLength(1)
  const hero = bundle.actions.filter(action => action.playerId === 3103)
  expect(hero.map(action => action.actionType)).toEqual([ActionType.RAISE, ActionType.RAISE])
  expect(hero[0]!.actionDetails).toEqual(expect.arrayContaining([ActionDetail.STEAL_CHANCE, ActionDetail.STEAL]))
  expect(hero[1]!.actionDetails).not.toEqual(expect.arrayContaining([ActionDetail.$3BET_CHANCE]))
  expect(counter(bundle, 3103, 'steal')).toEqual([1, 1])
  expect(counter(bundle, 3103, '3bet')).toEqual([0, 0])
  expect(counter(bundle, 3103, 'pfr')).toEqual([1, 1])
})

test.each(['unknown-first', 'known-first'] as const)('同msの%s順から後続機会を断定しない', order => {
  const bundle = convert(makeIdentityActionFixture({ sameTimestamp: order }))
  expect(counter(bundle, 3103, 'steal')).toEqual([0, 0])
  expect(counter(bundle, 3103, 'pfr')).toEqual([1, 1])
})

test.each([false, true])('preflop型未知ALL_IN: 以前の既知RAISE=%sを独立に保持する', knownRaiseBefore => {
  const bundle = convert(makeIdentityActionFixture({ followingType: ActionType.ALL_IN, knownRaiseBefore }))
  expect(bundle.actions.at(-1)).toMatchObject({ normalizationUnproven: true })
  expect(counter(bundle, 3103, 'pfr')).toEqual(knownRaiseBefore ? [1, 1] : [0, 0])
  expect(counter(bundle, 3103, 'vpip')).toEqual([1, 1])
})

test.each([PhaseType.FLOP, PhaseType.RIVER])('postflop型未知ALL_INのphase=%sはAF/AFq/river CALLを確定しない', phase => {
  const bundle = convert(makeIdentityActionFixture({ phase, followingType: ActionType.ALL_IN, menu: [ActionType.FOLD, ActionType.ALL_IN] }))
  expect(bundle.actions.at(-1)).toMatchObject({ normalizationUnproven: true })
  expect(counter(bundle, 3103, 'pfr')).toEqual([0, 1])
  expect(counter(bundle, 3103, 'af')).toEqual([0, 0])
  expect(counter(bundle, 3103, 'afq')).toEqual([0, 0])
  expect(bundle.actions.at(-1)!.actionDetails).not.toContain(ActionDetail.RIVER_CALL)
})

test('帰属可能なstrictly earlierメニューでALL_IN型だけ回復し、6種の機会は回復しない', () => {
  const bundle = convert(makeIdentityActionFixture({ followingType: ActionType.ALL_IN, trustedMenu: true }))
  expect(bundle.actions.at(-1)).not.toHaveProperty('normalizationUnproven')
  expect(counter(bundle, 3103, 'pfr')).toEqual([1, 1])
  expect(counter(bundle, 3103, '3bet')).toEqual([0, 0])
  expect(counter(bundle, 3103, 'steal')).toEqual([0, 0])
})

test.each(['3betfold', 'foldToSteal', 'cbet', 'cbetFold'] as const)('%sの既知の前提が残っていても、人物不明行後の機会を推測しない', stat => {
  const events = makeIdentityActionFixture({ knownRaiseBefore: true,
    phase: stat.startsWith('cbet') ? PhaseType.FLOP : PhaseType.PREFLOP,
    followingType: stat === 'cbet' ? ActionType.BET : ActionType.FOLD })
  const join = events.find(event => event.ApiTypeId === ApiType.EVT_PLAYER_JOIN)!
  const following = events.at(-2) as ApiEvent<ApiType.EVT_ACTION>
  const knownRaise = events.filter((event): event is ApiEvent<ApiType.EVT_ACTION> =>
    event.ApiTypeId === ApiType.EVT_ACTION && event.SeatIndex === 3)[0]!
  if (stat === '3betfold') {
    const open = events.find(event => event.ApiTypeId === ApiType.EVT_ACTION && event.SeatIndex === 2)!
    Object.assign(open, { ActionType: ActionType.RAISE, BetChip: 100 })
    following.SeatIndex = 2
  } else if (stat === 'foldToSteal' || stat === 'cbetFold') following.SeatIndex = 5
  if (stat === 'cbetFold') {
    const cbet = structuredClone(knownRaise)
    cbet.ActionType = ActionType.BET
    cbet.Progress.Phase = PhaseType.FLOP
    events.splice(events.indexOf(join), 0, cbet)
  }
  events.forEach((event, index) => { event.timestamp = 1734100600000 + index * 1000 })
  const observed = convert(events)
  const playerId = stat === '3betfold' ? 3102 : stat === 'cbet' ? 3103 : 3104
  expect(counter(observed, playerId, stat)).toEqual([0, 0])
  // 境界ACTIONだけを除いた対照は、本当に分子・機会を持つ。全体を消す実装を防ぐ。
  const control = convert(events.filter(event => !(event.ApiTypeId === ApiType.EVT_ACTION &&
    event.SeatIndex === 0 && event.timestamp! >= join.timestamp!)))
  expect(counter(control, playerId, stat)).toEqual([1, 1])
  if (stat === '3betfold') expect(counter(observed, 3103, '3bet')).toEqual([1, 1])
  if (stat === 'foldToSteal') expect(counter(observed, 3103, 'steal')).toEqual([1, 1])
  if (stat === 'cbetFold') expect(counter(observed, 3103, 'cbet')).toEqual([1, 1])
  if (stat === 'cbet') expect(counter(observed, 3103, 'af')).toEqual([1, 0])
})

test.each(['same-ms', 'empty', 'wrong-seat', 'wrong-phase', 'second-unknown'] as const)('人物不明行後の%sメニューをALL_IN型の回復根拠にしない', invalidMenu => {
  const events = makeIdentityActionFixture({ followingType: ActionType.ALL_IN, trustedMenu: true })
  const previous = events.at(-3) as ApiEvent<ApiType.EVT_ACTION>
  const following = events.at(-2) as ApiEvent<ApiType.EVT_ACTION>
  if (invalidMenu === 'same-ms') previous.timestamp = following.timestamp
  if (invalidMenu === 'empty') previous.Progress.NextActionTypes = []
  if (invalidMenu === 'wrong-seat') previous.Progress.NextActionSeat = 2
  if (invalidMenu === 'wrong-phase') previous.Progress.Phase = PhaseType.FLOP
  if (invalidMenu === 'second-unknown') previous.SeatIndex = 0
  const bundle = convert(events)
  expect(bundle.actions.at(-1)).toMatchObject({ normalizationUnproven: true })
  expect(counter(bundle, 3103, 'pfr')).toEqual([0, 0])
})

test('帰属可能なpostflopメニューで型とAFを回復しても、履歴依存のCB機会は回復しない', () => {
  const bundle = convert(makeIdentityActionFixture({ phase: PhaseType.FLOP, knownRaiseBefore: true,
    followingType: ActionType.ALL_IN, trustedMenu: true, menu: [ActionType.CHECK, ActionType.BET, ActionType.ALL_IN] }))
  expect(bundle.actions.at(-1)).toMatchObject({ actionType: ActionType.BET })
  expect(bundle.actions.at(-1)).not.toHaveProperty('normalizationUnproven')
  expect(counter(bundle, 3103, 'af')).toEqual([1, 0])
  expect(counter(bundle, 3103, 'afq')).toEqual([1, 1])
  expect(counter(bundle, 3103, 'cbet')).toEqual([0, 0])
})

test('人物不明ACTIONより後の305が示す独立メニューでもALL_IN型だけ回復する', () => {
  const events = makeIdentityActionFixture({ followingType: ActionType.ALL_IN, phase: PhaseType.FLOP, knownRaiseBefore: true })
  const street = makeIdentityWinnerFixture(false).find((event): event is ApiEvent<ApiType.EVT_DEAL_ROUND> =>
    event.ApiTypeId === ApiType.EVT_DEAL_ROUND && event.Progress.Phase === PhaseType.FLOP)!
  street.Progress.NextActionSeat = 3
  street.Progress.NextActionTypes = [ActionType.CHECK, ActionType.BET, ActionType.ALL_IN]
  events.splice(events.length - 2, 0, street)
  events.forEach((event, index) => { event.timestamp = 1734100700000 + index * 1000 })
  const bundle = convert(events)
  expect(bundle.actions.at(-1)).toMatchObject({ actionType: ActionType.BET })
  expect(bundle.actions.at(-1)).not.toHaveProperty('normalizationUnproven')
  expect(counter(bundle, 3103, 'af')).toEqual([1, 0])
  expect(counter(bundle, 3103, 'cbet')).toEqual([0, 0])
})

test('identity由来の勝者不明は勝率だけから除外し、到達・確定CALL・確定会計を保持する', async () => {
  const control = convert(makeIdentityWinnerFixture(false))
  const unknown = convert(makeIdentityWinnerFixture(true))
  expect(control.hands[0]!.winningPlayerIds).toEqual([3103])
  expect(control.hands[0]).not.toHaveProperty('winnerIdentityUnproven')
  expect(unknown.hands[0]).toMatchObject({ winningPlayerIds: [], winnerIdentityUnproven: true })
  expect(unknown.hands[0]!.playerChipAccounting!['3103']).toEqual(control.hands[0]!.playerChipAccounting!['3103'])
  expect(counter(unknown, 3103, 'wtsd')).toEqual([1, 1])
  expect(counter(unknown, 3103, 'wtsdNoAi')).toEqual([1, 1])
  expect(counter(unknown, 3103, 'af')).toEqual([0, 2])
  for (const stat of ['wwsf', 'wwsfNoAi', 'wsd', 'riverCallAccuracy'] as const) {
    expect(counter(unknown, 3103, stat)).toEqual([0, 0])
    expect(counter(control, 3103, stat)).toEqual([1, 1])
  }
  const actions = [...control.actions, ...unknown.actions].filter(action => action.playerId === 3103)
  const phases = [...control.phases, ...unknown.phases].filter(phase => phase.seatUserIds.includes(3103))
  for (const id of ['wwsf', 'wwsfNoAi', 'wsd', 'riverCallAccuracy']) {
    const stat = defaultRegistry.get(id)!
    expect(await stat.calculate({ playerId: 3103, actions, phases,
      hands: [...control.hands, ...unknown.hands], allPlayerActions: actions, allPlayerPhases: phases,
      winningHandIds: new Set(control.hands.map(hand => hand.id)), session: { players: new Map(), reset() {} } })).toEqual([1, 1])
  }
})

test('席交代証拠がないlegacy未解決精算には勝率の新しい除外を適用しない', () => {
  const events = makeIdentityWinnerFixture(false).filter(event => event.ApiTypeId !== ApiType.EVT_PLAYER_JOIN)
  const result = events.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)!
  result.Pot += 1 // 支払保存則だけを壊し、席交代と無関係な精算不能を作る。
  const bundle = convert(events)
  expect(bundle.hands[0]).not.toHaveProperty('winnerIdentityUnproven')
  for (const stat of ['wwsf', 'wwsfNoAi', 'wsd', 'riverCallAccuracy'] as const) {
    expect(counter(bundle, 3103, stat)[1]).toBe(1)
  }
})

test('live/offline保存と新しいStatsLedgerでの再読込が同じeligibilityを使う', async () => {
  const events = makeIdentityActionFixture({ followingType: ActionType.ALL_IN })
  const expected = convert(events)
  await chrome.storage.local.remove(PokerChaseService.STORAGE_KEY)
  const db = new PokerChaseDB(indexedDB, IDBKeyRange)
  await db.open()
  const service = trackServiceForTeardown(new PokerChaseService({ db }))
  await service.ready
  const warmup = jest.spyOn(db.hands, 'count').mockResolvedValue(0)
  try {
    for (const event of events) service.handAggregateStream.write(event)
    await service.handAggregateStream.whenIdle()
    expect(await db.hands.toArray()).toEqual(expected.hands)
    expect(await db.actions.toArray()).toEqual(expected.actions)
    expect(await db.phases.toArray()).toEqual(expected.phases)
    const first = await service.statsLedger.readPlayerSnapshot(3103)
    const reread = await new StatsLedger(db).readPlayerSnapshot(3103)
    expect(reread).toEqual(first)
    for (const id of NUMERIC_STAT_IDS) expect(getStatCounter(reread.counters, id)).toEqual(counter(expected, 3103, id))
    expect(getStatCounter(reread.counters, 'pfr')).toEqual([0, 0])
  } finally {
    warmup.mockRestore()
    service.cancelPendingPersist()
    db.close()
    await db.delete()
  }
})


test.each([1, 2])('旧version %sの統計台帳を再利用せず、保存済み根拠から現versionへ再計算する', async oldVersion => {
  const events = makeIdentityActionFixture({ followingType: ActionType.ALL_IN })
  const playerId = oldVersion === 1 ? 3103 : 3101
  if (oldVersion === 2) {
    const first = events.find(event => event.ApiTypeId === ApiType.EVT_ACTION && event.SeatIndex === 0)!
    events.find(event => event.ApiTypeId === ApiType.EVT_PLAYER_JOIN)!.timestamp = first.timestamp
  }
  const bundle = convert(events)
  const db = new PokerChaseDB(indexedDB, IDBKeyRange)
  await db.open()
  try {
    await db.hands.bulkPut(bundle.hands)
    await db.actions.bulkPut(bundle.actions)
    await db.phases.bulkPut(bundle.phases)
    const ledger = new StatsLedger(db)
    const current = await ledger.readPlayerSnapshot(playerId)
    const head = (await ledger.getActiveHead())!
    const aggregate = (await db.statPlayerAggregates.get([head.generation, playerId]))!
    const obsolete = structuredClone(bundle)
    delete obsolete.actions.at(-1)!.normalizationUnproven
    delete obsolete.hands[0]!.preflopIdentityUnprovenPlayerIds
    const oldCounters = derivePlayerHandStatContribution(obsolete.hands[0]!, obsolete.actions, obsolete.phases, playerId)!.counters
    expect(getStatCounter(oldCounters, 'pfr')).toEqual([oldVersion === 1 ? 1 : 0, 1])
    await db.statPlayerAggregates.put({ ...aggregate, version: oldVersion, totals: oldCounters })
    await db.statHandContributions.where('[generation+playerId]').equals([head.generation, playerId])
      .modify({ version: oldVersion, counters: oldCounters })
    await db.meta.put({ id: STATS_LEDGER_HEAD_META_ID, value: { ...head, version: oldVersion } })
    const reread = await new StatsLedger(db).readPlayerSnapshot(playerId)
    expect(reread.version).toBe(HAND_STAT_CONTRIBUTION_VERSION)
    expect(reread.version).toBe(3)
    expect(reread.counters).toEqual(current.counters)
    expect(getStatCounter(reread.counters, 'pfr')).toEqual([0, 0])
    expect(reread.diagnostics.baselineBuilt).toBe(true)
  } finally {
    db.close()
    await db.delete()
  }
})
