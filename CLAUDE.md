# PokerChase HUD v2 - AI Agent Documentation

> 🎯 **Purpose**: Technical reference for AI coding agents working on the PokerChase HUD Chrome extension.
>
> 📅 **Last Updated**: 2026-03-25

## 📋 Table of Contents

1. [Project Overview](#project-overview)
   - [Key Features](#key-features)
   - [Technical Stack](#technical-stack)
2. [Development Guidelines](#development-guidelines)
   - [Claude Code Instructions](#claude-code-instructions)
   - [Core Principles](#core-principles)
3. [Architecture](#architecture)
   - [System Overview](#system-overview)
   - [Design Principles](#design-principles)
   - [Data Flow](#data-flow)
4. [Implementation Details](#implementation-details)
   - [Table & Seat Handling](#table--seat-handling)
   - [Data Processing](#data-processing)
   - [UI & Display](#ui--display)
   - [Real-time Processing](#real-time-processing)
   - [Event Handling](#event-handling)
5. [Components & Modules](#components--modules)
   - [File Organization](#file-organization)
   - [Extension Layer](#extension-layer)
   - [Data Processing Streams](#data-processing-streams)
   - [Utility Modules](#utility-modules)
   - [UI Components](#ui-components)
6. [Statistics System](#statistics-system)
   - [Available Statistics](#available-statistics)
   - [Statistics Philosophy](#statistics-philosophy)
   - [Key Concepts](#key-concepts)
   - [Real-time Statistics](#real-time-statistics)
7. [Data Model & Events](#data-model--events)
   - [ApiEvent Architecture](#apievent-architecture)
   - [Event Types](#event-types)
   - [Database Schema](#database-schema)
   - [Configuration & Storage](#configuration--storage)
8. [Cloud Sync & Firebase Integration](#cloud-sync--firebase-integration)
   - [Architecture](#architecture-1)
   - [Key Features](#key-features-1)

## 📦 Project Overview

Chrome extension providing real-time poker statistics overlay and hand history tracking for PokerChase.

### Key Features

- Real-time HUD with 13+ statistics
- All-player SPR/pot odds display
- Hero hand improvement probabilities
- Hand history log with PokerStars export
- Import/export functionality
- Game type filtering (SNG/MTT/Ring)
- Cloud backup with automatic sync to Firebase
- Manual sync controls (upload/download) for cloud storage
- BigQuery integration for data analysis

### Technical Stack

- **Extension**: Chrome Manifest V3
- **Frontend**: React 18 + TypeScript
- **UI Library**: Material-UI (modular imports)
- **Storage**: IndexedDB (Dexie) + Cloud (Firestore)
- **Cloud Services**: Firebase (Auth, Firestore)
- **Build**: esbuild
- **Testing**: 
  - Jest with jsdom environment for browser API simulation
  - React Testing Library for component testing
  - Co-located test files with source code
- **Validation**: Zod (runtime schema validation)
- **Release Management**: Release-Please with GitHub Actions
  - Manual trigger via GitHub Actions → "Release Please"
  - Protected main branch with CODEOWNERS
  - Workflow details: `.github/workflows/release-please.yml`

## Development Guidelines

### Claude Code Instructions

#### Documentation Management

- **Keep CLAUDE.md up-to-date**: This is your primary reference for architectural decisions
- **Documentation Philosophy**:
  - Prefer updating existing documentation
  - Create new documentation when necessary for clarity
  - Use references to code/types instead of duplicating information
  - Avoid redundancy to prevent maintenance conflicts

#### Development Practices

- **Development Approach**:
  - Focus on architectural principles
  - Maintain existing patterns
  - Prefer editing over creating files
  - Use code comments for implementation details
- **Refactoring Strategy** (when improving existing code):
  - Phase 1: Apply new utilities to new code first
  - Phase 2: Gradually refactor existing code
  - Phase 3: Add tests and documentation
  - Always maintain backward compatibility
- **Language**:
  - Respond in Japanese (日本語) when communicating with users
  - Write CLAUDE.md documentation in English
- **Service Worker Compatibility**:
  - Avoid `window` object in background scripts
  - Use global timer functions (`setTimeout`, not `window.setTimeout`)
  - Consider Service Worker lifecycle in all background operations

#### Testing & Build

- **Test Organization**:
  - Test files are co-located with source files (e.g., `foo.ts` → `foo.test.ts`, `foo.tsx` → `foo.test.tsx`)
  - Test files use `.test.ts` or `.test.tsx` extension
  - No separate test directories; improves visibility and reduces cognitive load
  - All new statistics require unit tests
  - Component tests use React Testing Library
- **Testing Requirements**:
  - Always run tests and type checking after code changes
  - Use `npm run test` and `npm run typecheck` commands
  - Ensure all tests pass before completing tasks
  - All tests must pass; run `npm run test` to verify the current suite/test counts (grows over time — don't hardcode numbers here)
- **Build Commands**:
  - `npm run build` - Production build
  - `npm run typecheck` - TypeScript validation
  - `npm run test` - Run test suite
  - `npm run postbuild` - Create extension.zip
  - `npm run validate-schema` - Validate API events in NDJSON files
  - `npm run schema-diff` - Detect API schema changes (additions/removals) in NDJSON files
  - `npm run verify-stats -- <file.ndjson>` - Cross-check stats pipeline output against an independent oracle (regression check for entity-converter/write-entity-stream/stats changes; see CONTRIBUTING.md)
  - `npm run firebase:deploy` - Deploy Firestore rules and indexes
  - `npm run firebase:deploy:rules` - Deploy Firestore rules only
  - `npm run firebase:deploy:indexes` - Deploy Firestore indexes only
  - `npm run firebase:emulators` - Start local Firestore emulator

#### Incident Diagnosis Practices

Learned from the 2026-07 season-3 silent-drop incident (`docs/postmortems/2026-07-session-results-drop.md`) — apply when diagnosing missing/inconsistent data:

- **Declare observability**: any claimed mechanism ("X stopped arriving", "the game changed Y") must state where in the causal chain the evidence sits and which rival hypotheses it CANNOT distinguish. Stored data (IndexedDB/exports/Firestore/BQ) contains only validation-passing events — it can never distinguish "never arrived" from "arrived but was dropped pre-storage".
- **Prefer direct observation over inference**: before concluding from stored data, check whether the boundary can be observed directly (service-worker console, a single live session capture, packet-level logs). One console log settled in minutes what hours of stored-data inference could not.
- Write mechanisms as falsifiable predictions and check them; have a second pass with a DIFFERENT observation channel attempt to refute a mechanism before documenting it as fact.

#### Version Control

- **Conventional Commits**: Use standard format for all commits
- **Common scopes**: `hud`, `stats`, `ui`, `api`, `build`
- **Breaking changes**: Use `feat!` or `BREAKING CHANGE:` footer

### Core Principles

- **Important Instruction Reminders**:
  - Do what has been asked; nothing more, nothing less
  - NEVER create files unless they're absolutely necessary
  - ALWAYS prefer editing an existing file to creating a new one
  - NEVER proactively create documentation files unless explicitly requested

## Architecture Decision Records

Important technical decisions are documented in [docs/architecture.md](docs/architecture.md):
data storage (Dexie.js), normalized entities, Firestore strategy, and v3 index optimization.

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                  Game Website (poker-chase.com)             │
│  ┌─────────────────┐                                        │
│  │  WebSocket API  │◄──────── Intercept ────────┐          │
│  └────────┬────────┘                            │          │
│           │                                      │          │
│  ┌────────▼────────┐      ┌──────────────────┐ │          │
│  │  Unity Canvas   │      │ web_accessible_   │ │          │
│  │  ┌───────────┐  │      │ resource.ts       │◄┘          │
│  │  │   HUD     │  │◄─────inject─┤                         │
│  │  └───────────┘  │             │                         │
│  └─────────────────┘      ┌──────▼───────────┐            │
│                           │ content_script.ts │            │
└───────────────────────────┴──────┬───────────┴────────────┘
                                   │ Port
                           ┌───────▼────────┐
                           │ background.ts  │
                           │ ┌────────────┐ │
                           │ │   Dexie    │ │
                           │ │ IndexedDB  │ │
                           │ └────────────┘ │
                           └────────────────┘
```

### Design Principles

1. **Separation of Concerns**: Data processing isolated from UI
2. **Variable Table Model**: 4 or 6 seats based on table type, null for empty positions
3. **Hero-Centric Display**: All UI rotates around hero at position 0
4. **Performance First**: Caching, virtualization, batch processing for real-time updates
5. **Dual Indexing**: Original seat indices for data, rotated indices for display
6. **Type Safety**: Explicit types, error handling for invalid inputs
7. **Stream Independence**: Real-time stats process parallel to main statistics pipeline
8. **No Magic Numbers**: Use named constants (e.g., HUD_WIDTH)
9. **Service Worker Resilience**: Handle 30-second timeout gracefully
10. **State Persistence**: Maintain critical state across Service Worker lifecycle
11. **Cloud Sync**: Smart incremental sync with Firestore
    - No periodic sync (cost optimization)
    - Auto sync after 100+ new events at game end (upload only)
    - Upload: Only events newer than cloud's latest timestamp
    - Download: Cloud as complete source of truth
    - Manual sync controls for user-initiated operations
12. **Operation Exclusivity**: Only one long-running operation (export/import/rebuild) at a time, enforced in background.ts via `currentOperationState`
13. **Optimistic UI + Server Guard**: Popup sets state immediately on click (responsive UX), background validates and rejects if busy (correctness)
14. **Cache-First Rendering**: Frequently needed state (Firebase auth) cached in `chrome.storage.local` for instant popup rendering
15. **Rebuild Advisory Versioning**: Bump `REBUILD_ADVISORY_VERSION` (`src/constants/database.ts`) whenever a change alters write-time entity derivation for already-recorded data, so existing users get prompted (badge/notification/popup banner via `src/background/rebuild-advisory.ts`) to run データ再構築 after updating
16. **Raw Event Lake**: `apiEvents` is the raw wire log — any event with a numeric `timestamp`+`ApiTypeId` is stored, independent of whether it parses under the current Zod schema or is an application type. Validation gates only the real-time pipeline (streams/stats/entity generation), never storage. This is what makes データ再構築 an actual recovery path after a PokerChase payload change breaks a schema: rebuild re-validates every stored raw row against the *current* schema, so a later schema fix retroactively recovers rows that failed to parse when first received — no separate promotion mechanism needed. See "ApiEvent Architecture" and `docs/architecture.md` for the full rationale and history.

### Data Flow

#### Real-time Processing

```
WebSocket Events (from content_script)
    │
    ├─► Database (apiEvents.add) ─── Persistent storage
    │   (numeric timestamp+ApiTypeId only — the Raw Event Lake;
    │    independent of parseApiEvent/isApplicationApiEvent below)
    │
    ▼ parseApiEvent + isApplicationApiEvent gate
    (non-application / unparseable events stop here — already durably
     stored above, just not forwarded into the real-time pipeline)
    │
    ├─► HandLogStream ─────────────► Hand Log Output
    │   (Independent stream)          (via 'data' event)
    │
    ├─► RealTimeStatsStream ───────► Real-time Stats Output
    │   (Independent stream)          (via 'data' event)
    │
    └─► AggregateEventsStream
        (Groups events by hand)
             │
             ▼ (.pipe)
        WriteEntityStream
        (Persists entities to DB)
             │
             ▼ (.pipe)
        ReadEntityStream ──────────► Stats Output
        (Calculates statistics)       (via 'data' event)
```

**Key Points:**

- Three independent streams receive the same events simultaneously
- Only the main statistics pipeline uses `.pipe()` for sequential processing
- HandLogStream and RealTimeStatsStream operate in parallel, not as branches
- Each stream emits results via 'data' events to update different UI components
- Storage happens *before* the validation gate, not alongside it — see "Raw Event Lake" (Design Principles #16)

**Event Order Handling:**

- **AggregateEventsStream**: Buffers events until hand boundaries (EVT_HAND_RESULTS)
- **Incomplete Data**: Streams handle missing player info gracefully
- **Late Arrivals**: Session info updates retroactively when received
- **Duplicate Prevention**: Events keyed by timestamp+ApiTypeId

#### Import Processing

```
NDJSON File (.ndjson)
    ↓
Chunk Processing
    ├─► Duplicate Detection (Set-based, O(1) — keyed on timestamp+ApiTypeId)
    ├─► Raw Event Storage: every line with numeric timestamp+ApiTypeId is
    │   bulkAdd'ed to apiEvents (the Lake), regardless of Zod validity
    └─► Valid Application Events Collection (subset that also parses AND
        isApplicationApiEvent — tracked only for rows confirmed stored)
         ↓
EntityConverter (Direct generation, fed only the valid-application subset)
    ├─► Extracts session/player info
    ├─► Generates entities without streams
    └─► Uses statistics modules for ActionDetails
         ↓
Bulk Database Insert (bulkPut)
    ├─► hands
    ├─► phases
    └─► actions
         ↓
Statistics Refresh (batch mode)
```

**Import Optimizations:**

- Designed for processing tens of thousands of records
- Batch mode disables real-time updates during import
- Direct entity conversion bypasses stream overhead
- Falls back to individual inserts on bulk operation failure
- Storage and entity generation are decoupled: a line that fails to parse (or
  is a known non-application type) is still stored raw — it just doesn't
  reach `EntityConverter`. See "Raw Event Lake" (Design Principles #16).

**Critical Design Constraints (learned 2026-03):**

> **Data model & event edge cases** are consolidated in [docs/api-events.md](docs/api-events.md) — see "Data Constraints & Edge Cases", "Field Relationships", and "Enum Reference" sections.

- **EntityConverter state**: `convertEventsToEntities()` tracks hand boundaries via internal local variables (`currentHandEvents`). Must NOT be called in chunks — a hand spanning chunk boundaries will be lost. Always pass all events in a single call.
- **EntityConverter/HandLogProcessor never see raw, unvalidated rows**: both read required fields (e.g. `EVT_DEAL.Game.SmallBlind`) via unguarded `switch (event.ApiTypeId)` dispatch, with no `default:` case protecting against a well-known-ApiTypeId-but-malformed payload. Every call site that reads from `apiEvents` (the raw Lake) and feeds either of them re-validates first with `filterValidApplicationEvents()` (`src/utils/database-utils.ts`): `rebuildAllData`, `AutoSyncService.rebuildLocalEntities`, `HandLogExporter.exportHand`/`exportMultipleHands`. This re-validation on every rebuild is also the *entire* recovery mechanism for a PokerChase schema break — a later schema fix makes previously-unparseable rows parse on the next rebuild automatically, no promotion step required.
- **Dexie Collection reuse**: `processInChunks()` uses `.offset().limit()` on a Collection object, but Dexie Collections accumulate state. For reliable pagination, use cursor-based approach with `where('[timestamp+ApiTypeId]').above(lastKey).limit(N)`.
- **Export size limits**: Service Worker → content_script message limit is 64MiB. Data URL limit is ~2MB. Large exports use chunked message passing with Blob-based download in content_script.
- **PokerStars hand history format**: `calls` shows additional call amount (not total bet). `Dealt to` is hero-only. Summary uses `folded on the Flop/Turn/River`. See [docs/pokerstars-export.md](docs/pokerstars-export.md).
- **Side pot handling**: `collected X from main pot` / `from side pot` / `from side pot-N` (PS format). Winner determination uses `HandRanking` with `RewardChip` fallback. Main pot winner may not be eligible for side pots (e.g., ante all-in). Relies on invariant `Pot + sum(SidePot) == sum(RewardChip)`.
- **Ante all-in chip estimation**: When multiple players have `Chip=0, BetChip=0`, `Progress.Pot/SidePot` tier differences are used to reconstruct actual contributions (`buildAnteAllInChipsMap`). `EVT_HAND_RESULTS.RewardChip` resolves correct seat assignment (`fixAnteAllInChips`). Seat index ≠ stack order.
- **BB action skip**: PokerChase skips BB action when all other players are all-in or folded. Measured on the 393,830-event real-data audit: **31.9% of hands (9,979/31,301)** hit this path (e.g. walks) — a mainline case, not a rare edge case. `getMissingBBCheck` inserts `checks` (excluded for `NO_CALL` wins).
- **Winner definition (unified, #97)**: Both pipelines (`EntityConverter` and `WriteEntityStream`) define a hand winner as `RewardChip>0` (PT4-style "won any portion of the pot"), not `HandRanking===1` — the latter misses legitimate side-pot winners whose hand wasn't the overall best. See `src/entity-converter.ts` and `src/streams/write-entity-stream.ts`.
- **Position derivation (#95)**: Positions are derived from explicit `Game.ButtonSeat`/`SmallBlindSeat`/`BigBlindSeat` via `getPositionMap()` (`src/utils/position-utils.ts`), not by rotating `seatUserIds` — the rotation heuristic mislabeled positions whenever a seat was empty (58% of real hands have at least one empty seat).
- **SHOWDOWN phase gating (#94)**: A SHOWDOWN phase requires **≥2 showdown-participant `RankType`s** (`isShowdownParticipant()` in `src/types/game.ts`: ranks 0-9 or `SHOWDOWN_MUCK`/11), not merely `Results.length > 1` — `NO_CALL`/`FOLD_OPEN` reveals don't count.
- **HandLogExporter batch optimization**: `exportMultipleHands` prefetches all hands and API events in 2 DB queries, then processes in memory. Avoids N+1 query pattern (previously 100 hands = 300+ DB queries). Single-hand `exportHand` retains per-hand DB queries for simplicity.
- **Popup ↔ Background state synchronization**: Long-running operations (export/import/rebuild) track state in `currentOperationState` global variable in background.ts. Popup queries via `getOperationState` on mount to restore UI after close/reopen. Progress messages (`processing` state) must also set the active operation state (not just `started`), because popup may miss `started` during close/reopen window.
- **Optimistic UI updates**: Button click handlers set local state immediately before sending message to background, then revert if background rejects. Prevents race window where buttons remain clickable between click and first progress message.
- **Background concurrent operation guard**: Background rejects `exportData`/`rebuildData` when `currentOperationState !== 'idle'`. This is the server-side guarantee against double execution regardless of popup UI state.
- **Firebase auth cache**: Auth state is cached to `chrome.storage.local` (`firebaseAuthCache` key) on `onAuthStateChange`. Popup reads cache first for instant rendering, then verifies with background. Prevents "not signed in" flash during heavy background operations.

## Implementation Details

### Table & Seat Handling

> **SeatUserIds semantics and field relationships**: See [docs/api-events.md](docs/api-events.md#field-relationships).

- **Table size**: 4 or 6 seats (`SeatUserIds.length`), `-1` = empty, null in arrays
- **HUD-specific**: Hero always at UI position 0 (bottom center). Dual coordinate system: `originalSeatIndex` (DB/export) vs rotated position (UI). Use `rotateArrayFromIndex` utility.

### Data Processing

- **Scale Assumptions**: System designed to handle tens of thousands of records efficiently
- **ActionDetail Detection**: Always implement in statistics modules for consistency
- **Batch Operations**: Import data in chunks to prevent browser freezing
- **Transaction Safety**: Complete READONLY before READWRITE operations
- **Memory Management**: Process large datasets incrementally
- **Cache Invalidation**: Implement caching to prevent stale data in statistics
- **Export Format**: Maintain exact PokerStars format with original seat indices

#### Performance Optimization Results

Recent toArray() optimizations achieved:
- **Memory Usage**: Significant reduction for large datasets (10k+ events)
- **Query Performance**: 
  - EVT_DEAL search: From O(n) full scan to O(log n) with limit
  - Player name mapping: Incremental cache vs full rebuild
  - Export/rebuild: Chunk processing prevents memory spikes
- **Chunk Sizes**:
  - Import: 10,000 events per chunk
  - Sync: 5,000 events per chunk
  - EVT_DEAL search: 10 events per batch

### UI & Display

- **HUD Dimensions**: Regular HUD 240px width, Real-time stats 200px width
- **HUD Positioning**: Overlay on Unity WebGL canvas (not DOM elements)
  - Positions relate to game components (e.g., above nameplates)
  - Cannot query DOM for position information
- **Empty Seats**: Show "Waiting for Hand..." in UI
- **Chrome Extension**: Work within Manifest V3 constraints
- **HUD display modes** (#143, `UIConfig.hudDisplayMode: 'full' | 'compact'`, default `'compact'`): `'compact'` (`CompactStatDisplay.tsx`) shows one classic-HUD line (`VPIP/PFR/3B (HAND)`, rounded integers) plus a secondary AF/CB/STL line, suppressing zero-opportunity secondary stats instead of rendering `'-'`. `'full'` (`StatDisplay.tsx`) is the existing 16-stat grid, unchanged. Clicking the compact stat body toggles the full grid inline for that player (local per-`Hud`-instance state, so multiple panels can be expanded independently); the click handler `stopPropagation()`s so it doesn't trigger the HUD's click-to-copy or the `#128` positional drill-down chevron. Existing `uiConfig` missing these keys (pre-#143) resolve to the new defaults via the `{...DEFAULT_UI_CONFIG, ...stored}` merge in both `App.tsx` and `Popup.tsx`.
- **HUD color coding** (#143, `UIConfig.hudColorCoding: boolean`, default `true`): threshold-based value coloring for VPIP/PFR/3bet/AF in both display modes, data-driven in `src/components/hud/statColorRules.ts` (`STAT_COLOR_RULES`). n-gated: a stat is only colored once its own `[numerator, denominator]` has `denominator >= 20`; below that it keeps the existing dimmed low-confidence gray (`#888888`).
- **Stat tooltips** (#143, `src/components/hud/statTooltip.ts`): every stat cell (compact segments and full-grid rows) gets a native `title` composed of a base line — the stat's dynamic `StatDefinition.tooltip(context)` (#130, e.g. `vpipF`'s per-layer breakdown) if defined, else `"{name}: {value (num/den)}"` — followed by `StatDefinition.helpText`, a static one-line Japanese explanation defined per stat in `src/stats/core/*.ts`.
- **Player-type classification icon** (HM-style auto-rate, `src/components/hud/playerTypeRules.ts` → `classifyPlayerType`, rendered by `PlayerTypeIcons.tsx` in the HUD header, both display modes): a single emoji + native `title` tooltip (real numbers, Japanese) replacing the old decorative 🐟/🦈 placeholder pair. Data-driven thresholds (`PLAYER_TYPE_THRESHOLDS`), same tuning philosophy as `statColorRules.ts`:
  - **Quadrant** (VPIP × AF, boundaries inclusive on the loose/aggressive side): 🦈 TAG (tight+aggressive) / 💣 LAG (loose+aggressive) / 🪨 ニット (tight+passive) / 🐟 フィッシュ (loose+passive). Tight `< 25%` VPIP `≤` loose; passive `< 1.5` AF `≤` aggressive.
  - **🐳 Whale override**: full-table-layer VPIP (`vpipF`, not raw `vpip`) `≥ 50%` overrides the quadrant icon entirely regardless of AF. Uses `vpipF` specifically — not raw `vpip` — because VPIP is structurally inflated at short-handed tables (see the `vpipF` entry below); a player sampled mostly at HU/short tables would otherwise be mislabeled a whale off raw VPIP alone.
  - **n-gates**: no icon at all until `vpip` denominator `≥ 30` (baseline track-record gate). Whale additionally needs its own `vpipF` denominator `≥ 30` and fires on `vpipF` alone even when AF is under-sampled (whale ignores AF by definition). Quadrant classification additionally needs `af` denominator `≥ 20`; if AF's sample is too thin but VPIP's is fine, nothing is shown rather than guessing an unplaceable axis.
  - **Required-stat forcing**: `vpipF` is opt-in (`enabled: false` by default) and would otherwise never reach the classifier for users who haven't turned its HUD row on. `src/stats/compactStats.ts` exports `CLASSIFIER_REQUIRED_STAT_IDS = ['vpip', 'af', 'vpipF']` alongside the existing `COMPACT_REQUIRED_STAT_IDS`; `read-entity-stream.ts` forces the union of both sets into `calculateWithConfig` regardless of the user's `statDisplayConfigs.enabled` flags, same mechanism/rationale as #143's compact-line forcing (widens only what's *calculated*, not what the full grid *displays*).

### Real-time Processing

- **Parallel Streams**: Three independent streams process same events
  - HandLogStream → Hand history generation
  - RealTimeStatsStream → Pot odds, SPR, hand improvement
  - AggregateEventsStream → Statistics pipeline
- **Update Timing**:
  - Real-time stats: Update immediately on each action
  - Aggregated stats: Wait for hand completion (VPIP, PFR, etc.)
  - Hand log: Buffer events until hand boundary detected
- **AllPlayersRealTimeStats**: Contains heroStats and playerStats properties

### Event Handling

> **Event types, field relationships, data dependencies, edge cases, enums**: See [docs/api-events.md](docs/api-events.md).

- **HUD behavior**: Show "No Data" or cached values when data incomplete. Preserve session state across reconnections.
- **Batch vs Live**: Use `service.setBatchMode()` to differentiate import from live events
- **Service Worker Keepalive**: 25s interval during active games (EVT_SESSION_DETAILS → EVT_SESSION_RESULTS). Prevents 30s timeout.

## Components & Modules

### File Organization

**Main directories**:
- `/src/components/` - React UI components (HUD, popup, hand log)
- `/src/services/` - Business logic and service layers
- `/src/streams/` - Data processing pipelines
- `/src/stats/` - Statistics calculation modules
- `/src/types/` - TypeScript definitions with Zod schemas
- `/src/utils/` - Utility functions and helpers

For complete directory structure and file descriptions, see [docs/file-organization.md](docs/file-organization.md).

### Extension Layer

**Key components**:
- `web_accessible_resource.ts` - WebSocket interception and event forwarding
- `content_script.ts` - Bridge with keepalive mechanism and game state tracking
- `background.ts` - Service worker with state persistence and batch processing

### Data Processing Streams

Three independent streams process events in parallel:
- **AggregateEventsStream** → **WriteEntityStream** → **ReadEntityStream** (main statistics pipeline)
- **RealTimeStatsStream** - Real-time pot odds, SPR, hand improvement
- **HandLogStream** - Hand history generation

**Key optimization**: `EntityConverter` for direct event-to-entity conversion during imports.

### Services

**Core services**:
- **PokerChaseService** - Central state management with Chrome Storage persistence
- **FirestoreBackupService** - Cloud sync with incremental upload and full download
- **AutoSyncService** - Cost-optimized automatic synchronization
- **FirebaseAuthService** - Chrome identity API integration

Key features: Service Worker resilience, 100+ event threshold for auto-sync, state restoration.

### Utility Modules

**Key utilities**:
- **Database Utils** - `saveEntities()`, `processInChunks()`, optimized searches
- **Constants** - Centralized configuration in `DATABASE_CONSTANTS`
- **Hand Log Processor** - PokerStars-format hand history generation
- **Card Utils** - Card formatting (e.g., [37, 51] → ['Jh', 'Ac'])
- **Logger** - Structured logging foundation (migration in progress)
- **Schema Validator** - NDJSON validation tool

See individual files in `src/utils/` for implementation details.

### UI Components

**Main components**:
- **App.tsx** - Root component with state management and seat rotation
- **Hud.tsx** - Draggable HUD overlay (240px regular, 200px real-time)
- **HandLog.tsx** - Virtualized hand history with PokerStars export
- **Popup.tsx** - Extension settings interface

Components are modularized with feature-specific sub-components in `hud/` and `popup/` directories.

## Statistics System

### Available Statistics

| ID           | Name | Description                                    |
| ------------ | ---- | ---------------------------------------------- |
| `hands`      | HAND | Total hands played                             |
| `playerName` | Name | Player name with rank                          |
| `vpip`       | VPIP | Voluntarily put $ in pot % (walks excluded)    |
| `vpipF`      | VPIP·F | VPIP restricted to full-table-layer hands (walks excluded; **disabled by default**, opt-in via popup) |
| `pfr`        | PFR  | Pre-flop raise % (walks excluded)              |
| `3bet`       | 3B   | 3-bet %                                        |
| `3betfold`   | 3BF  | Fold to 3-bet %                                |
| `cbet`       | CB   | Continuation bet %                             |
| `cbetFold`   | CBF  | Fold to c-bet %                                |
| `af`         | AF   | Aggression factor (postflop only)              |
| `afq`        | AFq  | Aggression frequency % (postflop only)         |
| `wtsd`       | WTSD | Went to showdown % (flops seen, incl. preflop all-ins) |
| `wwsf`       | WWSF | Won when saw flop % (flops seen, incl. preflop all-ins) |
| `wtsdNoAi`   | WTSDa | Went to showdown %, decision-focused variant (preflop all-ins excluded; **disabled by default**, opt-in via popup) |
| `wwsfNoAi`   | WWSFa | Won when saw flop %, decision-focused variant (preflop all-ins excluded; **disabled by default**, opt-in via popup) |
| `wsd`        | W$SD | Won $ at showdown %                            |
| `riverCallAccuracy` | RCA | River call accuracy % (calls that won)  |

### Adding New Statistics

For detailed instructions on how to add new statistics to the HUD, see [CONTRIBUTING.md](./CONTRIBUTING.md).

### Statistics Philosophy

**Tracker-standard primaries, opt-in decision-focused variants**: Primary stats (VPIP, PFR, AF, AFq, WTSD, WWSF, etc.) follow official tracker (PT4/HM3) definitions so values are directly comparable with other trackers and with players' existing intuitions built on those tools. The previous "player decision focus" philosophy — measuring decision-making rather than automatic game outcomes — now lives in the opt-in `*a` variants (`wtsdNoAi`/WTSDa, `wwsfNoAi`/WWSFa): these exclude preflop all-ins (no postflop decision was made) and are disabled by default, enabled per-user from the popup's HUD display settings.

### Confirmed Statistical Definitions (PT4-aligned, audited 2026-03, re-aligned 2026-07 #115)

These definitions were validated by hand-tracing 22 hands from the integration test suite (2026-03), then cross-checked against PT4/HM3 official documentation and an independent oracle over a 393,830-event real-data capture (2026-07, #115 — see `npm run verify-stats`):

- **CBet (CB)**: PFR opens betting on flop (phasePrevBetCount=0, cBetter=playerId). Extended to turn/river while initiative retained.
- **CBetFold (CBF)**: Fold rate **only when a CBet was actually executed** (`cBetExecuted=true`). If PFR checked (no CBet), subsequent bets by others do NOT create CBetFold opportunities. Scoped to the same street as the CBet (`cBetPhase` tracking).
- **WTSD** (PT4 built-in definition): Flops seen → showdown, where "flops seen" **includes preflop all-ins** — PT4 staff: "Those stats are based on flops seen, not based on flops seen when not all-in, so all-in spots will count." Phase membership for FLOP is `BetStatus === BET_ABLE || BetStatus === ALL_IN` in both `entity-converter.ts` and `write-entity-stream.ts` (#115); FOLDED players remain excluded (the original #97 fix stays in place — only the all-in carve-out was reversed). `SHOWDOWN_MUCK (RankType=11)` counts as showdown.
- **W$SD**: ALL showdowns including preflop ALL_IN. `SHOWDOWN_MUCK` counts as showdown. `NO_CALL (RankType=10)` does NOT count as showdown.
- **WWSF** (PT4 built-in definition): Flops seen → won, same "flops seen incl. preflop all-ins" population as WTSD above.
- **WTSDa / WWSFa** (opt-in variants, disabled by default, #115): Preserve the pre-#115 decision-focused semantics as an explicit choice rather than the primary definition. Lineage: PT4's custom stat "WTSD without preflop all-ins" and Hand2Note's "Flop Any Action"-based variants. Base (denominator) is hands where the player took **≥1 action with `phase === FLOP`** — a `BET_ABLE` flop-seer always acts at least once; a preflop all-in player never does, reproducing the "no preflop all-ins" population without a second BetStatus re-derivation. WTSDa numerator: base hands that reached a SHOWDOWN phase. WWSFa numerator: base hands in `winningHandIds`. Implemented purely in `calculate()` (no schema changes). Enable from the popup's HUD display settings (`StatisticsConfigSection`); `defaultStatDisplayConfigs` respects `StatDefinition.enabled !== false`, and `mergeStatDisplayConfigs` appends them disabled for existing users.
- **AF** (PT4 official definition, postflop-only): `(BET+RAISE) / CALL`, **counting only actions with `phase !== PREFLOP`**. PT4: "Ratio of the times a player makes a POSTFLOP aggressive action (bet or raise) to the times they call." CHECK and FOLD excluded from both numerator and denominator; preflop opens/3-bets/etc. are excluded entirely (previously counted across all streets — corrected in #115).
- **AFq** (postflop-only, same scope as AF): `(BET+RAISE) / (BET+RAISE+CALL+FOLD)`, postflop actions only. CHECK excluded from denominator.
- **VPIP / PFR** (PT4/HM walk-exclusion standard, #115): Denominator is **hands − walks**, not all hands played. A hand is excluded from the denominator when the player was the BB (`Hand.bigBlindUserId`, derived from `Game.BigBlindSeat` at EVT_DEAL in both `entity-converter.ts` and `write-entity-stream.ts`) **and** took zero preflop actions in that hand — this covers both a true walk (everyone folds to the BB) and the documented "BB action skip" path (`NextActionSeat=-2`, no BB EVT_ACTION emitted; 31.9% of hands per the real-data audit). In both cases the BB had no voluntary preflop decision to make. A non-BB player who folded preflop still made a decision and remains counted as an opportunity. `Hand.bigBlindUserId` is a non-indexed optional field (no Dexie schema version bump required).
- **VPIP·F (vpipF)**: **HUD-original stat with no tracker equivalent** (トラッカー非互換のHUD独自指標, like RCA below) — opt-in, disabled by default. Same numerator/denominator logic as VPIP above (including walk exclusion, #115), restricted to "full-table-layer" hands only, computed **table-type relative**: a 6-max hand (`Hand.seatUserIds.length === 6`) qualifies when ≥5 of the 6 seats are dealt (non `-1`); a 4-max hand (`length === 4`) qualifies only when all 4 seats are dealt (a 4-max hand with 3 dealt is already short-handed behavior and is excluded). Rationale: real-data cross-check against the poker-warehouse analysis (hero=sola, 1,980 recent hands) shows VPIP inflates structurally as table size shrinks in SNG play — 5-6p 35.2% vs 4p 47.0% vs 3p 56.1% vs HU 71.9%, a 30+pt spread — because (a) VPIP mechanically approaches 100% heads-up, and (b) the high-VPIP zone (≤3 players left) is only reached by players who survived that far, so late-game hands' share of a player's sample is itself a function of their results (survivorship), distorting cross-player comparison on the plain aggregate. `vipF` restricts the primary number to the structurally comparable full-table population. Implemented purely in `calculate()` off `context.hands[].seatUserIds` (`src/stats/core/vpip-full.ts`, `classifyVpipFLayer` — re-exports the shared `classifyTableSizeLayer` from `src/utils/table-size.ts`, the single implementation of this rule) — no schema/entity-converter/write-entity-stream changes, no `REBUILD_ADVISORY_VERSION` bump, same opt-in wiring as WTSDa/WWSFa. A `StatDefinition.tooltip(context)` hook (new, generic — see `types/stats.ts`) renders a per-layer breakdown (`VPIP·F 35.2% (n=1252) | 4p 47.0% (n=279) | 3p 56.1% (n=221) | HU 71.9% (n=146)`) surfaced via the HUD stat cell's native `title` attribute; the cell itself still shows only the plain VPIP·F percentage. See `workspace/reports/pokerchase-hud-vpip-f-handover.md` for the full analysis this is based on. The C案 table-size *filter* (`FilterOptions.tableSize`, popup 卓人数 section) applies this same full/4p/3p/hu split to every HUD stat, at the same application point/ordering as `gameTypes` (filter, then `handLimit`) — see the `FilterOptions` row above.
- **3-Bet Fold (3BF)**: PT4's **general** "Fold to 3-Bet" variant — fold rate when facing curPrevBetCount=3, regardless of whether this player made the original raise being 3-bet ("cold-facing" is included). This is distinct from PT4's separate "Fold to 3-Bet After Raising" stat, which HUD does not implement.
- **Steal (STL)**: First-in raise from CO/BTN/SB when folded to (mechanical PT4/HM3 definition). **Heads-up hands are INCLUDED**: the HU button posts the SB and is labeled `SB` by `getPositionMap` (a steal position), so HU button opens count as steal attempts — this matches PT4/HM3/Poker Copilot, none of which carve out heads-up. Measured on real data: HU contributes 6.9% of all steal chances (~98% of HU hands generate one, since the SB first-in is always unopened). Do not "fix" this by excluding HU; it is the industry-standard behavior.
- **FoldToSteal (FTS)**: Blind (SB/BB) folds when facing an identified steal raise (`phasePrevBetCount=2`). Heads-up BB defenses are likewise INCLUDED (5.1% of all FTS chances), per the same standard.
- **River Call Accuracy (RCA)**: **HUD-original stat with no tracker equivalent** (not a PT4/HM3/Poker Copilot stat). Numerator is river CALL actions that won the hand (`RIVER_CALL_WON`); denominator is all river CALL actions (`RIVER_CALL`). Included for its own diagnostic value, not as a cross-tracker-comparable metric.

See `docs/hand-analysis.md` for the 22-hand audit trail (note: that document predates the 2026-07 #115 re-alignment — its AF/AFq/WTSD/WWSF/VPIP values reflect the pre-#115 definitions; see the note at the top of that file).

### Key Concepts

#### `phasePrevBetCount` (Preflop)

- **1**: Only BB posted (no raises)
- **2**: After first raise (2-bet)
- **3**: After 3-bet
- Used for 3-bet opportunity detection

#### `ActionDetail` Flags

Markers for specific actions used in statistics:

- `VPIP`: Voluntary pot entry
- `$3BET_CHANCE` / `$3BET`: 3-bet opportunities and executions
- `CBET_CHANCE` / `CBET`: Continuation bet tracking
- `ALL_IN`: All-in marker (action normalization)

### Real-time Statistics

Dynamic statistics for all players, with hero having additional hand improvement display. Updates per action/street.

#### Pot Odds Calculator (`pot-odds.ts`)

- **Pot Size**: Total pot including all bets
- **Call Amount**: Required chips to continue
- **Pot Odds %**: Call amount as percentage of total pot
- **Ratio**: Traditional odds format (e.g., "3:1")
- **SPR**: Stack-to-Pot Ratio for commitment decisions
- **All-Player Support**: `calculatePlayerPotOdds` works for any seat position

#### Hand Improvement (`hand-improvement.ts`)

- **Preflop**: Uses probability tables for pocket pairs, suited, offsuit
- **Postflop**: Dynamic calculation based on community cards
- **Caching**: Last 10 hero hands cached for performance
- **Display**: Probability table showing all possible hands

#### Poker Evaluator (`poker-evaluator.ts`)

- **Algorithm**: Bit manipulation for fast hand evaluation
- **Support**: 5-7 card evaluation
- **Features**: Handles wheel straights (A-2-3-4-5)
- **Performance**: Optimized for real-time calculations

#### Starting Hand Rankings (`starting-hand-rankings.ts`)

- **Coverage**: All 169 unique starting hands
- **Format**: "AA (1/169)", "72o (169/169)"
- **Categories**: Pocket pairs, suited, offsuit

## Data Model & Events

> **Canonical reference**: [docs/api-events.md](docs/api-events.md) consolidates event specifications, field relationships, edge cases, card encoding, and enum definitions. This section covers HUD-specific implementation details.

### ApiEvent Architecture

> **Event types, field relationships, data dependencies, edge cases, enums**: See [docs/api-events.md](docs/api-events.md).

#### Schema & Validation (HUD-specific)

- **Single Source of Truth**: Types derived from Zod schemas in `src/types/api.ts`
  - `ApiEvent<T>` generic type, `apiEventSchemas` object, `ApiEventSchema` discriminated union
  - Schema mode: `passthrough()` — unknown properties preserved
  - Schema diff: `npm run schema-diff -- <file.ndjson>` for offline change detection
- **Entity schemas** in `src/types/entities.ts`: `Hand`, `Phase`, `Action`, `User` with parse functions
- **Type guards** (no type assertions): `isApiEventType()`, `parseApiEvent()`, `isApplicationApiEvent()`, `getValidationError()`
- **Breaking changes**: Use `ApiEvent` (removed: `ApiEventType`, `ApiEventUnion`, `ApiEventSubset`, `ApiEventMap`)
- **Validation gates the pipeline, never storage** (Raw Event Lake — see Design Principles #16 and `docs/architecture.md`): `apiEvents.add()` in `src/background/event-ingestion.ts` runs before `parseApiEvent`/`isApplicationApiEvent` and stores anything with a numeric `timestamp`+`ApiTypeId` — non-application events (202/205 keepalive/timer), ApiTypeIds unknown to `apiEventSchemas`, and app-type events that currently fail to parse are all persisted. The same event is only forwarded to `eventLogger`/`handLogStream`/`handAggregateStream`/`realTimeStatsStream` when it *does* parse as a known application event. Any code path that reads raw `apiEvents` rows and feeds them into `EntityConverter` or `HandLogProcessor` (which read required fields like `EVT_DEAL.Game.SmallBlind` without guards) must first re-validate with `filterValidApplicationEvents()` (`src/utils/database-utils.ts`) — see `rebuildAllData`, `AutoSyncService.rebuildLocalEntities`, and `HandLogExporter`'s two prefetch sites for the pattern.
- **Cloud sync is application-type-only** (cost decision, not a data-loss concern): `AutoSyncService.syncToCloud()` filters each raw chunk to `isApplicationApiEvent` before upload — non-application noise and unparseable rows never leave the device. The upload cursor still advances on the *raw* chunk boundary (not the filtered subset), otherwise a chunk that's 100% noise would never advance and the sync loop would refetch it forever.

### Database Schema

Defined in `src/db/poker-chase-db.ts` (Dexie/IndexedDB). See [docs/architecture.md](docs/architecture.md) for design rationale.

#### Tables (v3)

| Table | Primary Key | Key Indexes | Purpose |
|---|---|---|---|
| `apiEvents` | `[timestamp+ApiTypeId]` | `[ApiTypeId+timestamp]` | Raw WebSocket events — the full Lake (see above), not just application events |
| `hands` | `id` (auto) | `*seatUserIds`, `approxTimestamp` | Processed hand data |
| `phases` | `[handId+phase]` | `handId`, `*seatUserIds` | Per-street state |
| `actions` | `[handId+index]` | `[playerId+phase]`, `[playerId+actionType]`, `*actionDetails` | Player actions with stat markers |
| `meta` | `id` | `updatedAt` | Import status, stats cache, sync state |

v3 migration added composite indexes for player-specific queries. `MetaRecord` replaced `ImportMeta`. No later version bump was needed to restore full-Lake storage (removing the `creating`/`reading` hooks is not an index change).

**Storage growth**: `apiEvents` now also durably stores non-application noise (202/205 keepalive/timer events at roughly the same volume as application events per session — expect apiEvents row count to grow, not just its "useful" subset). IndexedDB quota is browser-managed and generally GB-scale (much larger than `storage.local`'s ~10MB), so this is not expected to be a practical problem. There is currently **no automatic pruning** of `apiEvents`: the existing quota-exceeded handling in `src/services/poker-chase-service.ts` (`cleanupOldStorageData`) and `src/utils/database-utils.ts` (`withTransaction`'s `QuotaExceededError` branch) targets `chrome.storage.local` service-state persistence and IndexedDB transaction errors respectively — neither actively prunes `apiEvents` rows. Users can reset via the popup's "全データ削除" if this ever becomes a real problem; revisit with active pruning only if it does.

### Configuration & Storage

#### Chrome Storage

- **`storage.sync`**: User preferences (`options`, `uiConfig`, `handLogConfig`) and HUD positions (`hudPosition_0`–`hudPosition_5`, `hudPosition_100`)
- **`storage.local`**: Service state persistence (`pokerChaseServiceState` — playerId, latestEvtDeal, session)

#### Config Interfaces

| Interface | Location | Key Fields |
|---|---|---|
| `UIConfig` | `src/types/hand-log.ts` | `displayEnabled`, `scale` (0.5–2.0) |
| `HandLogConfig` | `src/types/hand-log.ts` | `enabled`, `maxHands`, `position`, `width`, `height`, `fontSize`, `opacity` |
| `FilterOptions` | `src/types/filters.ts` | `gameTypes` (sng/mtt/ring), `tableSize` (full/4p/3p/hu players-dealt layer, `src/utils/table-size.ts`, opt-out multiselect, missing key = all layers/no filter), `handLimit`, `statDisplayConfigs` |
| `HudPosition` | `src/components/Hud.tsx` | `top`, `left` (percentage) |

#### Data Flow

Popup → `chrome.runtime.sendMessage` → Background → forwarded to game tabs → React re-render.

#### Service State Persistence

Key `pokerChaseServiceState` in `storage.local`. Auto-saved with 500ms debounce on setter calls. Restored on Service Worker startup. Handles quota exceeded with automatic cleanup.

---

## Cloud Sync & Firebase Integration

### Architecture

- **Service Worker Compatible**: Firebase SDK v12+ with chrome.identity authentication
- **Data Structure**: `/users/{userId}/apiEvents/{timestamp_ApiTypeId}`
- **Sync Strategy**: Incremental upload, full download (cloud as source of truth)
- **Cost Optimized**: 100+ event threshold, no periodic sync
- **Application-type-only sync**: unlike local `apiEvents` (the full Raw Event Lake), Firestore only ever receives application-type events — `AutoSyncService.syncToCloud()` filters each raw chunk with `isApplicationApiEvent` before upload. Non-application noise (202/205 keepalive/timer) and anything that fails to parse stay local-only; this is a cost decision (Firestore write/storage cost), not a data-loss risk, since the local Lake already has the raw copy.

### Key Features

- **Auto Sync**: Triggers on two independent events, both gated by the same 100+ new-event backlog threshold (`AutoSyncService.EVENTS_THRESHOLD`) via a shared `syncIfBacklogExceedsThreshold()` helper:
  - **Primary — session end** (`EVT_SESSION_RESULTS`/309): `AutoSyncService.onGameSessionEnd()`
  - **Fallback — session start** (`EVT_ENTRY_QUEUED`/201 or `EVT_SESSION_DETAILS`/308): `AutoSyncService.onNewSessionStart()`. Added after the 2026 season-3 incident (`docs/postmortems/2026-07-session-results-drop.md`) where 309 alone was a single point of failure — a PokerChase payload change broke its schema and silently stopped auto-sync for ~2 months. Session start is a safe moment to sync (no hand is in flight), and reusing the same threshold check means a broken 309 now costs at most one session's lag instead of indefinite silence. No extra debounce is needed: the in-flight guard (`isSyncing`) and the fact that a successful sync advances `lastSyncTime` (shrinking the backlog below threshold) together prevent a double-fire when 309 fired normally just before session start.
- **Manual Sync**: Upload/download controls in popup
- **BigQuery Export**: Automatic daily snapshots for analysis
- **Free Tier Friendly**: Typical usage stays within limits

**Important**: Update `src/services/firebase-config.ts` with your Firebase configuration.

For detailed setup instructions, see [docs/firebase-setup.md](docs/firebase-setup.md).

---

## Important Reminders

- **Do what has been asked; nothing more, nothing less.**
- **NEVER create files unless they're absolutely necessary for achieving your goal.**
- **ALWAYS prefer editing an existing file to creating a new one.**
- **NEVER proactively create documentation files (\*.md) or README files. Only create documentation files if explicitly requested by the User.**
