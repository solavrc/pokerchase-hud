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
import { EntityConverter } from './entity-converter'
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
/** 同一ms群で、新ストリート最初の行が ALL_IN になるケース（codex review round 3）。 */
const STREET_OPENING_ALLIN_EVENTS = readFixture('hand-street-opening-allin.ndjson')

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

const replay = async (path: ReplayPath, events: ApiEvent[], seed?: SessionSeed) => {
  setOperationState({ type: 'idle' })
  await chrome.storage.local.remove(PokerChaseService.STORAGE_KEY)

  const db = new PokerChaseDB(indexedDB, IDBKeyRange)
  await db.open()
  const service = trackServiceForTeardown(new PokerChaseService({ db }))
  await service.ready
  applySessionSeed(service, seed)

  // Import/rebuild progress delivery and post-import tab refresh are
  // best-effort production side effects, not part of the data invariant.
  ;(chrome.runtime.sendMessage as jest.Mock).mockReturnValue(Promise.resolve())
  ;(chrome.tabs.query as jest.Mock).mockImplementation((_query, callback) => callback([]))

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

    return await takeCanonicalSnapshot(service, db)
  } finally {
    // replay() は1テスト内で4経路ぶん連続で呼ばれる。ルート afterEach
    // （test-service-teardown.ts）の取り消しはテスト終了時なので、ここで
    // 明示的に取り消さないと、直前の経路のインスタンスの500msタイマーが
    // 次の経路の `await service.ready`（restoreState()）より前に発火し、
    // 前の経路の playerId/session を次の経路へ持ち込んでしまう。
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
