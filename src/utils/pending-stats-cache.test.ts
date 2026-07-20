import { setPendingStats, consumePendingStats } from './pending-stats-cache'
import type { StatsData } from '../content_script'

describe('pending-stats-cache', () => {
  test('consumePendingStats returns undefined when nothing was cached', () => {
    expect(consumePendingStats()).toBeUndefined()
  })

  test('setPendingStats then consumePendingStats returns exactly what was stored', () => {
    const data: StatsData = { stats: [{ playerId: 1, statResults: [] }] }
    setPendingStats(data)

    expect(consumePendingStats()).toBe(data)
  })

  test('consumePendingStats clears the cache -- a second read returns undefined', () => {
    setPendingStats({ stats: [{ playerId: 1, statResults: [] }] })

    expect(consumePendingStats()).toBeDefined()
    expect(consumePendingStats()).toBeUndefined()
  })

  test('a later setPendingStats call replaces the previously cached value', () => {
    const first: StatsData = { stats: [{ playerId: 1, statResults: [] }] }
    const second: StatsData = { stats: [{ playerId: 2, statResults: [] }] }
    setPendingStats(first)
    setPendingStats(second)

    expect(consumePendingStats()).toBe(second)
  })
})
