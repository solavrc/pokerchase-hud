import { BattleType, type Hand } from '../types'
import { isHandInSessionScope } from './session-event-scope'

const hand = (
  scopeKey: string | undefined,
  id = 'shared-session',
  approxTimestamp = 2000
): Pick<Hand, 'session' | 'approxTimestamp'> => ({
  session: {
    scopeKey,
    id,
    battleType: BattleType.RING_GAME,
  },
  approxTimestamp,
})

describe('isHandInSessionScope', () => {
  test('matches durable scope keys exactly', () => {
    const scope = {
      scopeKey: 'run-b',
      id: 'shared-session',
      startedAt: 1000,
    }

    expect(isHandInSessionScope(hand('run-b'), scope)).toBe(true)
    expect(isHandInSessionScope(hand('run-a'), scope)).toBe(false)
  })

  test('falls back to the legacy boundary when only the hand lacks a scope key', () => {
    const scope = {
      scopeKey: 'legacy-run:4:shared-session:1000',
      id: 'shared-session',
      startedAt: 1000,
    }

    expect(isHandInSessionScope(hand(undefined), scope)).toBe(true)
    expect(isHandInSessionScope(hand(undefined, 'other-session'), scope)).toBe(false)
    expect(isHandInSessionScope(hand(undefined, 'shared-session', 999), scope)).toBe(false)
  })

  test('does not boundary-match a keyed hand when the active scope is legacy', () => {
    const scope = {
      id: 'shared-session',
      startedAt: 1000,
    }

    expect(isHandInSessionScope(hand('run-a'), scope)).toBe(false)
  })
})
