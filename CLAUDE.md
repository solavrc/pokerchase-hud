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
  - Current status: All 332 tests passing (38 suites) ✅
- **Build Commands**:
  - `npm run build` - Production build
  - `npm run typecheck` - TypeScript validation
  - `npm run test` - Run test suite
  - `npm run postbuild` - Create extension.zip
  - `npm run validate-schema` - Validate API events in NDJSON files
  - `npm run schema-diff` - Detect API schema changes (additions/removals) in NDJSON files
  - `npm run firebase:deploy` - Deploy Firestore rules and indexes
  - `npm run firebase:deploy:rules` - Deploy Firestore rules only
  - `npm run firebase:deploy:indexes` - Deploy Firestore indexes only
  - `npm run firebase:emulators` - Start local Firestore emulator

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

Important technical decisions are documented in `docs/adr/`:

- **ADR-001: Data Storage Architecture** - Rationale for Dexie.js, normalized entities, and Firestore strategy
- **ADR-002: Database Index Optimization** - v3 migration with composite indexes for performance

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

### Data Flow

#### Real-time Processing

```
WebSocket Events (from content_script)
    │
    ├─► Database (apiEvents.add) ─── Persistent storage
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

**Event Order Handling:**

- **AggregateEventsStream**: Buffers events until hand boundaries (EVT_HAND_RESULTS)
- **Incomplete Data**: Streams handle missing player info gracefully
- **Late Arrivals**: Session info updates retroactively when received
- **Duplicate Prevention**: Events keyed by timestamp+ApiTypeId

#### Import Processing

```
NDJSON File (.ndjson)
    ↓
Parse & Validate
    ↓
Chunk Processing
    ├─► Duplicate Detection (Set-based, O(1))
    └─► New Events Collection
         ↓
EntityConverter (Direct generation)
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

**Critical Design Constraints (learned 2026-03):**

> **Data model & event edge cases** are consolidated in [docs/reference/api-events.md](docs/reference/api-events.md) — see "Data Constraints & Edge Cases", "Field Relationships", and "Enum Reference" sections.

- **EntityConverter state**: `convertEventsToEntities()` tracks hand boundaries via internal local variables (`currentHandEvents`). Must NOT be called in chunks — a hand spanning chunk boundaries will be lost. Always pass all events in a single call.
- **Dexie Collection reuse**: `processInChunks()` uses `.offset().limit()` on a Collection object, but Dexie Collections accumulate state. For reliable pagination, use cursor-based approach with `where('[timestamp+ApiTypeId]').above(lastKey).limit(N)`.
- **Export size limits**: Service Worker → content_script message limit is 64MiB. Data URL limit is ~2MB. Large exports use chunked message passing with Blob-based download in content_script.
- **PokerStars hand history format**: `calls` shows additional call amount (not total bet). `Dealt to` is hero-only. Summary uses `folded on the Flop/Turn/River`. See [docs/reference/pokerstars-export.md](docs/reference/pokerstars-export.md).
- **HandLogExporter batch optimization**: `exportMultipleHands` prefetches all hands and API events in 2 DB queries, then processes in memory. Avoids N+1 query pattern (previously 100 hands = 300+ DB queries). Single-hand `exportHand` retains per-hand DB queries for simplicity.
- **Popup ↔ Background state synchronization**: Long-running operations (export/import/rebuild) track state in `currentOperationState` global variable in background.ts. Popup queries via `getOperationState` on mount to restore UI after close/reopen. Progress messages (`processing` state) must also set the active operation state (not just `started`), because popup may miss `started` during close/reopen window.
- **Optimistic UI updates**: Button click handlers set local state immediately before sending message to background, then revert if background rejects. Prevents race window where buttons remain clickable between click and first progress message.
- **Background concurrent operation guard**: Background rejects `exportData`/`rebuildData` when `currentOperationState !== 'idle'`. This is the server-side guarantee against double execution regardless of popup UI state.
- **Firebase auth cache**: Auth state is cached to `chrome.storage.local` (`firebaseAuthCache` key) on `onAuthStateChange`. Popup reads cache first for instant rendering, then verifies with background. Prevents "not signed in" flash during heavy background operations.

## Implementation Details

### Table & Seat Handling

> **SeatUserIds semantics and field relationships**: See [docs/reference/api-events.md](docs/reference/api-events.md#field-relationships).

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

> **Event types, field relationships, data dependencies, edge cases, enums**: See [docs/reference/api-events.md](docs/reference/api-events.md).

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

For complete directory structure and file descriptions, see [docs/implementation/file-organization.md](docs/implementation/file-organization.md).

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
| `vpip`       | VPIP | Voluntarily put $ in pot %                     |
| `pfr`        | PFR  | Pre-flop raise %                               |
| `3bet`       | 3B   | 3-bet %                                        |
| `3betfold`   | 3BF  | Fold to 3-bet %                                |
| `cbet`       | CB   | Continuation bet %                             |
| `cbetFold`   | CBF  | Fold to c-bet %                                |
| `af`         | AF   | Aggression factor                              |
| `afq`        | AFq  | Aggression frequency %                         |
| `wtsd`       | WTSD | Went to showdown % (excludes preflop all-ins)  |
| `wwsf`       | WWSF | Won when saw flop % (excludes preflop all-ins) |
| `wsd`        | W$SD | Won $ at showdown %                            |
| `riverCallAccuracy` | RCA | River call accuracy % (calls that won)  |

### Adding New Statistics

For detailed instructions on how to add new statistics to the HUD, please see [CONTRIBUTING.md](./CONTRIBUTING.md).

### Statistics Philosophy

**Player Decision Focus**: Statistics like WTSD and WWSF measure player decision-making rather than automatic game outcomes. Preflop all-ins are excluded because they involve no post-flop decisions, ensuring statistics reflect actual player tendencies and "stickiness" rather than forced showdowns.

### Confirmed Statistical Definitions (PT4-aligned, audited 2026-03)

These definitions were validated by hand-tracing 22 hands from the integration test suite:

- **CBet (CB)**: PFR opens betting on flop (phasePrevBetCount=0, cBetter=playerId). Extended to turn/river while initiative retained.
- **CBetFold (CBF)**: Fold rate **only when a CBet was actually executed** (`cBetExecuted=true`). If PFR checked (no CBet), subsequent bets by others do NOT create CBetFold opportunities. Scoped to the same street as the CBet (`cBetPhase` tracking).
- **WTSD**: Flops seen → showdown. Preflop ALL_IN excluded (no flop phase). `SHOWDOWN_MUCK (RankType=11)` counts as showdown.
- **W$SD**: ALL showdowns including preflop ALL_IN. `SHOWDOWN_MUCK` counts as showdown. `NO_CALL (RankType=10)` does NOT count as showdown.
- **WWSF**: Flops seen → won. Preflop ALL_IN excluded.
- **AF**: `(BET+RAISE) / CALL` — CHECK and FOLD excluded from both numerator and denominator.
- **AFq**: `(BET+RAISE) / (BET+RAISE+CALL+FOLD)` — CHECK excluded from denominator.

See `docs/hand-analysis.md` for the full 22-hand audit trail.

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

> **Canonical reference**: [docs/reference/api-events.md](docs/reference/api-events.md) consolidates event specifications, field relationships, edge cases, card encoding, and enum definitions. This section covers HUD-specific implementation details.

### ApiEvent Architecture

> **Event types, field relationships, data dependencies, edge cases, enums**: See [docs/reference/api-events.md](docs/reference/api-events.md).

#### Schema & Validation (HUD-specific)

- **Single Source of Truth**: Types derived from Zod schemas in `src/types/api.ts`
  - `ApiEvent<T>` generic type, `apiEventSchemas` object, `ApiEventSchema` discriminated union
  - Schema mode: `passthrough()` — unknown properties preserved
  - Schema diff: `npm run schema-diff -- <file.ndjson>` for offline change detection
- **Entity schemas** in `src/types/entities.ts`: `Hand`, `Phase`, `Action`, `User` with parse functions
- **Type guards** (no type assertions): `isApiEventType()`, `parseApiEvent()`, `isApplicationApiEvent()`, `getValidationError()`
- **Breaking changes**: Use `ApiEvent` (removed: `ApiEventType`, `ApiEventUnion`, `ApiEventSubset`, `ApiEventMap`)

### Database Schema

Defined in `src/db/poker-chase-db.ts` (Dexie/IndexedDB). See [ADR-001](docs/adr/001-data-storage-architecture.md) and [ADR-002](docs/adr/002-database-index-optimization.md) for design rationale.

#### Tables (v3)

| Table | Primary Key | Key Indexes | Purpose |
|---|---|---|---|
| `apiEvents` | `[timestamp+ApiTypeId]` | `[ApiTypeId+timestamp]` | Raw WebSocket events |
| `hands` | `id` (auto) | `*seatUserIds`, `approxTimestamp` | Processed hand data |
| `phases` | `[handId+phase]` | `handId`, `*seatUserIds` | Per-street state |
| `actions` | `[handId+index]` | `[playerId+phase]`, `[playerId+actionType]`, `*actionDetails` | Player actions with stat markers |
| `meta` | `id` | `updatedAt` | Import status, stats cache, sync state |

v3 migration added composite indexes for player-specific queries. `MetaRecord` replaced `ImportMeta`.

### Configuration & Storage

#### Chrome Storage

- **`storage.sync`**: User preferences (`options`, `uiConfig`, `handLogConfig`) and HUD positions (`hudPosition_0`–`hudPosition_5`, `hudPosition_100`)
- **`storage.local`**: Service state persistence (`pokerChaseServiceState` — playerId, latestEvtDeal, session)

#### Config Interfaces

| Interface | Location | Key Fields |
|---|---|---|
| `UIConfig` | `src/types/hand-log.ts` | `displayEnabled`, `scale` (0.5–2.0) |
| `HandLogConfig` | `src/types/hand-log.ts` | `enabled`, `maxHands`, `position`, `width`, `height`, `fontSize`, `opacity` |
| `FilterOptions` | `src/types/filters.ts` | `gameTypes` (sng/mtt/ring), `handLimit`, `statDisplayConfigs` |
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

### Key Features

- **Auto Sync**: Triggers on game end with 100+ new events
- **Manual Sync**: Upload/download controls in popup
- **BigQuery Export**: Automatic daily snapshots for analysis
- **Free Tier Friendly**: Typical usage stays within limits

**Important**: Update `src/services/firebase-config.ts` with your Firebase configuration.

For detailed setup instructions, see [docs/implementation/firebase-setup.md](docs/implementation/firebase-setup.md).

---

## Important Reminders

- **Do what has been asked; nothing more, nothing less.**
- **NEVER create files unless they're absolutely necessary for achieving your goal.**
- **ALWAYS prefer editing an existing file to creating a new one.**
- **NEVER proactively create documentation files (\*.md) or README files. Only create documentation files if explicitly requested by the User.**
