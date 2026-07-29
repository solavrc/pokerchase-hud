import { EntityConverter, type EntityBundle } from '../entity-converter'
import type { ApiEvent, Session } from '../types'
import { getRawEventSessionContext } from './raw-event-session-context'

const emptyBundle = (): EntityBundle => ({
  hands: [],
  phases: [],
  actions: [],
})

const appendBundle = (target: EntityBundle, source: EntityBundle): void => {
  target.hands.push(...source.hands)
  target.phases.push(...source.phases)
  target.actions.push(...source.actions)
}

/**
 * Replays one shared Raw Event Lake without allowing concurrent sessions to
 * overwrite each other's EntityConverter state.
 */
export class SessionScopedEntityConverter {
  private readonly legacyConverter: EntityConverter
  private readonly scopedConverters = new Map<string, EntityConverter>()

  constructor(defaultSession: Session) {
    this.legacyConverter = new EntityConverter(defaultSession)
  }

  private converterFor(event: ApiEvent): EntityConverter {
    const context = getRawEventSessionContext(event)
    if (!context) return this.legacyConverter

    const converterKey = context.originId
      ? `${context.originId}\u0000${context.scopeKey}`
      : context.scopeKey
    let converter = this.scopedConverters.get(converterKey)
    if (!converter) {
      converter = new EntityConverter({
        scopeKey: context.scopeKey,
        id: context.id,
        battleType: context.battleType,
        name: undefined,
        players: new Map(),
        reset: () => { },
      })
      this.scopedConverters.set(converterKey, converter)
    }
    return converter
  }

  convertEventChunk(events: ApiEvent[]): EntityBundle {
    const result = emptyBundle()
    const eventsByConverter = new Map<EntityConverter, ApiEvent[]>()

    for (const event of events) {
      const converter = this.converterFor(event)
      const scopedEvents = eventsByConverter.get(converter) ?? []
      scopedEvents.push(event)
      eventsByConverter.set(converter, scopedEvents)
    }
    for (const [converter, scopedEvents] of eventsByConverter) {
      appendBundle(result, converter.convertEventChunk(scopedEvents))
    }
    return result
  }

  flush(): EntityBundle {
    const result = emptyBundle()
    for (const converter of [this.legacyConverter, ...this.scopedConverters.values()]) {
      appendBundle(result, converter.flush())
    }
    return result
  }

  convertEventsToEntities(events: ApiEvent[]): EntityBundle {
    const result = this.convertEventChunk(events)
    appendBundle(result, this.flush())
    return result
  }
}
