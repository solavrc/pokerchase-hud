/**
 * Statistics Module Types
 */

import type { Action, Phase, Hand, Session } from './entities'
import type { ActionDetail, ActionType, PhaseType, Position } from './game'

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
  position?: Position
  /**
   * HandState for stateful detection.
   *
   * `actions` is structural data — the hand's recorded actions so far — and is
   * shared, readable by any stat. Namespacing convention for everything else:
   * shared core types carry no stat-specific fields. Each stateful stat stores
   * its own private, transient state under `statStates[statId]`, keyed by the
   * stat's own `id`, so stats never need to modify shared core types. For
   * example, a stat with id 'myStat' would do:
   *
   *   const state = (handState.statStates['myStat'] ??= {}) as MyStatState
   *   state.someFlag = true
   *
   * See src/stats/core/cbet.ts's `getCBetState` helper for a concrete example.
   */
  handState?: {
    actions?: Action[]  // 現在のハンドで記録済みのアクション
    statStates: Record<string, unknown>
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

  /**
   * Optional beginner-friendly one-line explanation (Japanese), shown as part
   * of the native `title` tooltip on every HUD stat cell (compact elements
   * and full-grid rows alike) — see `src/components/hud/statTooltip.ts`.
   * Static per stat id (unlike `tooltip`, which is context-dependent).
   */
  helpText?: string

  /** The calculation function */
  calculate: (context: StatCalculationContext) => StatValue | Promise<StatValue>
  
  /** Optional custom formatter */
  format?: (value: StatValue) => string

  /**
   * Optional tooltip formatter. Unlike `format` (which only sees the final
   * value), this receives the full calculation context so a stat can surface
   * a richer breakdown (e.g. per-layer sub-values) without changing what the
   * HUD cell itself displays. Rendered via the native `title` attribute on
   * the stat's value cell (see StatDisplay.tsx) — no new UI component.
   */
  tooltip?: (context: StatCalculationContext) => string

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
  /** Rendered by `StatDefinition.tooltip`, if defined; see that field's doc. */
  tooltip?: string
}

/**
 * Positional Drill-Down Types (#positional-drilldown)
 *
 * A per-position breakdown of the core preflop/postflop stats, computed by
 * src/services/positional-stats-service.ts. Each hand the player has played
 * is bucketed by the position they held in that hand:
 *  - The primary source is the `position` recorded on the player's own
 *    PREFLOP action rows for the hand (all such rows share one position).
 *  - Hands with NO preflop action by the player (BB walks / BB-skip, see
 *    vpip.ts) fall back to `hand.bigBlindUserId === playerId` → BB bucket.
 *  - Hands where the position can't be determined by either method (legacy
 *    `position === -3` rows, or no preflop action and no/foreign
 *    `bigBlindUserId`) land in the 'unknown' bucket.
 */

/** A concrete Position, or 'unknown' when the position couldn't be determined for a hand. */
export type PositionalStatsBucketId = Position | 'unknown'

/** The stat ids surfaced per position bucket, each as a [numerator, denominator] pair. */
export type PositionalStatId = 'vpip' | 'pfr' | '3bet' | 'steal' | 'foldToSteal' | 'cbet'

export interface PositionalStatsBucket {
  position: PositionalStatsBucketId
  /** Number of hands the player played at this position (includes BB walks for the BB bucket). */
  handsN: number
  stats: Record<PositionalStatId, [number, number]>
}

export interface PositionalStatsResult {
  positions: PositionalStatsBucket[]
  /** `Date.now()` at calculation time, so callers/UI can tell fresh results from cached ones. */
  computedAt: number
}
