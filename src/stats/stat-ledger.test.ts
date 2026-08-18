import Dexie, { type DBCore, type Middleware } from 'dexie'
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { PokerChaseDB } from '../db/poker-chase-db'
import type {
  StatHandContributionRecord,
  StatPlayerAggregateRecord,
} from '../db/poker-chase-db'
import type { EntityBundle } from '../entity-converter'
import type { Action, Hand, Phase, Session } from '../types/entities'
import { ActionDetail, ActionType, BattleType, PhaseType, Position } from '../types/game'
import type { StatCalculationContext, StatValue } from '../types/stats'
import { compareHandsNewestFirst } from '../utils/hand-order'
import { classifyTableSizeLayer } from '../utils/table-size'
import { normalizeStatsLatestHands } from '../utils/stats-hand-limit'
import { defaultRegistry } from './index'
import {
  HAND_STAT_CONTRIBUTION_VERSION,
  HAND_STAT_COUNTER_VECTOR_LENGTH,
  NUMERIC_STAT_IDS,
  createEmptyHandStatCounterVector,
  getStatCounter,
  type NumericStatId,
} from './hand-contribution'
import {
  STATS_CANONICAL_REBUILD_META_ID,
  STATS_LEDGER_HEAD_META_ID,
  STATS_LEDGER_STAGING_META_ID,
  StatsLedger,
  buildGenerationFromEntityBundle,
  buildStatSnapshot,
  type PlayerStatCounterSnapshot,
  type StatsLedgerFilters,
} from './stat-ledger'

const PLAYER_ID = 1
const OTHER_PLAYER_ID = 2
const ALL_KNOWN_BATTLE_TYPES = [
  BattleType.SIT_AND_GO,
  BattleType.TOURNAMENT,
  BattleType.FRIEND_SIT_AND_GO,
  BattleType.RING_GAME,
  BattleType.FRIEND_RING_GAME,
  BattleType.CLUB_MATCH,
] as const

const ledgerFiltersWithUnsafeLatestHands = (latestHands: unknown): StatsLedgerFilters => ({
  latestHands,
} as unknown as StatsLedgerFilters)

interface CoreReadProbeEntry {
  table: string
  operation: 'get' | 'getMany' | 'query'
  index?: string | null
  limit?: number
  resultCount: number
}

interface CoreReadProbe {
  entries: CoreReadProbeEntry[]
  reset: () => void
  failNextMetaPut: (id: string) => void
}

/** IndexedDBまで到達した行数を数え、diagnosticsの自己申告だけに依存しない。 */
function installCoreReadProbe(db: PokerChaseDB): CoreReadProbe {
  const entries: CoreReadProbeEntry[] = []
  let failingMetaId: string | null = null
  const middleware: Middleware<DBCore> = {
    stack: 'dbcore',
    name: `stat-ledger-test-probe-${Math.random()}`,
    create: down => ({
      ...down,
      table(tableName) {
        const table = down.table(tableName)
        return {
          ...table,
          mutate(request) {
            if (
              tableName === 'meta' &&
              failingMetaId !== null &&
              (request.type === 'add' || request.type === 'put') &&
              request.values.some(value => value?.id === failingMetaId)
            ) {
              failingMetaId = null
              request.trans.abort()
              return Dexie.Promise.reject(new Error('injected meta put fault'))
            }
            return table.mutate(request)
          },
          get(request) {
            return table.get(request).then(result => {
              entries.push({
                table: tableName,
                operation: 'get',
                resultCount: result === undefined ? 0 : 1,
              })
              return result
            })
          },
          getMany(request) {
            return table.getMany(request).then(result => {
              entries.push({
                table: tableName,
                operation: 'getMany',
                resultCount: result.filter(value => value !== undefined).length,
              })
              return result
            })
          },
          query(request) {
            return table.query(request).then(result => {
              entries.push({
                table: tableName,
                operation: 'query',
                index: request.query.index.name,
                limit: request.limit,
                resultCount: result.result.length,
              })
              return result
            })
          },
        }
      },
    }),
  }
  db.use(middleware)
  return {
    entries,
    reset: () => { entries.length = 0 },
    failNextMetaPut: id => { failingMetaId = id },
  }
}

function makeHand(overrides: Partial<Hand> & { id: number }): Hand {
  return {
    seatUserIds: [PLAYER_ID, OTHER_PLAYER_ID, 3, 4, 5, 6],
    winningPlayerIds: [],
    smallBlind: 50,
    bigBlind: 100,
    bigBlindUserId: OTHER_PLAYER_ID,
    session: { battleType: BattleType.SIT_AND_GO },
    results: [],
    ...overrides,
  }
}

function makeAction(
  handId: number,
  index: number,
  phase: PhaseType,
  actionType: Exclude<ActionType, ActionType.ALL_IN>,
  position: Position,
  actionDetails: ActionDetail[] = [],
  playerId = PLAYER_ID
): Action {
  return {
    handId,
    index,
    playerId,
    phase,
    actionType,
    bet: 100,
    pot: 200,
    sidePot: [],
    position,
    actionDetails,
  }
}

function makePhase(
  handId: number,
  phase: PhaseType,
  seatUserIds: number[] = [PLAYER_ID, OTHER_PLAYER_ID]
): Phase {
  return {
    handId,
    phase,
    seatUserIds,
    communityCards: phase === PhaseType.FLOP ? [1, 2, 3] : [],
  }
}

function fixtureBundle(): EntityBundle {
  const hands: Hand[] = [
    makeHand({
      id: 110,
      approxTimestamp: 1_000,
      winningPlayerIds: [PLAYER_ID],
      session: { battleType: BattleType.SIT_AND_GO },
    }),
    makeHand({
      id: 109,
      approxTimestamp: 3_000,
      seatUserIds: [PLAYER_ID, OTHER_PLAYER_ID, -1, -1, -1, -1],
      session: { battleType: BattleType.RING_GAME },
    }),
    makeHand({
      id: 108,
      seatUserIds: [PLAYER_ID, OTHER_PLAYER_ID, 3, -1, -1, -1],
      winningPlayerIds: [PLAYER_ID],
      bigBlindUserId: PLAYER_ID,
      session: { battleType: BattleType.TOURNAMENT },
    }),
    makeHand({
      id: 107,
      approxTimestamp: 3_000,
      seatUserIds: [PLAYER_ID, OTHER_PLAYER_ID, 3, 4, -1, -1],
      session: { battleType: BattleType.SIT_AND_GO },
    }),
    makeHand({
      id: 106,
      approxTimestamp: 2_000,
      winningPlayerIds: [PLAYER_ID],
      session: { battleType: BattleType.FRIEND_RING_GAME },
    }),
    makeHand({
      id: 105,
      seatUserIds: [PLAYER_ID, OTHER_PLAYER_ID, 3, 4, -1, -1],
      session: {},
    }),
  ]

  const actions: Action[] = [
    makeAction(110, 0, PhaseType.PREFLOP, ActionType.RAISE, Position.BTN,
      [ActionDetail.VPIP, ActionDetail.STEAL_CHANCE, ActionDetail.STEAL]),
    makeAction(110, 1, PhaseType.FLOP, ActionType.BET, Position.BTN,
      [ActionDetail.CBET_CHANCE, ActionDetail.CBET]),
    makeAction(110, 2, PhaseType.TURN, ActionType.RAISE, Position.BTN),
    makeAction(110, 3, PhaseType.RIVER, ActionType.CALL, Position.BTN,
      [ActionDetail.RIVER_CALL, ActionDetail.RIVER_CALL_WON]),

    makeAction(109, 0, PhaseType.PREFLOP, ActionType.FOLD, Position.SB,
      [ActionDetail.FOLD_TO_STEAL_CHANCE, ActionDetail.FOLD_TO_STEAL]),

    // 108はBBのpreflop actionが欠ける通常形。postflopだけを残す。
    makeAction(108, 0, PhaseType.FLOP, ActionType.CALL, Position.BB),

    makeAction(107, 0, PhaseType.PREFLOP, ActionType.RAISE, Position.CO,
      [ActionDetail.VPIP, ActionDetail.$3BET_CHANCE, ActionDetail.$3BET]),
    makeAction(107, 1, PhaseType.FLOP, ActionType.CALL, Position.CO,
      [ActionDetail.CBET_FOLD_CHANCE]),

    makeAction(106, 0, PhaseType.PREFLOP, ActionType.CALL, Position.HJ,
      [ActionDetail.VPIP]),
    makeAction(106, 1, PhaseType.FLOP, ActionType.FOLD, Position.HJ,
      [ActionDetail.CBET_FOLD_CHANCE, ActionDetail.CBET_FOLD]),

    makeAction(105, 0, PhaseType.PREFLOP, ActionType.RAISE, Position.UTG,
      [ActionDetail.VPIP, ActionDetail.$3BET_FOLD_CHANCE, ActionDetail.$3BET_FOLD]),
    makeAction(105, 1, PhaseType.TURN, ActionType.BET, Position.UTG),
    makeAction(105, 2, PhaseType.RIVER, ActionType.CALL, Position.UTG,
      [ActionDetail.RIVER_CALL]),
  ]

  const phases: Phase[] = [
    makePhase(110, PhaseType.FLOP),
    makePhase(110, PhaseType.TURN),
    makePhase(110, PhaseType.RIVER),
    makePhase(110, PhaseType.SHOWDOWN),
    makePhase(108, PhaseType.FLOP),
    makePhase(108, PhaseType.SHOWDOWN),
    makePhase(107, PhaseType.FLOP),
    makePhase(106, PhaseType.FLOP),
    makePhase(105, PhaseType.TURN),
    makePhase(105, PhaseType.RIVER),
    makePhase(105, PhaseType.SHOWDOWN),
  ]
  return { hands, actions, phases }
}

function singleHandBundle(
  id: number,
  overrides: Partial<Hand> = {},
  playerActionDetails: ActionDetail[] = [ActionDetail.VPIP]
): EntityBundle {
  const hand = makeHand({ id, approxTimestamp: id * 10, ...overrides })
  return {
    hands: [hand],
    actions: [makeAction(
      id,
      0,
      PhaseType.PREFLOP,
      ActionType.CALL,
      Position.BTN,
      playerActionDetails
    )],
    phases: [],
  }
}

function mergeBundles(...bundles: EntityBundle[]): EntityBundle {
  return {
    hands: bundles.flatMap(bundle => bundle.hands),
    actions: bundles.flatMap(bundle => bundle.actions),
    phases: bundles.flatMap(bundle => bundle.phases),
  }
}

function selectLegacyHands(
  bundle: EntityBundle,
  playerId: number,
  filters: StatsLedgerFilters
): Hand[] {
  let hands = bundle.hands.filter(hand => hand.seatUserIds.includes(playerId))
  if (filters.battleTypes !== undefined) {
    hands = hands.filter(hand =>
      hand.session.battleType !== undefined && filters.battleTypes!.includes(hand.session.battleType)
    )
  }
  if (filters.tableSizeLayers !== undefined) {
    hands = hands.filter(hand => {
      const layer = classifyTableSizeLayer(hand)
      return layer !== null && filters.tableSizeLayers!.includes(layer)
    })
  }
  const latestHands = normalizeStatsLatestHands(filters.latestHands)
  if (latestHands !== undefined) {
    hands = [...hands]
      .sort(compareHandsNewestFirst)
      .slice(0, latestHands)
  }
  return hands
}

const legacySession: Session = {
  id: 'stat-ledger-parity',
  battleType: BattleType.SIT_AND_GO,
  name: 'stat-ledger-parity',
  players: new Map(),
  reset: () => {},
}

async function calculateLegacyNumericStats(
  bundle: EntityBundle,
  playerId: number,
  filters: StatsLedgerFilters
): Promise<Record<NumericStatId, StatValue>> {
  const hands = selectLegacyHands(bundle, playerId, filters)
  const handIds = new Set(hands.map(hand => hand.id))
  const actions = bundle.actions.filter(action =>
    action.playerId === playerId && action.handId !== undefined && handIds.has(action.handId)
  )
  const phases = bundle.phases.filter(phase =>
    phase.handId !== undefined && handIds.has(phase.handId) && phase.seatUserIds.includes(playerId)
  )
  const context: StatCalculationContext = {
    playerId,
    actions,
    phases,
    hands,
    allPlayerActions: actions,
    allPlayerPhases: phases,
    winningHandIds: new Set(
      hands.filter(hand => hand.winningPlayerIds.includes(playerId)).map(hand => hand.id)
    ),
    session: legacySession,
  }
  const pairs = await Promise.all(NUMERIC_STAT_IDS.map(async statId => {
    const definition = defaultRegistry.get(statId)
    if (!definition) throw new Error(`Legacy stat is not registered: ${statId}`)
    return [statId, await definition.calculate(context)] as const
  }))
  return Object.fromEntries(pairs) as Record<NumericStatId, StatValue>
}

function disableScheduledGc(ledger: StatsLedger): void {
  // staging/activation API自体のテストで1秒後のbest-effort timerを残さない。
  ;(ledger as unknown as { cleanupScheduled: boolean }).cleanupScheduled = true
}

function dummyContributionRecord(
  generation: number,
  playerId: number,
  handId: number
): StatHandContributionRecord {
  return {
    generation,
    playerId,
    handId,
    hasTimestamp: 1,
    hasKnownBattle: 1,
    sortTimestamp: handId,
    battleBucket: `battle:${BattleType.SIT_AND_GO}`,
    tableBucket: 'table:full',
    positionBucket: `position:${Position.BTN}`,
    version: HAND_STAT_CONTRIBUTION_VERSION,
    approxTimestamp: handId,
    battleType: BattleType.SIT_AND_GO,
    tableSizeLayer: 'full',
    position: Position.BTN,
    counters: createEmptyHandStatCounterVector(),
  }
}

function dummyAggregateRecord(
  generation: number,
  playerId: number
): StatPlayerAggregateRecord {
  return {
    generation,
    playerId,
    version: HAND_STAT_CONTRIBUTION_VERSION,
    ready: true,
    totals: createEmptyHandStatCounterVector(),
    buckets: [],
    updatedAt: 1,
  }
}

describe('StatsLedger core invariants', () => {
  let db: PokerChaseDB
  let ledger: StatsLedger
  let probe: CoreReadProbe

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    probe = installCoreReadProbe(db)
    await db.open()
    ledger = new StatsLedger(db)
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    db.close()
    await db.delete()
  })

  test('複数hand・battle/table filter・filter後latest Nで既存18数値指標と厳密一致する', async () => {
    disableScheduledGc(ledger)
    const bundle = fixtureBundle()
    await ledger.replaceGenerationFromEntityBundle(bundle, { generation: 100 })

    const cases: StatsLedgerFilters[] = [
      {},
      { battleTypes: [BattleType.SIT_AND_GO, BattleType.TOURNAMENT] },
      { tableSizeLayers: ['full', '4p'] },
      {
        battleTypes: [BattleType.SIT_AND_GO, BattleType.RING_GAME],
        tableSizeLayers: ['full', 'hu'],
      },
      { latestHands: 20 },
      {
        battleTypes: [BattleType.SIT_AND_GO, BattleType.RING_GAME],
        tableSizeLayers: ['full', '4p', 'hu'],
        latestHands: 20,
      },
      { battleTypes: [] },
    ]

    for (const filters of cases) {
      const snapshot = await ledger.readPlayerSnapshot(PLAYER_ID, filters)
      const incremental = buildStatSnapshot(snapshot.counters)
      const legacy = await calculateLegacyNumericStats(bundle, PLAYER_ID, filters)
      expect(Object.keys(incremental).sort()).toEqual([...NUMERIC_STAT_IDS].sort())
      expect(incremental).toStrictEqual(legacy)
      expect(snapshot.selectedHands).toBe(selectLegacyHands(bundle, PLAYER_ID, filters).length)
    }
  })

  test('filter後のglobal latest Nはtimestamp有無・同値・HandId逆転を旧順序どおり扱う', async () => {
    disableScheduledGc(ledger)
    const specs: Array<{
      id: number
      timestamp?: number
      battleType: BattleType
      seats: number[]
    }> = [
      { id: 900, battleType: BattleType.SIT_AND_GO, seats: [1, 2, 3, 4, 5, 6] },
      { id: 100, timestamp: 1_000, battleType: BattleType.SIT_AND_GO, seats: [1, 2, 3, 4, 5, 6] },
      // HandIdは小さいがtimestampが新しいMTT table-move型の逆転。
      { id: 99, timestamp: 2_000, battleType: BattleType.RING_GAME, seats: [1, 2, -1, -1, -1, -1] },
      { id: 80, timestamp: 2_000, battleType: BattleType.SIT_AND_GO, seats: [1, 2, -1, -1, -1, -1] },
      { id: 1_000, battleType: BattleType.RING_GAME, seats: [1, 2, 3, 4, 5, 6] },
    ]
    const bundle = mergeBundles(...specs.map(spec => singleHandBundle(spec.id, {
      ...(spec.timestamp === undefined ? {} : { approxTimestamp: spec.timestamp }),
      seatUserIds: spec.seats,
      session: { battleType: spec.battleType },
    })))
    // singleHandBundleの既定timestampを、legacy行では確実に欠落させる。
    for (const spec of specs.filter(candidate => candidate.timestamp === undefined)) {
      delete bundle.hands.find(hand => hand.id === spec.id)!.approxTimestamp
    }
    await ledger.replaceGenerationFromEntityBundle(bundle, { generation: 200 })

    const filters: StatsLedgerFilters = {
      battleTypes: [BattleType.SIT_AND_GO, BattleType.RING_GAME],
      tableSizeLayers: ['full', 'hu'],
      latestHands: 20,
    }
    const snapshot = await ledger.readPlayerSnapshot(PLAYER_ID, filters)
    expect(snapshot.selection.kind).toBe('rows')
    const rowIds = snapshot.selection.kind === 'rows'
      ? snapshot.selection.rows.map(row => row.handId)
      : []
    expect(rowIds).toEqual([99, 80, 100, 1_000, 900])
    expect(rowIds).toEqual(
      selectLegacyHands(bundle, PLAYER_ID, filters).map(hand => hand.id)
    )
  })

  test('非finite timestampは欠損順、契約外の小数latestはALLへ戻る', async () => {
    disableScheduledGc(ledger)
    const bundle = mergeBundles(
      singleHandBundle(1, { approxTimestamp: 100 }),
      singleHandBundle(999, { approxTimestamp: Number.NaN }),
      singleHandBundle(1_000, { approxTimestamp: Number.POSITIVE_INFINITY }),
      singleHandBundle(500, { approxTimestamp: undefined })
    )
    delete bundle.hands.find(hand => hand.id === 500)!.approxTimestamp
    await ledger.replaceGenerationFromEntityBundle(bundle, { generation: 201 })

    const ordered = await ledger.readPlayerSnapshot(PLAYER_ID, { latestHands: 20 })
    expect(ordered.selection.kind).toBe('rows')
    if (ordered.selection.kind === 'rows') {
      expect(ordered.selection.rows.map(row => row.handId)).toEqual([1, 1_000, 999, 500])
    }

    const fractional = await ledger.readPlayerSnapshot(
      PLAYER_ID,
      ledgerFiltersWithUnsafeLatestHands(0.5)
    )
    expect(fractional.matchedHandsBeforeLimit).toBe(4)
    expect(fractional.selectedHands).toBe(4)
    expect(fractional.selection.kind).toBe('aggregate')
  })

  test('ALL aggregateは寄与行を0件読み、latestは各bucket queryにつき最大N件だけ読む', async () => {
    disableScheduledGc(ledger)
    const bundle = mergeBundles(...Array.from({ length: 48 }, (_, index) => {
      const battleType = index % 2 === 0 ? BattleType.SIT_AND_GO : BattleType.RING_GAME
      const seats = index % 4 < 2
        ? [PLAYER_ID, OTHER_PLAYER_ID, 3, 4, 5, 6]
        : [PLAYER_ID, OTHER_PLAYER_ID, -1, -1, -1, -1]
      return singleHandBundle(1_000 + index, {
        approxTimestamp: 10_000 + index,
        seatUserIds: seats,
        session: { battleType },
      })
    }))
    await ledger.replaceGenerationFromEntityBundle(bundle, { generation: 300 })

    probe.reset()
    const aggregate = await ledger.readPlayerSnapshot(PLAYER_ID)
    expect(aggregate.diagnostics).toMatchObject({
      source: 'aggregate',
      contributionRowsRead: 0,
      indexQueries: [],
    })
    expect(probe.entries.filter(entry =>
      entry.table === 'statHandContributions' && entry.operation === 'query'
    )).toHaveLength(0)

    probe.reset()
    const limit = 20
    const latest = await ledger.readPlayerSnapshot(PLAYER_ID, {
      battleTypes: [BattleType.SIT_AND_GO, BattleType.RING_GAME],
      tableSizeLayers: ['full', 'hu'],
      latestHands: limit,
    })
    const contributionQueries = probe.entries.filter(entry =>
      entry.table === 'statHandContributions' && entry.operation === 'query'
    )
    expect(latest.diagnostics.indexQueries).toHaveLength(4)
    expect(contributionQueries).toHaveLength(4)
    expect(contributionQueries.every(entry => entry.limit === limit)).toBe(true)
    expect(contributionQueries.every(entry => entry.resultCount <= limit)).toBe(true)
    expect(contributionQueries.reduce((sum, entry) => sum + entry.resultCount, 0))
      .toBeLessThanOrEqual(limit * contributionQueries.length)
    expect(latest.selectedHands).toBe(limit)
  })

  test('既知BattleTypeの完全選択はunknownを除外した1 queryへcollapseする', async () => {
    disableScheduledGc(ledger)
    const knownBundles = ALL_KNOWN_BATTLE_TYPES.map((battleType, index) =>
      singleHandBundle(2_000 + index, {
        approxTimestamp: 20_000 + index,
        session: { battleType },
      })
    )
    const unknownBundle = singleHandBundle(9_999, {
      approxTimestamp: 99_999,
      session: {},
    })
    await ledger.replaceGenerationFromEntityBundle(
      mergeBundles(...knownBundles, unknownBundle),
      { generation: 350 }
    )

    probe.reset()
    const exactAll = await ledger.readPlayerSnapshot(PLAYER_ID, {
      battleTypes: ALL_KNOWN_BATTLE_TYPES,
      latestHands: 20,
    })
    expect(exactAll.diagnostics.indexQueries).toEqual([
      '[generation+playerId+hasKnownBattle+hasTimestamp+sortTimestamp+handId]',
    ])
    expect(exactAll.diagnostics.contributionRowsRead).toBeLessThanOrEqual(20)
    expect(exactAll.selection.kind).toBe('rows')
    if (exactAll.selection.kind === 'rows') {
      expect(exactAll.selection.rows.map(row => row.handId)).not.toContain(9_999)
      expect(exactAll.selection.rows).toHaveLength(ALL_KNOWN_BATTLE_TYPES.length)
    }
    const materialized = probe.entries.filter(entry =>
      entry.table === 'statHandContributions' && entry.operation === 'query'
    )
    expect(materialized).toHaveLength(1)
    expect(materialized[0]?.resultCount).toBeLessThanOrEqual(20)

    const twoTables = await ledger.readPlayerSnapshot(PLAYER_ID, {
      battleTypes: ALL_KNOWN_BATTLE_TYPES,
      tableSizeLayers: ['full', 'hu'],
      latestHands: 20,
    })
    expect(twoTables.diagnostics.indexQueries).toEqual([
      '[generation+playerId+hasKnownBattle+tableBucket+hasTimestamp+sortTimestamp+handId]',
      '[generation+playerId+hasKnownBattle+tableBucket+hasTimestamp+sortTimestamp+handId]',
    ])
    expect(twoTables.diagnostics.contributionRowsRead).toBeLessThanOrEqual(6)
  })

  test('既知BattleTypeの部分選択または余分なunknown値は完全選択へcollapseしない', async () => {
    disableScheduledGc(ledger)
    const bundle = mergeBundles(...ALL_KNOWN_BATTLE_TYPES.map((battleType, index) =>
      singleHandBundle(3_000 + index, {
        approxTimestamp: 30_000 + index,
        session: { battleType },
      })
    ))
    await ledger.replaceGenerationFromEntityBundle(bundle, { generation: 351 })

    const partial = await ledger.readPlayerSnapshot(PLAYER_ID, {
      battleTypes: ALL_KNOWN_BATTLE_TYPES.slice(0, -1),
      latestHands: 20,
    })
    expect(partial.diagnostics.indexQueries).toHaveLength(ALL_KNOWN_BATTLE_TYPES.length - 1)
    expect(partial.diagnostics.indexQueries.every(index => index.includes('battleBucket'))).toBe(true)

    const extraUnknown = await ledger.readPlayerSnapshot(PLAYER_ID, {
      battleTypes: [...ALL_KNOWN_BATTLE_TYPES, 999],
      latestHands: 20,
    })
    expect(extraUnknown.diagnostics.indexQueries).toHaveLength(ALL_KNOWN_BATTLE_TYPES.length + 1)
    expect(extraUnknown.diagnostics.indexQueries.every(index => index.includes('battleBucket'))).toBe(true)
  })

  test('lazy baselineを同一instance内でin-flight dedupし、新instanceはcanonicalを再読しない', async () => {
    const bundle = fixtureBundle()
    await db.hands.bulkPut(bundle.hands)
    await db.actions.bulkPut(bundle.actions)
    await db.phases.bulkPut(bundle.phases)

    probe.reset()
    const [first, second] = await Promise.all([
      ledger.readPlayerSnapshot(PLAYER_ID),
      ledger.readPlayerSnapshot(PLAYER_ID),
    ])
    const firstCanonicalQueries = probe.entries.filter(entry =>
      ['hands', 'actions', 'phases'].includes(entry.table) && entry.operation === 'query'
    )
    expect(firstCanonicalQueries.filter(entry => entry.table === 'hands')).toHaveLength(1)
    expect(firstCanonicalQueries.filter(entry => entry.table === 'actions')).toHaveLength(1)
    expect(firstCanonicalQueries.filter(entry => entry.table === 'phases')).toHaveLength(1)
    expect(first.counters).toEqual(second.counters)
    expect(first.diagnostics.baselineBuilt).toBe(true)
    expect(second.diagnostics.baselineBuilt).toBe(true)

    probe.reset()
    const restartedWorkerLedger = new StatsLedger(db)
    const afterMv3Restart = await restartedWorkerLedger.readPlayerSnapshot(PLAYER_ID)
    expect(afterMv3Restart.counters).toEqual(first.counters)
    expect(afterMv3Restart.diagnostics).toMatchObject({
      baselineBuilt: false,
      canonicalRowsRead: 0,
    })
    expect(probe.entries.filter(entry =>
      ['hands', 'actions', 'phases'].includes(entry.table) && entry.operation === 'query'
    )).toHaveLength(0)
  })

  test('cold baselineは寄与を250行以下でcommitし、ready後のprefetchはwriteしない', async () => {
    const hands = Array.from({ length: 501 }, (_, index) => makeHand({
      id: 40_000 + index,
      approxTimestamp: 40_000 + index,
    }))
    await db.hands.bulkPut(hands)
    const contributionBulkPut = jest.spyOn(db.statHandContributions, 'bulkPut')
    const aggregatePut = jest.spyOn(db.statPlayerAggregates, 'put')

    await ledger.ensurePlayerBaselines([PLAYER_ID])
    expect(contributionBulkPut.mock.calls.map(call => call[0].length)).toEqual([250, 250])
    const head = await ledger.getActiveHead()
    expect(await db.statHandContributions.where('generation').equals(head!.generation).count()).toBe(500)
    expect((await ledger.readPlayerSnapshot(PLAYER_ID)).totalHands).toBe(501)
    expect((await ledger.readPlayerSnapshot(PLAYER_ID, { latestHands: 500 })).selectedHands).toBe(500)
    expect(aggregatePut.mock.calls[0]?.[0]).toMatchObject({ ready: false })
    expect(aggregatePut.mock.calls[0]?.[0].buildId).toEqual(expect.any(String))
    expect(aggregatePut.mock.calls.at(-1)?.[0]).toMatchObject({ ready: true })
    expect(aggregatePut.mock.calls.at(-1)?.[0].buildId).toBeUndefined()

    contributionBulkPut.mockClear()
    aggregatePut.mockClear()
    const metaPut = jest.spyOn(db.meta, 'put')
    await ledger.ensurePlayerBaselines([PLAYER_ID])
    expect(contributionBulkPut).not.toHaveBeenCalled()
    expect(aggregatePut).not.toHaveBeenCalled()
    expect(metaPut).not.toHaveBeenCalled()
  }, 15_000)

  test('per-cell recentはplayerごと500件に有界で、all-history aggregateは全501件を保つ', async () => {
    const bundle: EntityBundle = {
      hands: Array.from({ length: 501 }, (_, index) => makeHand({
        id: 50_000 + index,
        approxTimestamp: 50_000 + index,
      })),
      actions: [],
      phases: [],
    }
    const built = buildGenerationFromEntityBundle(777, bundle)

    expect(built.contributions.filter(row => row.playerId === PLAYER_ID)).toHaveLength(500)
    expect(built.contributions.filter(row => row.playerId === OTHER_PLAYER_ID)).toHaveLength(500)
    const playerAggregate = built.aggregates.find(row => row.playerId === PLAYER_ID)
    expect(playerAggregate && getStatCounter(playerAggregate.totals, 'hands')).toEqual([501, 0])
  })

  test('500件より古い同一HandId再投入でもprevious canonical寄与を引き、二重加算しない', async () => {
    const hands = Array.from({ length: 501 }, (_, index) => makeHand({
      id: 60_000 + index,
      approxTimestamp: 60_000 + index,
    }))
    await db.hands.bulkPut(hands)
    await ledger.ensurePlayerBaselines([PLAYER_ID])
    const head = await ledger.getActiveHead()
    expect(await db.statHandContributions.get([head!.generation, PLAYER_ID, 60_000])).toBeUndefined()

    const previous: EntityBundle = { hands: [hands[0]!], actions: [], phases: [] }
    const replacement = singleHandBundle(60_000, {
      approxTimestamp: 60_000,
      seatUserIds: hands[0]!.seatUserIds,
    })
    await ledger.replaceCompletedHandContributions(replacement, previous)

    const snapshot = await ledger.readPlayerSnapshot(PLAYER_ID)
    expect(snapshot.totalHands).toBe(501)
    expect(getStatCounter(snapshot.counters, 'vpip')).toEqual([1, 501])
    expect(await db.statHandContributions.get([head!.generation, PLAYER_ID, 60_000])).toBeUndefined()
  }, 15_000)

  test('ready=falseのactive aggregateもlive差分更新し、player全寄与を再走査しない', async () => {
    await ledger.replaceCompletedHandContributions(singleHandBundle(60))
    probe.reset()
    await ledger.replaceCompletedHandContributions(singleHandBundle(61))

    const playerWideQueries = probe.entries.filter(entry =>
      entry.table === 'statHandContributions' &&
      entry.operation === 'query' &&
      entry.index === '[generation+playerId]'
    )
    expect(playerWideQueries).toHaveLength(0)
    const head = await ledger.getActiveHead()
    const aggregate = await db.statPlayerAggregates.get([head!.generation, PLAYER_ID])
    expect(aggregate?.ready).toBe(false)
    expect(aggregate?.totals[0]).toBe(2)
  })

  test('baseline scan後のcanonical revision変更を検出し、hybrid値を公開せず再試行する', async () => {
    const initial = singleHandBundle(70)
    await db.hands.bulkPut(initial.hands)
    await db.actions.bulkPut(initial.actions)

    const internal = ledger as unknown as {
      publishPlayerBaseline: (...args: any[]) => Promise<void>
    }
    const originalPublish = internal.publishPlayerBaseline.bind(ledger)
    let injected = false
    internal.publishPlayerBaseline = async (...args: any[]) => {
      if (!injected) {
        injected = true
        const live = singleHandBundle(71)
        await db.transaction('rw', [
          db.hands,
          db.phases,
          db.actions,
          db.meta,
          db.statHandContributions,
          db.statPlayerAggregates,
        ], async () => {
          await db.hands.bulkPut(live.hands)
          await db.actions.bulkPut(live.actions)
          await ledger.replaceCompletedHandContributions(live)
        })
      }
      await originalPublish(...args)
    }

    const snapshot = await ledger.readPlayerSnapshot(PLAYER_ID)
    expect(injected).toBe(true)
    expect(snapshot.selectedHands).toBe(2)
    expect(snapshot.diagnostics.baselineBuilt).toBe(true)
    expect((await calculateLegacyNumericStats(
      mergeBundles(initial, singleHandBundle(71)),
      PLAYER_ID,
      {}
    ))).toEqual(buildStatSnapshot(snapshot.counters))
  })

  test('cold baseline中に4hand連続commitしてもhard errorにせず完全値へ収束する', async () => {
    const initial = singleHandBundle(80)
    await db.hands.bulkPut(initial.hands)
    await db.actions.bulkPut(initial.actions)

    const internal = ledger as unknown as {
      publishPlayerBaseline: (...args: any[]) => Promise<void>
    }
    const originalPublish = internal.publishPlayerBaseline.bind(ledger)
    let injectedHands = 0
    internal.publishPlayerBaseline = async (...args: any[]) => {
      if (injectedHands < 4) {
        injectedHands++
        const live = singleHandBundle(80 + injectedHands)
        await db.transaction('rw', [
          db.hands,
          db.phases,
          db.actions,
          db.meta,
          db.statHandContributions,
          db.statPlayerAggregates,
        ], async () => {
          await db.hands.bulkPut(live.hands)
          await db.actions.bulkPut(live.actions)
          await ledger.replaceCompletedHandContributions(live)
        })
      }
      await originalPublish(...args)
    }

    const snapshot = await ledger.readPlayerSnapshot(PLAYER_ID)
    expect(injectedHands).toBe(4)
    expect(snapshot.selectedHands).toBe(5)
    expect(snapshot.totalHands).toBe(5)
  })

  test('lineupは単一readonly snapshotで読み、途中のlive commitをplayer間で混在させない', async () => {
    const initial = singleHandBundle(10)
    await db.hands.bulkPut(initial.hands)
    await db.actions.bulkPut(initial.actions)
    await db.phases.bulkPut(initial.phases)
    await ledger.readLineupSnapshots([PLAYER_ID, OTHER_PLAYER_ID])

    let releaseSecondRead!: () => void
    let secondReadEnteredResolve!: () => void
    const secondReadGate = new Promise<void>(resolve => { releaseSecondRead = resolve })
    const secondReadEntered = new Promise<void>(resolve => { secondReadEnteredResolve = resolve })
    const internal = ledger as unknown as {
      readPlayerAtHead: (...args: unknown[]) => Promise<PlayerStatCounterSnapshot>
    }
    const originalReadPlayerAtHead = internal.readPlayerAtHead.bind(ledger)
    internal.readPlayerAtHead = async (...args: unknown[]) => {
      const playerId = args[1] as number
      if (playerId === OTHER_PLAYER_ID) {
        secondReadEnteredResolve()
        await Dexie.waitFor(secondReadGate)
      }
      return await originalReadPlayerAtHead(...args)
    }

    const lineupRead = ledger.readLineupSnapshots([PLAYER_ID, OTHER_PLAYER_ID])
    await secondReadEntered
    const liveWrite = ledger.replaceCompletedHandContributions(singleHandBundle(11))
    releaseSecondRead()

    const duringCommit = await lineupRead
    await liveWrite
    expect(duringCommit.map(snapshot => snapshot.selectedHands)).toEqual([1, 1])
    expect(new Set(duringCommit.map(snapshot => snapshot.generation)).size).toBe(1)

    internal.readPlayerAtHead = originalReadPlayerAtHead
    const afterCommit = await ledger.readLineupSnapshots([PLAYER_ID, OTHER_PLAYER_ID])
    expect(afterCommit.map(snapshot => snapshot.selectedHands)).toEqual([2, 2])
  })

  test('aggregateまたは寄与のvector/version破損をcanonical baselineから自己修復する', async () => {
    const bundle = fixtureBundle()
    await db.hands.bulkPut(bundle.hands)
    await db.actions.bulkPut(bundle.actions)
    await db.phases.bulkPut(bundle.phases)
    const expected = await ledger.readPlayerSnapshot(PLAYER_ID)
    const head = await ledger.getActiveHead()
    if (!head) throw new Error('active ledger head is missing')

    const aggregate = await db.statPlayerAggregates.get([head.generation, PLAYER_ID])
    if (!aggregate) throw new Error('player aggregate is missing')
    await db.statPlayerAggregates.put({
      ...aggregate,
      version: HAND_STAT_CONTRIBUTION_VERSION + 1,
      totals: [1],
    })
    const aggregateRepaired = await ledger.readPlayerSnapshot(PLAYER_ID)
    expect(aggregateRepaired.counters).toEqual(expected.counters)
    expect(aggregateRepaired.diagnostics.baselineBuilt).toBe(true)
    expect(aggregateRepaired.diagnostics.canonicalRowsRead).toBeGreaterThan(0)

    const contribution = await db.statHandContributions
      .where('[generation+playerId]')
      .equals([head.generation, PLAYER_ID])
      .first()
    if (!contribution) throw new Error('player contribution is missing')
    await db.statHandContributions.put({
      ...contribution,
      version: HAND_STAT_CONTRIBUTION_VERSION + 1,
      counters: [1],
    })
    const contributionRepaired = await ledger.readPlayerSnapshot(PLAYER_ID, {
      latestHands: 20,
    })
    expect(contributionRepaired.counters).toEqual(expected.counters)
    expect(contributionRepaired.diagnostics.baselineBuilt).toBe(true)
    const stored = await db.statHandContributions.get([
      head.generation,
      PLAYER_ID,
      contribution.handId,
    ])
    expect(stored?.version).toBe(HAND_STAT_CONTRIBUTION_VERSION)
    expect(stored?.counters).toHaveLength(HAND_STAT_COUNTER_VECTOR_LENGTH)
  })

  test('6人lineupのaggregateが全て破損しても1 batchのforce baselineで自己修復する', async () => {
    const bundle = fixtureBundle()
    await db.hands.bulkPut(bundle.hands)
    await db.actions.bulkPut(bundle.actions)
    await db.phases.bulkPut(bundle.phases)
    const playerIds = [1, 2, 3, 4, 5, 6]
    const expected = await ledger.readLineupSnapshots(playerIds)
    const head = await ledger.getActiveHead()
    if (!head) throw new Error('active ledger head is missing')

    const aggregates = await db.statPlayerAggregates.bulkGet(
      playerIds.map(playerId => [head.generation, playerId])
    )
    for (const aggregate of aggregates) {
      if (!aggregate) throw new Error('player aggregate is missing')
      await db.statPlayerAggregates.put({
        ...aggregate,
        version: HAND_STAT_CONTRIBUTION_VERSION + 1,
        totals: [1],
      })
    }

    const repaired = await ledger.readLineupSnapshots(playerIds)
    expect(repaired.map(snapshot => snapshot.counters))
      .toEqual(expected.map(snapshot => snapshot.counters))
    expect(repaired.every(snapshot => snapshot.diagnostics.baselineBuilt)).toBe(true)

    const stored = await db.statPlayerAggregates.bulkGet(
      playerIds.map(playerId => [head.generation, playerId])
    )
    expect(stored.every(aggregate =>
      aggregate?.version === HAND_STAT_CONTRIBUTION_VERSION &&
      aggregate.totals.length === HAND_STAT_COUNTER_VECTOR_LENGTH
    )).toBe(true)
  })

  test('activeなしのprepareは異なる世代を採番し、marker fault時はheadごとrollbackする', async () => {
    disableScheduledGc(ledger)
    probe.failNextMetaPut(STATS_LEDGER_STAGING_META_ID)

    await expect(ledger.prepareStagingGeneration()).rejects.toThrow()
    expect(await ledger.getActiveHead()).toBeNull()
    expect(await db.meta.get(STATS_LEDGER_STAGING_META_ID)).toBeUndefined()

    const staging = await ledger.prepareStagingGeneration()
    const active = await ledger.getActiveHead()
    expect(active).not.toBeNull()
    expect(staging.generation).not.toBe(active!.generation)
    expect(staging.generation).toBeGreaterThan(active!.generation)
  })

  test('cloud rebuild失敗後はmalformed markerでもhybrid canonical baselineを拒否し、完全置換でだけ解除する', async () => {
    disableScheduledGc(ledger)
    const oldBundle = singleHandBundle(20)
    await ledger.replaceGenerationFromEntityBundle(oldBundle, { generation: 390 })
    const staging = await ledger.prepareStagingGeneration(391)

    const missingPlayerId = 77
    const hybridHand = makeHand({
      id: 21,
      seatUserIds: [missingPlayerId, OTHER_PLAYER_ID, -1, -1, -1, -1],
      approxTimestamp: 210,
    })
    await db.hands.put(hybridHand)
    await expect(ledger.readPlayerSnapshot(missingPlayerId))
      .rejects.toThrow('not known complete')

    await ledger.abandonStagingGeneration(staging.generation)
    expect(await db.meta.get(STATS_CANONICAL_REBUILD_META_ID)).toBeDefined()
    await db.meta.put({
      id: STATS_CANONICAL_REBUILD_META_ID,
      value: { malformed: true },
      updatedAt: Date.now(),
    })
    await expect(ledger.readPlayerSnapshot(missingPlayerId))
      .rejects.toThrow('not known complete')

    const completeBundle: EntityBundle = {
      hands: [...oldBundle.hands, hybridHand],
      actions: [...oldBundle.actions],
      phases: [],
    }
    await ledger.replaceGenerationFromEntityBundle(completeBundle, { generation: 392 })
    expect(await db.meta.get(STATS_CANONICAL_REBUILD_META_ID)).toBeUndefined()
    expect((await ledger.readPlayerSnapshot(missingPlayerId)).selectedHands).toBe(1)
  })

  test('staging owner fenceは別workerのappend/activate/abandonを拒否する', async () => {
    disableScheduledGc(ledger)
    const staging = await ledger.prepareStagingGeneration()
    const marker = await db.meta.get(STATS_LEDGER_STAGING_META_ID)
    await db.meta.put({
      ...marker!,
      value: { ...marker!.value, ownerId: 'foreign-worker' },
    })
    await expect(ledger.appendStagingEntityBundle(staging.generation, singleHandBundle(30)))
      .rejects.toThrow('not owned')
    await expect(ledger.activateStagingGeneration(staging.generation))
      .rejects.toThrow('not owned')
    await ledger.abandonStagingGeneration(staging.generation)
    expect(await db.meta.get(STATS_LEDGER_STAGING_META_ID)).toBeDefined()
  })

  test('staging中のlive write失敗markerはactivateに吸収されず復旧要求を保持する', async () => {
    disableScheduledGc(ledger)
    const staging = await ledger.prepareStagingGeneration()

    await ledger.markCanonicalRebuildRequired('live-write-failure')

    await expect(ledger.activateStagingGeneration(staging.generation))
      .rejects.toThrow('not owned')
    expect(await db.meta.get(STATS_LEDGER_STAGING_META_ID)).toBeDefined()
    expect(await db.meta.get(STATS_CANONICAL_REBUILD_META_ID)).toBeDefined()
    expect(await ledger.needsCanonicalRebuildRecovery()).toBe(true)
  })

  test('stagingは空のままとし、activate後は表示playerだけをlazy baselineする', async () => {
    disableScheduledGc(ledger)
    const oldBundle = singleHandBundle(40)
    await db.hands.bulkPut(oldBundle.hands)
    await db.actions.bulkPut(oldBundle.actions)
    await ledger.replaceGenerationFromEntityBundle(oldBundle, { generation: 400 })
    const staging = await ledger.prepareStagingGeneration(401)
    await ledger.appendStagingEntityBundle(staging.generation, oldBundle)

    const liveBundle = singleHandBundle(41)
    await db.hands.bulkPut(liveBundle.hands)
    await db.actions.bulkPut(liveBundle.actions)
    await ledger.replaceCompletedHandContributions(liveBundle)
    const activeRows = await db.statHandContributions.where('generation').equals(400).count()
    const stagingRows = await db.statHandContributions.where('generation').equals(401).count()
    expect(activeRows).toBe(12)
    expect(stagingRows).toBe(0)
    const beforeActivation = await ledger.readPlayerSnapshot(PLAYER_ID)
    expect(beforeActivation.generation).toBe(400)
    expect(beforeActivation.selectedHands).toBe(2)

    const contributionPut = jest.spyOn(db.statHandContributions, 'put')
    const contributionBulkPut = jest.spyOn(db.statHandContributions, 'bulkPut')
    const contributionDelete = jest.spyOn(db.statHandContributions, 'delete')
    const contributionBulkDelete = jest.spyOn(db.statHandContributions, 'bulkDelete')
    const contributionClear = jest.spyOn(db.statHandContributions, 'clear')
    const aggregatePut = jest.spyOn(db.statPlayerAggregates, 'put')
    const aggregateBulkPut = jest.spyOn(db.statPlayerAggregates, 'bulkPut')
    const aggregateDelete = jest.spyOn(db.statPlayerAggregates, 'delete')
    const aggregateBulkDelete = jest.spyOn(db.statPlayerAggregates, 'bulkDelete')
    const aggregateClear = jest.spyOn(db.statPlayerAggregates, 'clear')

    await ledger.activateStagingGeneration(staging.generation)
    expect(contributionPut).not.toHaveBeenCalled()
    expect(contributionBulkPut).not.toHaveBeenCalled()
    expect(contributionDelete).not.toHaveBeenCalled()
    expect(contributionBulkDelete).not.toHaveBeenCalled()
    expect(contributionClear).not.toHaveBeenCalled()
    expect(aggregatePut).not.toHaveBeenCalled()
    expect(aggregateBulkPut).not.toHaveBeenCalled()
    expect(aggregateDelete).not.toHaveBeenCalled()
    expect(aggregateBulkDelete).not.toHaveBeenCalled()
    expect(aggregateClear).not.toHaveBeenCalled()

    const afterActivation = await ledger.readPlayerSnapshot(PLAYER_ID)
    expect(afterActivation.generation).toBe(401)
    expect(afterActivation.counters).toEqual(beforeActivation.counters)
    expect(afterActivation.selectedHands).toBe(2)
    expect(afterActivation.diagnostics.baselineBuilt).toBe(true)
  })

  test('abandonはactiveを維持してmarkerを外し、孤児stagingを後続GC可能にする', async () => {
    disableScheduledGc(ledger)
    await ledger.replaceGenerationFromEntityBundle(singleHandBundle(50), { generation: 500 })
    const staging = await ledger.prepareStagingGeneration(501)
    await db.statHandContributions.put(dummyContributionRecord(staging.generation, PLAYER_ID, 51))
    await db.statPlayerAggregates.put(dummyAggregateRecord(staging.generation, PLAYER_ID))

    await ledger.abandonStagingGeneration(staging.generation)
    expect((await ledger.getActiveHead())?.generation).toBe(500)
    expect(await db.meta.get(STATS_LEDGER_STAGING_META_ID)).toBeUndefined()
    expect(await db.statHandContributions.where('generation').equals(501).count()).toBeGreaterThan(0)

    const internal = ledger as unknown as {
      deleteOneInactiveGenerationChunk: () => Promise<boolean>
    }
    while (await internal.deleteOneInactiveGenerationChunk()) {
      // 全chunkを明示回収する。
    }
    expect(await db.statHandContributions.where('generation').equals(501).count()).toBe(0)
    expect(await db.statPlayerAggregates.where('generation').equals(501).count()).toBe(0)
    expect(await db.statHandContributions.where('generation').equals(500).count()).toBeGreaterThan(0)
  })

  test('generation GCはactive/stagingを保持し、1回の削除を250行以下に制限する', async () => {
    disableScheduledGc(ledger)
    const activeGeneration = 600
    const stagingGeneration = 601
    const orphanGeneration = 602
    await db.meta.bulkPut([
      {
        id: STATS_LEDGER_HEAD_META_ID,
        value: { generation: activeGeneration, version: HAND_STAT_CONTRIBUTION_VERSION },
      },
      {
        id: STATS_LEDGER_STAGING_META_ID,
        value: {
          generation: stagingGeneration,
          version: HAND_STAT_CONTRIBUTION_VERSION,
          ownerId: 'any-staging-owner',
        },
      },
    ])
    await db.statHandContributions.bulkPut([
      dummyContributionRecord(activeGeneration, 1, 1),
      dummyContributionRecord(stagingGeneration, 1, 1),
      ...Array.from({ length: 251 }, (_, index) =>
        dummyContributionRecord(orphanGeneration, index + 1, index + 1)
      ),
    ])
    await db.statPlayerAggregates.bulkPut([
      dummyAggregateRecord(activeGeneration, 1),
      dummyAggregateRecord(stagingGeneration, 1),
      ...Array.from({ length: 251 }, (_, index) =>
        dummyAggregateRecord(orphanGeneration, index + 1)
      ),
    ])

    const contributionDeletes = jest.spyOn(db.statHandContributions, 'bulkDelete')
    const aggregateDeletes = jest.spyOn(db.statPlayerAggregates, 'bulkDelete')
    const internal = ledger as unknown as {
      deleteOneInactiveGenerationChunk: () => Promise<boolean>
    }
    let iterations = 0
    while (await internal.deleteOneInactiveGenerationChunk()) {
      iterations++
      if (iterations > 10) throw new Error('statistics-ledger GC did not converge')
    }

    const deletedKeyBatches = [
      ...contributionDeletes.mock.calls.map(call => call[0]),
      ...aggregateDeletes.mock.calls.map(call => call[0]),
    ]
    expect(deletedKeyBatches.length).toBeGreaterThan(1)
    expect(deletedKeyBatches.every(keys => keys.length <= 250)).toBe(true)
    expect(await db.statHandContributions.where('generation').equals(orphanGeneration).count()).toBe(0)
    expect(await db.statPlayerAggregates.where('generation').equals(orphanGeneration).count()).toBe(0)
    expect(await db.statHandContributions.where('generation').equals(activeGeneration).count()).toBe(1)
    expect(await db.statHandContributions.where('generation').equals(stagingGeneration).count()).toBe(1)
    expect(await db.statPlayerAggregates.where('generation').equals(activeGeneration).count()).toBe(1)
    expect(await db.statPlayerAggregates.where('generation').equals(stagingGeneration).count()).toBe(1)
  }, 15_000)
})
