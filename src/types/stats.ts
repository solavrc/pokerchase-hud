/**
 * Statistics Module Types
 */

import type { Action, Phase, Hand, Session } from './entities'
import type { ActionDetail, ActionType, PhaseType } from './game'

/**
 * Context provided to statistics calculation functions
 */
export interface StatCalculationContext {
  playerId: number
  actions: Action[]      // Filtered actions for this player
  phases: Phase[]        // Filtered phases for this player  
  hands: Hand[]          // Filtered hands for this player
  allPlayerActions: Action[]  // All actions (for optimization)
  allPlayerPhases: Phase[]    // All phases (for optimization)
  winningHandIds: Set<number>  // Hand IDs where this player won
  session: Session  // Session information including player data
  activeOpponents?: number  // Number of active opponents (for real-time equity calculation)
}

/**
 * Possible return values from a statistic calculation
 */
export type StatValue = 
  | number                                      // Simple count (e.g., hands)
  | [numerator: number, denominator: number]    // Fraction format (e.g., VPIP)
  | string                                      // Custom format
  | Record<string, any>                         // Complex object (e.g., hand improvement)

/**
 * Context for ActionDetail detection during action processing
 */
export interface ActionDetailContext {
  playerId: number
  actionType: Exclude<ActionType, ActionType.ALL_IN>
  phase: PhaseType
  phasePlayerActionIndex: number
  phasePrevBetCount: number
  // HandState for stateful detection
  handState?: {
    cBetter?: number
    lastAggressor?: number
    currentStreetAggressor?: number
    // 他の状態管理用フィールドを追加可能
  }
}

/**
 * Definition of a single statistic
 */
export interface StatDefinition {
  /** Unique identifier (e.g., 'vpip', 'pfr') */
  id: string
  
  /** Display name (e.g., 'VPIP', 'PFR') */
  name: string
  
  /** Optional description for documentation */
  description?: string
  
  /** The calculation function */
  calculate: (context: StatCalculationContext) => StatValue | Promise<StatValue>
  
  /** Optional custom formatter */
  format?: (value: StatValue) => string
  
  /** Display order (lower numbers appear first) */
  order?: number
  
  /** Whether this stat is enabled by default */
  enabled?: boolean
  
  /** Optional function to detect ActionDetails during action processing */
  detectActionDetails?: (context: ActionDetailContext) => ActionDetail[]
  
  /** Optional function to update handState during action processing */
  updateHandState?: (context: ActionDetailContext) => void
}

/**
 * Result of a statistic calculation with metadata
 */
export interface StatResult {
  id: string
  name: string
  value: StatValue
  formatted?: string
}