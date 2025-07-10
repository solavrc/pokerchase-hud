# PokerChase HUD v2 - Developer Documentation

> 🎯 **Purpose**: This document serves as the primary technical reference for PokerChase HUD Chrome extension development and maintenance.

## 📋 Table of Contents

1. [Quick Start](#quick-start)
2. [Project Overview](#project-overview)
3. [Architecture](#architecture)
4. [Core Components](#core-components)
5. [Data Flow](#data-flow)
6. [API Reference](#api-reference)
7. [Configuration](#configuration)
8. [Development Guide](#development-guide)
9. [Build & Optimization](#build--optimization)
10. [Troubleshooting](#troubleshooting)

## 🚀 Quick Start

```bash
# Clone repository
git clone https://github.com/solavrc/pokerchase-hud.git
cd pokerchase-hud-v2

# Install dependencies
npm install

# Build extension (optimized production build)
npm run build

# Load in Chrome
# 1. Open chrome://extensions/
# 2. Enable "Developer mode"
# 3. Click "Load unpacked" 
# 4. Select the project directory
```

## 📦 Project Overview

PokerChase HUD v2 is an unofficial Chrome extension providing real-time poker statistics and hand history tracking with an optimized, lightweight architecture.

### ✨ Key Features

- **Real-time HUD**: Player statistics overlay with drag & drop positioning
- **Hand History Log**: Live PokerStars-format export with virtualized scrolling
- **Statistics Engine**: 13 poker statistics with modular architecture
- **Smart Filtering**: Game type (SNG/MTT/Ring) and hand count filters
- **Optimized UI**: 75%+ smaller bundle size, instant loading
- **Dynamic URL Support**: Automatically adapts to game URL from manifest

### 🛠 Technical Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Extension** | Chrome Manifest V3 | Modern extension API |
| **Frontend** | React 18 + TypeScript | Type-safe UI components |
| **UI Library** | Material-UI (modular) | Optimized component imports |
| **Storage** | IndexedDB (Dexie) | High-performance data persistence |
| **Build** | esbuild | Ultra-fast bundling (~100ms) |
| **Testing** | Jest + React Testing | Unit and integration tests |

### 📊 Performance Metrics

- **Bundle Sizes** (after optimization):
  - popup.js: 391KB (was 1.8MB)
  - content_script.js: 369KB (was 1.5MB)
  - background.js: 213KB (was 503KB)
- **Build Time**: ~100ms
- **Stats Cache**: 5-second TTL
- **Memory**: Virtualized scrolling for hand log

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
- Drag-to-move with position persistence (saved per seat)
- Click-to-copy functionality
- Player type indicators (🐟🦈) for future features
- Responsive scaling with UI config

#### HandLog.tsx

- Real-time hand history display
- Virtualized scrolling (react-window) for performance
- Default: 400x100px, positioned 135px from bottom
- Hover expands to 50% screen height
- Resizable with edge drag handle
- Double-click to clear log
- Click hand to copy to clipboard

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
    enabled: boolean;        // default: true
    position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'; // default: 'bottom-right'
    maxHands: number;        // default: 5
    width: number;           // default: 400px
    height: number;          // default: 100px
    opacity: number;         // default: 0.8 (0.0 - 1.0)
    fontSize: number;        // default: 8px
    autoScroll: boolean;     // default: true
    showTimestamps: boolean; // default: false
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

### 🔧 Commands

```bash
# Production build (optimized)
npm run build

# Type checking
npm run typecheck

# Run tests
npm run test

# Package extension (creates extension.zip)
npm run postbuild

# Clean build
rm -rf dist && npm run build
```

### 🔗 Dynamic URL Management

The extension automatically adapts to the game URL specified in `manifest.json`:

```json
// manifest.json
"content_scripts": [{
  "matches": ["https://game.poker-chase.com/*"]
}]
```

Components access this URL dynamically:
```typescript
// Import manifest
import { content_scripts } from '../manifest.json'

// Get game URL pattern
const gameUrlPattern = content_scripts[0].matches[0]
```

This allows easy deployment to different environments without code changes.

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

## Build & Optimization

### 🚄 Performance Optimizations

The build system implements several optimizations for production:

```typescript
// esbuild.config.ts
{
  format: 'iife',           // Chrome extension compatible
  minify: true,             // Minimize code size
  treeShaking: true,        // Remove unused code
  legalComments: 'none',    // Strip license comments
  define: {
    'process.env.NODE_ENV': '"production"'  // React production mode
  }
}
```

### 📦 Bundle Size Optimization

| Optimization | Impact | Implementation |
|-------------|---------|----------------|
| **Material-UI Modular Imports** | -60% popup.js | Import individual components |
| **Tree Shaking** | -40% all bundles | Remove unused exports |
| **Production React** | -30% React size | NODE_ENV=production |
| **Minification** | -50% overall | esbuild minify |

### 🎯 Import Best Practices

```typescript
// ❌ Bad - imports entire library
import { Button, Dialog } from '@mui/material'

// ✅ Good - tree-shakeable imports
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
```

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
