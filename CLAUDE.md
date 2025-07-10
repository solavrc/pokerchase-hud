# PokerChase HUD - Technical Documentation

This document serves as the primary technical reference for the PokerChase HUD Chrome extension development.

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Core Components](#core-components)
4. [Data Flow](#data-flow)
5. [API Reference](#api-reference)
6. [Configuration](#configuration)
7. [Development Guide](#development-guide)
8. [Troubleshooting](#troubleshooting)

## Overview

PokerChase HUD is an unofficial Chrome extension that provides real-time player statistics and hand history tracking for poker games.

### Key Features

- **Real-time HUD**: Displays player statistics overlay on the game interface
- **Hand History**: Live PokerStars-format hand log with export capabilities
- **Statistics Tracking**: 13 poker statistics including VPIP, PFR, 3-bet, etc.
- **Flexible Filtering**: Game type and hand count filters
- **Drag & Drop UI**: Customizable HUD positioning

### Technical Stack

- **Framework**: Chrome Extension Manifest V3
- **Frontend**: React 18 + TypeScript
- **Storage**: IndexedDB (via Dexie)
- **Build**: esbuild
- **Testing**: Jest

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Game Website (poker-chase.com)          │
│  ┌─────────────────┐                                        │
│  │  WebSocket API  │◄──────── Intercept ────────┐          │
│  └────────┬────────┘                            │          │
│           │                                      │          │
│  ┌────────▼────────┐      ┌──────────────────┐ │          │
│  │  Unity Canvas   │      │ web_accessible_   │ │          │
│  │                 │      │ resource.ts       │◄┘          │
│  │  ┌───────────┐  │      └──────┬───────────┘            │
│  │  │   HUD     │  │◄─────inject─┤                         │
│  │  └───────────┘  │             │                         │
│  └─────────────────┘      ┌──────▼───────────┐            │
│                           │ content_script.ts │            │
└───────────────────────────┴──────┬───────────┴────────────┘
                                   │ Port
                           ┌───────▼────────┐
                           │ background.ts  │
                           │                │
                           │ ┌────────────┐ │
                           │ │   Dexie    │ │
                           │ │ IndexedDB  │ │
                           │ └────────────┘ │
                           └────────────────┘
```

### Design Principles

1. **Separation of Concerns**

   - Data processing in streams (no UI logic)
   - UI controlled by user settings only
   - Configuration persisted in Chrome storage

2. **Consistent UI Behavior**

   - Always maintain 6 seat positions
   - Empty seats return null (no placeholders)
   - Master toggle controls all visibility

3. **Performance First**
   - 5-second statistics cache
   - Virtualized scrolling for hand log
   - Compound database indexes
   - React component memoization

## Core Components

### Extension Components

#### web_accessible_resource.ts

**Purpose**: WebSocket interception and game event capture
**Key Features**:

- Overrides native WebSocket constructor
- Filters poker-chase.com API traffic
- Forwards events to content script via postMessage

#### content_script.ts

**Purpose**: Bridge between web page and extension
**Key Features**:

- Maintains persistent connection to background service
- Injects React app into game DOM
- Handles bidirectional message passing
- Security validation for message origins

#### background.ts

**Purpose**: Service worker for data persistence and processing
**Key Features**:

- Manages IndexedDB via Dexie
- Handles import/export operations
- Maintains WebSocket connection lifecycle
- Implements chunked data processing for large imports

### Stream Pipeline

```
AggregateEventsStream
    │
    ├─► WriteEntityStream ─► ReadEntityStream ─► Stats Output
    │
    └─► HandLogStream ─► Hand Log Output (parallel)
```

#### AggregateEventsStream

- Groups events by hand (EVT_DEAL to EVT_HAND_RESULTS)
- Persists raw API events to IndexedDB
- Manages session state and player names
- Stores latest EVT_DEAL for seat mapping

#### WriteEntityStream

- Decomposes hand events into entities (Hand, Phase, Action)
- Normalizes ALL_IN actions to base types
- Adds ActionDetail flags for statistics
- Batch writes with transactions

#### ReadEntityStream

- Applies filters (game type, hand limit)
- Calculates statistics using modular system
- Implements 5-second result caching
- Outputs PlayerStats array (always 6 elements)

#### HandLogStream

- Parallel processing for real-time display
- Uses HandLogProcessor for formatting
- Memory-efficient with configurable limits
- Handles session cleanup intelligently

### UI Components

#### App.tsx

- Root component with state management
- Seat rotation logic (hero at position 0)
- Configuration loading with race condition prevention
- Master visibility control

#### Hud.tsx

- Player statistics overlay (240px fixed width)
- Drag-to-move with position persistence
- Click-to-copy functionality
- Player type indicators (🦈/🐟) for future features

#### HandLog.tsx

- Real-time hand history display
- Virtualized scrolling (react-window)
- Configurable position, size, opacity
- Auto-scroll with manual override

## Data Flow

### Event Processing Flow

```
1. WebSocket Message Intercepted
   ↓
2. web_accessible_resource validates and forwards
   ↓
3. content_script receives via postMessage
   ↓
4. background service processes through streams
   ↓
5. Statistics calculated and cached
   ↓
6. UI components updated with new data
```

### Seat Mapping Algorithm

```typescript
// EVT_DEAL contains hero's seat index
const heroSeatIndex = evtDeal.Player.SeatIndex;

// Rotate stats array so hero is at position 0
const mappedStats = [
  ...stats.slice(heroSeatIndex),
  ...stats.slice(0, heroSeatIndex),
];
```

## API Reference

### Available Statistics

| Stat | Name                     | Description                   | Formula                                           |
| ---- | ------------------------ | ----------------------------- | ------------------------------------------------- |
| HAND | Hands                    | Total hands played            | Count of all hands                                |
| Name | Player Name              | Name with rank                | `${name} <${rank}>`                               |
| VPIP | Voluntarily Put $ In Pot | % of hands played voluntarily | (VP hands / Total hands) × 100                    |
| PFR  | Pre-Flop Raise           | % of hands raised preflop     | (PFR hands / Total hands) × 100                   |
| CB   | Continuation Bet         | % of c-bet when had chance    | (CBet / CBet opportunities) × 100                 |
| CBF  | C-Bet Fold               | % fold to c-bet               | (Fold to CBet / Face CBet) × 100                  |
| 3B   | 3-Bet                    | % of 3-betting                | (3-bet hands / 3-bet opportunities) × 100         |
| 3BF  | Fold to 3-Bet            | % fold when facing 3-bet      | (Fold to 3-bet / Face 3-bet) × 100                |
| AF   | Aggression Factor        | Ratio of aggressive actions   | (Bet + Raise) / Call                              |
| AFq  | Aggression Frequency     | % of aggressive actions       | (Bet + Raise) / (Bet + Raise + Call + Fold) × 100 |
| WTSD | Went To ShowDown         | % reached showdown            | (Showdowns / Saw flop) × 100                      |
| WWSF | Won When Saw Flop        | % won after seeing flop       | (Won after flop / Saw flop) × 100                 |
| W$SD | Won $ at ShowDown        | % won at showdown             | (Won at SD / Went to SD) × 100                    |

### Game Events

#### Session Events

| Event               | ID  | Description   | Triggers      |
| ------------------- | --- | ------------- | ------------- |
| RES_ENTRY_QUEUED    | 201 | Game entry    | Session reset |
| EVT_SESSION_DETAILS | 308 | Game config   | -             |
| EVT_SESSION_RESULTS | 309 | Final results | HUD cleanup   |

#### Player Events

| Event                    | ID  | Description     | Data                |
| ------------------------ | --- | --------------- | ------------------- |
| EVT_PLAYER_SEAT_ASSIGNED | 313 | Initial seating | TableUsers[]        |
| EVT_PLAYER_JOIN          | 301 | Mid-game join   | JoinUser            |
| EVT_DEAL                 | 303 | Hand start      | Player, SeatUserIds |

#### Action Events

| Event            | ID  | Description   | Triggers          |
| ---------------- | --- | ------------- | ----------------- |
| EVT_ACTION       | 304 | Player action | Stats update      |
| EVT_HAND_RESULTS | 306 | Hand complete | Stats calculation |

### Message Types

```typescript
// Extension Messages
interface StatsData {
  stats: PlayerStats[]; // Always 6 elements
  evtDeal?: ApiEvent<ApiType.EVT_DEAL>; // For seat mapping
}

interface HandLogEvent {
  type: "add" | "update" | "clear" | "removeIncomplete";
  entries?: HandLogEntry[];
  handId?: number;
}
```

## Configuration

### Storage Structure

```typescript
// Chrome Storage Sync
{
  uiConfig: {
    displayEnabled: boolean;  // Master toggle
    scale: number;           // 0.5 - 2.0
  },

  handLogConfig: {
    enabled: boolean;
    position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
    maxHands: number;
    width: number;
    height: number;
    opacity: number;        // 0.0 - 1.0
    fontSize: number;
  },

  options: {
    filterOptions: {
      gameTypes: {
        sng: boolean;       // [0,2,6]
        mtt: boolean;       // [1]
        ring: boolean;      // [4,5]
      },
      handLimit?: number;   // 20/50/100/200/500/undefined
      statDisplayConfigs: StatDisplayConfig[];
    }
  },

  // Per-seat HUD positions
  hudPosition_0: { top: string; left: string; },
  hudPosition_1: { top: string; left: string; },
  // ... up to hudPosition_5
}
```

### Database Schema

```javascript
// IndexedDB via Dexie
{
  // Raw API events
  apiEvents: '[timestamp+ApiTypeId],timestamp,ApiTypeId',

  // Hand entities
  hands: 'id,*seatUserIds,*winningPlayerIds',

  // Phase data (preflop/flop/turn/river)
  phases: '[handId+phase],handId,*seatUserIds,phase',

  // Player actions
  actions: '[handId+index],handId,playerId,phase,actionType,*actionDetails'
}
```

## Development Guide

### Commands

```bash
# Production build
npm run build

# Type checking
npm run typecheck

# Run tests
npm run test

# Package extension
npm run postbuild
```

### Adding New Statistics

1. Create module in `src/stats/core/[stat-name].ts`
2. Implement `StatDefinition` interface:
   ```typescript
   export interface StatDefinition {
     id: string;
     name: string;
     description: string;
     category: "preflop" | "postflop" | "general";
     precision?: number;
     format?: (value: StatValue) => string;
     detectActionDetails?: (
       action: Action,
       context: ActionDetailContext
     ) => ActionDetail[];
     updateHandState?: (action: Action, handState: HandState) => void;
     calculate: (actions: Action[], playerId: number) => StatValue;
   }
   ```
3. Export from `src/stats/core/index.ts`
4. Module is automatically registered

### Code Standards

- **TypeScript**: Strict mode enabled
- **Comments**: Japanese (日本語) for team collaboration
- **Error Handling**: Use centralized ErrorHandler
- **Console Logs**: Prohibited in production
- **Component Keys**: Use `seat-${index}` pattern

### Security Guidelines

- Validate all WebSocket messages
- Sanitize user inputs
- Never log sensitive player data
- Check message origins in content script
- Use Content Security Policy

## Troubleshooting

### Common Issues

#### HUD Not Displaying

1. Check master toggle in popup settings
2. Verify at least one game type filter is selected
3. Ensure config is loaded (`configLoaded` state)
4. Check browser console for errors

#### Statistics Not Updating

1. Verify WebSocket connection is active
2. Check if playerId is set (EVT_DEAL received)
3. Look for database errors in console
4. Clear cache and reload extension

#### Performance Issues

1. Check IndexedDB size (browser limits)
2. Verify hand limit filter is reasonable
3. Look for memory leaks in DevTools
4. Consider clearing old data

### Debug Mode

Enable debug logging by setting in background script:

```javascript
const DEBUG = true; // Enable verbose logging
```

---

_For development assistance with Claude Code, this file provides the necessary context. Focus on maintaining the architectural principles and code standards outlined above._
