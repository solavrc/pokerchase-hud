import { ActionType, ApiType, PhaseType, type ApiEvent, type ApiHandEvent } from '../types'
import { getApplicableActionMenu } from './action-raise-option'
import { HAND_ENDING_NEXT_ACTION_SEAT } from './action-phase'
import type { getSeatIdentityEvidence } from './seat-occupancy'

/** 先行人物・ベット履歴に依存する6統計。確定済みflagは遡って消さない（MUST NOT）。 */
export const IDENTITY_CONTEXT_STAT_IDS = new Set(['3bet', '3betfold', 'cbet', 'cbetFold', 'steal', 'foldToSteal'])

export function getIdentityStatEligibility(
  deal: ApiEvent<ApiType.EVT_DEAL>,
  events: readonly ApiHandEvent[],
  identity: ReturnType<typeof getSeatIdentityEvidence>,
) {
  const unattributedActions = events.filter((event): event is ApiEvent<ApiType.EVT_ACTION> =>
    event.ApiTypeId === ApiType.EVT_ACTION && identity.atOrAfterBoundary(event.SeatIndex, event))
  const atOrBefore = (left: ApiHandEvent, right: ApiHandEvent): boolean =>
    Number.isFinite(left.timestamp) && Number.isFinite(right.timestamp)
      ? left.timestamp! <= right.timestamp!
      : events.indexOf(left) <= events.indexOf(right)
  const contextUnproven = (event: ApiEvent<ApiType.EVT_ACTION>): boolean =>
    unattributedActions.some(unknown => atOrBefore(unknown, event))
  let firstPostflopTimestamp = Number.POSITIVE_INFINITY
  for (const event of events) {
    if (event.ApiTypeId !== ApiType.EVT_ACTION && event.ApiTypeId !== ApiType.EVT_DEAL_ROUND) continue
    if (event.ApiTypeId === ApiType.EVT_ACTION &&
        (event.Progress.NextActionSeat === HAND_ENDING_NEXT_ACTION_SEAT ||
         deal.SeatUserIds[event.SeatIndex] === undefined || deal.SeatUserIds[event.SeatIndex] === -1)) continue
    if (event.Progress.Phase > PhaseType.PREFLOP && event.Progress.Phase <= PhaseType.RIVER &&
        Number.isFinite(event.timestamp)) firstPostflopTimestamp = Math.min(firstPostflopTimestamp, event.timestamp!)
  }

  return {
    contextUnproven,
    preflopOmission: (event: ApiEvent<ApiType.EVT_ACTION>, phase: PhaseType): boolean => {
      if (event.Progress.NextActionSeat !== HAND_ENDING_NEXT_ACTION_SEAT) return phase === PhaseType.PREFLOP
      // 終端行のPhaseは3固定。同msの305/304の保存順でpreflop否定を作らない（MUST NOT）。
      // 厳密に先行する街の証拠がある場合だけ、除外行をpostflop限定として扱う。
      return !Number.isFinite(event.timestamp) || firstPostflopTimestamp >= event.timestamp!
    },
    normalizationUnproven: (
      event: ApiEvent<ApiType.EVT_ACTION>,
      previous: ApiHandEvent | undefined,
      phase: PhaseType,
    ): boolean => {
      if (event.ActionType !== ActionType.ALL_IN || !contextUnproven(event)) return false
      // 人物不明rowや同ms順に依存した候補typeは、統計上の確定typeにしない（MUST NOT）。
      if (!previous || (previous.ApiTypeId !== ApiType.EVT_ACTION && previous.ApiTypeId !== ApiType.EVT_DEAL &&
          previous.ApiTypeId !== ApiType.EVT_DEAL_ROUND) || !Number.isFinite(previous.timestamp) ||
          !Number.isFinite(event.timestamp) || previous.timestamp! >= event.timestamp!) return true
      if (previous.ApiTypeId === ApiType.EVT_ACTION &&
          (identity.atOrAfterBoundary(previous.SeatIndex, previous) ||
           deal.SeatUserIds[previous.SeatIndex] === undefined || deal.SeatUserIds[previous.SeatIndex] === -1)) return true
      if (unattributedActions.some(unknown => atOrBefore(unknown, event) &&
          (!Number.isFinite(unknown.timestamp) || previous.timestamp! <= unknown.timestamp!))) return true
      // 後から取得した独立の当該席・街メニューは型だけを回復する。6統計の履歴は回復しない。
      return getApplicableActionMenu(previous.Progress, event.SeatIndex, phase) === undefined
    },
  }
}
