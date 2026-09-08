/**
 * Cross-path canonical parity gate.
 *
 * A single anonymized real-capture fixture is replayed through every derived
 * data path:
 *   1. the live AggregateEvents -> WriteEntity -> ReadEntity pipeline,
 *   2. EntityConverter directly,
 *   3. the manual Raw Event Lake rebuild,
 *   4. JSONL import (which performs the canonical full rebuild).
 *
 * Existing unit tests cover individual conversion rules in depth. This suite
 * deliberately stays at the integration boundary: it compares the complete
 * persisted entity model and calculated statistics so a future one-path fix
 * cannot silently leave another path behind.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from './app'
import { trackServiceForTeardown } from './utils/test-service-teardown'
import { threeBetStat } from './stats/core/3bet'
import { EntityConverter } from './entity-converter'
import { apiEventSchemas } from './types/api'
import { getRecentHands } from './services/recent-hands-service'
import { deriveMidHandChipInflow } from './utils/hand-chip-accounting'
import { createImportExportHandlers } from './background/import-export'
import { setOperationState } from './background/operation-state'
import { mergeApiEvents, type RawApiEvent } from './utils/api-event-key'
import {
  ActionDetail,
  ActionType,
  ApiType,
  BattleType,
  PhaseType,
  type ApiEvent,
  type PlayerStats
} from './types'

type ReplayPath = 'live' | 'entity-converter' | 'rebuild' | 'import'

type SessionSeed = {
  id?: string
  battleType?: BattleType
  name?: string
  players: Array<[number, { name: string, rank: string }]>
}

const readFixture = (name: string): ApiEvent[] =>
  readFileSync(join(process.cwd(), 'e2e/fixtures', name), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line)) as ApiEvent[]

const FIXTURE_EVENTS = readFixture('session-3hands.ndjson')

/** #340 の再現: 同一ミリ秒に 304×6 + 305×2 が同居し、主キー順で 304 が先に並ぶ。 */
const SAME_MS_BURST_EVENTS = readFixture('hand-samems-street-burst.ndjson')
/** #339 の再現: Ringのハンド中リバイイン（ハンド内観測）と終了時の自動買い足し。 */
const RING_REBUY_EVENTS = readFixture('hand-ring-midhand-rebuy.ndjson')
/** ハンド中にfold済みの席へ別人が入り、終点snapshotだけが新しい人物になる。 */
const RING_REPLACEMENT_EVENTS = readFixture('hand-ring-seat-replacement.ndjson')
/** 同一ms群で、新ストリート最初の行が ALL_IN になるケース（codex review round 3）。 */
const STREET_OPENING_ALLIN_EVENTS = readFixture('hand-street-opening-allin.ndjson')
/** CHECK権からのBBレイズ・フロップの先制ベットと、CHECK不可のショートコール。 */
const CHECK_OPTION_ALLIN_EVENTS = readFixture('hand-check-option-allin.ndjson')

const entryEvent = FIXTURE_EVENTS.find(event => event.ApiTypeId === ApiType.EVT_ENTRY_QUEUED)!
const detailsEvent = FIXTURE_EVENTS.find(event => event.ApiTypeId === ApiType.EVT_SESSION_DETAILS)!
const seatEvent = FIXTURE_EVENTS.find(event => event.ApiTypeId === ApiType.EVT_PLAYER_SEAT_ASSIGNED)!
const firstDealIndex = FIXTURE_EVENTS.findIndex(event => event.ApiTypeId === ApiType.EVT_DEAL)

const FIXTURE_SESSION_SEED: SessionSeed = {
  id: entryEvent.Id,
  battleType: entryEvent.BattleType,
  name: detailsEvent.Name,
  players: seatEvent.TableUsers.map(user => [
    user.UserId,
    { name: user.UserName, rank: user.Rank.RankId }
  ])
}

// A realistic incremental window: no 201/308/313 session prelude is present,
// so the incremental EntityConverter entry point must retain the SessionState
// seed supplied by the currently-running service. This is the exact shape that
// caught the prototype-getter spread regression fixed in PR #109.
const SEEDED_HAND_WINDOW = FIXTURE_EVENTS.slice(firstDealIndex)

const applySessionSeed = (service: PokerChaseService, seed?: SessionSeed): void => {
  if (!seed) return
  service.session.setId(seed.id)
  service.session.setBattleType(seed.battleType)
  service.session.setName(seed.name)
  for (const [userId, player] of seed.players) {
    service.session.setPlayer(userId, player)
  }
}

const canonicalizeStats = (stats: PlayerStats[]) =>
  stats
    .filter((player): player is Extract<PlayerStats, { statResults: unknown }> => 'statResults' in player)
    .map(player => ({
      playerId: player.playerId,
      // Player names come from ephemeral live SessionState rather than the
      // derived tables. Session id/type/name parity is asserted on Hand below;
      // this comparison covers every numeric/statistical derived value.
      statResults: player.statResults
        .filter(stat => stat.id !== 'playerName')
        .map(stat => ({ id: stat.id, value: stat.value }))
        .sort((a, b) => a.id.localeCompare(b.id))
    }))
    .sort((a, b) => a.playerId - b.playerId)

const takeCanonicalSnapshot = async (service: PokerChaseService, db: PokerChaseDB) => {
  const hands = await db.hands.orderBy('id').toArray()
  const phases = await db.phases.orderBy('[handId+phase]').toArray()
  const actions = await db.actions.orderBy('[handId+index]').toArray()
  const playerIds = [...new Set(hands.flatMap(hand => hand.seatUserIds))]
    .filter(playerId => playerId !== -1)
    .sort((a, b) => a - b)
  const stats = canonicalizeStats(await service.statsOutputStream.calcStats(playerIds))

  return {
    // Full entities intentionally remain in the snapshot. Together they cover
    // hand start timestamp, session metadata, winners/chip accounting, boards,
    // phase membership, action position, and stat-detection actionDetails.
    hands,
    phases,
    actions,
    stats
  }
}

const saveBundle = async (
  db: PokerChaseDB,
  bundle: ReturnType<EntityConverter['convertEventsToEntities']>
): Promise<void> => {
  await db.transaction('rw', [db.hands, db.phases, db.actions], async () => {
    if (bundle.hands.length > 0) await db.hands.bulkPut(bundle.hands)
    if (bundle.phases.length > 0) await db.phases.bulkPut(bundle.phases)
    if (bundle.actions.length > 0) await db.actions.bulkPut(bundle.actions)
  })
}

const replay = async (
  path: ReplayPath,
  events: ApiEvent[],
  seed?: SessionSeed,
  staleBundle?: ReturnType<EntityConverter['convertEventsToEntities']>
) => {
  setOperationState({ type: 'idle' })
  await chrome.storage.local.remove(PokerChaseService.STORAGE_KEY)

  const db = new PokerChaseDB(indexedDB, IDBKeyRange)
  await db.open()
  const service = trackServiceForTeardown(new PokerChaseService({ db }))
  await service.ready
  applySessionSeed(service, seed)
  if (staleBundle) {
    await saveBundle(db, staleBundle)
    // 旧canonical由来の台帳も一度作り、再構築が同時に置換することを検証する。
    await service.statsOutputStream.calcStats(staleBundle.hands[0]!.seatUserIds)
  }

  // Import/rebuild progress delivery and post-import tab refresh are
  // best-effort production side effects, not part of the data invariant.
  ;(chrome.runtime.sendMessage as jest.Mock).mockReturnValue(Promise.resolve())
  ;(chrome.tabs.query as jest.Mock).mockImplementation((_query, callback) => callback([]))

  const actionEvidence: Array<{ playerId: number, phase: PhaseType, actionType: ActionType, canRaise: boolean | null, threeBetChance: boolean }> = []
  const detectThreeBet = threeBetStat.detectActionDetails!
  const actionSpy = jest.spyOn(threeBetStat, 'detectActionDetails').mockImplementation(context => {
    const details = detectThreeBet(context)
    actionEvidence.push({
      playerId: context.playerId, phase: context.phase, actionType: context.actionType,
      canRaise: context.canRaise ?? null, threeBetChance: details.includes(ActionDetail.$3BET_CHANCE),
    })
    return details
  })
  try {
    if (path === 'live') {
      // EVT_DEAL also launches an intentionally unawaited hand-count warmup
      // outside the SimpleTransform queue. It is irrelevant to persisted
      // parity (stats are calculated directly below), and must not outlive
      // this fresh fixed-name DB into the next replay.
      const warmupCount = jest.spyOn(db.hands, 'count').mockResolvedValue(0)
      try {
        for (const event of events) service.handAggregateStream.write(event)
        await service.handAggregateStream.whenIdle()
        expect(warmupCount).toHaveBeenCalled()
        if (events === RING_REPLACEMENT_EVENTS) {
          expect(service.session.players.get(3101)?.name).toBe('Player1')
          expect(service.session.players.get(3105)?.name).toBe('Player5')
        }
      } finally {
        warmupCount.mockRestore()
      }
    } else if (path === 'entity-converter') {
      const bundle = new EntityConverter(service.session).convertEventsToEntities(events)
      await saveBundle(db, bundle)
    } else {
      const handlers = createImportExportHandlers(service, db, 'https://example.com/*')
      if (path === 'rebuild') {
        await mergeApiEvents(db, events as RawApiEvent[])
        await handlers.rebuildAllData()
      } else {
        await handlers.importData(events.map(event => JSON.stringify(event)).join('\n'))
      }
      await service.statsOutputStream.whenIdle()
    }

    const recent = events === RING_REPLACEMENT_EVENTS
      ? await Promise.all([3101, 3103, 3104, 3105].map(async playerId => ({
          playerId,
          hands: (await getRecentHands(db, service, playerId)).hands.map(hand => ({ netChips: hand.netChips })),
        })))
      : undefined
    return { ...await takeCanonicalSnapshot(service, db), actionEvidence, recent }
  } finally {
    // replay() は1テスト内で4経路ぶん連続で呼ばれる。ルート afterEach
    // （test-service-teardown.ts）の取り消しはテスト終了時なので、ここで
    // 明示的に取り消さないと、直前の経路のインスタンスの500msタイマーが
    // 次の経路の `await service.ready`（restoreState()）より前に発火し、
    // 前の経路の playerId/session を次の経路へ持ち込んでしまう。
    actionSpy.mockRestore()
    service.cancelPendingPersist()
    setOperationState({ type: 'idle' })
    db.close()
    await db.delete()
  }
}

const replayEveryPath = async (events: ApiEvent[], seed?: SessionSeed) => {
  const snapshots = {} as Record<ReplayPath, Awaited<ReturnType<typeof replay>>>
  for (const path of ['live', 'entity-converter', 'rebuild', 'import'] as const) {
    snapshots[path] = await replay(path, events, seed)
  }
  return snapshots
}

describe('cross-path canonical parity', () => {
  test('an anonymized real three-hand capture has identical entities and stats on every path', async () => {
    // Fixture capability checks: this is a real legacy delta-board stream,
    // contains multiple completed hands, and begins with a complete session
    // prelude. If the fixture is replaced, do not silently weaken this gate.
    expect(FIXTURE_EVENTS.filter(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)).toHaveLength(3)
    expect(FIXTURE_EVENTS.some(event =>
      event.ApiTypeId === ApiType.EVT_DEAL_ROUND && event.CommunityCards.length === 1
    )).toBe(true)
    expect(firstDealIndex).toBeGreaterThan(0)

    const snapshots = await replayEveryPath(FIXTURE_EVENTS)
    const canonical = snapshots.live

    expect(snapshots['entity-converter']).toEqual(canonical)
    expect(snapshots.rebuild).toEqual(canonical)
    expect(snapshots.import).toEqual(canonical)

    // Independent fixture oracles prevent a shared helper regression from
    // making all paths consistently wrong.
    expect(canonical.hands.map(hand => ({
      id: hand.id,
      approxTimestamp: hand.approxTimestamp,
      winners: hand.winningPlayerIds,
      session: hand.session
    }))).toEqual([
      {
        id: 258411144,
        approxTimestamp: 1726929399688,
        winners: [1003],
        session: { id: '10_20_0001', battleType: BattleType.RING_GAME, name: '初級ルーム' }
      },
      {
        id: 258411368,
        approxTimestamp: 1726929418548,
        winners: [1003],
        session: { id: '10_20_0001', battleType: BattleType.RING_GAME, name: '初級ルーム' }
      },
      {
        id: 258411964,
        approxTimestamp: 1726929470457,
        winners: [1002],
        session: { id: '10_20_0001', battleType: BattleType.RING_GAME, name: '初級ルーム' }
      }
    ])
    expect(canonical.hands.every(hand => hand.playerChipAccounting !== undefined)).toBe(true)
    expect(canonical.phases.find(phase =>
      phase.handId === 258411368 && phase.phase === PhaseType.TURN
    )?.communityCards).toEqual([35, 4, 23, 26])
    expect(canonical.phases.filter(phase => phase.handId === 258411368).map(phase => ({
      phase: phase.phase,
      seatUserIds: phase.seatUserIds
    }))).toEqual([
      { phase: PhaseType.PREFLOP, seatUserIds: [-1, -1, 1001, 1002, 1003, 1004] },
      { phase: PhaseType.FLOP, seatUserIds: [1002, 1003, 1004] },
      { phase: PhaseType.TURN, seatUserIds: [1002, 1003, 1004] }
    ])
    expect(canonical.actions
      .filter(action => action.handId === 258411368 && action.phase === PhaseType.PREFLOP)
      .map(action => ({ playerId: action.playerId, position: action.position }))
    ).toEqual([
      { playerId: 1002, position: 1 },
      { playerId: 1003, position: 0 },
      { playerId: 1004, position: -1 },
      { playerId: 1001, position: -2 }
    ])
    const selectedStatValues = (playerId: number, ids: string[]) => Object.fromEntries(
      canonical.stats
        .find(player => player.playerId === playerId)!
        .statResults
        .filter(stat => ids.includes(stat.id))
        .map(stat => [stat.id, stat.value])
    )
    expect(selectedStatValues(1001, ['hands', 'vpip', 'pfr', 'foldToSteal'])).toEqual({
      foldToSteal: [1, 1],
      hands: 3,
      pfr: [0, 3],
      vpip: [0, 3]
    })
    expect(selectedStatValues(1002, ['hands', 'vpip', 'pfr', 'cbet', 'wtsd', 'wwsf'])).toEqual({
      cbet: [1, 1],
      hands: 3,
      pfr: [1, 2],
      vpip: [1, 2],
      wtsd: [0, 1],
      wwsf: [0, 1]
    })
    expect(selectedStatValues(1003, ['hands', 'vpip', 'cbetFold', 'wtsd', 'wwsf'])).toEqual({
      cbetFold: [0, 1],
      hands: 3,
      vpip: [1, 2],
      wtsd: [0, 1],
      wwsf: [1, 1]
    })
    expect(selectedStatValues(1004, ['hands', 'vpip', 'pfr', 'wtsd', 'wwsf'])).toEqual({
      hands: 3,
      pfr: [0, 3],
      vpip: [1, 3],
      wtsd: [0, 1],
      wwsf: [0, 1]
    })
  })

  test('a same-millisecond 304/305 burst attributes every action to its own street (#340)', async () => {
    // Fixture capability check: 8イベントが同一msに同居し、export順（主キー順 =
    // ApiTypeId昇順）では全ての 304 が 305 より前に並ぶ。ここが崩れると
    // EVT_DEAL_ROUND 駆動カウンタの遅れを再現できない。
    const burstTimestamp = SAME_MS_BURST_EVENTS
      .filter(event => event.ApiTypeId === ApiType.EVT_DEAL_ROUND)
      .map(event => event.timestamp)[0]
    const burst = SAME_MS_BURST_EVENTS.filter(event => event.timestamp === burstTimestamp)
    expect(burst.map(event => event.ApiTypeId)).toEqual([304, 304, 304, 304, 304, 304, 305, 305])

    const snapshots = await replayEveryPath(SAME_MS_BURST_EVENTS)
    const canonical = snapshots.live
    expect(snapshots['entity-converter']).toEqual(canonical)
    expect(snapshots.rebuild).toEqual(canonical)
    expect(snapshots.import).toEqual(canonical)

    // 3件のプリフロップ + バーストのフロップ3件 + ターン3件。カウンタ駆動だと
    // バーストの6件すべてがプリフロップに落ちる。
    expect(canonical.actions.map(action => ({
      playerId: action.playerId,
      phase: action.phase,
      actionType: action.actionType
    }))).toEqual([
      { playerId: 2001, phase: PhaseType.PREFLOP, actionType: ActionType.CALL },
      { playerId: 2002, phase: PhaseType.PREFLOP, actionType: ActionType.CALL },
      { playerId: 2003, phase: PhaseType.PREFLOP, actionType: ActionType.CHECK },
      { playerId: 2002, phase: PhaseType.FLOP, actionType: ActionType.CHECK },
      { playerId: 2003, phase: PhaseType.FLOP, actionType: ActionType.CHECK },
      { playerId: 2001, phase: PhaseType.FLOP, actionType: ActionType.CHECK },
      { playerId: 2002, phase: PhaseType.TURN, actionType: ActionType.BET },
      { playerId: 2003, phase: PhaseType.TURN, actionType: ActionType.FOLD },
      // ハンド終了行（NextActionSeat=-2）の Progress.Phase は3固定で届く。
      // これを素朴に採用するとリバー帰属になるため、進行中のストリートを使う。
      { playerId: 2001, phase: PhaseType.TURN, actionType: ActionType.FOLD }
    ])
    const handEndingRows = SAME_MS_BURST_EVENTS
      .filter((event): event is Extract<ApiEvent, { ApiTypeId: ApiType.EVT_ACTION }> =>
        event.ApiTypeId === ApiType.EVT_ACTION)
      .filter(event => event.Progress.NextActionSeat === -2)
    expect(handEndingRows.map(event => event.Progress.Phase)).toEqual([PhaseType.RIVER])

    // AF/AFq はポストフロップ限定なので、この付け替えは分母ごと動く。
    // カウンタ駆動だとポストフロップのアクションが全てプリフロップに落ち、
    // 2001 の AFq は [0,0]（機会ゼロ）、2002 の AF は [0,0] になっていた。
    const postflopAggression = (playerId: number) => Object.fromEntries(
      canonical.stats.find(player => player.playerId === playerId)!.statResults
        .filter(stat => ['af', 'afq'].includes(stat.id))
        .map(stat => [stat.id, stat.value])
    )
    expect(postflopAggression(2001)).toEqual({ af: [0, 0], afq: [0, 1] })
    expect(postflopAggression(2002)).toEqual({ af: [1, 0], afq: [1, 1] })

    // 同一ms群を時系列として会計してはならない（codex review P1）: この群では
    // ターンのアクションのあとにフロップの305が届く。後退したスナップショットを
    // 取り込むと、精算済みのターン投入40が買い足しとして戻り、2002の +40 が
    // 0 になり架空のrake 40が生まれる。
    expect(canonical.hands[0]!.winningPlayerIds).toEqual([2002])
    expect(canonical.hands[0]!.playerChipAccounting).toEqual({
      '2001': { grossPayout: 0, totalContribution: 20, netChips: -20 },
      '2002': { grossPayout: 100, totalContribution: 60, netChips: 40 },
      '2003': { grossPayout: 0, totalContribution: 20, netChips: -20 }
    })
  })

  test('a street-opening ALL_IN is normalized as a BET, not against the previous street', async () => {
    const snapshots = await replayEveryPath(STREET_OPENING_ALLIN_EVENTS)
    const canonical = snapshots.live
    expect(snapshots['entity-converter']).toEqual(canonical)
    expect(snapshots.rebuild).toEqual(canonical)
    expect(snapshots.import).toEqual(canonical)

    // 同一ms群で 304 が 305 より前に並ぶため、フロップ最初の行（この ALL_IN）を
    // 処理する時点の progress は「プリフロップ終了時点」のもので
    // NextActionTypes は空。ここを見て正規化すると CALL になってしまう。
    // ストリートの開き手が対峙するベットは存在しないので BET が正しい。
    const flopAllIn = canonical.actions.find(action => action.phase === PhaseType.FLOP)!
    expect({
      playerId: flopAllIn.playerId,
      actionType: flopAllIn.actionType,
      isAllIn: flopAllIn.actionDetails.includes(ActionDetail.ALL_IN)
    }).toEqual({ playerId: 2002, actionType: ActionType.BET, isAllIn: true })

    const aggression = Object.fromEntries(
      canonical.stats.find(player => player.playerId === 2002)!.statResults
        .filter(stat => ['af', 'afq'].includes(stat.id))
        .map(stat => [stat.id, stat.value])
    )
    expect(aggression).toEqual({ af: [1, 0], afq: [1, 1] })

    // 未コール分の返却は「ポットを勝った」ではないが、この席は争われた60も獲る。
    expect(canonical.hands[0]!.winningPlayerIds).toEqual([2002])
    expect(canonical.hands[0]!.playerChipAccounting).toEqual({
      '2001': { grossPayout: 0, totalContribution: 20, netChips: -20 },
      '2002': { grossPayout: 4040, totalContribution: 4000, netChips: 40 },
      '2003': { grossPayout: 0, totalContribution: 20, netChips: -20 }
    })
  })

  test('check-option ALL_IN hands preserve raises, bets and counters on every path', async () => {
    // 架空の各局は独立session。前局の永続化を終えてから次局へ進める。
    const sessions: ApiEvent[][] = []
    for (const event of CHECK_OPTION_ALLIN_EVENTS) {
      if (event.ApiTypeId === ApiType.EVT_ENTRY_QUEUED &&
          (sessions.length === 0 || sessions.at(-1)!.at(-1)?.ApiTypeId === ApiType.EVT_HAND_RESULTS)) sessions.push([])
      sessions.at(-1)!.push(event)
    }
    const cases: Awaited<ReturnType<typeof replay>>[] = []
    for (const events of sessions) {
      const snapshots = await replayEveryPath(events)
      expect(snapshots['entity-converter']).toEqual(snapshots.live)
      expect(snapshots.rebuild).toEqual(snapshots.live)
      expect(snapshots.import).toEqual(snapshots.live)
      cases.push(snapshots.live)
    }
    // 金額・席・街ごとの固定表で、経路一致だけでは検出できない共通誤りも止める（MUST）。
    const expectedActions = JSON.parse(readFileSync(
      join(process.cwd(), 'e2e/fixtures/hand-check-option-allin.expected.json'), 'utf8'))
    expect(cases.flatMap(snapshot => snapshot.actionEvidence.map((evidence, actionIndex) => ({
      handId: snapshot.hands[0]!.id, actionIndex, ...evidence,
    })))).toEqual(expectedActions)
    const canonical = {
      actions: cases.flatMap(snapshot => snapshot.actions),
      hands: cases.flatMap(snapshot => snapshot.hands),
      stats: cases.flatMap(snapshot => snapshot.stats),
    }

    // BB=100に対する1,000と150への増額はどちらもRAISE。フロップで
    // 対峙額0から20を出すALL_INは、最小ベット100未満でもBETになる。
    expect(canonical.actions.filter(action => action.actionDetails.includes(ActionDetail.ALL_IN))
      .map(({ playerId, phase, actionType, bet }) => ({ playerId, phase, actionType, bet })))
      .toEqual([
        { playerId: 1102, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, bet: 1000 },
        { playerId: 1202, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, bet: 150 },
        { playerId: 1301, phase: PhaseType.FLOP, actionType: ActionType.BET, bet: 20 },
        { playerId: 1402, phase: PhaseType.PREFLOP, actionType: ActionType.CALL, bet: 150 },
        { playerId: 1502, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE, bet: 400 },
        { playerId: 1702, phase: PhaseType.PREFLOP, actionType: ActionType.CALL, bet: 150 },
        { playerId: 1802, phase: PhaseType.PREFLOP, actionType: ActionType.CALL, bet: 150 },
        { playerId: 1901, phase: PhaseType.FLOP, actionType: ActionType.BET, bet: 20 },
        ...[2002, 2102, 2202, 2302, 2402, 2502].map(playerId => ({
          playerId, phase: PhaseType.PREFLOP, actionType: ActionType.CALL, bet: 150,
        })),
      ])
    const statsFor = (playerId: number) => Object.fromEntries(
      canonical.stats.find(player => player.playerId === playerId)!.statResults
        .map(stat => [stat.id, stat.value])
    )
    expect(statsFor(1102)).toMatchObject({ pfr: [1, 1] })
    expect(statsFor(1202)).toMatchObject({ pfr: [1, 1] })
    expect(statsFor(1103)).toMatchObject({ '3bet': [0, 0] })
    expect(statsFor(1203)).toMatchObject({ '3bet': [0, 0] })
    expect(statsFor(1301)).toMatchObject({ pfr: [1, 1], af: [1, 0], afq: [1, 1], cbet: [1, 1] })
    expect(statsFor(1302)).toMatchObject({ af: [0, 1], cbetFold: [0, 1] })
    // ショートコールは機会もなく、CALL+ALL_INでのショートレイズは機会を持つ。
    expect(statsFor(1402)).toMatchObject({ pfr: [0, 1], '3bet': [0, 0] })
    expect(statsFor(1502)).toMatchObject({ pfr: [1, 1], '3bet': [1, 1] })
    // レイズ不能でも、3betに対するフォールド機会は残る（MUST）。
    expect(statsFor(1503)).toMatchObject({ '3betfold': [1, 1] })
    expect(statsFor(1501)).toMatchObject({ '3betfold': [0, 1] })
    // 矛盾するメニューより実RAISEを優先し、空・別席は未知として機会を残す。
    expect(statsFor(1602)).toMatchObject({ '3bet': [1, 1] })
    expect(statsFor(1702)).toMatchObject({ '3bet': [0, 1] })
    expect(statsFor(1802)).toMatchObject({ '3bet': [0, 1] })
    expect(statsFor(1901)).toMatchObject({ pfr: [0, 1], af: [1, 0], cbet: [0, 0] })
    for (const playerId of [2002, 2102, 2202, 2302]) {
      expect(statsFor(playerId)).toMatchObject({ pfr: [0, 1], '3bet': [0, 1] })
    }
    for (const playerId of [2402, 2502]) {
      expect(statsFor(playerId)).toMatchObject({ pfr: [0, 1], '3bet': [0, 0] })
    }
    expect(canonical.hands).toHaveLength(15)
    expect(canonical.hands.every(hand =>
      Object.values(hand.playerChipAccounting!).every(accounting => accounting !== null)
    )).toBe(true)
  })

  test('a Ring mid-hand rebuy keeps exact winners and net chips (#339)', async () => {
    const snapshots = await replayEveryPath(RING_REBUY_EVENTS)
    const canonical = snapshots.live
    expect(snapshots['entity-converter']).toEqual(canonical)
    expect(snapshots.rebuild).toEqual(canonical)
    expect(snapshots.import).toEqual(canonical)

    // 卓の合計チップはディール(10,000)からリザルト(12,015)へ +2,015 増える。
    // 従来の「Ringはチップ生成を拒否」ルールでは settlement 全体が
    // unresolved() へ落ち winningPlayerIds が空になっていた。
    expect(canonical.hands).toHaveLength(1)
    expect(canonical.hands[0]!.winningPlayerIds).toEqual([2001])
    expect(canonical.hands[0]!.playerChipAccounting).toEqual({
      // ヒーロー: 20(プリフロップコール) + 100(フロップベット) を投じて145回収。
      '2001': { grossPayout: 145, totalContribution: 120, netChips: 25 },
      // ハンド中に +2,000 買い足した席。買い足しは「このハンドの結果」ではない。
      '2002': { grossPayout: 0, totalContribution: 10, netChips: -10 },
      // 終了スタックにだけ現れる +20 の自動買い足し（バイイン上限への復帰）。
      '2003': { grossPayout: 0, totalContribution: 20, netChips: -20 }
    })
  })

  test('Ringの席交代をlive・EC・Lake再構築・importから直近ハンドまで同じ人物で会計する', async () => {
    const snapshots = await replayEveryPath(RING_REPLACEMENT_EVENTS)
    const canonical = snapshots.live
    expect(snapshots['entity-converter']).toEqual(canonical)
    expect(snapshots.rebuild).toEqual(canonical)
    expect(snapshots.import).toEqual(canonical)
    expect(canonical.hands[0]!.winningPlayerIds).toEqual([3104])
    expect(canonical.hands[0]!.playerChipAccounting!['3101']).toEqual({ grossPayout: 0, totalContribution: 0, netChips: 0 })
    expect(canonical.recent).toEqual([
      { playerId: 3101, hands: [{ netChips: 0 }] },
      { playerId: 3103, hands: [{ netChips: -25 }] },
      { playerId: 3104, hands: [{ netChips: 25 }] },
      { playerId: 3105, hands: [] },
    ])

    const staleBundle = structuredClone({ hands: canonical.hands, phases: canonical.phases, actions: canonical.actions })
    staleBundle.hands[0]!.winningPlayerIds = []
    staleBundle.hands[0]!.playerChipAccounting!['3101'] = { grossPayout: 0, totalContribution: 541, netChips: -541 }
    expect(await replay('rebuild', RING_REPLACEMENT_EVENTS, undefined, staleBundle)).toEqual(canonical)
  })

  test('交代後snapshotとactionを旧人へ付けず、次DEALでは新しい人物として記録する', async () => {
    const events = structuredClone(RING_REPLACEMENT_EVENTS)
    const deal = events.find(event => event.ApiTypeId === ApiType.EVT_DEAL)!
    const results = events.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)!
    const fold = events.find(event => event.ApiTypeId === ApiType.EVT_ACTION)!
    const newSeatAction = structuredClone(fold)
    Object.assign(newSeatAction, { timestamp: 1733100006100, Chip: 2900, BetChip: 50, ActionType: ActionType.CALL })
    const flop: ApiEvent<ApiType.EVT_DEAL_ROUND> = {
      ApiTypeId: ApiType.EVT_DEAL_ROUND, timestamp: 1733100006200,
      CommunityCards: [0, 1, 2], Progress: { ...deal.Progress, MinRaise: 0, NextActionTypes: [ActionType.CHECK, ActionType.ALL_IN, ActionType.BET], Phase: 1 },
      Player: { ...deal.Player!, BetChip: 0, BetStatus: 2 },
      OtherPlayers: deal.OtherPlayers.map(player => ({
        ...player, Status: 0, BetChip: 0, Chip: player.SeatIndex === 0 ? 2900 : player.Chip,
        BetStatus: player.SeatIndex === 0 || player.SeatIndex === 5 ? 1 : 2,
      })),
    }
    events.splice(events.indexOf(results), 0, newSeatAction, flop)
    const nextHand = structuredClone(RING_REPLACEMENT_EVENTS.slice(2).filter(event => event.ApiTypeId !== ApiType.EVT_PLAYER_JOIN))
    for (const event of nextHand) {
      event.timestamp = event.timestamp! + 10000
      if (event.ApiTypeId === ApiType.EVT_DEAL) {
        event.SeatUserIds[0] = 3105
        event.OtherPlayers.find(player => player.SeatIndex === 0)!.Chip = 2950
      } else if (event.ApiTypeId === ApiType.EVT_ACTION && event.SeatIndex === 0) {
        event.Chip = 2950
      } else if (event.ApiTypeId === ApiType.EVT_HAND_RESULTS) {
        event.HandId += 1
      }
    }
    events.push(...nextHand)
    for (const event of events) expect(apiEventSchemas[event.ApiTypeId].safeParse(event).success).toBe(true)
    const snapshots = await replayEveryPath(events)
    const canonical = snapshots.live
    expect(snapshots['entity-converter']).toEqual(canonical)
    expect(snapshots.rebuild).toEqual(canonical)
    expect(snapshots.import).toEqual(canonical)
    expect(canonical.hands).toHaveLength(2)
    expect(canonical.actions.filter(action => action.playerId === 3101)).toHaveLength(1)
    expect(canonical.actions.filter(action => action.playerId === 3105)).toHaveLength(1)
    expect(canonical.phases.find(phase => phase.phase === PhaseType.FLOP)!.seatUserIds).toEqual([3104])
    expect(canonical.hands[0]!.playerChipAccounting!['3101']).toBeNull()
    expect(canonical.hands[0]!.winningPlayerIds).toEqual([])
    expect(canonical.hands[1]!.seatUserIds[0]).toBe(3105)
    expect(canonical.hands[1]!.winningPlayerIds).toEqual([3104])
  })

  test.each([
    [ApiType.EVT_DEAL, true], [ApiType.EVT_DEAL, false],
    [ApiType.EVT_ACTION, true], [ApiType.EVT_ACTION, false],
    [ApiType.EVT_HAND_RESULTS, true], [ApiType.EVT_HAND_RESULTS, false],
  ])('301と%sが同一msでbefore=%sでも全経路で同じunknownを永続化する', async (kind, before) => {
    const events = structuredClone(RING_REPLACEMENT_EVENTS)
    const join = events.find(event => event.ApiTypeId === ApiType.EVT_PLAYER_JOIN)!
    const target = events.find(event => event.ApiTypeId === kind)!
    join.timestamp = target.timestamp
    events.splice(events.indexOf(join), 1)
    events.splice(events.indexOf(target) + (before ? 0 : 1), 0, join)
    for (const event of events) expect(apiEventSchemas[event.ApiTypeId].safeParse(event).success).toBe(true)
    const snapshots = await replayEveryPath(events)
    const canonical = snapshots.live
    for (const snapshot of Object.values(snapshots)) {
      expect(snapshot.hands).toEqual(canonical.hands)
      expect(snapshot.actions).toEqual(canonical.actions)
      expect(snapshot.phases).toEqual(canonical.phases)
      expect(snapshot.stats).toEqual(canonical.stats)
    }
    expect(canonical.hands).toHaveLength(1)
    expect(canonical.hands[0]!.playerChipAccounting!['3101']).toBeNull()
    expect(canonical.hands[0]!.winningPlayerIds).toEqual([])
  })

  test.each([true, false])('他席304または305との同一ms301 before=%sを全経路でunknownにする', async before => {
    for (const kind of [ApiType.EVT_ACTION, ApiType.EVT_DEAL_ROUND]) {
      const events = structuredClone(RING_REPLACEMENT_EVENTS)
      const deal = events.find(event => event.ApiTypeId === ApiType.EVT_DEAL)!
      const join = events.find(event => event.ApiTypeId === ApiType.EVT_PLAYER_JOIN)!
      const results = events.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)!
      const otherAction = events.find(event => event.ApiTypeId === ApiType.EVT_ACTION && event.SeatIndex === 2)!
      const round: ApiEvent<ApiType.EVT_DEAL_ROUND> = {
        ApiTypeId: ApiType.EVT_DEAL_ROUND, timestamp: 1733100006100,
        CommunityCards: [0, 1, 2], Progress: { ...deal.Progress, MinRaise: 0, Phase: 1, NextActionTypes: [ActionType.CHECK, ActionType.ALL_IN, ActionType.BET] },
        Player: { ...deal.Player!, BetChip: 0, BetStatus: 2 },
        OtherPlayers: deal.OtherPlayers.map(player => ({ ...player, Status: 0, BetChip: 0, BetStatus: 2 })),
      }
      if (kind === ApiType.EVT_DEAL_ROUND) events.splice(events.indexOf(results), 0, round)
      const target = kind === ApiType.EVT_ACTION ? otherAction : round
      join.timestamp = target.timestamp
      events.splice(events.indexOf(join), 1)
      events.splice(events.indexOf(target) + (before ? 0 : 1), 0, join)
      for (const event of events) expect(apiEventSchemas[event.ApiTypeId].safeParse(event).success).toBe(true)
      const snapshots = await replayEveryPath(events)
      for (const snapshot of Object.values(snapshots)) {
        expect(snapshot.hands).toEqual(snapshots.live.hands)
        expect(snapshot.actions).toEqual(snapshots.live.actions)
        expect(snapshot.phases).toEqual(snapshots.live.phases)
        expect(snapshot.stats).toEqual(snapshots.live.stats)
        expect(snapshot.hands[0]!.playerChipAccounting!['3101']).toBeNull()
        expect(snapshot.hands[0]!.winningPlayerIds).toEqual([])
      }
    }
  })

  test('ECはchunk終端306を保留し、後着同ms301を次時刻または最終flushで一度だけ確定する', () => {
    for (const finishByFlush of [true, false]) {
      const events = structuredClone(RING_REPLACEMENT_EVENTS)
      const join = events.find(event => event.ApiTypeId === ApiType.EVT_PLAYER_JOIN)!
      const result = events.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)!
      join.timestamp = result.timestamp
      const converter = new EntityConverter({ players: new Map(), reset() {} })
      expect(converter.convertEventChunk(events.filter(event => event !== join)).hands).toHaveLength(0)
      expect(converter.convertEventChunk([join]).hands).toHaveLength(0)
      const finished = finishByFlush ? converter.flush() : converter.convertEventChunk([
        { ApiTypeId: ApiType.EVT_SESSION_DETAILS, timestamp: result.timestamp! + 1, Name: 'next session' } as ApiEvent,
      ])
      expect(finished.hands).toHaveLength(1)
      expect(finished.hands[0]!.playerChipAccounting!['3101']).toBeNull()
      expect(converter.flush().hands).toHaveLength(0)
    }
  })

  test('EntityConverter preserves the live SessionState seed for a prelude-free incremental window', async () => {
    expect(SEEDED_HAND_WINDOW.some(event => event.ApiTypeId === ApiType.EVT_ENTRY_QUEUED)).toBe(false)
    expect(SEEDED_HAND_WINDOW.some(event => event.ApiTypeId === ApiType.EVT_SESSION_DETAILS)).toBe(false)
    expect(SEEDED_HAND_WINDOW.some(event => event.ApiTypeId === ApiType.EVT_PLAYER_SEAT_ASSIGNED)).toBe(false)

    // Full-Lake rebuild/import intentionally begin from unknown session state
    // and recover context from their own 201/308/313 rows; seeding them with
    // the currently-running (latest) session would misattribute an older
    // boundary-less first hand. The incremental EntityConverter entry point,
    // however, must clone the live SessionState getters explicitly.
    const canonical = await replay('live', SEEDED_HAND_WINDOW, FIXTURE_SESSION_SEED)
    const converted = await replay('entity-converter', SEEDED_HAND_WINDOW, FIXTURE_SESSION_SEED)

    expect(converted).toEqual(canonical)
    expect(canonical.hands).toHaveLength(3)
    expect(canonical.hands.every(hand =>
      hand.session.id === FIXTURE_SESSION_SEED.id &&
      hand.session.battleType === FIXTURE_SESSION_SEED.battleType &&
      hand.session.name === FIXTURE_SESSION_SEED.name
    )).toBe(true)
  })
})

/** 人物の帰属可否と、卓の進行・ハンド所有metadataを別々に検証する。 */
describe('seat boundary preserves table progression and hand metadata', () => {
  test.each([false, true])('交代席の304が開いたFLOPを後続FOLDへ伝える（late305=%s）', async lateRound => {
    const source = structuredClone(RING_REPLACEMENT_EVENTS)
    const deal = source.find(event => event.ApiTypeId === ApiType.EVT_DEAL)!
    const old0 = source.find((event): event is ApiEvent<ApiType.EVT_ACTION> => event.ApiTypeId === ApiType.EVT_ACTION && event.SeatIndex === 0)!
    const old2 = source.find((event): event is ApiEvent<ApiType.EVT_ACTION> => event.ApiTypeId === ApiType.EVT_ACTION && event.SeatIndex === 2)!
    const boundary = source.find(event => event.ApiTypeId === ApiType.EVT_PLAYER_JOIN)!
    const ending = source.find((event): event is ApiEvent<ApiType.EVT_ACTION> => event.ApiTypeId === ApiType.EVT_ACTION && event.SeatIndex === 3)!
    const result = source.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)!
    const timestamp = 1733100006000
    const opening = structuredClone(old0)
    Object.assign(opening, { timestamp, sequence: 0, SeatIndex: 0, ActionType: ActionType.BET, Chip: 2850, BetChip: 100,
      Progress: { ...opening.Progress, Phase: 1, Pot: 175, NextActionSeat: 5, NextActionTypes: [2, 3, 4, 5] } })
    Object.assign(ending, { timestamp, sequence: 1, SeatIndex: 5, ActionType: ActionType.FOLD, Chip: 4875, BetChip: 0,
      Progress: { ...ending.Progress, Phase: 3, Pot: 175, NextActionSeat: -2, NextActionTypes: [] } })
    const round: ApiEvent<ApiType.EVT_DEAL_ROUND> = {
      ApiTypeId: ApiType.EVT_DEAL_ROUND, timestamp, CommunityCards: [0, 1, 2],
      Progress: { ...deal.Progress, Phase: 1, Pot: 75, MinRaise: 0, NextActionSeat: 0, NextActionTypes: [0, 1, 5] },
      Player: { ...deal.Player!, BetChip: 0, BetStatus: 1 },
      OtherPlayers: deal.OtherPlayers.map(player => ({ ...player, Status: 0, BetChip: 0, BetStatus: player.SeatIndex === 0 || player.SeatIndex === 5 ? 1 : 2 })),
    }
    const events = [...source.slice(0, 2), deal, old0, old2, boundary, opening, ending, ...(lateRound ? [round] : []), result]
    // 交代席のFLOPを見落とすと、BBのblind精算が説明不能な減少になり流入全体がnullへ落ちる。
    expect(deriveMidHandChipInflow(deal, result, [deal, old0, old2, boundary, opening, ending, ...(lateRound ? [round] : []), result], BattleType.RING_GAME)?.get(5)).toBe(0)
    for (const event of events) expect(apiEventSchemas[event.ApiTypeId].safeParse(event).success).toBe(true)
    const snapshots = await replayEveryPath(events)
    for (const snapshot of Object.values(snapshots)) {
      expect(snapshot).toEqual(snapshots.live)
      expect(snapshot.actions.map(({ playerId, phase }) => ({ playerId, phase }))).toEqual([
        { playerId: 3101, phase: PhaseType.PREFLOP },
        { playerId: 3102, phase: PhaseType.PREFLOP },
        { playerId: 3104, phase: PhaseType.FLOP },
      ])
      expect(snapshot.hands[0]!.playerChipAccounting!['3101']).toBeNull()
      expect(snapshot.hands[0]!.playerChipAccounting!['3104']).toEqual({ grossPayout: 75, totalContribution: 50, netChips: 25 })
      const stats = Object.fromEntries(snapshot.stats.find(player => player.playerId === 3104)!.statResults.map(stat => [stat.id, stat.value]))
      // BBにpreflop actionはないので、既存walk除外契約ではPFR機会0。FOLDはFLOPのAFq分母。
      expect(stats).toMatchObject({ af: [0, 0], afq: [0, 1], pfr: [0, 0] })
      expect(snapshot.phases.map(phase => phase.phase)).toEqual(lateRound ? [PhaseType.PREFLOP, PhaseType.FLOP] : [PhaseType.PREFLOP])
    }
  })

  test.each([
    { offset: 0, before: false }, { offset: 0, before: true }, { offset: 1, before: false },
  ])('完成ハンドと次DEALのsessionを独立に保つ %j', async ({ offset, before }) => {
    const events = structuredClone(RING_REPLACEMENT_EVENTS)
    const entry = events.find(event => event.ApiTypeId === ApiType.EVT_ENTRY_QUEUED)!
    entry.Id = 'OLD_ID'
    const deal = events.find(event => event.ApiTypeId === ApiType.EVT_DEAL)!
    const result = events.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)!
    const oldDetails = { ...structuredClone(detailsEvent), Name: 'OLD_SESSION', timestamp: entry.timestamp! + 1 }
    events.splice(1, 0, oldDetails)
    const nextEntry = { ...structuredClone(entry), Id: 'NEXT_ID', timestamp: result.timestamp! + offset }
    const nextDetails = { ...structuredClone(detailsEvent), Name: 'NEXT_SESSION', timestamp: result.timestamp! + offset }
    events.splice(events.indexOf(result) + Number(!before), 0, nextEntry, nextDetails)
    // 完成後301の再評価でも、次のsessionを旧ハンドへ遡及適用しない。
    if (offset === 0) {
      const boundary = events.find(event => event.ApiTypeId === ApiType.EVT_PLAYER_JOIN)!
      events.splice(events.indexOf(boundary), 1)
      boundary.timestamp = result.timestamp
      events.push(boundary)
    }
    const nextHand = structuredClone(RING_REPLACEMENT_EVENTS.slice(2).filter(event => event.ApiTypeId !== ApiType.EVT_PLAYER_JOIN))
    for (const event of nextHand) {
      event.timestamp = event.timestamp! + 10000
      if (event.ApiTypeId === ApiType.EVT_HAND_RESULTS) event.HandId++
    }
    events.push(...nextHand)
    for (const event of events) expect(apiEventSchemas[event.ApiTypeId].safeParse(event).success).toBe(true)
    const snapshots = await replayEveryPath(events)
    for (const snapshot of Object.values(snapshots)) {
      expect(snapshot.hands.map(hand => hand.session)).toEqual([
        { id: 'OLD_ID', battleType: BattleType.RING_GAME, name: 'OLD_SESSION' },
        { id: 'NEXT_ID', battleType: BattleType.RING_GAME, name: 'NEXT_SESSION' },
      ])
      expect(snapshot.hands[0]!.approxTimestamp).toBe(deal.timestamp)
      expect(snapshot.hands).toEqual(snapshots.live.hands)
      expect(snapshot.actions).toEqual(snapshots.live.actions)
      expect(snapshot.stats).toEqual(snapshots.live.stats)
    }
  })
})
