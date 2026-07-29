import type { BattleType } from '../types'

/**
 * Internal storage envelope metadata. The PokerChase payload itself remains
 * unchanged; this sibling field records which concurrent browser session
 * observed the event so canonical replay can reproduce the live attribution.
 */
export const RAW_EVENT_SESSION_CONTEXT_FIELD = '__pokerChaseHudSessionContext'

export type RawEventSessionContext = Readonly<{
  scopeKey: string
  id: string
  battleType: BattleType
  startedAt: number
}>

export const getRawEventSessionContext = (event: unknown): RawEventSessionContext | undefined => {
  if (event === null || typeof event !== 'object') return undefined
  const context = (event as Record<string, unknown>)[RAW_EVENT_SESSION_CONTEXT_FIELD]
  if (context === null || typeof context !== 'object') return undefined
  const candidate = context as Record<string, unknown>
  if (
    typeof candidate.scopeKey !== 'string' ||
    typeof candidate.id !== 'string' ||
    typeof candidate.battleType !== 'number' ||
    typeof candidate.startedAt !== 'number' ||
    !Number.isFinite(candidate.startedAt)
  ) {
    return undefined
  }
  return {
    scopeKey: candidate.scopeKey,
    id: candidate.id,
    battleType: candidate.battleType as BattleType,
    startedAt: candidate.startedAt,
  }
}

export const withRawEventSessionContext = <T extends object>(
  event: T,
  context: RawEventSessionContext | undefined
): T => context
  ? { ...event, [RAW_EVENT_SESSION_CONTEXT_FIELD]: { ...context } }
  : event
