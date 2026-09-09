import { ActionType, ApiType, BetStatusType, PhaseType, RankType, isShowdownParticipant, type ApiEvent, type ApiHandEvent } from '../types'
import type { Action, Phase } from '../types/entities'
import type { getSeatIdentityEvidence } from './seat-occupancy'

/** 配信・省略の両経路でFLOP参加を同じ人物証拠から判定する。Resultsの存在だけでは肯定しない（MUST NOT）。 */
export function deriveFlopParticipation(
  deal: ApiEvent<ApiType.EVT_DEAL>,
  events: readonly ApiHandEvent[],
  identity: ReturnType<typeof getSeatIdentityEvidence>,
  actions: readonly Pick<Action, 'phase' | 'actionType' | 'playerId'>[],
  flop: Pick<Phase, 'seatUserIds'> | undefined,
  results: ApiEvent<ApiType.EVT_HAND_RESULTS>,
  boardCardCount: number,
) {
  const participants = new Set(flop?.seatUserIds ?? [])
  const nonparticipants = new Set(actions.filter(action => action.phase === PhaseType.PREFLOP &&
    action.actionType === ActionType.FOLD).map(action => action.playerId))
  for (const event of events) {
    if (event.ApiTypeId !== ApiType.EVT_DEAL_ROUND || event.Progress.Phase !== PhaseType.FLOP) continue
    for (const player of event.Player ? [event.Player, ...event.OtherPlayers] : event.OtherPlayers) {
      if (!identity.atOrAfterBoundary(player.SeatIndex, event) &&
          [BetStatusType.FOLDED, BetStatusType.NOT_IN_PLAY, BetStatusType.ELIMINATED].includes(player.BetStatus)) {
        nonparticipants.add(deal.SeatUserIds[player.SeatIndex]!)
      }
    }
  }
  for (const action of actions) {
    if (action.phase > PhaseType.PREFLOP && !nonparticipants.has(action.playerId)) participants.add(action.playerId)
  }
  const showdown = results.Results.filter(isShowdownParticipant)
  if (boardCardCount >= 3 && showdown.length >= 2) {
    for (const { UserId } of showdown) if (!nonparticipants.has(UserId)) participants.add(UserId)
  }
  const foldOpen = new Set(results.Results.filter(result => result.RankType === RankType.FOLD_OPEN).map(result => result.UserId))
  // 通常のtimeout欠測へ拡張せず、人物境界と無305のFOLD_OPENだけを未知候補にする。
  const unprovenPlayerIds = deal.SeatUserIds.filter((userId, seat) => userId !== -1 &&
    !participants.has(userId) && !nonparticipants.has(userId) &&
    (identity.boundaries.has(seat) || (!flop && foldOpen.has(userId))))
  return {
    seatUserIds: deal.SeatUserIds.filter(userId => userId !== -1 && participants.has(userId)),
    unprovenPlayerIds,
  }
}
