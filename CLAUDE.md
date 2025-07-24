# PokerChase HUD v2 - AI Agent Documentation

> 🎯 **Purpose**: Technical reference for AI coding agents working on the PokerChase HUD Chrome extension.
>
> 📅 **Last Updated**: 2025-07-24

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
  - Current status: All 270 tests passing ✅
- **Build Commands**:
  - `npm run build` - Production build
  - `npm run typecheck` - TypeScript validation
  - `npm run test` - Run test suite
  - `npm run postbuild` - Create extension.zip
  - `npm run validate-schema` - Validate API events in NDJSON files
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

## Implementation Details

### Table & Seat Handling

- **Variable Table Size**: Maximum 4 or 6 seats
  - Check `SeatUserIds.length` to determine actual table size
  - Empty seats represented as null in arrays
  - PokerStars format compliance required for exports
- **Hero Positioning**: Always place hero at position 0 (UI bottom center)
  - No dealer position in PokerChase; no absolute seat numbering
  - `SeatUserIds` index = logical seat number (randomly assigned)
  - Hero `UserId` = `SeatUserIds[Player.SeatIndex]` from EVT_DEAL
  - Dual coordinate system: originalSeatIndex (DB/export) vs rotated position (UI)
  - Use `rotateArrayFromIndex` utility for seat array transformations

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

- **Event Schema**: PokerChase API controls schema; may change without notice
- **Event Ordering**: Guaranteed logical sequence, but may have connectivity losses
- **Data Dependencies**:
  - Hero identification requires EVT_DEAL.Player field
  - HandId only available at hand completion (EVT_HAND_RESULTS)
  - Player names from EVT_PLAYER_SEAT_ASSIGNED or EVT_PLAYER_JOIN
- **Graceful Degradation**: Show "No Data" or cached values when data incomplete
- **Session Continuity**: Preserve session state across WebSocket reconnections
- **Batch vs Live**: Use `service.setBatchMode()` to differentiate import from live events
- **Service Worker Keepalive**: 
  - Sends keepalive messages every 25 seconds during active games
  - Automatically starts on EVT_SESSION_DETAILS (game start)
  - Stops on EVT_SESSION_RESULTS (game end) or tab visibility change
  - Prevents Service Worker from timing out after 30 seconds

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

### Adding New Statistics

For detailed instructions on how to add new statistics to the HUD, please see [CONTRIBUTING.md](./CONTRIBUTING.md).

### Statistics Philosophy

**Player Decision Focus**: Statistics like WTSD and WWSF measure player decision-making rather than automatic game outcomes. Preflop all-ins are excluded because they involve no post-flop decisions, ensuring statistics reflect actual player tendencies and "stickiness" rather than forced showdowns.

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

### ApiEvent Architecture

#### Event Schema Constraints

- **External Control**: `ApiEvent` schema is provided by PokerChase API and outside developer control
- **Schema Volatility**: May change partially without notice, requiring defensive coding
- **Event Ordering**: Events arrive in guaranteed logical sequence
- **Connectivity Issues**: Events may be lost due to player-side network problems
- **Runtime Validation**: Zod schemas provide runtime type checking and validation
  - **Complete Zod Schema Way Pattern**: Types are now derived from schemas (Single Source of Truth)
  - All API events have corresponding Zod schemas in `src/types/api.ts`
  - Use `ApiEventSchema` for discriminated union validation
  - `validate-schemas` tool can verify NDJSON exports against schemas
  - **Schema organization**:
    - Consolidated 5 redundant type definitions into single `ApiEvent<T>` type
    - Individual event schemas exported via `apiEventSchemas` object
    - Common sub-schemas for reusability: `seatIndexSchema`, `playerBaseSchema`, `progressBaseSchema`, etc.
    - Direct schema access: `apiEventSchemas[ApiType.EVT_DEAL]`
    - Schema access functions: `getEventSchema()`, `parseEventWithSchema()`, `getAvailableEventTypes()`
  - **Entity types migration** (`src/types/entities.ts`):
    - Converted `Hand`, `Phase`, `Action`, `User` to Zod schemas
    - Added MetaRecord schemas with union types for type-safe variants
    - Export parse functions: `parseHand()`, `parsePhase()`, `parseAction()`, `parseMetaRecord()`
    - Session kept as interface due to function properties
- **Type Guard Functions**: Safe type narrowing without assertions
  - `isApiEventType(event, type)`: Type-safe event type checking
  - `parseApiEvent(data)`: Parse and validate with proper typing
  - `getValidationError(error)`: Extract readable error messages
  - `isApplicationApiEvent(event)`: Filter non-game events
  - Eliminated all type assertions (`as`) in favor of type guards
  - Non-application events automatically filtered at database level
- **Breaking Changes**:
  - **Removed exports**: `ApiEventType`, `ApiEventUnion`, `ApiEventSubset`, `ApiEventMap`
  - Use `ApiEvent` instead of removed types

#### Data Dependencies & Timing

**Critical Dependencies**:

- **Hero Identification**: Requires `EVT_DEAL` with `Player` field (missing in spectator mode)
- **Player Names**: Available via `EVT_PLAYER_SEAT_ASSIGNED` (initial) or `EVT_PLAYER_JOIN` (mid-game)
- **Session Info**: From `RES_ENTRY_QUEUED` (ID, battle type) and `EVT_SESSION_DETAILS` (name)
  - A "Session" represents a complete game instance (tournament, ring game, etc.)
  - Contains metadata like game type, stakes, and tournament structure
  - Persists across multiple hands until game completion
- **HandId**: Only available at hand completion (`EVT_HAND_RESULTS`)
- **UserId**: Obtained via `SeatUserIds[Player.SeatIndex]` from `EVT_DEAL`

**Aggregation Challenges**:

- Hand-level aggregation requires `HandId` which only arrives at hand end
- Must verify all required events are received before processing
- Player information arrives incrementally across multiple events
- Cannot aggregate hands in real-time; must buffer until boundary detected

**State Management**:

- Must handle missing events gracefully
- Session continuity must be maintained across reconnections
- Import vs live events must be differentiated via `service.setBatchMode()`

### Event Types

**Event categories**:
- **Session Events** - Game lifecycle (RES_ENTRY_QUEUED, EVT_SESSION_DETAILS/RESULTS)
- **Player Events** - Seating and identification (EVT_PLAYER_SEAT_ASSIGNED, EVT_DEAL)
- **Game Events** - Actions and results (EVT_ACTION, EVT_DEAL_ROUND, EVT_HAND_RESULTS)

**Key relationships**:
- Hero ID: `SeatUserIds[EVT_DEAL.Player.SeatIndex]`
- Table size: `SeatUserIds.length` (4 or 6)
- HandId: Only available at EVT_HAND_RESULTS

For complete event reference, see [docs/reference/api-events.md](docs/reference/api-events.md).

### Database Schema

Database schema is defined in `src/db/poker-chase-db.ts` using Dexie (IndexedDB wrapper).

#### Tables & Indexes (v3)

**`apiEvents`** - Raw WebSocket events storage

- Primary: `[timestamp+ApiTypeId]` (compound key for uniqueness)
- Indexes: `timestamp`, `ApiTypeId`, `[ApiTypeId+timestamp]` (v3: for efficient type-specific queries)
- Purpose: Store all events for replay, import/export, debugging
- **Hooks**: Automatic filtering of non-application events on read/write

**`hands`** - Processed hand data

- Primary: `id` (auto-increment)
- Indexes: `*seatUserIds`, `*winningPlayerIds` (multi-entry), `approxTimestamp` (v3: for recent hands queries)
- Contains: Session info, player mapping, winners

**`phases`** - Hand phases (preflop/flop/turn/river)

- Primary: `[handId+phase]` (compound key)
- Indexes: `handId`, `*seatUserIds`, `phase`
- Contains: Player states, bet counts, pot size per phase

**`actions`** - Player actions with statistics markers

- Primary: `[handId+index]` (compound key)
- Indexes: `handId`, `playerId`, `phase`, `actionType`, `*actionDetails`, `[playerId+phase]`, `[playerId+actionType]` (v3: for player-specific queries)
- Contains: Action type, bet amount, `ActionDetail` flags

**`meta`** - Generic metadata storage (v3: expanded from ImportMeta)

- Primary: `id`
- Indexes: `updatedAt` (v3: for cache expiration)
- Purpose: Store various metadata including:
  - Import tracking (`importStatus`)
  - Statistics cache (`statisticsCache:*`)
  - Rebuild status (`rebuildStatus`)
  - Sync state and other app metadata
- **Schema**: `MetaRecord` with flexible `value` field

#### Version Migrations

- **v1**: Initial schema
- **v2**: Added indexes for common queries
- **v3**: Performance optimization with composite indexes and expanded meta table
  - Added composite indexes: `[ApiTypeId+timestamp]`, `[playerId+phase]`, `[playerId+actionType]`
  - `MetaRecord` replaces `ImportMeta` for flexible metadata storage
  - New indexes enable efficient type-specific and player-specific queries

See `PokerChaseDB` class for detailed schema and hook implementations.

### Configuration & Storage

#### Chrome Storage Architecture

Configuration uses Chrome's `storage.sync` API for cross-device synchronization:

**Storage Areas**:

- `sync`: User preferences, HUD positions (synced across devices)
- `local`: Service state persistence (PokerChaseService state)

#### Configuration Interfaces

**`UIConfig`** (`src/types/hand-log.ts`)

- `displayEnabled`: Master toggle for all HUD elements
- `scale`: Global scale factor (0.5 - 2.0)

**`HandLogConfig`** (`src/types/hand-log.ts`)

- `enabled`: Show/hide hand log
- `maxHands`: Number of hands to display (1-50)
- `position`: Screen position ('top-left', 'bottom-right', etc.)
- `width`, `height`: Dimensions in pixels
- `fontSize`: Text size (8-16px)
- `opacity`: Background transparency (0-1)

**`FilterOptions`** (`src/types/filters.ts`)

- `gameTypes`: Object with `sng`, `mtt`, `ring` boolean flags
- `handLimit`: Number of recent hands for stats (20, 50, 100, 200, 500, or undefined for all)
- `statDisplayConfigs`: Array of enabled statistics with display order

**`HudPosition`** (`src/components/Hud.tsx`)

- `top`, `left`: Percentage-based positioning
- Stored per seat for individual HUD placement

#### Storage Keys

**User Preferences**:

- `options`: Main configuration object (includes `FilterOptions`)
- `uiConfig`: UI scale and display toggle
- `handLogConfig`: Hand log display settings

**HUD Positions**:

- `hudPosition_0` to `hudPosition_5`: Regular HUD positions per seat
- `hudPosition_100`: Hero's real-time stats HUD position

#### Data Flow

1. **Popup → Background**: Settings changes via `chrome.runtime.sendMessage`
2. **Background → Content**: Updates forwarded to all game tabs
3. **Content → UI**: React components re-render with new settings
4. **Persistence**: Automatic via Chrome sync storage

#### Service State Persistence

**Storage Key**: `pokerChaseServiceState`

**Persisted Data**:
- `playerId`: Current hero player ID
- `latestEvtDeal`: Most recent EVT_DEAL event for seat mapping
- `session`: Game session information (id, battleType, name, players)
- `lastUpdated`: Timestamp of last persistence

**Persistence Features**:
- **Automatic saving**: Triggered by setter methods with 500ms debounce
- **Restoration on startup**: Service worker loads state before processing events
- **Quota handling**: Automatic cleanup of old temporary data on quota exceeded
- **Error resilience**: Continues operation even if storage fails

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
