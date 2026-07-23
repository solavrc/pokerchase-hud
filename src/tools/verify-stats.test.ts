/**
 * Smoke test for the verify-stats harness's plumbing: runs the real
 * pipeline (EntityConverter + StatDefinition.calculate) and the
 * independent oracle over a tiny inline three-player hand fixture (NOT the
 * 140MB real capture -- that is exercised manually via
 * `npm run verify-stats -- <file.ndjson>`) and checks that:
 *  - both sides produce the same per-stat fractions for a hand-crafted hand
 *    with a known preflop raise, a continuation bet + fold, and a showdown
 *  - compareResults/formatReport correctly report a mismatch when one side's
 *    stat is deliberately perturbed
 *  - a missing/non-fraction stat on one side is counted as a mismatch (not
 *    silently skipped), with a distinct `missing` counter
 *  - eligibility is the union of both sides, so a player entirely absent
 *    from one side still surfaces as a mismatch instead of vanishing
 *
 * This exercises the same code path `npm run verify-stats` uses, just
 * against a fixture small enough for CI instead of a real ndjson export.
 */
import { runPipeline } from './verify-stats/pipeline'
import { runOracle } from './verify-stats/oracle'
import { compareResults, formatReport } from './verify-stats/compare'
import { ApiType, apiEventSchemas } from '../types/api'
import { ActionType, BattleType, BetStatusType, PhaseType, RankType } from '../types/game'
import type { ApiEvent } from '../types'

// Mirrors the createEvent() helper in entity-converter.test.ts: parses through
// the real zod schema so the fixture is a realistic, schema-valid event.
function createEvent<T extends ApiType>(apiType: T, data: Omit<ApiEvent<T>, 'ApiTypeId'>): ApiEvent<T> {
  const eventData = { ...data, ApiTypeId: apiType }
  const schema = apiEventSchemas[apiType]
  if (!schema) throw new Error(`No schema found for ApiType: ${apiType}`)
  return schema.parse(eventData) as ApiEvent<T>
}

const PLAYER_A = 100 // BTN/raiser, c-bets flop
const PLAYER_B = 101 // BB, calls preflop, folds to c-bet
const PLAYER_C = 102 // SB, folds preflop

function buildHandEvents(): ApiEvent[] {
  return [
    createEvent(ApiType.EVT_DEAL, {
      timestamp: 1000,
      // 4-seat table (schema minimum) with one empty seat, to also exercise
      // empty-seat handling in position derivation.
      SeatUserIds: [PLAYER_C, PLAYER_B, PLAYER_A, -1],
      Game: {
        CurrentBlindLv: 1,
        NextBlindUnixSeconds: -1,
        Ante: 0,
        SmallBlind: 10,
        BigBlind: 20,
        ButtonSeat: 2,
        SmallBlindSeat: 0,
        BigBlindSeat: 1
      },
      Player: { SeatIndex: 2, BetStatus: 1, HoleCards: [0, 1], Chip: 980, BetChip: 0 },
      Progress: {
        Phase: 0,
        NextActionSeat: 2,
        NextActionTypes: [ActionType.FOLD, ActionType.CALL, ActionType.RAISE, ActionType.ALL_IN],
        NextExtraLimitSeconds: 15,
        MinRaise: 40,
        Pot: 30,
        SidePot: []
      },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 990, BetChip: 10 },
        { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 980, BetChip: 20 }
      ]
    }),
    // BTN (PLAYER_A) raises preflop.
    createEvent(ApiType.EVT_ACTION, {
      timestamp: 1001,
      SeatIndex: 2,
      ActionType: ActionType.RAISE,
      Chip: 920,
      BetChip: 60,
      Progress: {
        Phase: 0,
        NextActionSeat: 0,
        NextActionTypes: [ActionType.FOLD, ActionType.CALL, ActionType.RAISE, ActionType.ALL_IN],
        NextExtraLimitSeconds: 15,
        MinRaise: 100,
        Pot: 90,
        SidePot: []
      }
    }),
    // SB (PLAYER_C) folds.
    createEvent(ApiType.EVT_ACTION, {
      timestamp: 1002,
      SeatIndex: 0,
      ActionType: ActionType.FOLD,
      Chip: 990,
      BetChip: 10,
      Progress: {
        Phase: 0,
        NextActionSeat: 1,
        NextActionTypes: [ActionType.FOLD, ActionType.CALL, ActionType.RAISE, ActionType.ALL_IN],
        NextExtraLimitSeconds: 15,
        MinRaise: 100,
        Pot: 90,
        SidePot: []
      }
    }),
    // BB (PLAYER_B) calls.
    createEvent(ApiType.EVT_ACTION, {
      timestamp: 1003,
      SeatIndex: 1,
      ActionType: ActionType.CALL,
      Chip: 920,
      BetChip: 60,
      Progress: {
        Phase: 0,
        NextActionSeat: -1,
        NextActionTypes: [],
        NextExtraLimitSeconds: 0,
        MinRaise: 0,
        Pot: 150,
        SidePot: []
      }
    }),
    // Flop deal-round: PLAYER_C folded preflop so is not BET_ABLE here.
    createEvent(ApiType.EVT_DEAL_ROUND, {
      timestamp: 1004,
      CommunityCards: [10, 20, 30],
      Progress: {
        Phase: 1,
        NextActionSeat: 1,
        NextActionTypes: [ActionType.CHECK, ActionType.BET, ActionType.ALL_IN],
        NextExtraLimitSeconds: 15,
        MinRaise: 0,
        Pot: 150,
        SidePot: []
      },
      Player: { SeatIndex: 2, BetStatus: 1, HoleCards: [0, 1], Chip: 920, BetChip: 0 },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: 2, Chip: 990, BetChip: 0 },
        { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 920, BetChip: 0 }
      ]
    }),
    // BB checks.
    createEvent(ApiType.EVT_ACTION, {
      timestamp: 1005,
      SeatIndex: 1,
      ActionType: ActionType.CHECK,
      Chip: 920,
      BetChip: 0,
      Progress: {
        Phase: 1,
        NextActionSeat: 2,
        NextActionTypes: [ActionType.CHECK, ActionType.BET, ActionType.ALL_IN],
        NextExtraLimitSeconds: 15,
        MinRaise: 0,
        Pot: 150,
        SidePot: []
      }
    }),
    // BTN c-bets the flop.
    createEvent(ApiType.EVT_ACTION, {
      timestamp: 1006,
      SeatIndex: 2,
      ActionType: ActionType.BET,
      Chip: 820,
      BetChip: 100,
      Progress: {
        Phase: 1,
        NextActionSeat: 1,
        NextActionTypes: [ActionType.FOLD, ActionType.CALL, ActionType.RAISE, ActionType.ALL_IN],
        NextExtraLimitSeconds: 15,
        MinRaise: 200,
        Pot: 250,
        SidePot: []
      }
    }),
    // BB folds to the c-bet.
    createEvent(ApiType.EVT_ACTION, {
      timestamp: 1007,
      SeatIndex: 1,
      ActionType: ActionType.FOLD,
      Chip: 920,
      BetChip: 0,
      Progress: {
        Phase: 1,
        NextActionSeat: -2,
        NextActionTypes: [],
        NextExtraLimitSeconds: 0,
        MinRaise: 0,
        Pot: 250,
        SidePot: []
      }
    }),
    createEvent(ApiType.EVT_HAND_RESULTS, {
      timestamp: 1008,
      HandId: 999001,
      CommunityCards: [10, 20, 30],
      Pot: 250,
      SidePot: [],
      ResultType: 0,
      DefeatStatus: 0,
      Player: { SeatIndex: 2, BetStatus: -1, Chip: 1070, BetChip: 0 },
      Results: [
        { UserId: PLAYER_A, HoleCards: [], RankType: 10, Hands: [], HandRanking: -1, Ranking: -2, RewardChip: 250 }
      ],
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: -1, Chip: 990, BetChip: 0 },
        { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 920, BetChip: 0 }
      ]
    })
  ]
}

describe('verify-stats harness', () => {
  it('pipeline and oracle agree on every stat for a hand-crafted hand', async () => {
    const events = buildHandEvents()

    const pipeline = await runPipeline(events)
    const oracle = runOracle(events)

    // Sanity: both sides saw the same three players.
    expect([...pipeline.keys()].sort()).toEqual([PLAYER_A, PLAYER_B, PLAYER_C].sort())
    expect([...oracle.keys()].sort()).toEqual([PLAYER_A, PLAYER_B, PLAYER_C].sort())

    const report = compareResults(pipeline, oracle, /* minHands */ 1)
    expect(report.eligiblePlayers).toBe(3)

    const failing = report.stats.filter(s => s.total > 0 && s.mismatches.length > 0)
    expect(failing).toEqual([])

    // Spot-check a couple of concrete values so a broken fixture doesn't
    // silently pass just because both sides are equally wrong.
    expect(pipeline.get(PLAYER_A)?.stats['cbet']).toEqual([1, 1]) // c-bet executed, one chance
    expect(oracle.get(PLAYER_A)?.stats.cbet).toEqual([1, 1])
    expect(pipeline.get(PLAYER_B)?.stats['cbetFold']).toEqual([1, 1]) // folded to the c-bet
    expect(oracle.get(PLAYER_B)?.stats.cbetFold).toEqual([1, 1])
    // PLAYER_C folded preflop, never reached the flop.
    expect(pipeline.get(PLAYER_C)?.stats['wtsd']).toEqual([0, 0])
    expect(oracle.get(PLAYER_C)?.stats.wtsd).toEqual([0, 0])
  })

  it('formatReport surfaces a mismatch when one side disagrees', () => {
    const pipeline = new Map([
      [PLAYER_A, { playerId: PLAYER_A, hands: 60, stats: { vpip: [30, 60] } }],
    ])
    const oracle = new Map([
      [PLAYER_A, { playerId: PLAYER_A, hands: 60, stats: { vpip: [29, 60] as [number, number] } }],
    ])

    const report = compareResults(pipeline as any, oracle as any, 50)
    const vpip = report.stats.find(s => s.stat === 'vpip')!
    expect(vpip.total).toBe(1)
    expect(vpip.agree).toBe(0)
    expect(vpip.pct).toBe(0)
    expect(vpip.mismatches).toHaveLength(1)
    expect(vpip.mismatches[0]).toMatchObject({ playerId: PLAYER_A, dNum: 1, dDen: 0 })

    const rendered = formatReport(report)
    expect(rendered).toContain('Mismatches for vpip')
    expect(rendered).toContain(`player ${PLAYER_A}`)
  })

  it('oracle infers one omitted tournament result snapshot and keeps a net-loss side-pot winner', async () => {
    const events = [
      { ApiTypeId: ApiType.EVT_ENTRY_QUEUED, timestamp: 2000, BattleType: BattleType.SIT_AND_GO, Code: 0, Id: 'test', IsRetire: false },
      {
        ApiTypeId: ApiType.EVT_DEAL,
        timestamp: 2001,
        SeatUserIds: [201, 202, 203, -1],
        Game: { Ante: 0, SmallBlind: 1, BigBlind: 2, ButtonSeat: 0, SmallBlindSeat: 1, BigBlindSeat: 2 },
        Player: { SeatIndex: 0, BetStatus: BetStatusType.BET_ABLE, Chip: 100, BetChip: 0 },
        OtherPlayers: [
          { SeatIndex: 1, BetStatus: BetStatusType.BET_ABLE, Chip: 100, BetChip: 0 },
          { SeatIndex: 2, BetStatus: BetStatusType.BET_ABLE, Chip: 100, BetChip: 0 },
        ],
        Progress: { Phase: PhaseType.PREFLOP, NextActionTypes: [], Pot: 0, SidePot: [] },
      },
      {
        ApiTypeId: ApiType.EVT_DEAL_ROUND,
        timestamp: 2002,
        CommunityCards: [0, 4, 8],
        Player: { SeatIndex: 0, BetStatus: BetStatusType.ALL_IN, Chip: 10, BetChip: 0 },
        OtherPlayers: [
          { SeatIndex: 1, BetStatus: BetStatusType.ALL_IN, Chip: 0, BetChip: 0 },
          { SeatIndex: 2, BetStatus: BetStatusType.ALL_IN, Chip: 0, BetChip: 0 },
        ],
        Progress: { Phase: PhaseType.FLOP, NextActionTypes: [], Pot: 270, SidePot: [20] },
      },
      {
        ApiTypeId: ApiType.EVT_HAND_RESULTS,
        timestamp: 2003,
        HandId: 999002,
        CommunityCards: [12, 16],
        Pot: 270,
        SidePot: [20],
        Results: [
          { UserId: 201, RankType: RankType.ONE_PAIR, HandRanking: 1, RewardChip: 270 },
          { UserId: 202, RankType: RankType.HIGH_CARD, HandRanking: 2, RewardChip: 20 },
          { UserId: 203, RankType: RankType.HIGH_CARD, HandRanking: -1, RewardChip: 0 },
        ],
        Player: { SeatIndex: 0, BetStatus: BetStatusType.HAND_ENDED, Chip: 280, BetChip: 0 },
        // seat 1 (the side-pot winner) is intentionally omitted.
        OtherPlayers: [
          { SeatIndex: 2, BetStatus: BetStatusType.HAND_ENDED, Chip: 0, BetChip: 0 },
        ],
      },
    ] as unknown as ApiEvent[]

    const pipeline = await runPipeline(events)
    const oracle = runOracle(events)

    expect(pipeline.get(202)?.stats.wwsf).toEqual([1, 1])
    expect(oracle.get(202)?.stats.wwsf).toEqual([1, 1])
  })

  it('oracle re-derives a short ante all-in tier instead of treating the returned excess as a win', async () => {
    const events = [
      { ApiTypeId: ApiType.EVT_ENTRY_QUEUED, timestamp: 3000, BattleType: BattleType.SIT_AND_GO, Code: 0, Id: 'test', IsRetire: false },
      {
        ApiTypeId: ApiType.EVT_DEAL,
        timestamp: 3001,
        SeatUserIds: [301, 302, -1, -1],
        Game: { Ante: 100, SmallBlind: 1, BigBlind: 2, ButtonSeat: 0, SmallBlindSeat: 0, BigBlindSeat: 1 },
        Player: { SeatIndex: 0, BetStatus: BetStatusType.ALL_IN, Chip: 0, BetChip: 0 },
        OtherPlayers: [
          { SeatIndex: 1, BetStatus: BetStatusType.BET_ABLE, Chip: 100, BetChip: 0 },
        ],
        Progress: { Phase: PhaseType.PREFLOP, NextActionTypes: [], Pot: 60, SidePot: [70] },
      },
      {
        ApiTypeId: ApiType.EVT_DEAL_ROUND,
        timestamp: 3002,
        CommunityCards: [0, 4, 8],
        Player: { SeatIndex: 0, BetStatus: BetStatusType.ALL_IN, Chip: 0, BetChip: 0 },
        OtherPlayers: [
          { SeatIndex: 1, BetStatus: BetStatusType.BET_ABLE, Chip: 80, BetChip: 20 },
        ],
        Progress: { Phase: PhaseType.FLOP, NextActionTypes: [], Pot: 60, SidePot: [90] },
      },
      {
        ApiTypeId: ApiType.EVT_HAND_RESULTS,
        timestamp: 3003,
        HandId: 999003,
        CommunityCards: [12, 16],
        Pot: 60,
        SidePot: [90],
        Results: [
          { UserId: 301, RankType: RankType.ONE_PAIR, HandRanking: 1, RewardChip: 60 },
          { UserId: 302, RankType: RankType.HIGH_CARD, HandRanking: 2, RewardChip: 90 },
        ],
        Player: { SeatIndex: 0, BetStatus: BetStatusType.HAND_ENDED, Chip: 60, BetChip: 0 },
        OtherPlayers: [
          { SeatIndex: 1, BetStatus: BetStatusType.HAND_ENDED, Chip: 170, BetChip: 0 },
        ],
      },
    ] as unknown as ApiEvent[]

    const pipeline = await runPipeline(events)
    const oracle = runOracle(events)

    expect(pipeline.get(301)?.stats.wwsf).toEqual([1, 1])
    expect(oracle.get(301)?.stats.wwsf).toEqual([1, 1])
    expect(pipeline.get(302)?.stats.wwsf).toEqual([0, 1])
    expect(oracle.get(302)?.stats.wwsf).toEqual([0, 1])
  })

  it('counts a missing/non-fraction stat as a mismatch, not a silent skip', () => {
    // Pipeline-side vpip resolved to scalar 0 (mirrors StatsRegistry's catch
    // handler reducing a thrown StatDefinition.calculate to `0`) while the
    // oracle has a legitimate fraction. A `continue`-based skip would drop
    // this player from `total` entirely and let the stat report 100%
    // agreement despite the divergence; hardened compareResults must count
    // it as a mismatch with `missing: true` and expose a distinct `missing`
    // counter on the StatAgreement.
    const pipeline = new Map([
      [PLAYER_A, { playerId: PLAYER_A, hands: 60, stats: { vpip: 0 } }],
    ])
    const oracle = new Map([
      [PLAYER_A, { playerId: PLAYER_A, hands: 60, stats: { vpip: [30, 60] as [number, number] } }],
    ])

    const report = compareResults(pipeline as any, oracle as any, 50)
    const vpip = report.stats.find(s => s.stat === 'vpip')!
    expect(vpip.total).toBe(1)
    expect(vpip.agree).toBe(0)
    expect(vpip.missing).toBe(1)
    expect(vpip.pct).toBe(0)
    expect(vpip.mismatches).toHaveLength(1)
    expect(vpip.mismatches[0]).toMatchObject({ playerId: PLAYER_A, missing: true, pipeline: undefined, oracle: [30, 60] })

    const rendered = formatReport(report)
    expect(rendered).toContain('Mismatches for vpip')
    expect(rendered).toContain('MISSING')
  })

  it('builds eligibility from the union of both sides, not the pipeline alone', () => {
    // PLAYER_B only appears on the oracle side with >= minHands (e.g.
    // EntityConverter dropped the player entirely, or undercounted their
    // hands below the threshold). Using only pipeline-side eligibility would
    // silently exclude PLAYER_B from every stat comparison; union-based
    // eligibility must still surface this as a mismatch for every compared
    // stat, with the pipeline side reported as absent.
    const pipeline = new Map([
      [PLAYER_A, { playerId: PLAYER_A, hands: 60, stats: { vpip: [30, 60] } }],
      // PLAYER_B absent entirely from the pipeline side.
    ])
    const oracle = new Map([
      [PLAYER_A, { playerId: PLAYER_A, hands: 60, stats: { vpip: [30, 60] as [number, number] } }],
      [PLAYER_B, { playerId: PLAYER_B, hands: 55, stats: { vpip: [20, 55] as [number, number] } }],
    ])

    const report = compareResults(pipeline as any, oracle as any, 50)
    expect(report.eligiblePlayers).toBe(2)

    const vpip = report.stats.find(s => s.stat === 'vpip')!
    expect(vpip.total).toBe(2)
    expect(vpip.agree).toBe(1) // PLAYER_A agrees
    expect(vpip.missing).toBe(1) // PLAYER_B missing on the pipeline side
    const bMismatch = vpip.mismatches.find(m => m.playerId === PLAYER_B)
    expect(bMismatch).toMatchObject({ missing: true, pipeline: undefined, oracle: [20, 55] })
  })
})
