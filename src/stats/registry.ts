/**
 * Statistics Registry - Manages all available statistics definitions
 */

import type { StatCalculationContext, StatDefinition, StatResult } from '../types/stats'

export class StatsRegistry {
  private stats = new Map<string, StatDefinition>()
  private enabledStats = new Set<string>()

  /**
   * Register a new statistic definition
   */
  register(stat: StatDefinition): void {
    this.stats.set(stat.id, stat)
    // Enable by default unless explicitly disabled
    if (stat.enabled !== false) {
      this.enabledStats.add(stat.id)
    }
  }

  /**
   * Unregister a statistic
   */
  unregister(id: string): void {
    this.stats.delete(id)
    this.enabledStats.delete(id)
  }

  /**
   * Get all registered statistics (sorted by order)
   */
  getAll(): StatDefinition[] {
    return Array.from(this.stats.values())
      .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
  }

  /**
   * Get all enabled statistics (sorted by order)
   */
  getEnabled(): StatDefinition[] {
    return this.getAll().filter(stat => this.enabledStats.has(stat.id))
  }

  /**
   * Get a specific statistic by ID
   */
  get(id: string): StatDefinition | undefined {
    return this.stats.get(id)
  }

  /**
   * Enable/disable a statistic
   */
  setEnabled(id: string, enabled: boolean): void {
    if (enabled) {
      this.enabledStats.add(id)
    } else {
      this.enabledStats.delete(id)
    }
  }

  /**
   * Check if a statistic is enabled
   */
  isEnabled(id: string): boolean {
    return this.enabledStats.has(id)
  }

  /**
   * Calculate all enabled statistics for a given context
   */
  async calculateAll(context: StatCalculationContext): Promise<StatResult[]> {
    const promises = this.getEnabled().map(async stat => {
      try {
        const value = await stat.calculate(context)
        const formatted = stat.format ? stat.format(value) : undefined
        return {
          id: stat.id,
          name: stat.name,
          value,
          formatted
        }
      } catch (error) {
        console.error(`[StatsRegistry] Error calculating stat ${stat.id}:`, error)
        return {
          id: stat.id,
          name: stat.name,
          value: 0,
          formatted: '-'
        }
      }
    })
    return Promise.all(promises)
  }

  /**
   * Calculate statistics based on custom display configuration
   */
  async calculateWithConfig(context: StatCalculationContext, configs?: import('../types/filters').StatDisplayConfig[]): Promise<StatResult[]> {
    if (!configs) {
      return this.calculateAll(context)
    }

    // Sort configs by order and filter enabled ones
    const sortedConfigs = configs
      .filter(config => config.enabled)
      .sort((a, b) => a.order - b.order)

    const promises = sortedConfigs.map(async config => {
      const stat = this.get(config.id)
      if (!stat) {
        console.warn(`[StatsRegistry] Stat ${config.id} not found in registry`)
        return {
          id: config.id,
          name: 'Unknown',
          value: 0,
          formatted: '-'
        }
      }

      try {
        const value = await stat.calculate(context)
        const formatted = stat.format ? stat.format(value) : undefined
        return {
          id: stat.id,
          name: stat.name,
          value,
          formatted
        }
      } catch (error) {
        console.error(`[StatsRegistry] Error calculating stat ${stat.id}:`, error)
        return {
          id: stat.id,
          name: stat.name,
          value: 0,
          formatted: '-'
        }
      }
    })
    return Promise.all(promises)
  }

  /**
   * Clear all registrations
   */
  clear(): void {
    this.stats.clear()
    this.enabledStats.clear()
  }
}

// Export singleton instance
export const defaultRegistry = new StatsRegistry()
