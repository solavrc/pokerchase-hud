import { ApiType, type ApiEvent, type ApiHandEvent } from '../types/api'
import { BetStatusType } from '../types/game'

/** 配札時の人物と異なる着席を観測した席。DEALのlineup自体は変更しない（MUST）。 */
export const getReplacedDealtSeat = (
  deal: ApiEvent<ApiType.EVT_DEAL> | undefined,
  join: ApiEvent<ApiType.EVT_PLAYER_JOIN>
): number | undefined => {
  const seatIndex = join.JoinPlayer?.SeatIndex
  const joinedUserId = join.JoinUser?.UserId
  if (!Number.isSafeInteger(seatIndex) || !Number.isSafeInteger(joinedUserId) || joinedUserId < 0) return undefined
  const dealtUserId = deal?.SeatUserIds[seatIndex]
  return dealtUserId !== undefined && dealtUserId !== -1 && dealtUserId !== joinedUserId
    ? seatIndex
    : undefined
}

export const getReplacedDealtSeats = (
  deal: ApiEvent<ApiType.EVT_DEAL>,
  handEvents: readonly ApiHandEvent[] | undefined
): Set<number> => {
  const replacedSeats = new Set<number>()
  for (const event of handEvents ?? []) {
    if (event.ApiTypeId !== ApiType.EVT_PLAYER_JOIN) continue
    const seat = getReplacedDealtSeat(deal, event)
    if (seat !== undefined) replacedSeats.add(seat)
  }
  return replacedSeats
}

/** 301 has no table id: this is an identity uncertainty boundary, not proof of table membership. */
export const getSeatIdentityEvidence = (deal: ApiEvent<ApiType.EVT_DEAL>, events: readonly ApiHandEvent[] = []) => {
  const boundaries = new Map<number, ApiEvent<ApiType.EVT_PLAYER_JOIN>>()
  const ambiguousSeats = new Set<number>()
  const results = events.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)
  for (const event of events) {
    if (event.ApiTypeId !== ApiType.EVT_PLAYER_JOIN) continue
    const seat = getReplacedDealtSeat(deal, event)
    if (seat === undefined) continue
    const prior = boundaries.get(seat)
    if (!prior || event.timestamp! < prior.timestamp!) boundaries.set(seat, event)
  }
  const atOrAfterBoundary = (seat: number, event: ApiHandEvent): boolean => {
    const boundary = boundaries.get(seat)
    if (!boundary) return false
    return Number.isFinite(event.timestamp) && Number.isFinite(boundary.timestamp)
      ? event.timestamp! >= boundary.timestamp!
      : events.indexOf(event) >= events.indexOf(boundary)
  }
  for (const [seat, boundary] of boundaries) {
    // Raw Lake's per-type key order does not establish chronology inside a millisecond.
    if (Number.isFinite(boundary.timestamp) && events.some(event =>
      [ApiType.EVT_DEAL, ApiType.EVT_ACTION, ApiType.EVT_DEAL_ROUND, ApiType.EVT_HAND_RESULTS].includes(event.ApiTypeId) &&
      event.timestamp === boundary.timestamp)) ambiguousSeats.add(seat)
    for (const event of events) {
      if (!atOrAfterBoundary(seat, event)) continue
      if (event.ApiTypeId === ApiType.EVT_ACTION && event.SeatIndex === seat) ambiguousSeats.add(seat)
      if (event.ApiTypeId === ApiType.EVT_PLAYER_SEAT_ASSIGNED && event.timestamp! < results?.timestamp! && event.SeatUserIds[seat] === deal.SeatUserIds[seat]) ambiguousSeats.add(seat)
      if (event.ApiTypeId === ApiType.EVT_DEAL_ROUND &&
          (event.Player ? [event.Player, ...event.OtherPlayers] : event.OtherPlayers).some(snapshot =>
            snapshot.SeatIndex === seat &&
            (snapshot.BetStatus === BetStatusType.BET_ABLE || snapshot.BetStatus === BetStatusType.ALL_IN || snapshot.BetChip > 0))) {
        ambiguousSeats.add(seat)
      }
    }
  }
  return { boundaries, ambiguousSeats, atOrAfterBoundary }
}
