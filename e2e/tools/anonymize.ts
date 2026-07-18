/**
 * Pure, dependency-free anonymization of captured PokerChase API events.
 *
 * Deterministically remaps every real `UserId`/`UserName` pair found in a
 * list of decoded API events (see docs/api-events.md) to a small synthetic
 * id space (1001, 1002, ...) and "Player{n}" names. The same real UserId
 * always maps to the same synthetic id across the whole event list, so
 * hand/session logic that keys off UserId (seat tracking, VPIP, etc.)
 * behaves identically on the anonymized fixture.
 *
 * No network/filesystem access -- kept pure so it's easy to unit test and
 * safe to reuse from `extract-fixture.ts` or ad-hoc scripts.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const SYNTHETIC_ID_BASE = 1001

/** Maps a synthetic UserId (as produced by `anonymizeEvents`) to its display name, e.g. 1001 -> "Player1". */
export const syntheticPlayerName = (syntheticId: number): string =>
  `Player${syntheticId - SYNTHETIC_ID_BASE + 1}`

export interface AnonymizeStats {
  /** real UserId -> synthetic UserId, for logging/debugging by callers. */
  idMap: Map<number, number>
}

/**
 * Anonymizes a list of decoded (already `JSON.parse`d) API event objects.
 * Returns new objects; the input is not mutated.
 *
 * Fields walked, per docs/api-events.md:
 *   - `UserId` + `UserName` pairs (EVT_PLAYER_JOIN.JoinUser,
 *     EVT_PLAYER_SEAT_ASSIGNED.TableUsers[])
 *   - bare `UserId` (EVT_HAND_RESULTS.Results[].UserId)
 *   - `SeatUserIds[]` / `OnlineUserIds[]` (-1 = empty seat, left untouched)
 */
export const anonymizeEvents = (events: unknown[], stats: AnonymizeStats = { idMap: new Map() }): unknown[] => {
  const { idMap } = stats
  let nextId = SYNTHETIC_ID_BASE + idMap.size

  const mapId = (id: number): number => {
    if (id === -1) return -1
    let mapped = idMap.get(id)
    if (mapped === undefined) {
      mapped = nextId++
      idMap.set(id, mapped)
    }
    return mapped
  }

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk)
    if (!isRecord(value)) return value

    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      if (key === 'UserId' && typeof val === 'number') {
        out[key] = mapId(val)
      } else if (key === 'UserName' && typeof val === 'string' && typeof value['UserId'] === 'number') {
        out[key] = syntheticPlayerName(mapId(value['UserId'] as number))
      } else if ((key === 'SeatUserIds' || key === 'OnlineUserIds') && Array.isArray(val)) {
        out[key] = val.map((v) => (typeof v === 'number' ? mapId(v) : v))
      } else {
        out[key] = walk(val)
      }
    }
    return out
  }

  return events.map(walk)
}
