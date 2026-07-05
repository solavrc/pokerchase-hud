/**
 * verify-stats: independent oracle.
 *
 * Computes VPIP/PFR/3BET/3BETFOLD/CBET/CBETFOLD/AF/AFq/WTSD/WSD/WWSF/STEAL/
 * FOLDTOSTEAL/RCA directly from raw NDJSON events, with NO imports from
 * `src/stats` or `src/entity-converter`. Only wire-protocol enums are
 * imported -- `ApiType` from `src/types/api` and `ActionType`/
 * `BetStatusType`/`RankType` from `src/types/game` -- for readability;
 * every detection rule below is written from
 * scratch against the documented event semantics in CLAUDE.md /
 * docs/hand-analysis.md, not against the pipeline's implementation.
 *
 * This independence is the whole point of the tool: if a bug is introduced
 * in entity-converter.ts or a stats/core/*.ts module, this file has no way
 * to inherit it, so a genuine behavioral divergence shows up as a disagreement
 * in compare.ts instead of two buggy implementations silently agreeing with
 * each other. Do not import pipeline/stats code into this file.
 *
 * Semantics deliberately kept in sync with the pipeline (verified against
 * entity-converter.ts / src/stats/core during the 2026-07 real-data audit
 * that produced this harness, PRs #93-#97):
 *  (a) "saw flop" is derived from the FLOP EVT_DEAL_ROUND event's per-seat
 *      BetStatus === BET_ABLE (Player + OtherPlayers), not from "did not
 *      fold preflop" -- a player who went all-in preflop has BetStatus
 *      ALL_IN, not BET_ABLE, so they are correctly excluded even though
 *      they never "folded".
 *  (b) Positions are derived purely from Game.ButtonSeat / SmallBlindSeat /
 *      BigBlindSeat (never by rotating/inferring from seat order), which
 *      handles empty seats (busted players) correctly.
 *  (c) Showdown participation is gated on RankType: NO_CALL and FOLD_OPEN
 *      are excluded, everything else (0-9 real ranks, SHOWDOWN_MUCK)
 *      counts as a showdown.
 *  (d) Winners are players with RewardChip > 0 in EVT_HAND_RESULTS.Results.
 *  (e) River Call Accuracy (RCA): numerator is river CALL actions by a player
 *      in hands where that player ends up with RewardChip > 0; denominator is
 *      all river CALL actions by that player -- mirroring
 *      src/stats/core/river-call-accuracy.ts's RIVER_CALL/RIVER_CALL_WON
 *      ActionDetail tagging (RIVER_CALL is set when a CALL action occurs on
 *      the river; RIVER_CALL_WON is added post-hoc, in EVT_HAND_RESULTS, to
 *      any RIVER_CALL action taken by a player who ends up with
 *      RewardChip > 0 for that hand -- see entity-converter.ts /
 *      write-entity-stream.ts).
 */
import { ApiType } from '../../types/api'
import { ActionType, BetStatusType, PhaseType, RankType } from '../../types/game'

type ActionTypeNum = Exclude<ActionType, ActionType.ALL_IN>

/** Minimal shapes for the raw NDJSON fields this oracle reads. No schema/type imports beyond the enums above. */
interface RawSeatPlayer {
  SeatIndex: number
  BetStatus: BetStatusType
}
interface RawGame {
  ButtonSeat: number
  SmallBlindSeat: number
  BigBlindSeat: number
}
interface RawDealEvent {
  ApiTypeId: ApiType.EVT_DEAL
  SeatUserIds: number[]
  Game: RawGame
  Progress: RawProgress
}
interface RawProgress {
  NextActionTypes: number[]
  Phase?: number
}
interface RawActionEvent {
  ApiTypeId: ApiType.EVT_ACTION
  SeatIndex: number
  ActionType: ActionType
  BetChip: number
  Progress: RawProgress
}
interface RawDealRoundEvent {
  ApiTypeId: ApiType.EVT_DEAL_ROUND
  Player?: RawSeatPlayer
  OtherPlayers: RawSeatPlayer[]
  Progress: RawProgress & { Phase: number }
}
interface RawResultEntry {
  UserId: number
  RankType: RankType
  RewardChip: number
}
interface RawHandResultsEvent {
  ApiTypeId: ApiType.EVT_HAND_RESULTS
  HandId: number
  Results: RawResultEntry[]
}
type RawEvent = RawDealEvent | RawActionEvent | RawDealRoundEvent | RawHandResultsEvent | { ApiTypeId: number }

/** Fraction-valued stat: [numerator, denominator]. */
export type OracleFraction = [number, number]

export interface OraclePlayerResult {
  playerId: number
  hands: number
  stats: {
    vpip: OracleFraction
    pfr: OracleFraction
    '3bet': OracleFraction
    '3betfold': OracleFraction
    cbet: OracleFraction
    cbetFold: OracleFraction
    af: OracleFraction
    afq: OracleFraction
    wtsd: OracleFraction
    wsd: OracleFraction
    wwsf: OracleFraction
    steal: OracleFraction
    foldToSteal: OracleFraction
    riverCallAccuracy: OracleFraction
  }
}

export type OracleResult = Map<number, OraclePlayerResult>

interface PlayerAcc {
  hands: Set<number>
  vpip: number
  pfrHands: Set<number>
  threeBetChance: number
  threeBet: number
  threeBetFoldChance: number
  threeBetFold: number
  cbetChance: number
  cbet: number
  cbetFoldChance: number
  cbetFold: number
  betRaise: number
  call: number
  fold: number
  flopsSeen: Set<number>
  showdownsReached: Set<number>
  wonAtShowdownAllHands: Set<number>
  showdownAllCount: Set<number>
  wonAfterFlop: Set<number>
  stealChance: number
  steal: number
  foldToStealChance: number
  foldToSteal: number
  riverCall: number
  riverCallWon: number
}

function newAcc(): PlayerAcc {
  return {
    hands: new Set(), vpip: 0, pfrHands: new Set(),
    threeBetChance: 0, threeBet: 0, threeBetFoldChance: 0, threeBetFold: 0,
    cbetChance: 0, cbet: 0, cbetFoldChance: 0, cbetFold: 0,
    betRaise: 0, call: 0, fold: 0,
    flopsSeen: new Set(), showdownsReached: new Set(),
    wonAtShowdownAllHands: new Set(), showdownAllCount: new Set(), wonAfterFlop: new Set(),
    stealChance: 0, steal: 0, foldToStealChance: 0, foldToSteal: 0,
    riverCall: 0, riverCallWon: 0,
  }
}

type PositionLabel = 'BB' | 'SB' | 'BTN' | 'CO' | 'HJ' | 'UTG' | 'OTHER'

/**
 * Derive seat -> position labels purely from ButtonSeat/SmallBlindSeat/BigBlindSeat
 * (independent re-derivation of the same rule src/utils/position-utils.ts implements).
 */
function computePositions(seatUserIds: number[], buttonSeat: number, sbSeat: number, bbSeat: number): Map<number, PositionLabel> {
  const n = seatUserIds.length
  const activeSeats: number[] = []
  for (let i = 0; i < n; i++) if (seatUserIds[i] !== -1) activeSeats.push(i)

  const posMap = new Map<number, PositionLabel>()

  if (activeSeats.length === 2) {
    // Heads-up: BTN === SB seat, the other seat is BB.
    for (const seat of activeSeats) {
      const pid = seatUserIds[seat]!
      posMap.set(pid, seat === bbSeat ? 'BB' : 'SB')
    }
    return posMap
  }

  const idxInActiveBtn = activeSeats.indexOf(buttonSeat)
  const postBtnOrder: number[] = []
  for (let k = 1; k <= activeSeats.length; k++) {
    postBtnOrder.push(activeSeats[(idxInActiveBtn + k) % activeSeats.length]!)
  }
  // postBtnOrder ends with BTN itself; label from the back: BTN, CO, HJ, then UTG for the rest.
  const labels: PositionLabel[] = new Array(postBtnOrder.length).fill('OTHER')
  labels[labels.length - 1] = 'BTN'
  if (labels.length - 2 >= 0) labels[labels.length - 2] = 'CO'
  if (labels.length - 3 >= 0) labels[labels.length - 3] = 'HJ'
  for (let i = 0; i < labels.length - 3; i++) labels[i] = 'UTG'

  for (let i = 0; i < postBtnOrder.length; i++) {
    const seat = postBtnOrder[i]!
    let label = labels[i]!
    if (seat === sbSeat) label = 'SB'
    else if (seat === bbSeat) label = 'BB'
    posMap.set(seatUserIds[seat]!, label)
  }
  return posMap
}

interface ActionRec {
  playerId: number
  actionType: ActionTypeNum
}

/** Map ALL_IN to the action it functionally represents, using NextActionTypes like the live pipeline does. */
function normalizeAllIn(actionEvent: RawActionEvent, prevProgress: RawProgress | undefined): ActionTypeNum {
  if (actionEvent.ActionType !== ActionType.ALL_IN) return actionEvent.ActionType as ActionTypeNum
  const nextTypes: number[] = prevProgress?.NextActionTypes || []
  if (nextTypes.includes(ActionType.BET)) return ActionType.BET
  if (nextTypes.includes(ActionType.CALL)) return ActionType.RAISE
  return ActionType.CALL
}

export interface RunOracleOptions {
  /** Emit hand-by-hand trace lines to the given sink for the listed hand IDs (debugging aid). */
  traceHandIds?: Set<number>
  trace?: (line: string) => void
}

/**
 * Process every complete hand (EVT_DEAL .. EVT_HAND_RESULTS) in `events` and
 * return per-player fractions for every tracked stat.
 */
export function runOracle(events: unknown[], options: RunOracleOptions = {}): OracleResult {
  const players = new Map<number, PlayerAcc>()
  const acc = (pid: number): PlayerAcc => {
    let a = players.get(pid)
    if (!a) { a = newAcc(); players.set(pid, a) }
    return a
  }

  const trace = options.trace ?? ((line: string) => console.error(line))
  const traceHandIds = options.traceHandIds ?? new Set<number>()

  let currentHand: RawEvent[] = []

  function processHand(handEvents: RawEvent[]): void {
    const dealEvt = handEvents.find((e): e is RawDealEvent => e.ApiTypeId === ApiType.EVT_DEAL)
    const resultsEvt = handEvents.find((e): e is RawHandResultsEvent => e.ApiTypeId === ApiType.EVT_HAND_RESULTS)
    // Incomplete hand (session boundary / dropped event) -- excluded, same as the
    // pipeline's `handState.hand.id > 0` completeness check.
    if (!dealEvt || !resultsEvt) return

    // Table-move chimera hand rejection, kept in sync with
    // hasResultsOutsideDealtLineup (src/types/game.ts) / entity-converter.ts /
    // write-entity-stream.ts: if EVT_HAND_RESULTS.Results references a UserId
    // absent from this hand's EVT_DEAL.SeatUserIds, the RESULTS belongs to the
    // destination table reached via a mid-hand EVT_ENTRY_QUEUED move, not to the
    // buffered DEAL. The oracle must drop the same hands the pipeline drops or
    // verify-stats would report a spurious divergence.
    {
      const dealtUserIds = new Set(dealEvt.SeatUserIds.filter(id => id !== -1))
      const hasForeignResult = resultsEvt.Results.some(({ UserId }) => !dealtUserIds.has(UserId))
      if (hasForeignResult) return
    }

    const seatUserIds = dealEvt.SeatUserIds
    const { ButtonSeat: buttonSeat, SmallBlindSeat: sbSeat, BigBlindSeat: bbSeat } = dealEvt.Game
    const posMap = computePositions(seatUserIds, buttonSeat, sbSeat, bbSeat)
    const handId = resultsEvt.HandId

    for (const pid of seatUserIds) {
      if (pid === -1) continue
      acc(pid).hands.add(handId)
    }

    let phase = 0 // 0=preflop
    let prevProgress: RawProgress | undefined = dealEvt.Progress
    const preflopRaisers: number[] = []
    let cBetter: number | undefined
    let cBetExecuted = false
    let cBetPhase: number | undefined
    let stealRaiser: number | undefined
    const preflopActionsSoFar: ActionRec[] = []
    // Players confirmed to have reached the flop (BetStatus===BET_ABLE at the FLOP deal-round).
    let flopActivePlayers: Set<number> | undefined
    // Count of river CALL actions by player this hand (RIVER_CALL is tagged
    // per-action in the product; RIVER_CALL_WON is resolved for ALL of a
    // winning player's river-call actions once EVT_HAND_RESULTS is known).
    const riverCallsThisHand = new Map<number, number>()

    const phaseActionsMap = new Map<number, ActionRec[]>([[0, []]])
    const perPlayerPhaseActionIdx = new Map<string, number>()
    const traceLines: string[] = []

    for (const event of handEvents) {
      if (event.ApiTypeId === ApiType.EVT_ACTION) {
        const actionEvt = event as RawActionEvent
        const seatIndex = actionEvt.SeatIndex
        const playerId = seatUserIds[seatIndex]!
        const normType = normalizeAllIn(actionEvt, prevProgress)

        const actionsInPhase = phaseActionsMap.get(phase) ?? []
        const betRaiseSoFarInPhase = actionsInPhase.filter(a => a.actionType === ActionType.BET || a.actionType === ActionType.RAISE).length
        const curPrevBetCount = betRaiseSoFarInPhase + (phase === 0 ? 1 : 0)

        const key = `${phase}:${playerId}`
        const phasePlayerActionIndex = perPlayerPhaseActionIdx.get(key) ?? 0
        const rec: ActionRec = { playerId, actionType: normType }

        // VPIP: preflop, player's first preflop action, CALL or RAISE.
        if (phase === 0 && phasePlayerActionIndex === 0 && (normType === ActionType.CALL || normType === ActionType.RAISE)) {
          acc(playerId).vpip++
        }

        // PFR: any preflop RAISE (unique hand count).
        if (phase === 0 && normType === ActionType.RAISE) {
          acc(playerId).pfrHands.add(handId)
        }

        // 3BET / 3BETFOLD: facing a 2-bet -> 3bet chance; facing a 3-bet -> 3betfold chance.
        if (phase === 0 && curPrevBetCount === 2) {
          acc(playerId).threeBetChance++
          if (normType === ActionType.RAISE) acc(playerId).threeBet++
        }
        if (phase === 0 && curPrevBetCount === 3) {
          acc(playerId).threeBetFoldChance++
          if (normType === ActionType.FOLD) acc(playerId).threeBetFold++
        }

        // STEAL: preflop, no raise yet, late position (CO/BTN/SB), everyone before folded.
        const posLabel = posMap.get(playerId)
        if (phase === 0 && curPrevBetCount === 1 && (posLabel === 'CO' || posLabel === 'BTN' || posLabel === 'SB')) {
          const allFoldedBefore = preflopActionsSoFar.every(a => a.actionType === ActionType.FOLD)
          if (allFoldedBefore) {
            acc(playerId).stealChance++
            if (normType === ActionType.RAISE) {
              acc(playerId).steal++
              stealRaiser = playerId
            }
          }
        }

        // FOLD TO STEAL: blinds facing the identified steal raiser.
        if (phase === 0 && curPrevBetCount === 2 && (posLabel === 'SB' || posLabel === 'BB') && stealRaiser !== undefined && stealRaiser !== playerId) {
          acc(playerId).foldToStealChance++
          if (normType === ActionType.FOLD) acc(playerId).foldToSteal++
        }

        // CBET / CBETFOLD.
        if (phase !== 0 && cBetter !== undefined) {
          if (curPrevBetCount === 0) {
            if (cBetter === playerId) {
              acc(playerId).cbetChance++
              if (normType === ActionType.BET) {
                acc(playerId).cbet++
                cBetExecuted = true
                cBetPhase = phase
                cBetter = undefined
              } else {
                cBetter = undefined // missed opportunity
              }
            } else if (normType === ActionType.BET) {
              cBetter = undefined // donk bet
            }
          }
        }
        if (phase !== 0 && cBetExecuted && cBetPhase === phase && curPrevBetCount === 1) {
          acc(playerId).cbetFoldChance++
          if (normType === ActionType.FOLD) acc(playerId).cbetFold++
        }

        // AF / AFq.
        if (normType === ActionType.BET || normType === ActionType.RAISE) acc(playerId).betRaise++
        if (normType === ActionType.CALL) acc(playerId).call++
        if (normType === ActionType.FOLD) acc(playerId).fold++

        // RCA: RIVER_CALL is tagged on every river CALL action (denominator);
        // RIVER_CALL_WON is resolved below, once Results is known.
        if (phase === PhaseType.RIVER && normType === ActionType.CALL) {
          acc(playerId).riverCall++
          riverCallsThisHand.set(playerId, (riverCallsThisHand.get(playerId) ?? 0) + 1)
        }

        if (phase === 0 && normType === ActionType.RAISE) preflopRaisers.push(playerId)

        actionsInPhase.push(rec)
        phaseActionsMap.set(phase, actionsInPhase)
        perPlayerPhaseActionIdx.set(key, phasePlayerActionIndex + 1)
        if (phase === 0) preflopActionsSoFar.push(rec)

        prevProgress = actionEvt.Progress

        if (traceHandIds.has(handId)) {
          traceLines.push(`  seat${seatIndex}(P${playerId}) phase=${phase} raw=${actionEvt.ActionType} norm=${normType} prevBet=${curPrevBetCount} bet=${actionEvt.BetChip}`)
        }
      } else if (event.ApiTypeId === ApiType.EVT_DEAL_ROUND) {
        const roundEvt = event as RawDealRoundEvent
        const newPhase = roundEvt.Progress.Phase
        phase = newPhase
        if (!phaseActionsMap.has(phase)) phaseActionsMap.set(phase, [])
        prevProgress = roundEvt.Progress

        if (phase === 1) {
          // Semantic-sync (a): "saw flop" = BetStatus===BET_ABLE for this seat at the
          // FLOP deal-round, exactly mirroring entity-converter.ts's phase-membership
          // filter. This correctly excludes preflop all-ins (BetStatus=ALL_IN) even
          // though they never technically "folded".
          const seatPlayers = roundEvt.Player ? [roundEvt.Player, ...roundEvt.OtherPlayers] : roundEvt.OtherPlayers
          flopActivePlayers = new Set(
            seatPlayers
              .filter(p => p.BetStatus === BetStatusType.BET_ABLE)
              .map(p => seatUserIds[p.SeatIndex]!)
              .filter(pid => pid !== -1)
          )
          cBetter = preflopRaisers.length > 0 ? preflopRaisers[preflopRaisers.length - 1] : undefined
        }
        if (traceHandIds.has(handId)) {
          traceLines.push(`[DEAL_ROUND phase=${phase}]`)
        }
      }
    }

    // Showdown / WTSD / WSD / WWSF determination from Results.
    const results = resultsEvt.Results || []
    // Semantic-sync (d): winners are players with RewardChip > 0.
    const winners = new Set(results.filter(r => r.RewardChip > 0).map(r => r.UserId))

    // Semantic-sync (e): RIVER_CALL_WON is added to every RIVER_CALL action
    // taken by a player who ends up with RewardChip > 0 for this hand.
    for (const [pid, count] of riverCallsThisHand) {
      if (winners.has(pid)) acc(pid).riverCallWon += count
    }

    for (const r of results) {
      const pid = r.UserId
      // Semantic-sync (c): showdown participation is RankType-gated (NO_CALL and
      // FOLD_OPEN excluded; SHOWDOWN_MUCK and all real ranks count).
      const isShowdownParticipant = r.RankType !== RankType.NO_CALL && r.RankType !== RankType.FOLD_OPEN
      if (isShowdownParticipant) {
        acc(pid).showdownAllCount.add(handId) // WSD denominator: ALL showdowns incl preflop all-in.
        if (winners.has(pid)) acc(pid).wonAtShowdownAllHands.add(handId)
      }
      if (flopActivePlayers?.has(pid) && isShowdownParticipant) {
        acc(pid).showdownsReached.add(handId) // WTSD numerator (flop seen -> showdown).
      }
    }

    if (traceHandIds.has(handId)) {
      trace(`--- Hand ${handId} --- seats=${JSON.stringify(seatUserIds)} btn=${buttonSeat} sb=${sbSeat} bb=${bbSeat}`)
      traceLines.forEach(trace)
      trace(`Results: ${JSON.stringify(results)}`)
    }

    if (flopActivePlayers) {
      for (const pid of flopActivePlayers) {
        acc(pid).flopsSeen.add(handId)
        if (winners.has(pid)) acc(pid).wonAfterFlop.add(handId)
      }
    }
  }

  for (const raw of events) {
    const e = raw as RawEvent
    if (e.ApiTypeId === ApiType.EVT_DEAL) {
      if (currentHand.length > 0) processHand(currentHand)
      currentHand = [e]
    } else if (currentHand.length > 0) {
      currentHand.push(e)
      if (e.ApiTypeId === ApiType.EVT_HAND_RESULTS) {
        processHand(currentHand)
        currentHand = []
      }
    }
  }
  if (currentHand.length > 0) processHand(currentHand)

  const result: OracleResult = new Map()
  for (const [pid, a] of players.entries()) {
    result.set(pid, {
      playerId: pid,
      hands: a.hands.size,
      stats: {
        vpip: [a.vpip, a.hands.size],
        pfr: [a.pfrHands.size, a.hands.size],
        '3bet': [a.threeBet, a.threeBetChance],
        '3betfold': [a.threeBetFold, a.threeBetFoldChance],
        cbet: [a.cbet, a.cbetChance],
        cbetFold: [a.cbetFold, a.cbetFoldChance],
        af: [a.betRaise, a.call],
        afq: [a.betRaise, a.betRaise + a.call + a.fold],
        wtsd: [a.showdownsReached.size, a.flopsSeen.size],
        wsd: [a.wonAtShowdownAllHands.size, a.showdownAllCount.size],
        wwsf: [a.wonAfterFlop.size, a.flopsSeen.size],
        steal: [a.steal, a.stealChance],
        foldToSteal: [a.foldToSteal, a.foldToStealChance],
        riverCallAccuracy: [a.riverCallWon, a.riverCall],
      }
    })
  }
  return result
}
