/**
 * Unit tests for the HUD stat display config persistence decision logic
 * (src/background/hud-config-sync.ts, #100 review)
 */
import { needsConfigPersist } from './hud-config-sync'
import type { StatDisplayConfig } from '../types/filters'

const config = (id: string, order: number, enabled = true): StatDisplayConfig => ({ id, enabled, order })

describe('needsConfigPersist', () => {
  it('returns false when saved and merged have the same id set (no new/removed stats)', () => {
    const saved = [config('vpip', 0), config('pfr', 1)]
    const merged = [config('vpip', 0, false), config('pfr', 1)] // enabled/order differ, that's fine

    expect(needsConfigPersist(saved, merged)).toBe(false)
  })

  it('returns true when merged has more entries than saved (new stat added, e.g. #86 STL/FTS)', () => {
    const saved = [config('vpip', 0), config('pfr', 1)]
    const merged = [config('vpip', 0), config('pfr', 1), config('stl', 2)]

    expect(needsConfigPersist(saved, merged)).toBe(true)
  })

  it('returns true when merged has fewer entries than saved (stat removed/deprecated)', () => {
    const saved = [config('vpip', 0), config('pfr', 1), config('deprecated', 2)]
    const merged = [config('vpip', 0), config('pfr', 1)]

    expect(needsConfigPersist(saved, merged)).toBe(true)
  })

  it('returns true when the id sets differ even at the same length (swap)', () => {
    const saved = [config('vpip', 0), config('pfr', 1)]
    const merged = [config('vpip', 0), config('af', 1)]

    expect(needsConfigPersist(saved, merged)).toBe(true)
  })

  it('returns true when saved is undefined and merged is non-empty (first-time persist)', () => {
    expect(needsConfigPersist(undefined, [config('vpip', 0)])).toBe(true)
  })

  it('returns false when saved is undefined and merged is empty', () => {
    expect(needsConfigPersist(undefined, [])).toBe(false)
  })

  it('returns true when saved is an empty array and merged is non-empty', () => {
    expect(needsConfigPersist([], [config('vpip', 0)])).toBe(true)
  })

  it('is idempotent: once persisted, a second comparison with the merged result as "saved" returns false', () => {
    const saved = [config('vpip', 0), config('pfr', 1)]
    const merged = [config('vpip', 0), config('pfr', 1), config('stl', 2)]

    expect(needsConfigPersist(saved, merged)).toBe(true)
    // Simulate the write having happened - the next startup compares merged against itself
    expect(needsConfigPersist(merged, merged)).toBe(false)
  })
})
