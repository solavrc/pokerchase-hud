# PokerChase HUD v2 - AI Agent Documentation

> 🎯 **Purpose**: Technical reference for AI coding agents working on the PokerChase HUD Chrome extension.
>
> 📅 **Last Updated**: 2025-07-23

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
   - [Event Processing](#event-processing)
   - [Database Schema](#database-schema)
   - [Configuration & Storage](#configuration--storage)
8. [Cloud Sync & Firebase Integration](#cloud-sync--firebase-integration)
   - [Architecture](#cloud-architecture)
   - [Setup Requirements](#setup-requirements)
   - [Data Flow](#cloud-data-flow)
   - [BigQuery Integration](#bigquery-integration)
   - [Cost Optimization](#cost-optimization)

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
- BigQuery integration for data analysis

### Technical Stack

- **Extension**: Chrome Manifest V3
- **Frontend**: React 18 + TypeScript
- **UI Library**: Material-UI (modular imports)
- **Storage**: IndexedDB (Dexie) + Cloud (Firestore)
- **Cloud Services**: Firebase (Auth, Firestore)
- **Build**: esbuild
- **Testing**: Jest + React Testing Library
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
- **Language**:
  - Respond in Japanese (日本語) when communicating with users
  - Write CLAUDE.md documentation in English
- **Service Worker Compatibility**:
  - Avoid `window` object in background scripts
  - Use global timer functions (`setTimeout`, not `window.setTimeout`)
  - Consider Service Worker lifecycle in all background operations

#### Testing & Build

- **Test Organization**:
  - Test files are co-located with source files (e.g., `foo.ts` → `foo.test.ts`)
  - Test files use `.test.ts` extension
  - No separate test directories; improves visibility and reduces cognitive load
  - All new statistics require unit tests
- **Testing Requirements**:
  - Always run tests and type checking after code changes
  - Use `npm run test` and `npm run typecheck` commands
  - Ensure all tests pass before completing tasks
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
11. **Cloud Sync**: Automatic timestamp-based incremental sync with Firestore
    - No periodic sync (cost optimization)
    - Sync after 100+ new events at game end
    - No minimum interval between sync attempts
    - Timestamp-based queries for efficiency

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

#### Directory Structure

```
/                          # Project root
├── manifest.json          # Chrome extension manifest
├── package.json           # Node.js dependencies and scripts
├── tsconfig.json          # TypeScript configuration
├── esbuild.config.ts      # Build configuration
├── jest.config.cjs        # Test configuration
├── release-please-config.json  # Release automation config
├── CLAUDE.md              # This AI agent documentation
├── README.md              # Project overview
├── CONTRIBUTING.md        # Contribution guidelines
├── CHANGELOG.md           # Version history
├── firebase.json          # Firebase project configuration
├── .firebaserc            # Firebase project settings
├── firestore.rules        # Firestore security rules
├── firestore.indexes.json # Firestore index definitions
├── icons/                 # Extension icons
│   ├── icon_16px.png, icon_48px.png, icon_128px.png
│   └── README.png         # README screenshot
└── src/                   # Source code
    ├── app.ts             # Re-export layer for backward compatibility
    ├── background.ts      # Service worker for persistence
    ├── content_script.ts  # Bridge between page and extension
    ├── web_accessible_resource.ts  # WebSocket interception
    ├── entity-converter.ts     # Direct event-to-entity conversion
    ├── popup.ts           # Extension popup entry point
    ├── index.html         # Extension HTML
    ├── components/        # React UI components
    │   ├── App.tsx       # Root component with state management
    │   ├── Hud.tsx       # HUD overlay component
    │   ├── HandLog.tsx   # Hand history log component
    │   └── Popup.tsx     # Extension popup interface
    ├── db/
    │   └── poker-chase-db.ts  # Database definition (PokerChaseDB)
    ├── services/
    │   ├── poker-chase-service.ts      # Main service class
    │   ├── firebase-auth-service.ts    # Firebase authentication
    │   ├── firebase-config.ts          # Firebase configuration
    │   ├── firestore-backup-service.ts # Cloud sync logic
    │   └── auto-sync-service.ts        # Automatic sync management
    ├── stats/
    │   ├── core/         # Statistic definitions
    │   │   ├── 3bet.ts, 3bet-fold.ts
    │   │   ├── af.ts, afq.ts
    │   │   ├── cbet.ts, cbet-fold.ts
    │   │   ├── hands.ts, pfr.ts, vpip.ts
    │   │   ├── player-name.ts
    │   │   └── wsd.ts, wtsd.ts, wwsf.ts
    │   ├── helpers.ts    # Common helper functions
    │   ├── registry.ts   # Statistics registry
    │   └── utils.ts      # Utility functions
    ├── streams/
    │   ├── aggregate-events-stream.ts  # Event aggregation
    │   ├── write-entity-stream.ts      # Entity persistence
    │   ├── read-entity-stream.ts       # Statistics calculation
    │   ├── hand-log-stream.ts          # Hand history generation
    │   └── realtime-stats-stream.ts    # Real-time statistics
    ├── realtime-stats/    # Real-time statistics components
    │   ├── hand-improvement.ts         # Hand improvement calculator
    │   ├── pot-odds.ts                 # Pot odds calculator
    │   ├── realtime-stats-service.ts   # Real-time stats service
    │   └── index.ts                    # Module exports
    ├── tools/             # Development tools
    │   └── validate-schemas.ts  # NDJSON event validator
    ├── types/             # TypeScript type definitions
    │   ├── api.ts, entities.ts, errors.ts
    │   ├── filters.ts, game.ts, hand-log.ts
    │   ├── messages.ts, stats.ts
    │   └── index.ts      # Central export point
    └── utils/             # Utility modules
        ├── array-utils.ts    # Array manipulation
        ├── card-utils.ts     # Card formatting
        ├── error-handler.ts  # Error handling
        ├── hand-log-exporter.ts      # Export functionality
        ├── hand-log-processor.ts     # PokerStars format
        ├── poker-evaluator.ts        # Hand evaluation
        ├── river-probabilities.ts    # River probability tables
        └── starting-hand-rankings.ts # Starting hand rankings
```

### Extension Layer

#### `web_accessible_resource.ts`

- WebSocket constructor override
- API traffic interception
- Event forwarding via postMessage

#### `content_script.ts`

- Bridge between page and extension
- React app injection
- Message validation and routing
- **Keepalive mechanism**: Sends periodic messages to prevent Service Worker timeout
- **Game state tracking**: Monitors EVT_SESSION_DETAILS/RESULTS for active games
- **Resource cleanup**: Handles beforeunload and visibilitychange events

#### `background.ts`

- Service worker for persistence
- Import/export operations
- Connection lifecycle management
- Batch processing coordination
- **State initialization**: Waits for `service.ready` promise before processing
- **Keepalive handling**: Processes keepalive messages to stay active
- **Schema validation**: Validates all incoming API events with Zod
- **Auto data rebuild**: Rebuilds data from apiEvents on version update
- **Firebase auth**: Handles Google sign-in/out requests
- **Auto sync coordination**: Manages cloud sync after game sessions

### Data Processing Streams

#### `AggregateEventsStream` (`src/streams/aggregate-events-stream.ts`)

- Groups events by hand boundaries
- Manages session state
- Controls DB write modes (real-time vs replay)

#### `WriteEntityStream` (`src/streams/write-entity-stream.ts`)

- Decomposes events into entities
- Normalizes ALL_IN actions
- Delegates ActionDetail detection to statistics modules
- Supports batch mode

#### `ReadEntityStream` (`src/streams/read-entity-stream.ts`)

- Applies filters (game type, hand limit)
- Calculates statistics via registry
- Implements caching to improve performance
- Always returns 6-element array

#### `EntityConverter` (Import Optimization)

- Direct event-to-entity conversion
- Bypasses stream overhead
- Extracts session/player information
- Uses statistics modules for consistency
- Generates SHOWDOWN phases
- **Location**: `src/entity-converter.ts`

#### `RealTimeStatsStream` (`src/streams/realtime-stats-stream.ts`)

- Processes events in parallel with main pipeline
- Tracks all players' chip stacks and bet amounts
- Calculates pot odds and SPR for all players
- Computes hand improvement probabilities for hero
- Updates on each action and street
- Returns `AllPlayersRealTimeStats` with hero and player data

#### `HandLogStream` (`src/streams/hand-log-stream.ts`)

- Generates hand history entries in real-time
- Uses HandLogProcessor for consistent formatting
- Emits events for UI updates
- Resets hand state while preserving session data

### Services

#### `PokerChaseService` (`src/services/poker-chase-service.ts`)

- **Core service**: Central state management and stream coordination
- **Chrome Storage persistence**: Automatic state saving to survive Service Worker restarts
  - Uses getter/setter pattern for transparent persistence
  - Persists `playerId`, `latestEvtDeal`, and session data
  - Implements 500ms debouncing to optimize write frequency
- **Initialization promise**: `ready` property ensures complete initialization
  - Prevents race conditions during startup
  - Background script waits for this before processing events
- **Error handling**: Tracks initialization errors separately
  - `isReady` getter checks both initialization and error state
  - Storage quota exceeded handling with automatic cleanup
- **Session management**: Maintains game session continuity
  - Players Map with custom setter for persistence
  - Direct property access during restoration to avoid circular persistence

#### `AutoSyncService` (`src/services/auto-sync-service.ts`)

- **Automatic cloud synchronization**: Handles bidirectional sync with Firestore
- **Cost-optimized scheduling**:
  - Initial sync only on first authentication
  - No periodic sync (manual or event-driven only)
  - Event-driven sync after game sessions (100+ events threshold)
  - No minimum interval between sync attempts
- **Timestamp-based incremental sync**:
  - Tracks last sync timestamp in Firestore user metadata
  - Only syncs events newer than last timestamp
  - Reduces Firestore read/write operations significantly
- **Progress tracking**: Real-time progress updates for UI
- **State management**: Maintains sync state with status, progress, and errors
- **Data rebuild after sync**: Uses EntityConverter to rebuild hands/phases/actions from downloaded events

### Utility Modules

#### Schema Validator (`tools/validate-schemas.ts`)

- **Purpose**: Validates NDJSON export files against API event schemas
- **Usage**: `npm run validate-schema -- <file.ndjson>`
- **Features**:
  - Parses NDJSON files line by line
  - Validates each event against its Zod schema
  - Reports schema violations with detailed error messages
  - Handles large files efficiently
- **Default File**: Searches for default NDJSON file if no argument provided

#### Array Utilities (`array-utils.ts`)

- **rotateArrayFromIndex**: Safely rotates arrays from specified index
- **Error Handling**: Throws exceptions for null/undefined arrays and non-integer indices
- **Type Safe**: Generic function with proper TypeScript types
- **Usage**: Seat rotation, player ordering

#### Card Utilities (`card-utils.ts`)

- **formatCards**: Converts card indices to string format (e.g., [37, 51] → ['Jh', 'Ac'])
- **formatCardsArray**: Array version of card formatting
- **Consistent Format**: Used throughout for card display

#### Hand Log Processor (`hand-log-processor.ts`)

- **Core Logic**: Generates PokerStars-format hand histories
- **Accurate Showdown**: Last aggressor shows first
- **Enhanced Descriptions**: Detailed hand rankings (e.g., "two pair, Sevens and Deuces")
- **Tournament Tracking**: Player finish positions
- **Uncalled Bets**: Proper handling of returned chips in heads-up situations
- **Pot Calculations**: Excludes uncalled bets from total pot
- **Table Size**: Dynamically determined from `SeatUserIds.length`
- **Location**: `src/utils/hand-log-processor.ts`

#### Error Handler (`error-handler.ts`)

- **Centralized**: Consistent error handling across extension
- **User-Friendly**: Translates technical errors for users
- **Logging**: Controlled error logging for debugging

### UI Components

React components for the HUD interface. See individual component files for detailed implementation:

- **`App.tsx`**: Root component managing state and seat rotation logic
- **`Hud.tsx`**: HUD overlay with drag & drop (240px regular, 200px real-time stats)
- **`HandLog.tsx`**: Virtualized hand history log with PokerStars export
- **`Popup.tsx`**: Extension settings and import/export interface

For implementation details, see comments in `src/components/`.

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
  - All API events now have corresponding Zod schemas in `src/types/api.ts`
  - Use `ApiEventSchema` for discriminated union validation
  - `validate-schemas` tool can verify NDJSON exports against schemas

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

For complete type definitions and Zod schemas, see `src/types/api.ts`. All event types now have corresponding runtime validation schemas.

#### Session Events

| Event                 | ID  | Purpose                                    | Key Fields                |
| --------------------- | --- | ------------------------------------------ | ------------------------- |
| `RES_ENTRY_QUEUED`    | 201 | Session start, extracts ID and battle type | `SessionId`, `BattleType` |
| `EVT_SESSION_DETAILS` | 308 | Game configuration and name                | `SessionName`, `Config`   |
| `EVT_SESSION_RESULTS` | 309 | Session end, triggers cleanup              | `Results`, `Rankings`     |

#### Player Events

| Event                      | ID  | Purpose                          | Key Fields                                     |
| -------------------------- | --- | -------------------------------- | ---------------------------------------------- |
| `EVT_PLAYER_SEAT_ASSIGNED` | 313 | Initial seating with names/ranks | `SeatUserIds[]`, `PlayerNames[]`               |
| `EVT_PLAYER_JOIN`          | 301 | Mid-game joins                   | `JoinPlayer`, `SeatIndex`                      |
| `EVT_DEAL`                 | 303 | Hand start, hero identification  | `Player.SeatIndex`, `SeatUserIds[]`, `Cards[]` |

#### Game Events

| Event              | ID  | Purpose                         | Key Fields                           |
| ------------------ | --- | ------------------------------- | ------------------------------------ |
| `EVT_ACTION`       | 304 | Player actions (bet/fold/raise) | `UserId`, `ActionType`, `BetSize`    |
| `EVT_DEAL_ROUND`   | 305 | New street (flop/turn/river)    | `DealType`, `Cards[]`                |
| `EVT_HAND_RESULTS` | 306 | Hand completion, winners        | `HandId`, `Results[]`, `WinnerIds[]` |

### Event Processing

#### Typical Hand Event Sequence

For concrete examples with actual event data, see `src/app.test.ts`.

```
1. EVT_DEAL (303)
   - Provides: Hero identification, initial SeatUserIds
   - Extract: Hero UserId = SeatUserIds[Player.SeatIndex]

2. EVT_ACTION (304) [multiple]
   - Preflop actions: posts, raises, calls, folds
   - Track: Who entered pot (VPIP), who raised (PFR)

3. EVT_DEAL_ROUND (305) - Flop
   - Community cards revealed
   - Reset street-specific counters

4. EVT_ACTION (304) [multiple]
   - Flop actions: checks, bets, raises
   - Track: Continuation bets, aggression

5. EVT_DEAL_ROUND (305) - Turn
6. EVT_ACTION (304) [multiple]
7. EVT_DEAL_ROUND (305) - River
8. EVT_ACTION (304) [multiple]

9. EVT_HAND_RESULTS (306)
   - Provides: HandId, winners, final pot
   - Triggers: Statistics calculation, hand log generation
```

#### Event Data Relationships

**SeatUserIds Array**:

- Length determines table size (4 or 6)
- Index = logical seat position
- Value = UserId (or -1 for empty)
- Order randomly assigned at seating

**Player Identification Flow**:

```
EVT_PLAYER_SEAT_ASSIGNED → Initial player names/ranks
         ↓
EVT_DEAL.Player.SeatIndex → Hero seat identification
         ↓
SeatUserIds[Player.SeatIndex] → Hero UserId
         ↓
EVT_ACTION.UserId → Track hero's actions
```

### Database Schema

Database schema is defined in `src/db/poker-chase-db.ts` using Dexie (IndexedDB wrapper).

#### Tables & Indexes

**`apiEvents`** - Raw WebSocket events storage

- Primary: `[timestamp+ApiTypeId]` (compound key for uniqueness)
- Indexes: `timestamp`, `ApiTypeId`
- Purpose: Store all events for replay, import/export, debugging

**`hands`** - Processed hand data

- Primary: `id` (auto-increment)
- Indexes: `*seatUserIds`, `*winningPlayerIds` (multi-entry)
- Contains: Session info, player mapping, winners

**`phases`** - Hand phases (preflop/flop/turn/river)

- Primary: `[handId+phase]` (compound key)
- Indexes: `handId`, `*seatUserIds`, `phase`
- Contains: Player states, bet counts, pot size per phase

**`actions`** - Player actions with statistics markers

- Primary: `[handId+index]` (compound key)
- Indexes: `handId`, `playerId`, `phase`, `actionType`, `*actionDetails`
- Contains: Action type, bet amount, `ActionDetail` flags

**`meta`** - Import tracking and incremental processing

- Primary: `id`
- Purpose: Track last processed timestamp for incremental updates

See `PokerChaseDB` class for detailed schema and version migrations.

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

**Service Worker Compatible Design**:
- Firebase SDK's XMLHttpRequest dependency prevents direct usage in Service Workers
- Solution: Use Firestore REST API for cloud operations
- Authentication via `chrome.identity` API with Firebase credential exchange

**Data Structure**:
```
Firestore:
/users/{userId}/
  /apiEvents/{eventId}  // eventId = timestamp_ApiTypeId
    - timestamp: number
    - ApiTypeId: number
    - [event data...]
```

### Setup Requirements

1. **Firebase Project**:
   - Authentication with Google provider
   - Firestore database (asia-northeast1 recommended)
   - Security rules deployment via `npm run firebase:deploy:rules`

2. **OAuth Configuration**:
   - Chrome Extension OAuth client in Google Cloud Console
   - Manifest.json `oauth2` section with client ID
   - Scopes: userinfo.email, userinfo.profile

3. **Extension ID Management**:
   - Development and production IDs differ
   - Cannot share IDs between local dev and Chrome Web Store
   - Requires separate OAuth clients for each environment

### Cloud Data Flow

**Upload Sync**:
1. Filter events newer than last sync timestamp
2. Batch process in chunks of 300 events
3. Use composite key `timestamp_ApiTypeId` for deduplication
4. Update user metadata with sync timestamp

**Download Sync**:
1. Query events newer than local max timestamp
2. Bulk insert to IndexedDB
3. Rebuild entities using EntityConverter
4. Trigger statistics recalculation

**Auto Sync Triggers**:
- Initial login (first sync only)
- Game session end (100+ new events threshold)
- Manual sync via popup UI

### BigQuery Integration

**Export Configuration**:
- Enable BigQuery export in Firebase Console
- Automatic daily snapshots to `users_raw_latest`
- Change history in `users_raw_changelog`

**Analysis Views**:
```sql
-- User event statistics
CREATE VIEW user_event_stats AS
SELECT 
  user_id,
  COUNT(*) as total_events,
  MIN(TIMESTAMP_MILLIS(timestamp)) as first_event
FROM (...)
GROUP BY user_id;
```

### Cost Optimization

1. **Firestore Optimization**:
   - Timestamp-based incremental sync
   - No periodic sync (event-driven only)
   - Batch operations to reduce API calls
   - 100-event threshold for game-end sync

2. **Free Tier Limits**:
   - Authentication: 10,000/month
   - Firestore: 50k reads/day, 20k writes/day, 1GB storage
   - BigQuery: 1TB queries/month, 10GB storage

3. **Data Size Estimates**:
   - 1 event ≈ 200 bytes
   - 1000 hands ≈ 10,000 events ≈ 2MB
   - Typical user stays within free tier

### Troubleshooting

**Common Issues**:

1. **"XMLHttpRequest is not defined"**:
   - Service Workers don't support XMLHttpRequest
   - Solution: Use Firestore REST API implementation

2. **"Write stream exhausted"**:
   - Firestore rate limiting
   - Solution: Reduce batch size, add delays between batches

3. **Login UI not updating**:
   - Check Service Worker console for auth errors
   - Verify OAuth client configuration
   - Ensure Firebase Auth domains are authorized

**Debug Commands**:
```javascript
// Check auth state (in Service Worker console)
firebaseAuthService.getCurrentUser()
firebaseAuthService.isSignedIn()

// Test Chrome identity
chrome.identity.getAuthToken({ interactive: true }, console.log)
```

---

## Important Reminders

- **Do what has been asked; nothing more, nothing less.**
- **NEVER create files unless they're absolutely necessary for achieving your goal.**
- **ALWAYS prefer editing an existing file to creating a new one.**
- **NEVER proactively create documentation files (\*.md) or README files. Only create documentation files if explicitly requested by the User.**
