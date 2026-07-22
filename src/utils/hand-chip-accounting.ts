import type { ApiEvent } from '../types/api'
import { ApiType } from '../types/api'
import { BetStatusType } from '../types/game'

type DealEvent = ApiEvent<ApiType.EVT_DEAL>
type HandResultsEvent = ApiEvent<ApiType.EVT_HAND_RESULTS>

interface ChipSnapshot {
  SeatIndex: number
  Chip: number
  BetChip: number
  BetStatus: number
}

export interface PlayerHandChipAccounting {
  /** EVT_HAND_RESULTS.Results[].RewardChip. Includes uncalled returns. */
  grossPayout: number
  /** Every chip committed during the hand, including forced posts and returned excess. */
  totalContribution: number
  /** grossPayout - totalContribution. */
  netChips: number
}

export type PlayerHandChipAccountingMap = Record<string, PlayerHandChipAccounting | null>

const getDealSnapshot = (event: DealEvent, seatIndex: number): ChipSnapshot | undefined => {
  if (event.Player?.SeatIndex === seatIndex) return event.Player
  return event.OtherPlayers.find(player => player.SeatIndex === seatIndex)
}

const getResultSnapshot = (event: HandResultsEvent, seatIndex: number): ChipSnapshot | undefined => {
  if (event.Player?.SeatIndex === seatIndex) return event.Player
  return event.OtherPlayers.find(player => player.SeatIndex === seatIndex)
}

/**
 * Whether the seat paid this hand's ante. This is shared with HandLogProcessor
 * so the HUD and exported hand history use one interpretation of DEAL state.
 */
export const isAnteContributor = (event: DealEvent, seatIndex: number): boolean => {
  const betStatus = getDealSnapshot(event, seatIndex)?.BetStatus
  return betStatus === undefined ||
    betStatus === BetStatusType.BET_ABLE ||
    betStatus === BetStatusType.ALL_IN
}

/**
 * Stack after the ante but before restoring the posted blind. At EVT_DEAL,
 * Chip is after all forced posts and BetChip is the street-cumulative forced
 * amount (currently blinds), so Chip + BetChip restores it without double-
 * counting. The same rule also covers a future straddle-like forced post if
 * PokerChase reports it through BetChip.
 */
export const getPlayerChipsAfterAnte = (event: DealEvent, seatIndex: number): number | null => {
  const snapshot = getDealSnapshot(event, seatIndex)
  return snapshot ? snapshot.Chip + snapshot.BetChip : null
}

const countAnteContributors = (event: DealEvent): number =>
  event.SeatUserIds.reduce((count, userId, seatIndex) =>
    userId !== -1 && isAnteContributor(event, seatIndex) ? count + 1 : count, 0)

/**
 * Recover the stack immediately before this hand's forced posts.
 *
 * A normal stack is directly observable as Chip + BetChip + Ante. A player
 * reduced to Chip=0/BetChip=0 by a short ante has no per-seat starting amount
 * on the wire. We only accept the main-pot tier when it identifies that seat
 * uniquely (one such seat), or when every such seat necessarily shares the
 * same tier (no side pot). Otherwise the answer is deliberately unknown.
 */
export const deriveStartingStack = (event: DealEvent, seatIndex: number): number | null => {
  const snapshot = getDealSnapshot(event, seatIndex)
  if (!snapshot) return null

  const chipsAfterAnte = snapshot.Chip + snapshot.BetChip
  if (!isAnteContributor(event, seatIndex)) return chipsAfterAnte

  const ante = event.Game.Ante ?? 0
  if (chipsAfterAnte > 0 || ante === 0) return chipsAfterAnte + ante

  const anteAllInSeats = event.SeatUserIds
    .map((userId, index) => ({ userId, index }))
    .filter(({ userId, index }) =>
      userId !== -1 &&
      isAnteContributor(event, index) &&
      getPlayerChipsAfterAnte(event, index) === 0)
    .map(({ index }) => index)

  if (anteAllInSeats.length > 1 && event.Progress.SidePot.length > 0) return null

  const contributorCount = countAnteContributors(event)
  if (contributorCount <= 0 || event.Progress.Pot % contributorCount !== 0) return null

  const inferredStack = event.Progress.Pot / contributorCount
  if (!Number.isSafeInteger(inferredStack) || inferredStack <= 0 || inferredStack > ante) return null
  return inferredStack
}

const emptyAccounting = (event: DealEvent): PlayerHandChipAccountingMap =>
  Object.fromEntries(event.SeatUserIds.filter(userId => userId !== -1).map(userId => [String(userId), null]))

/**
 * Derive exact signed per-player chip results from one causal DEAL -> RESULTS
 * pair. `RewardChip` is gross payout (and can be an uncalled return), so:
 *
 *   contribution = starting stack + gross payout - final stack
 *   net          = gross payout - contribution
 *
 * The equivalent final-start delta is used only after validating the payout,
 * lineup, and per-seat snapshots. EVT_ACTION.BetChip is intentionally not
 * summed: it is cumulative within each street, so replaying it as incremental
 * amounts would double-count calls/raises. Endpoint stacks also remain exact
 * when a redundant action was not captured. Any ambiguous or inconsistent
 * player remains null rather than receiving an estimated loss. Table-wide
 * starting/final totals are deliberately not required to match: Ring rake is
 * a legitimate chip outflow, so exact per-seat net can sum to `-rake`.
 */
export const derivePlayerHandChipAccounting = (
  deal: DealEvent,
  results: HandResultsEvent
): PlayerHandChipAccountingMap => {
  const accounting = emptyAccounting(deal)
  const dealtUserIds = new Set(deal.SeatUserIds.filter(userId => userId !== -1))

  // Imported legacy/test rows can bypass the current API parser. Missing
  // settlement fields are an unknown result, never a reason to throw or infer.
  if (!Array.isArray(results.Results) ||
      !Array.isArray(results.SidePot) ||
      !Number.isSafeInteger(results.Pot) ||
      !Array.isArray(results.OtherPlayers)) return accounting

  if (results.Results.some(result => !dealtUserIds.has(result.UserId))) return accounting
  if (new Set(results.Results.map(result => result.UserId)).size !== results.Results.length) return accounting

  const grossPot = results.Pot + results.SidePot.reduce((sum, pot) => sum + pot, 0)
  const grossPayout = results.Results.reduce((sum, result) => sum + result.RewardChip, 0)
  if (!Number.isSafeInteger(grossPot) || grossPot !== grossPayout) return accounting

  const finalSeats = [
    ...(results.Player ? [results.Player] : []),
    ...results.OtherPlayers,
  ]
  const duplicateFinalSeat = finalSeats.some((snapshot, index) =>
    finalSeats.findIndex(candidate => candidate.SeatIndex === snapshot.SeatIndex) !== index)
  if (duplicateFinalSeat) return accounting

  const starts = new Map<number, number>()
  for (let seatIndex = 0; seatIndex < deal.SeatUserIds.length; seatIndex++) {
    if (deal.SeatUserIds[seatIndex] === -1) continue
    const startingStack = deriveStartingStack(deal, seatIndex)
    if (startingStack === null) continue
    starts.set(seatIndex, startingStack)
  }

  for (let seatIndex = 0; seatIndex < deal.SeatUserIds.length; seatIndex++) {
    const userId = deal.SeatUserIds[seatIndex]
    if (userId === undefined || userId === -1) continue

    const startingStack = starts.get(seatIndex)
    const finalSnapshot = getResultSnapshot(results, seatIndex)
    if (startingStack === undefined || !finalSnapshot) continue

    const payout = results.Results.find(result => result.UserId === userId)?.RewardChip ?? 0
    const finalStack = finalSnapshot.Chip + finalSnapshot.BetChip
    const totalContribution = startingStack + payout - finalStack
    if (!Number.isSafeInteger(totalContribution) || totalContribution < 0 || totalContribution > startingStack) continue

    const netChips = payout - totalContribution
    if (!Number.isSafeInteger(netChips) || netChips !== finalStack - startingStack) continue

    accounting[String(userId)] = {
      grossPayout: payout,
      totalContribution,
      netChips,
    }
  }

  return accounting
}
