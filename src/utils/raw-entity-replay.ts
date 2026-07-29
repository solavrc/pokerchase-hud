import { EntityConverter, type EntityBundle } from '../entity-converter'
import {
  ApiType,
  BattleType,
  isApiEventType,
  isApplicationApiEvent,
  parseApiEvent,
} from '../types'
import type { ApiEvent, Session } from '../types'

type RawReplayEvent = Record<string, unknown> & {
  timestamp?: number
  ApiTypeId: number
  sequence?: number
}

// Entry cancellation is intentionally outside ApiType/application streams,
// but remains a raw lifecycle boundary for every replay path.
const EVT_ENTRY_CANCELLED_API_TYPE_ID = 203

type ReplayEntryBoundary = {
  id?: string
  battleType?: BattleType
}

type ReplaySessionSnapshot = {
  id?: string
  battleType?: BattleType
  name?: string
  players: Array<[number, { name: string, rank: string }]>
}

export type RawEntityReplaySnapshot = {
  session: ReplaySessionSnapshot
  replayEnded: boolean
  latestDealEvent?: ApiEvent<ApiType.EVT_DEAL>
  validApplicationEventCount: number
}

export type RawEntityReplayResult = {
  entities: EntityBundle
  snapshot: RawEntityReplaySnapshot
}

const REPLAY_BATTLE_TYPES = new Set<number>([
  BattleType.SIT_AND_GO,
  BattleType.TOURNAMENT,
  BattleType.FRIEND_SIT_AND_GO,
  BattleType.RING_GAME,
  BattleType.FRIEND_RING_GAME,
  BattleType.CLUB_MATCH,
])

/**
 * Raw 201 recovery mirrors live ingestion: explicit Code failures are not
 * boundaries; successful minimally usable Id/BattleType are restored; all
 * other non-failure 201 shapes clear prior context fail-closed.
 */
const getReplayEntryBoundary = (
  event: unknown
): ReplayEntryBoundary | undefined => {
  const raw = event as {
    ApiTypeId?: unknown
    Code?: unknown
    Id?: unknown
    BattleType?: unknown
  }
  if (raw.ApiTypeId !== ApiType.EVT_ENTRY_QUEUED) return undefined
  if (typeof raw.Code === 'number' && raw.Code !== 0) return undefined
  if (
    raw.Code === 0 &&
    typeof raw.Id === 'string' &&
    typeof raw.BattleType === 'number' &&
    REPLAY_BATTLE_TYPES.has(raw.BattleType)
  ) {
    return {
      id: raw.Id,
      battleType: raw.BattleType as BattleType,
    }
  }
  return {}
}

/**
 * Stateful raw-Lake replay shared by cloud download, manual rebuild and
 * post-import rebuild. Raw lifecycle rows drive the session state machine in
 * the same order as validated application events reach EntityConverter.
 */
export class RawEntityReplay {
  private readonly converter: EntityConverter
  private readonly session = {
    id: undefined as string | undefined,
    battleType: undefined as BattleType | undefined,
    name: undefined as string | undefined,
    players: new Map<number, { name: string, rank: string }>(),
  }
  private pendingFriendSngSession?: ReplaySessionSnapshot
  private replayEnded = false
  private latestDealEvent?: ApiEvent<ApiType.EVT_DEAL>
  private validApplicationEventCount = 0

  constructor(seed: Session) {
    this.applySessionSnapshot({
      id: seed.id,
      battleType: seed.battleType,
      name: seed.name,
      players: [...seed.players.entries()].map(([userId, info]) => [
        userId,
        { ...info },
      ]),
    })
    this.converter = new EntityConverter(seed)
  }

  convertChunk(events: RawReplayEvent[]): EntityBundle {
    const entities: EntityBundle = { hands: [], phases: [], actions: [] }
    let validSegment: ApiEvent[] = []

    const convertValidSegment = (): void => {
      if (validSegment.length === 0) return
      const converted = this.converter.convertEventChunk(validSegment)
      entities.hands.push(...converted.hands)
      entities.phases.push(...converted.phases)
      entities.actions.push(...converted.actions)
      validSegment = []
    }

    for (const event of events) {
      const parsed = parseApiEvent(event)
      const validApplicationEvent =
        parsed && isApplicationApiEvent(parsed) ? parsed : undefined
      const entryBoundary = getReplayEntryBoundary(event)
      const isEntry = entryBoundary !== undefined
      const isSessionResult =
        event.ApiTypeId === ApiType.EVT_SESSION_RESULTS
      const isEntryCancellation =
        event.ApiTypeId === EVT_ENTRY_CANCELLED_API_TYPE_ID

      // Boundaries apply after every preceding validated event, while the raw
      // boundary itself remains excluded when it is unsafe/non-application.
      if (isEntry || isSessionResult || isEntryCancellation) {
        convertValidSegment()
      }

      if (isEntry) {
        this.latestDealEvent = undefined
        this.pendingFriendSngSession = undefined
        this.resetSession()
        if (entryBoundary.id !== undefined && entryBoundary.battleType !== undefined) {
          this.session.id = entryBoundary.id
          this.session.battleType = entryBoundary.battleType
        }
        this.converter.applySessionSnapshot(this.session)
        this.replayEnded = false
      } else if (
        isSessionResult &&
        this.session.battleType === BattleType.FRIEND_SIT_AND_GO
      ) {
        // A Friend SNG 309 is provisional: the shared raw Lake can interleave
        // another private match's result. Keep the converter context until the
        // next DEAL decides whether this hand stream continued.
        this.pendingFriendSngSession = this.captureSession()
        this.latestDealEvent = undefined
        this.resetSession()
        this.replayEnded = true
      } else if (isSessionResult || isEntryCancellation) {
        this.pendingFriendSngSession = undefined
        this.latestDealEvent = undefined
        this.resetSession()
        this.converter.applySessionSnapshot(this.session)
        this.replayEnded = true
      } else {
        this.restoreSessionMetadata(event)
      }

      if (
        this.pendingFriendSngSession &&
        this.session.battleType === undefined &&
        isApiEventType(event, ApiType.EVT_DEAL)
      ) {
        // Settle events between the provisional terminal and this DEAL under
        // their original context. A seated deal proves continuation. A
        // spectator deal instead switches the converter to the terminal empty
        // context before that new hand is buffered.
        convertValidSegment()
        if (event.Player?.SeatIndex !== undefined) {
          this.applySessionSnapshot(this.pendingFriendSngSession)
          this.converter.applySessionSnapshot(this.session)
          this.pendingFriendSngSession = undefined
          this.replayEnded = false
        } else {
          this.converter.applySessionSnapshot(this.session)
        }
      }

      if (validApplicationEvent) {
        validSegment.push(validApplicationEvent)
        this.validApplicationEventCount++
      }

      if (
        validApplicationEvent &&
        isApiEventType(validApplicationEvent, ApiType.EVT_DEAL) &&
        validApplicationEvent.Player?.SeatIndex !== undefined
      ) {
        this.latestDealEvent = validApplicationEvent
      }
    }

    convertValidSegment()
    return entities
  }

  convertEvents(events: RawReplayEvent[]): EntityBundle {
    const entities = this.convertChunk(events)
    const remaining = this.flush()
    entities.hands.push(...remaining.hands)
    entities.phases.push(...remaining.phases)
    entities.actions.push(...remaining.actions)
    return entities
  }

  flush(): EntityBundle {
    return this.converter.flush()
  }

  snapshot(): RawEntityReplaySnapshot {
    return {
      session: this.captureSession(),
      replayEnded: this.replayEnded,
      latestDealEvent: this.latestDealEvent,
      validApplicationEventCount: this.validApplicationEventCount,
    }
  }

  private captureSession(): ReplaySessionSnapshot {
    return {
      id: this.session.id,
      battleType: this.session.battleType,
      name: this.session.name,
      players: [...this.session.players.entries()].map(([userId, info]) => [
        userId,
        { ...info },
      ]),
    }
  }

  private applySessionSnapshot(snapshot: ReplaySessionSnapshot): void {
    this.resetSession()
    this.session.id = snapshot.id
    this.session.battleType = snapshot.battleType
    this.session.name = snapshot.name
    for (const [userId, info] of snapshot.players) {
      this.session.players.set(userId, { ...info })
    }
  }

  private resetSession(): void {
    this.session.id = undefined
    this.session.battleType = undefined
    this.session.name = undefined
    this.session.players.clear()
  }

  private restoreSessionMetadata(event: RawReplayEvent): void {
    if (isApiEventType(event, ApiType.EVT_SESSION_DETAILS)) {
      this.session.name = event.Name
    } else if (isApiEventType(event, ApiType.EVT_PLAYER_SEAT_ASSIGNED)) {
      event.TableUsers?.forEach(tableUser => {
        this.session.players.set(tableUser.UserId, {
          name: tableUser.UserName,
          rank: tableUser.Rank.RankId,
        })
      })
    } else if (isApiEventType(event, ApiType.EVT_PLAYER_JOIN) && event.JoinUser) {
      this.session.players.set(event.JoinUser.UserId, {
        name: event.JoinUser.UserName,
        rank: event.JoinUser.Rank.RankId,
      })
    }
  }
}

/**
 * Async one-shot boundary used by manual/import rebuilds. Keeping this
 * awaited seam lets callers preserve their snapshot-vs-live-write
 * transaction tests while sharing the exact same raw replay state machine.
 */
export const convertRawEventsToEntities = async (
  events: RawReplayEvent[],
  seed: Session
): Promise<RawEntityReplayResult> => {
  const replay = new RawEntityReplay(seed)
  const entities = replay.convertEvents(events)
  return {
    entities,
    snapshot: replay.snapshot(),
  }
}
