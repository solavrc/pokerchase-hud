/**
 * Utility functions for statistics calculations
 */

import type { Action } from '../types/entities'

/**
 * Count unique hand IDs from a list of actions
 */
export function getUniqueHandIds(actions: Action[]): number {
  return new Set(actions.map(a => a.handId)).size
}

/**
 * Standard percentage formatter
 */
export function formatPercentage(value: import('../types/stats').StatValue): string {
  if (!Array.isArray(value) || value.length !== 2) return '-'
  const [numerator, denominator] = value
  if (denominator === 0) return '-'
  const percentage = (numerator / denominator * 100).toFixed(1)
  return `${percentage}% (${numerator}/${denominator})`
}

/**
 * Format aggression factor (not a percentage)
 */
export function formatFactor(value: import('../types/stats').StatValue): string {
  if (!Array.isArray(value) || value.length !== 2) return '-'
  const [numerator, denominator] = value
  if (denominator === 0) return '-'
  const factor = (numerator / denominator).toFixed(2)
  return `${factor} (${numerator}/${denominator})`
}