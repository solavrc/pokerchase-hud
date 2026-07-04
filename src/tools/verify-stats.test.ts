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
 *
 * This exercises the same code path `npm run verify-stats` uses, just
 * against a fixture small enough for CI instead of a real ndjson export.
 */
import { runPipeline } from './verify-stats/pipeline'
import { runOracle } from './verify-stats/oracle'
import { compareResults, formatReport } from './verify-stats/compare'
import { ApiType, apiEventSchemas } from '../types/api'
import { ActionType } from '../types/game'
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
})
