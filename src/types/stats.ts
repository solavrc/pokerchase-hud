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

/**
 * Recent Hands Panel Types (#recent-hands-panel)
 *
 * A per-player "last N hands" drill-down, computed by
 * src/services/recent-hands-service.ts (HM3/PT4 "Last Hands" +
 * Hand2Note "recent showdown hole cards" pattern). Unlike the positional
 * drill-down, this is intentionally NOT bucketed -- each hand the player was
 * dealt into becomes one row, newest first, independent of the app-wide
 * `handLimitFilter` (which controls how much history feeds the aggregate
 * stats, not this "last N hands" list).
 */

/**
 * Simplified preflop-line taxonomy. Derived purely from the player's own
 * PREFLOP actions for the hand plus a locally-recomputed `phasePrevBetCount`
 * (same formula as `write-entity-stream.ts`: count of prior BET/RAISE
 * actions in the phase, +1 for PREFLOP to account for the forced blind).
 * The label reflects the LAST action taken (not the "most notable" one):
 *
 *  - No preflop action at all: `'Walk'` if the player was BB (uncontested,
 *    the server never even recorded a BB action), else `null` (no data --
 *    e.g. the player disconnected before any action was recorded).
 *  - First action is a plain CHECK (BB's option after being limped to, or a
 *    walk-adjacent check): `'Check'`.
 *  - First action is a FOLD: `'Fold'`.
 *  - CALL with `phasePrevBetCount <= 1` (just the blind posted, i.e. a
 *    limp): `'Limp'`.
 *  - CALL with `phasePrevBetCount >= 2` as the player's FIRST preflop
 *    action (calling a raise cold): `'ColdCall'`.
 *  - CALL with `phasePrevBetCount >= 2` after the player already had a
 *    preflop line (e.g. they limped, then called a raise): `'Call'`.
 *  - RAISE/BET with `phasePrevBetCount === 1` (the opening raise):
 *    `'Open'`.
 *  - RAISE/BET with `phasePrevBetCount === 2` (raising over one prior
 *    raise): `'3Bet'`.
 *  - RAISE/BET with `phasePrevBetCount >= 3`: `` `${phasePrevBetCount + 1}Bet` `` (e.g. `'4Bet'`).
 *  - If the LAST action in the sequence is a FOLD and the player had a
 *    preceding label (i.e. this isn't their first preflop action), the
 *    preceding label gets a `'-F'` suffix (e.g. opened, got 3-bet, folded
 *    -> `'Open-F'`; 3-bet, got 4-bet, folded -> `'3Bet-F'`).
 */
export type PreflopLine = string

export interface RecentHandEntry {
  handId: number
  /** `Hand.approxTimestamp`, or `null` if the hand predates that field. */
  approxTimestamp: number | null
  /** `null` when the position can't be determined (see positional drill-down's identical fallback rules). */
  position: Position | null
  /**
   * Revealed hole cards as `['Ah', 'Kd']`, ONLY when actually shown at
   * showdown. Gated on BOTH conditions: `isShowdownParticipant(result)`
   * (RankType is a real comparison 0-9, or 11 SHOWDOWN_MUCK -- i.e.
   * excludes 10 NO_CALL and 12 FOLD_OPEN, so a voluntary post-fold reveal
   * never counts as "revealed" here even though the server does send real
   * card values for it) AND `HoleCards` actually holding valid card indices
   * (SHOWDOWN_MUCK almost always means `HoleCards` is empty/[-1,-1] since
   * the player mucked without showing -- the RankType alone doesn't
   * guarantee visibility, the card data has to back it up too). `null`
   * otherwise. See docs/api-events.md's RankType table.
   */
  holeCards: string[] | null
  /** See `PreflopLine`'s doc comment for the taxonomy. `null` when no preflop data exists for this hand/player. */
  preflopLine: PreflopLine | null
  /** Player reached the flop (BET_ABLE or ALL_IN when FLOP was dealt), or -- when no FLOP phase was even recorded because the hand went all-in preflop and ran out without any `EVT_DEAL_ROUND` -- reached showdown at all (which is only possible once the full board is out). */
  sawFlop: boolean
  /** `isShowdownParticipant(result)` for this player's result row -- true for any real comparison or a showdown muck, false for uncontested wins/folds. */
  wentToShowdown: boolean
  /** `result.RewardChip > 0` for this player. */
  won: boolean
  /**
   * `result.RewardChip` when `won`, else `null`. This is the gross amount
   * awarded back (winnings), NOT a true net profit/loss for the hand --
   * reconstructing "chips contributed this hand" would require replaying
   * every street's pot/side-pot accounting, which isn't worth it for a
   * glanceable recent-hands row (see the feature's task brief).
   */
  netChips: number | null
}

export interface RecentHandsResult {
  hands: RecentHandEntry[]
  /** `Date.now()` at calculation time, so callers/UI can tell fresh results from cached ones. */
  computedAt: number
}
