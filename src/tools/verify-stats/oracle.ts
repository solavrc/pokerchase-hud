/**
 * verify-stats: independent oracle.
 *
 * Computes VPIP/PFR/3BET/3BETFOLD/CBET/CBETFOLD/AF/AFq/WTSD/WSD/WWSF/
 * WTSDa/WWSFa/STEAL/FOLDTOSTEAL/RCA directly from raw NDJSON events, with NO
 * imports from `src/stats` or `src/entity-converter`. Only wire-protocol
 * enums are imported -- `ApiType` from `src/types/api` and `ActionType`/
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
 * that produced this harness, PRs #93-#97, and the 2026-07 conformance
 * audit against PT4/HM3 official definitions, #115):
 *  (a) "saw flop" (WTSD/WWSF denominator) is derived from the FLOP
 *      EVT_DEAL_ROUND event's per-seat BetStatus === BET_ABLE ||
 *      BetStatus === ALL_IN (Player + OtherPlayers). PT4 staff describe WTSD/
 *      WWSF as built on "flops seen", explicitly INCLUDING preflop all-in
 *      spots ("Those stats are based on flops seen, not based on flops seen
 *      when not all-in, so all-in spots will count") -- only FOLDED players
 *      are excluded from this population (the #97 fix, which stays in place).
 *  (a2) WTSDa/WWSFa (opt-in decision-focused variants, #115) instead use a
 *      "took a flop action" base: hands where the player has >= 1 EVT_ACTION
 *      with phase===FLOP. A BET_ABLE flop-seer always acts at least once on
 *      the flop; a preflop all-in player never does. This reproduces the
 *      lineage semantics (PT4 custom-stat "WTSD without preflop all-ins" /
 *      Hand2Note "Flop Any Action") without needing a second BetStatus
 *      re-derivation.
 *  (a4b) DEAL_ROUND-omitted preflop all-ins (post-#115 audit): when every
 *      remaining player is all-in preflop, PokerChase skips EVT_DEAL_ROUND
 *      entirely for the rest of the hand and ships the whole remaining
 *      board in EVT_HAND_RESULTS.CommunityCards instead (documented in
 *      docs/api-events.md). No FLOP-phase BetStatus snapshot ever exists in
 *      that case, so (a)'s derivation alone would silently miss these hands
 *      from "flops seen" -- the same gap flagged against the pipeline itself
 *      (PR #115 unresolved review thread). This oracle closes it with its
 *      OWN fallback, independent of how entity-converter.ts/
 *      write-entity-stream.ts do it: if no EVT_DEAL_ROUND for phase FLOP was
 *      ever observed AND the accumulated board (DEAL_ROUND CommunityCards +
 *      EVT_HAND_RESULTS.CommunityCards) reaches >= 3 cards, "saw flop" is
 *      every dealt seat that (i) never took a PREFLOP FOLD action AND
 *      (ii) is present in EVT_HAND_RESULTS.Results[]. (i) alone is NOT
 *      sufficient (PR #184 codex review, P2): on a timeout/disconnect
 *      PokerChase may send no explicit FOLD EVT_ACTION at all for that seat,
 *      AND omit the player from Results[] entirely (docs/api-events.md
 *      "EVT_ACTION: 送信されないケース" / "タイムアウト / 切断"; also
 *      src/types/api.ts EVT_HAND_RESULTS.Results[].UserId doc: "タイムアウト/
 *      切断プレイヤーはResults[]に含まれない場合がある"). Such a player never
 *      folded and never went all-in -- they just silently vanished -- so a
 *      FOLD-action-only check wrongly keeps them in the synthesized FLOP.
 *      Requiring Results[] presence closes this: every genuine preflop
 *      all-in survivor is guaranteed to reach an unconditional showdown (no
 *      further betting decisions remain once all contesting players are
 *      all-in) and therefore IS present in Results[] with a real RankType
 *      (0-9) or SHOWDOWN_MUCK (11) -- confirmed by src/types/api.ts's own
 *      invariant "Pot + sum(SidePot) == sum(Results[].RewardChip)" holding
 *      100% (docs/api-events.md line 285), which requires every chip-bearing
 *      contestant to have a Results[] entry. The (i) FOLD-action check is
 *      still needed alongside (ii): a player who folded preflop but later
 *      chose FOLD_OPEN (self-reveal) DOES appear in Results[] (RankType=12)
 *      despite never seeing the flop, so Results[] presence alone is not a
 *      sufficient condition either -- src/types/api.ts: "フォールド済み
 *      プレイヤーはFOLD_OPENしない限りResults[]に含まれない". Only the AND of
 *      both conditions matches the game's actual semantics. This is
 *      deliberately actions/results-derived (mirroring how folded players
 *      are excluded everywhere else in this file), not a copy of the
 *      pipeline's own fallback.
 *  (a3) VPIP/PFR denominators exclude "walks": a hand where the player is
 *      the BB (Game.BigBlindSeat) and took ZERO preflop actions (true walk,
 *      or the "BB action skip" path where NextActionSeat=-2 and the BB's
 *      check is never sent as an EVT_ACTION -- CLAUDE.md "BB action skip").
 *      In both cases the BB had no voluntary preflop decision to make.
 *      Non-BB players who folded preflop still made a decision and remain
 *      counted as an opportunity. This mirrors the PT4/HM3 standard
 *      denominator of "hands - walks".
 *  (a4) AF/AFq are POSTFLOP-only (PT4 official definition: "Ratio of the
 *      times a player makes a POSTFLOP aggressive action (bet or raise) to
 *      the times they call"). Preflop actions are excluded from both sides
 *      of both fractions.
 *  (b) Positions are derived purely from Game.ButtonSeat / SmallBlindSeat /
 *      BigBlindSeat (never by rotating/inferring from seat order), which
 *      handles empty seats (busted players) correctly.
 *  (c) Showdown participation is gated on RankType: NO_CALL and FOLD_OPEN
 *      are excluded, everything else (0-9 real ranks, SHOWDOWN_MUCK)
 *      counts as a showdown.
 *  (d) Winners are players with a positive contested award. RewardChip also
 *      includes uncalled excess returns, so the oracle independently rebuilds
 *      contribution tiers from DEAL/RESULTS stack snapshots and removes every
 *      tier reached by only one contributor.
 *  (e) River Call Accuracy (RCA): numerator is river CALL actions by a player
 *      in hands where that player wins a contested award; denominator is
 *      all river CALL actions by that player -- mirroring
 *      src/stats/core/river-call-accuracy.ts's RIVER_CALL/RIVER_CALL_WON
 *      ActionDetail tagging (RIVER_CALL is set when a CALL action occurs on
 *      the river; RIVER_CALL_WON is added post-hoc, in EVT_HAND_RESULTS, to
 *      any RIVER_CALL action taken by a player who wins a contested award
 *      for that hand -- see entity-converter.ts /
 *      write-entity-stream.ts).
 *  (f) VPIP·F (vpipF, opt-in HUD-original stat, see hand-over
 *      workspace/reports/pokerchase-hud-vpip-f-handover.md): same VPIP
 *      numerator/denominator logic as (a3) above, restricted to "full table
 *      layer" hands -- table-type relative: a 6-max hand (SeatUserIds.length
 *      === 6) qualifies when >= 5 of the 6 seats are dealt (non -1); a 4-max
 *      hand (SeatUserIds.length === 4) qualifies only when all 4 seats are
 *      dealt. This is an independent re-derivation of
 *      src/stats/core/vpip-full.ts's `classifyVpipFLayer` -- deliberately not
 *      imported, per this file's independence contract.
 */
import { ApiType } from '../../types/api'
import { ActionType, BattleType, BetStatusType, PhaseType, RankType } from '../../types/game'

type ActionTypeNum = Exclude<ActionType, ActionType.ALL_IN>

/** Minimal shapes for the raw NDJSON fields this oracle reads. No schema/type imports beyond the enums above. */
interface RawSeatPlayer {
  SeatIndex: number
  BetStatus: BetStatusType
  Chip?: number
  BetChip?: number
}
interface RawGame {
  ButtonSeat: number
  SmallBlindSeat: number
  BigBlindSeat: number
  Ante?: number
}
interface RawDealEvent {
  ApiTypeId: ApiType.EVT_DEAL
  SeatUserIds: number[]
  Game: RawGame
  Progress: RawProgress
  Player?: RawSeatPlayer
  OtherPlayers?: RawSeatPlayer[]
}
interface RawProgress {
  NextActionTypes: number[]
  Phase?: number
  Pot?: number
  SidePot?: number[]
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
  CommunityCards?: number[]
}
interface RawResultEntry {
  UserId: number
  RankType: RankType
  HandRanking?: number
  RewardChip: number
}
interface RawHandResultsEvent {
  ApiTypeId: ApiType.EVT_HAND_RESULTS
  HandId: number
  Results: RawResultEntry[]
  CommunityCards?: number[]
  Pot?: number
  SidePot?: number[]
  Player?: RawSeatPlayer
  OtherPlayers?: RawSeatPlayer[]
}
interface RawSessionStartEvent {
  ApiTypeId: ApiType.EVT_ENTRY_QUEUED
  BattleType: BattleType
}
type RawEvent = RawDealEvent | RawActionEvent | RawDealRoundEvent | RawHandResultsEvent | RawSessionStartEvent | { ApiTypeId: number }

const rawSeatSnapshot = (
  event: { Player?: RawSeatPlayer, OtherPlayers?: RawSeatPlayer[] },
  seatIndex: number
): RawSeatPlayer | undefined => {
  if (event.Player?.SeatIndex === seatIndex) return event.Player
  return event.OtherPlayers?.find(player => player.SeatIndex === seatIndex)
}

const rawPaysAnte = (deal: RawDealEvent, seatIndex: number): boolean => {
  const betStatus = rawSeatSnapshot(deal, seatIndex)?.BetStatus
  return betStatus === undefined ||
    betStatus === BetStatusType.BET_ABLE ||
    betStatus === BetStatusType.ALL_IN
}

const rawStartingStack = (deal: RawDealEvent, seatIndex: number): number | null => {
  const snapshot = rawSeatSnapshot(deal, seatIndex)
  if (snapshot?.Chip === undefined || snapshot.BetChip === undefined) return null

  const chipsAfterAnte = snapshot.Chip + snapshot.BetChip
  if (!rawPaysAnte(deal, seatIndex)) return chipsAfterAnte

  const ante = deal.Game.Ante ?? 0
  if (chipsAfterAnte > 0 || ante === 0) return chipsAfterAnte + ante

  const anteAllInSeats = deal.SeatUserIds
    .map((userId, index) => ({ userId, index }))
    .filter(({ userId, index }) =>
      userId !== -1 &&
      rawPaysAnte(deal, index) &&
      (rawSeatSnapshot(deal, index)?.Chip ?? 0) +
        (rawSeatSnapshot(deal, index)?.BetChip ?? 0) === 0)
  if (anteAllInSeats.length > 1 && (deal.Progress.SidePot?.length ?? 0) > 0) return null

  const contributorCount = deal.SeatUserIds.reduce((count, userId, index) =>
    userId !== -1 && rawPaysAnte(deal, index) ? count + 1 : count, 0)
  const pot = deal.Progress.Pot
  if (pot === undefined || contributorCount <= 0 || pot % contributorCount !== 0) return null

  const inferredStack = pot / contributorCount
  return Number.isSafeInteger(inferredStack) && inferredStack > 0 && inferredStack <= ante
    ? inferredStack
    : null
}

/**
 * Independent winner resolution for the verification oracle.
 *
 * This deliberately does not import the production settlement helper. Exact
 * endpoint contributions are `start + payout - final`; contribution levels
 * reached by one player are uncalled returns, while levels reached by two or
 * more players are contested. Abbreviated legacy rows retain only an explicit
 * main-pot/NO_CALL winner signal.
 */
const resolveContestedWinners = (
  deal: RawDealEvent,
  results: RawHandResultsEvent,
  battleType: BattleType | undefined
): Set<number> => {
  const fallback = () => new Set(
    results.Results
      .filter(result =>
        result.RewardChip > 0 &&
        (result.HandRanking === 1 || result.RankType === RankType.NO_CALL))
      .map(result => result.UserId)
  )
  if (!Array.isArray(results.Results) ||
      !Array.isArray(results.SidePot) ||
      !Number.isSafeInteger(results.Pot)) return fallback()

  const userIds = deal.SeatUserIds.filter(userId => userId !== -1)
  const resultByUserId = new Map(results.Results.map(result => [result.UserId, result]))
  const starts = new Map<number, number>()
  const finalStacks = new Map<number, number>()
  for (let seatIndex = 0; seatIndex < deal.SeatUserIds.length; seatIndex++) {
    const userId = deal.SeatUserIds[seatIndex]
    if (userId === undefined || userId === -1) continue
    const startingStack = rawStartingStack(deal, seatIndex)
    if (startingStack !== null) starts.set(seatIndex, startingStack)

    const final = rawSeatSnapshot(results, seatIndex)
    if (final?.Chip !== undefined && final.BetChip !== undefined) {
      finalStacks.set(seatIndex, final.Chip + final.BetChip)
    }
  }

  const occupiedSeatIndexes = deal.SeatUserIds
    .map((userId, seatIndex) => ({ userId, seatIndex }))
    .filter(({ userId }) => userId !== -1)
    .map(({ seatIndex }) => seatIndex)
  const isTournament = battleType === BattleType.SIT_AND_GO ||
    battleType === BattleType.TOURNAMENT ||
    battleType === BattleType.FRIEND_SIT_AND_GO ||
    battleType === BattleType.CLUB_MATCH
  const missingFinalSeatIndexes = occupiedSeatIndexes.filter(seatIndex => !finalStacks.has(seatIndex))
  if (isTournament &&
      missingFinalSeatIndexes.length === 1 &&
      occupiedSeatIndexes.every(seatIndex => starts.has(seatIndex))) {
    const missingSeatIndex = missingFinalSeatIndexes[0]!
    const missingUserId = deal.SeatUserIds[missingSeatIndex]
    if (missingUserId !== undefined && results.Results.some(result => result.UserId === missingUserId)) {
      const totalStartingStack = occupiedSeatIndexes.reduce((sum, seatIndex) => sum + starts.get(seatIndex)!, 0)
      const knownFinalStack = occupiedSeatIndexes.reduce((sum, seatIndex) => sum + (finalStacks.get(seatIndex) ?? 0), 0)
      const inferredFinalStack = totalStartingStack - knownFinalStack
      if (!Number.isSafeInteger(inferredFinalStack) || inferredFinalStack < 0) return fallback()
      finalStacks.set(missingSeatIndex, inferredFinalStack)
    }
  }

  const contributions = new Map<number, number>()
  for (let seatIndex = 0; seatIndex < deal.SeatUserIds.length; seatIndex++) {
    const userId = deal.SeatUserIds[seatIndex]
    if (userId === undefined || userId === -1) continue
    const startingStack = starts.get(seatIndex)
    const finalStack = finalStacks.get(seatIndex)
    if (startingStack === undefined || finalStack === undefined) return fallback()

    const payout = resultByUserId.get(userId)?.RewardChip ?? 0
    const contribution = startingStack + payout - finalStack
    if (!Number.isSafeInteger(contribution) || contribution < 0 || contribution > startingStack) return fallback()
    contributions.set(userId, contribution)
  }

  const grossPot = results.Pot! + results.SidePot!.reduce((sum, pot) => sum + pot, 0)
  const grossPayout = results.Results.reduce((sum, result) => sum + result.RewardChip, 0)
  const totalContribution = [...contributions.values()].reduce((sum, contribution) => sum + contribution, 0)
  if (!Number.isSafeInteger(grossPot) ||
      grossPot !== grossPayout ||
      totalContribution < grossPayout) return fallback()

  const uncalledReturns = new Map<number, number>(userIds.map(userId => [userId, 0]))
  const levels = [...new Set(contributions.values())]
    .filter(contribution => contribution > 0)
    .sort((a, b) => a - b)
  let previousLevel = 0
  for (const level of levels) {
    const contributors = userIds.filter(userId => contributions.get(userId)! >= level)
    if (contributors.length === 1) {
      const userId = contributors[0]!
      uncalledReturns.set(userId, uncalledReturns.get(userId)! + (level - previousLevel))
    }
    previousLevel = level
  }

  const winners = new Set<number>()
  for (const result of results.Results) {
    const contestedAward = result.RewardChip - (uncalledReturns.get(result.UserId) ?? 0)
    if (!Number.isSafeInteger(contestedAward) || contestedAward < 0) return fallback()
    if (contestedAward > 0) winners.add(result.UserId)
  }
  return winners
}

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
    wtsdNoAi: OracleFraction
    wwsfNoAi: OracleFraction
    steal: OracleFraction
    foldToSteal: OracleFraction
    riverCallAccuracy: OracleFraction
    vpipF: OracleFraction
  }
}

export type OracleResult = Map<number, OraclePlayerResult>

interface PlayerAcc {
  hands: Set<number>
  vpip: number
  pfrHands: Set<number>
  /**
   * VPIP/PFR opportunity hands (#115, PT4/HM walk-exclusion standard:
   * denominator = hands - walks). A hand is excluded from THIS set (not from
   * `hands`, which is the plain "hands played" count used elsewhere, e.g.
   * `hands` stat) when the player was the BB in that hand and never took a
   * single preflop action -- a true walk, or the "BB action skip" path
   * (NextActionSeat=-2 with no BB EVT_ACTION, CLAUDE.md). In both cases the BB
   * had no voluntary preflop decision to make. Non-BB folds still count as an
   * opportunity (the player did make a decision).
   */
  vpipPfrOpportunityHands: Set<number>
  /**
   * VPIP·F (vpipF, see semantic-sync (f) above): same VPIP counter/opportunity
   * pair as `vpip`/`vpipPfrOpportunityHands`, but scoped to "full table layer"
   * hands only (table-type-relative: 6-max >= 5 dealt, 4-max = 4 dealt).
   */
  vpipF: number
  vpipFOpportunityHands: Set<number>
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
  /**
   * WTSDa/WWSFa base (#115, opt-in decision-focused variant lineage: PT4
   * custom-stat "WTSD without preflop all-ins" / Hand2Note "Flop Any Action").
   * Hands where the player took at least one FLOP-phase action -- a BET_ABLE
   * flop-seer always acts at least once on the flop, while a preflop all-in
   * player never does, so this set is exactly the "saw flop, not all-in"
   * population without needing a separate BetStatus re-derivation.
   */
  flopActionHands: Set<number>
  flopActionShowdowns: Set<number>
  flopActionWins: Set<number>
  stealChance: number
  steal: number
  foldToStealChance: number
  foldToSteal: number
  riverCall: number
  riverCallWon: number
}

function newAcc(): PlayerAcc {
  return {
    hands: new Set(), vpip: 0, pfrHands: new Set(), vpipPfrOpportunityHands: new Set(),
    vpipF: 0, vpipFOpportunityHands: new Set(),
    threeBetChance: 0, threeBet: 0, threeBetFoldChance: 0, threeBetFold: 0,
    cbetChance: 0, cbet: 0, cbetFoldChance: 0, cbetFold: 0,
    betRaise: 0, call: 0, fold: 0,
    flopsSeen: new Set(), showdownsReached: new Set(),
    wonAtShowdownAllHands: new Set(), showdownAllCount: new Set(), wonAfterFlop: new Set(),
    flopActionHands: new Set(), flopActionShowdowns: new Set(), flopActionWins: new Set(),
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
  let currentBattleType: BattleType | undefined
  let currentHandBattleType: BattleType | undefined

  function processHand(handEvents: RawEvent[], battleType: BattleType | undefined): void {
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

    // Fused-buffer rejection, kept in sync with write-entity-stream.ts /
    // entity-converter.ts: a duplicate EVT_DEAL_ROUND for the same phase is the
    // signature of a mid-hand table move/rebalance fusing two hands into one
    // buffer (the "dual board" observation -- 12/12 such hands in the real
    // capture carry a mid-hand EVT_ENTRY_QUEUED/EVT_PLAYER_SEAT_ASSIGNED; 3 of
    // them slip past the results-membership guard because both hands happen to
    // involve the same players).
    {
      const seenPhases = new Set<number>()
      for (const e of handEvents) {
        if (e.ApiTypeId !== ApiType.EVT_DEAL_ROUND) continue
        const p = (e as RawDealRoundEvent).Progress.Phase
        if (seenPhases.has(p)) return
        seenPhases.add(p)
      }
    }

    const seatUserIds = dealEvt.SeatUserIds
    const { ButtonSeat: buttonSeat, SmallBlindSeat: sbSeat, BigBlindSeat: bbSeat } = dealEvt.Game
    const posMap = computePositions(seatUserIds, buttonSeat, sbSeat, bbSeat)
    const handId = resultsEvt.HandId
    // BB player for this hand (VPIP/PFR walk-exclusion, #115); undefined if the
    // seat is somehow empty (defensive -- BigBlindSeat always points to an
    // occupied seat in real data per docs/api-events.md).
    const bbUserId = bbSeat !== -1 && seatUserIds[bbSeat] !== -1 ? seatUserIds[bbSeat] : undefined

    // VPIP·F (semantic-sync (f)): "full table layer" classification, table-type
    // relative -- independent re-derivation of classifyVpipFLayer.
    const dealtCount = seatUserIds.filter(id => id !== -1).length
    const tableSize = seatUserIds.length
    const isFullLayerHand = (tableSize === 6 && dealtCount >= 5) || (tableSize === 4 && dealtCount === 4)

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
    // Players who took at least one preflop action this hand (VPIP/PFR
    // walk-exclusion, #115: a BB with zero preflop actions had no voluntary
    // decision -- true walk or the "BB action skip" path, CLAUDE.md).
    const playersWithPreflopAction = new Set<number>()
    // Players who FOLDed during PREFLOP this hand -- the only way to leave a
    // hand before an unconditional preflop-all-in runout (a4b below).
    const preflopFoldedPlayers = new Set<number>()
    // Players confirmed to have reached the flop (BetStatus===BET_ABLE at the FLOP deal-round).
    let flopActivePlayers: Set<number> | undefined
    // Running count of community cards seen via EVT_DEAL_ROUND this hand
    // (a4b below: used to detect a fully-omitted DEAL_ROUND sequence by
    // comparing against the final board size once EVT_HAND_RESULTS arrives).
    let dealRoundCommunityCardCount = 0
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

        if (phase === 0) playersWithPreflopAction.add(playerId)
        // a4b: track PREFLOP folds independent of (a)'s BetStatus-based
        // derivation, for the DEAL_ROUND-omitted fallback below.
        if (phase === 0 && normType === ActionType.FOLD) preflopFoldedPlayers.add(playerId)

        // WTSDa/WWSFa base (#115): any FLOP-phase action by this player this hand.
        if (phase === PhaseType.FLOP) acc(playerId).flopActionHands.add(handId)

        // VPIP: preflop, player's first preflop action, CALL or RAISE.
        if (phase === 0 && phasePlayerActionIndex === 0 && (normType === ActionType.CALL || normType === ActionType.RAISE)) {
          acc(playerId).vpip++
          // VPIP·F (semantic-sync (f)): same trigger, scoped to full-layer hands.
          if (isFullLayerHand) acc(playerId).vpipF++
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

        // AF / AFq: PT4 official definition is POSTFLOP-only ("Ratio of the
        // times a player makes a POSTFLOP aggressive action (bet or raise) to
        // the times they call"), #115. Preflop actions are excluded entirely.
        if (phase !== 0) {
          if (normType === ActionType.BET || normType === ActionType.RAISE) acc(playerId).betRaise++
          if (normType === ActionType.CALL) acc(playerId).call++
          if (normType === ActionType.FOLD) acc(playerId).fold++
        }

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
        // a4b: accumulate board size as actually dealt via EVT_DEAL_ROUND, to
        // compare against the final board once EVT_HAND_RESULTS arrives.
        dealRoundCommunityCardCount += roundEvt.CommunityCards?.length ?? 0

        if (phase === 1) {
          // Semantic-sync (a): "saw flop" = BetStatus===BET_ABLE || BetStatus===ALL_IN
          // for this seat at the FLOP deal-round, exactly mirroring
          // entity-converter.ts's / write-entity-stream.ts's phase-membership
          // filter (#115). PT4's WTSD/WWSF are built on "flops seen" and
          // explicitly INCLUDE preflop all-in spots; only FOLDED players are
          // excluded from this population (the #97 fix, which stays in place).
          const seatPlayers = roundEvt.Player ? [roundEvt.Player, ...roundEvt.OtherPlayers] : roundEvt.OtherPlayers
          flopActivePlayers = new Set(
            seatPlayers
              .filter(p => p.BetStatus === BetStatusType.BET_ABLE || p.BetStatus === BetStatusType.ALL_IN)
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

    // a4b: DEAL_ROUND-omitted preflop all-in fallback. If no EVT_DEAL_ROUND
    // for the FLOP was ever observed (flopActivePlayers still undefined) but
    // the board nonetheless reached the flop -- the remaining cards arrived
    // solely via EVT_HAND_RESULTS.CommunityCards -- derive "saw flop"
    // independently from a BetStatus snapshot that was never sent. A dealt
    // seat only belongs in the synthesized FLOP if it (i) never took a
    // PREFLOP FOLD action AND (ii) is present in Results[] -- see this
    // file's header comment (a4b) for why the AND of both is required: (i)
    // alone wrongly keeps silent timeout/disconnect seats (no FOLD action
    // AND absent from Results[]), while (ii) alone wrongly keeps FOLD_OPEN
    // self-reveals (present in Results[] despite folding preflop).
    const finalBoardCardCount = dealRoundCommunityCardCount + (resultsEvt.CommunityCards?.length ?? 0)
    if (flopActivePlayers === undefined && finalBoardCardCount >= 3) {
      const resultUserIds = new Set((resultsEvt.Results || []).map(r => r.UserId))
      flopActivePlayers = new Set(
        seatUserIds.filter(pid => pid !== -1 && !preflopFoldedPlayers.has(pid) && resultUserIds.has(pid))
      )
    }

    // Showdown / WTSD / WSD / WWSF determination from Results.
    const results = resultsEvt.Results || []
    // Semantic-sync (d): independently remove uncalled-only contribution tiers.
    const winners = resolveContestedWinners(dealEvt, resultsEvt, battleType)

    // Semantic-sync (e): RIVER_CALL_WON is added to every RIVER_CALL action
    // taken by a player who wins a contested award in this hand.
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
      // WTSDa numerator (#115): base hand (flop action taken) that reached showdown.
      if (acc(pid).flopActionHands.has(handId) && isShowdownParticipant) {
        acc(pid).flopActionShowdowns.add(handId)
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

    // WWSFa numerator (#115): base hand (flop action taken) that this player won.
    // Only players who acted on the flop can have this hand in flopActionHands,
    // so iterate the seated players for this hand rather than all known players.
    for (const pid of seatUserIds) {
      if (pid === -1) continue
      if (acc(pid).flopActionHands.has(handId) && winners.has(pid)) {
        acc(pid).flopActionWins.add(handId)
      }
    }

    // VPIP/PFR opportunity hands (#115, PT4/HM walk-exclusion standard):
    // every seated player gets this hand as an opportunity UNLESS they are the
    // BB and never took a preflop action (true walk, or the "BB action skip"
    // path where all other players are all-in/folded before the BB acts).
    // Non-BB players who folded preflop still made a decision, so their
    // opportunity is retained even with zero preflop actions being impossible
    // for them (folding IS an action).
    for (const pid of seatUserIds) {
      if (pid === -1) continue
      const isBbWalk = pid === bbUserId && !playersWithPreflopAction.has(pid)
      if (!isBbWalk) {
        acc(pid).vpipPfrOpportunityHands.add(handId)
        // VPIP·F opportunity set (semantic-sync (f)): same walk-exclusion rule,
        // scoped to full-layer hands only.
        if (isFullLayerHand) acc(pid).vpipFOpportunityHands.add(handId)
      }
    }
  }

  for (const raw of events) {
    const e = raw as RawEvent
    if (e.ApiTypeId === ApiType.EVT_ENTRY_QUEUED) {
      currentBattleType = (e as RawSessionStartEvent).BattleType
    }
    if (e.ApiTypeId === ApiType.EVT_DEAL) {
      if (currentHand.length > 0) processHand(currentHand, currentHandBattleType)
      currentHand = [e]
      currentHandBattleType = currentBattleType
    } else if (currentHand.length > 0) {
      currentHand.push(e)
      if (e.ApiTypeId === ApiType.EVT_HAND_RESULTS) {
        processHand(currentHand, currentHandBattleType)
        currentHand = []
      }
    }
  }
  if (currentHand.length > 0) processHand(currentHand, currentHandBattleType)

  const result: OracleResult = new Map()
  for (const [pid, a] of players.entries()) {
    result.set(pid, {
      playerId: pid,
      hands: a.hands.size,
      stats: {
        // VPIP/PFR denominators use the walk-excluded opportunity set (#115),
        // not the raw hands-played count.
        vpip: [a.vpip, a.vpipPfrOpportunityHands.size],
        pfr: [a.pfrHands.size, a.vpipPfrOpportunityHands.size],
        '3bet': [a.threeBet, a.threeBetChance],
        '3betfold': [a.threeBetFold, a.threeBetFoldChance],
        cbet: [a.cbet, a.cbetChance],
        cbetFold: [a.cbetFold, a.cbetFoldChance],
        af: [a.betRaise, a.call],
        afq: [a.betRaise, a.betRaise + a.call + a.fold],
        wtsd: [a.showdownsReached.size, a.flopsSeen.size],
        wsd: [a.wonAtShowdownAllHands.size, a.showdownAllCount.size],
        wwsf: [a.wonAfterFlop.size, a.flopsSeen.size],
        // WTSDa/WWSFa (#115): opt-in decision-focused variants, flop-action base.
        wtsdNoAi: [a.flopActionShowdowns.size, a.flopActionHands.size],
        wwsfNoAi: [a.flopActionWins.size, a.flopActionHands.size],
        steal: [a.steal, a.stealChance],
        foldToSteal: [a.foldToSteal, a.foldToStealChance],
        riverCallAccuracy: [a.riverCallWon, a.riverCall],
        vpipF: [a.vpipF, a.vpipFOpportunityHands.size],
      }
    })
  }
  return result
}
