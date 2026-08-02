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
 * Simplified preflop-line taxonomy, written in the compact shorthand common to
 * HUDs/trackers (#356 -- sola: 一般的なHUDの表現に合わせて). Derived purely
 * from the player's own PREFLOP actions plus a locally-recomputed
 * `phasePrevBetCount` (same formula as `write-entity-stream.ts`: count of prior
 * BET/RAISE actions in the phase, +1 for PREFLOP to account for the forced
 * blind). The label reflects the LAST action taken (not the "most notable"):
 *
 *  | label | meaning |
 *  |---|---|
 *  | `'W'` | walk -- BB uncontested, the server never recorded a BB action |
 *  | `'X'` | check (BB's option after being limped to) -- same letter as the postflop notation |
 *  | `'F'` | fold as the player's FIRST preflop action |
 *  | `'L'` | limp -- CALL with `phasePrevBetCount <= 1` (only the blind posted) |
 *  | `'OR'` | open raise -- BET/RAISE with `phasePrevBetCount === 1` |
 *  | `'3B'` | 3bet -- BET/RAISE with `phasePrevBetCount === 2` |
 *  | `'4B'`, `'5B'`… | `` `${phasePrevBetCount + 1}B` `` for `>= 3` |
 *  | `'CC'` | cold-call of an OPEN -- CALL with `phasePrevBetCount === 2` as the player's FIRST preflop action |
 *  | `'3CC'` | cold-call of a 3BET -- same, `phasePrevBetCount === 3` |
 *  | `'4CC'`, `'5CC'`… | `` `${phasePrevBetCount}CC` `` for `>= 4` |
 *  | `'C'` | a non-cold call -- CALL with `phasePrevBetCount >= 2` when the player already had a line (e.g. limped, then called a raise) |
 *  | `null` | no data (e.g. the player disconnected before any action was recorded) |
 *
 * Note the cold-call family does NOT add one the way the bet family does:
 * `phasePrevBetCount` is the number of bets the action FACED, so facing 2 is
 * facing the open (`'CC'`) while raising over 2 is a 3bet (`'3B'`).
 * `'CC'` vs `'3CC'` are kept apart deliberately -- flatting an open and
 * flatting a 3bet are entirely different actions (#356).
 *
 * If the LAST action in the sequence is a FOLD and the player had a preceding
 * label, that label gets a `'-F'` suffix (e.g. opened, got 3-bet, folded ->
 * `'OR-F'`; 3-bet, got 4-bet, folded -> `'3B-F'`). The suffix stays `-F` and
 * MUST NOT become `/F`: `/` is the street separator in the postflop column and
 * would read as a street boundary here.
 *
 * These strings are display labels recomputed on every read. They are NOT
 * persisted anywhere -- not in IndexedDB, not in `chrome.storage`, and not in
 * any export or cloud upload -- so the vocabulary can change without a
 * migration.
 */
export type PreflopLine = string

/**
 * One of the player's OWN postflop actions, with the sizing context needed to
 * render it (#354).
 */
export interface StreetAction {
  /**
   * Compact letter for the action: `X` CHECK / `B` BET / `C` CALL /
   * `R` RAISE / `F` FOLD.
   */
  letter: string
  /**
   * True when the pipeline normalized this action away from
   * `ActionType.ALL_IN` (the raw event's ALL_IN is rewritten to BET/RAISE/CALL
   * and the fact kept in `Action.actionDetails`). Rendered as a `!` suffix --
   * without it an all-in is indistinguishable from a normal bet.
   */
  allIn: boolean
  /**
   * Chips this action ADDED, not the street-cumulative amount:
   * `Action.bet` minus the same player's previous `Action.bet` on the same
   * street. `Action.bet` is `EVT_ACTION.BetChip`, which is cumulative within a
   * street and resets at each street boundary. `null` when not derivable.
   */
  increment: number | null
  /**
   * Total pot (main + all side pots) immediately BEFORE this action.
   *
   * `Action.pot`/`Action.sidePot` are `EVT_ACTION.Progress.Pot`/`SidePot`,
   * which are **post-action** snapshots -- they already include this action's
   * chips. Verified against two independent raw captures (80,758 postflop
   * aggressive actions, 99.995% / 99.998% agreement with
   * `potBefore = pot + ΣsidePot - increment`; the residue is the documented
   * capture-anomaly class, see docs/api-events.md "クロージングコールの欠落").
   * Side pots must be summed in: chips move between `Pot` and `SidePot[]` as
   * all-ins tier the pot, so `Pot` alone is not the money on the table.
   * `null` when not derivable.
   */
  potBefore: number | null
  /**
   * `increment / potBefore` as a rounded integer percentage -- the pot-relative
   * sizing shown next to `B`/`R`. `null` for non-aggressive actions (a call,
   * check or fold has no meaningful pot-relative size) and whenever
   * `increment`/`potBefore` are not derivable or `potBefore <= 0`.
   */
  potPercent: number | null
}

/**
 * The player's own postflop actions, per street, in `Action.index` order.
 * An empty array means the player took no action on that street -- which
 * covers both "the street was never dealt" and "the street was dealt but the
 * player was already all-in / had folded". The two are told apart by the
 * neighbouring streets and `sawFlop`, not by this field.
 *
 * The street each action belongs to comes from `Action.phase`, which since
 * #340/#346 is the authoritative `Progress.Phase` carried by the action event
 * itself (not a locally-counted EVT_DEAL_ROUND cursor).
 */
export interface PostflopLines {
  flop: StreetAction[]
  turn: StreetAction[]
  river: StreetAction[]
}

export interface RecentHandEntry {
  handId: number
  /**
   * `Hand.approxTimestamp`, or `null` if the hand predates that field. The
   * panel stopped rendering a time column (#353 -- sola: 時刻は不要), but the
   * value stays in the contract: it is the `EVT_DEAL` timestamp the service
   * correlates hero's dealt hole cards on, and it is what makes a row
   * identifiable when this result is inspected outside the panel.
   */
  approxTimestamp: number | null
  /**
   * `Hand.bigBlind` -- the big blind of THIS hand at deal time. SNG/MTT blind
   * levels escalate, so a chip result is only comparable across hands once
   * divided by the blind that was live for that hand. `null` only when the
   * derived hand has no usable (positive, finite) big blind, in which case the
   * UI falls back to showing raw chips for that row rather than hiding it.
   */
  bigBlind: number | null
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
  /**
   * Where `holeCards` came from. `'results'` is the WebSocket
   * `EVT_HAND_RESULTS.Results` path above. `'replay'` means the row was
   * mucked at showdown (RankType 11, `HoleCards` empty) and the cards were
   * filled from a stored replay detail (`replayDetails`, opt-in only) --
   * the server discloses mucked showdown hands through its own replay
   * feature, so this is the same information the game itself renders.
   * `'dealt'` means the row is HERO's own hand and the cards were read from
   * the Raw Event Lake's `EVT_DEAL.Player.HoleCards` -- the cards hero was
   * actually dealt, which the `Hand` entity does not persist. This source is
   * used only when `service.playerId === playerId`; `EVT_DEAL.Player` is the
   * observing client's own seat, so it can never expose another player's
   * hand. No visibility gate applies to it: hero's own cards were hero's
   * information from the moment they were dealt.
   * `null` when `holeCards` is `null`.
   */
  holeCardsSource: 'results' | 'replay' | 'dealt' | null
  /** See `PreflopLine`'s doc comment for the taxonomy. `null` when no preflop data exists for this hand/player. */
  preflopLine: PreflopLine | null
  /** See `PostflopLines`. Every street is empty for hands that ended preflop. */
  postflopLines: PostflopLines
  /**
   * The amount that belongs to `preflopLine`, in big blinds: `Action.bet`
   * (street-cumulative for preflop, so it is exactly the raise-TO for a
   * bet/raise and the call-TO for a call) divided by `bigBlind`, taken from
   * the action that PRODUCED the label.
   *
   * `null` when the label carries no amount -- `'L'`/`'C'`/`'X'`/`'F'`/`'W'`
   * and no-data rows -- when `bigBlind` is unusable, or when the labelling
   * action is a short all-in that only looks like a raise (see
   * `resolveEffectiveActionType`).
   *
   * Kept out of the `preflopLine` string on purpose: that label is a
   * documented, separately-tested taxonomy, and the `-F` suffix leaves no
   * clean place to splice a number. The panel composes the two at render time
   * (`formatPreflopLine`), so the number always lands on its own action.
   */
  preflopLineAmountBB: number | null
  /** Exact chips for `preflopLineAmountBB` (the raise-to / call-to total). `null` likewise. */
  preflopLineAmountChips: number | null
  /**
   * The community cards this hand ran out, as `['8h','9h','6h','2s','Ad']`
   * (#356). Length is 0 (never saw a flop), 3, 4, or 5 -- the UI groups it back
   * into flop / turn / river by position.
   *
   * Read from the already-batched `phases` rows rather than a new query:
   * `Phase.communityCards` is cumulative per street, so the longest array in
   * the hand is the final board. That also covers all-in runouts, where
   * `EVT_DEAL_ROUND` never arrives and the board only exists on the
   * synthesized FLOP and SHOWDOWN phases.
   *
   * This is the hand's board, NOT anyone's hole cards -- it is public
   * information for every seat, so no visibility gate applies.
   */
  board: string[]
  /** Player reached the flop (BET_ABLE or ALL_IN when FLOP was dealt), or -- when no FLOP phase was even recorded because the hand went all-in preflop and ran out without any `EVT_DEAL_ROUND` -- reached showdown at all (which is only possible once the full board is out). */
  sawFlop: boolean
  /** `isShowdownParticipant(result)` for this player's result row -- true for any real comparison or a showdown muck, false for uncontested wins/folds. */
  wentToShowdown: boolean
  /** True when the exact signed chip result is positive. */
  won: boolean
  /**
   * Exact signed result: gross payout (including uncalled returns) minus all
   * chips contributed during the hand. Positive, negative, and zero are all
   * displayable. `null` means the causal DEAL/RESULTS snapshots could not
   * determine a unique result, or the derived hand predates the accounting
   * field and needs a Raw Event Lake rebuild.
   */
  netChips: number | null
}

export interface RecentHandsResult {
  hands: RecentHandEntry[]
  /** `Date.now()` at calculation time, so callers/UI can tell fresh results from cached ones. */
  computedAt: number
}
