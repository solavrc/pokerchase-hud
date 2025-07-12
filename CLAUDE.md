# PokerChase HUD v2 - Developer Documentation

> 🎯 **Purpose**: Primary technical reference for PokerChase HUD Chrome extension development and maintenance.
> 
> 📅 **Last Updated**: 2025-07-12 - Real-time statistics HUD, unified ActionDetail detection, import optimizations

## 📋 Table of Contents

1. [Quick Start](#quick-start)
2. [Project Overview](#project-overview)
3. [Architecture](#architecture)
4. [Core Components](#core-components)
5. [Statistics System](#statistics-system)
6. [Data Processing](#data-processing)
7. [UI Components](#ui-components)
8. [Configuration & Storage](#configuration--storage)
9. [Development Guide](#development-guide)
10. [Performance & Optimization](#performance--optimization)
11. [Troubleshooting](#troubleshooting)

## 🚀 Quick Start

```bash
# Clone and setup
git clone https://github.com/solavrc/pokerchase-hud.git
cd pokerchase-hud-v2
npm install

# Build and run
npm run build          # Production build
npm run typecheck      # Type checking
npm run test          # Run tests

# Install in Chrome
1. Open chrome://extensions/
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select project directory
```

## 📦 Project Overview

### Description
Unofficial Chrome extension providing real-time poker statistics overlay and hand history tracking for PokerChase.

### Key Features
- **Real-time HUD**: Player statistics with drag & drop positioning
- **Hero Real-time Stats**: Dynamic pot odds and hand improvement probabilities
- **Hand History Log**: PokerStars-format export with virtualized scrolling
- **Statistics Engine**: 13+ poker statistics with modular architecture
- **Starting Hand Rankings**: 169 preflop hand strength display
- **Smart Filtering**: Game type (SNG/MTT/Ring) and hand count filters
- **Import/Export**: High-performance bulk data processing
- **Data Rebuild**: Reconstruct statistics from raw events

### Technical Stack
| Component | Technology | Purpose |
|-----------|------------|---------|
| **Extension** | Chrome Manifest V3 | Modern extension API |
| **Frontend** | React 18 + TypeScript | Type-safe UI components |
| **UI Library** | Material-UI (modular) | Optimized imports |
| **Storage** | IndexedDB (Dexie) | High-performance persistence |
| **Build** | esbuild | Ultra-fast bundling |
| **Testing** | Jest + React Testing | Unit/integration tests |

### Performance Metrics
| Metric | Value | Details |
|--------|-------|---------|
| **Bundle Sizes** | 213-392KB | 75%+ reduction from v1 |
| **Build Time** | ~100ms | esbuild optimization |
| **Import Speed** | 20s/250k events | 83% faster than v1 |
| **Memory Usage** | 175MB peak | 65% reduction |
| **Stats Cache** | 5s TTL | Prevents redundant calculations |
| **Real-time Calc** | <10ms | Per action/street update |
| **Hand Eval Speed** | ~1ms | Bit manipulation optimization |

## 🏗️ Architecture

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
2. **Consistent UI**: Always 6 seats, null for empty positions
3. **Performance First**: Caching, virtualization, batch processing
4. **Unified Logic**: Single source of truth for statistics

### Data Flow Pipelines

#### Real-time Processing
```
WebSocket Events
    ↓
AggregateEventsStream
    ├─► WriteEntityStream ─► ReadEntityStream ─► Stats Output
    ├─► HandLogStream ─► Hand Log Output (parallel)
    └─► RealTimeStatsStream ─► Real-time Stats Output (parallel)
```

#### Import Processing
```
NDJSON File
    ↓
Chunk Processing (5MB)
    ↓
EntityConverter (Direct generation)
    ↓
Bulk Database Insert
```

## 🔧 Core Components

### Extension Layer

#### `web_accessible_resource.ts`
- WebSocket constructor override
- API traffic interception
- Event forwarding via postMessage

#### `content_script.ts`
- Bridge between page and extension
- React app injection
- Message validation and routing

#### `background.ts`
- Service worker for persistence
- Import/export operations
- Connection lifecycle management
- Batch processing coordination

### Data Processing Streams

#### `AggregateEventsStream`
- Groups events by hand boundaries
- Manages session state
- Controls DB write modes (real-time vs replay)

#### `WriteEntityStream`
- Decomposes events into entities
- Normalizes ALL_IN actions
- Delegates ActionDetail detection to statistics modules
- Supports batch mode

#### `ReadEntityStream`
- Applies filters (game type, hand limit)
- Calculates statistics via registry
- Implements 5-second caching
- Always returns 6-element array

#### `EntityConverter` (Import Optimization)
- Direct event-to-entity conversion
- Bypasses stream overhead
- Extracts session/player information
- Uses statistics modules for consistency
- Generates SHOWDOWN phases

#### `RealTimeStatsStream` (Hero Analytics)
- Processes events in parallel with main pipeline
- Tracks hero hole cards and community cards
- Calculates pot odds and call amounts
- Computes hand improvement probabilities
- Updates on each action and street

## 📊 Statistics System

### Available Statistics

| ID | Name | Description | Category |
|----|------|-------------|----------|
| `hands` | HAND | Total hands played | general |
| `playerName` | Name | Player name with rank | general |
| `vpip` | VPIP | Voluntarily put $ in pot % | preflop |
| `pfr` | PFR | Pre-flop raise % | preflop |
| `3bet` | 3B | 3-bet % | preflop |
| `3betfold` | 3BF | Fold to 3-bet % | preflop |
| `cbet` | CB | Continuation bet % | postflop |
| `cbetFold` | CBF | Fold to c-bet % | postflop |
| `af` | AF | Aggression factor | general |
| `afq` | AFq | Aggression frequency % | general |
| `wtsd` | WTSD | Went to showdown % | postflop |
| `wwsf` | WWSF | Won when saw flop % | postflop |
| `wsd` | W$SD | Won $ at showdown % | postflop |

### Adding New Statistics

1. Create `src/stats/core/[stat-name].ts`
2. Implement `StatDefinition`:
```typescript
export interface StatDefinition {
  id: string
  name: string
  description: string
  category: "preflop" | "postflop" | "general"
  precision?: number
  format?: (value: StatValue) => string
  
  // Unified detection logic (used by both streams and EntityConverter)
  detectActionDetails?: (context: ActionDetailContext) => ActionDetail[]
  updateHandState?: (context: ActionDetailContext) => void
  
  // Calculation from accumulated data
  calculate: (context: StatCalculationContext) => StatValue
}
```
3. Export from `src/stats/core/index.ts`
4. Automatically registered via `defaultRegistry`

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

## 🎯 Real-time Statistics

### Overview
Hero-only dynamic statistics displayed above regular HUD, updating per action/street.

### Components

#### Pot Odds Calculator (`pot-odds.ts`)
- **Pot Size**: Total pot including all bets
- **Call Amount**: Required chips to continue
- **Pot Odds %**: Call amount as percentage of total pot
- **Ratio**: Traditional odds format (e.g., "3:1")

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

## 🔄 Data Processing

### Event Types

#### Session Events
| Event | ID | Purpose |
|-------|-----|---------|
| `RES_ENTRY_QUEUED` | 201 | Session start, extracts ID and battle type |
| `EVT_SESSION_DETAILS` | 308 | Game configuration and name |
| `EVT_SESSION_RESULTS` | 309 | Session end, triggers cleanup |

#### Player Events
| Event | ID | Purpose |
|-------|-----|---------|
| `EVT_PLAYER_SEAT_ASSIGNED` | 313 | Initial seating with names/ranks |
| `EVT_PLAYER_JOIN` | 301 | Mid-game joins |
| `EVT_DEAL` | 303 | Hand start, hero identification |

#### Game Events
| Event | ID | Purpose |
|-------|-----|---------|
| `EVT_ACTION` | 304 | Player actions (bet/fold/raise) |
| `EVT_DEAL_ROUND` | 305 | New street (flop/turn/river) |
| `EVT_HAND_RESULTS` | 306 | Hand completion, winners |

### Database Schema

```typescript
{
  // Raw WebSocket events
  apiEvents: '[timestamp+ApiTypeId],timestamp,ApiTypeId',
  
  // Processed entities
  hands: 'id,*seatUserIds,*winningPlayerIds',
  phases: '[handId+phase],handId,*seatUserIds,phase',
  actions: '[handId+index],handId,playerId,phase,actionType,*actionDetails',
  
  // Import tracking
  meta: 'id'  // Stores lastProcessedTimestamp
}
```

### Seat Mapping
Hero always appears at position 0:
```typescript
const heroIndex = evtDeal.Player.SeatIndex
const rotatedStats = [
  ...stats.slice(heroIndex),
  ...stats.slice(0, heroIndex)
]
```

## 🎨 UI Components

### `App.tsx`
- Root component with central state
- Configuration loading and validation
- Master visibility control
- Seat rotation logic
- Real-time stats state management

### `Hud.tsx`
- **Regular HUD**: 240px fixed-width overlay
- **Real-time Stats**: 200px width (hero only)
- Drag & drop with position persistence
- Per-player statistics display
- Click-to-copy functionality
- Real-time display components:
  - Starting hand ranking
  - Pot odds with call amount
  - Hand improvement probability table
- Future: Fish/shark indicators

### `HandLog.tsx`
- Virtualized scrolling (react-window)
- Hover-to-expand behavior
- Resizable with drag handle
- Double-click to clear
- PokerStars format export

### `Popup.tsx`
- Extension settings interface
- Import/export functionality
- Filter configuration
- Statistics customization

## ⚙️ Configuration & Storage

### Chrome Storage Structure
```typescript
{
  // UI settings
  uiConfig: {
    displayEnabled: boolean,  // Master toggle
    scale: number            // 0.5 - 2.0
  },
  
  // Hand log settings
  handLogConfig: {
    enabled: boolean,
    position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right',
    maxHands: number,
    width: number,
    height: number,
    opacity: number,         // 0.0 - 1.0
    fontSize: number,
    autoScroll: boolean,
    showTimestamps: boolean
  },
  
  // Game filters
  options: {
    filterOptions: {
      gameTypes: {
        sng: boolean,        // [0,2,6]
        mtt: boolean,        // [1]
        ring: boolean        // [4,5]
      },
      handLimit?: number,    // Recent N hands
      statDisplayConfigs: StatDisplayConfig[]
    }
  },
  
  // HUD positions (per seat)
  hudPosition_0: { top: string, left: string },
  hudPosition_1: { top: string, left: string },
  // ... up to hudPosition_5
  
  // Real-time stats HUD position (hero only)
  hudPosition_100: { top: string, left: string }
}
```

## 👨‍💻 Development Guide

### Commands
```bash
npm run build        # Production build
npm run typecheck    # TypeScript validation
npm run test         # Run test suite (includes 1,600+ lines for real-time stats)
npm run postbuild    # Create extension.zip
```

### Code Standards
- **TypeScript**: Strict mode enabled
- **Comments**: Japanese (日本語) for team
- **Errors**: Centralized ErrorHandler
- **Logging**: No console.log in production
- **Keys**: `seat-${index}` pattern

### Security
- Validate all WebSocket messages
- Check postMessage origins
- No sensitive data in logs
- Content Security Policy

### Dynamic URL Support
Extension adapts to manifest URL:
```typescript
import { content_scripts } from '../manifest.json'
const gameUrl = content_scripts[0].matches[0]
```

## 🚀 Performance & Optimization

### Build Optimization
| Technique | Impact | Implementation |
|-----------|---------|----------------|
| Modular imports | -60% bundle | Individual MUI components |
| Tree shaking | -40% size | esbuild configuration |
| Production mode | -30% React | NODE_ENV setting |
| Minification | -50% overall | esbuild minify |

### Import Performance

#### Optimizations
1. **Chunked Processing**: 5MB chunks prevent memory issues
2. **Duplicate Detection**: In-memory Set for O(1) lookups
3. **Bulk Operations**: `bulkPut` for batch inserts
4. **Direct Generation**: EntityConverter bypasses streams

#### Best Practices
```typescript
// ❌ Avoid spread with large arrays
const max = Math.max(...largeArray)  // Stack overflow

// ✅ Use reduce
const max = array.reduce((m, v) => v > m ? v : m, 0)

// ❌ Individual operations
for (const item of items) {
  await db.table.add(item)
}

// ✅ Bulk operations
await db.table.bulkPut(items)

// Transaction management
const data = await db.table.toArray()  // Complete READONLY
// Process outside transaction to avoid conflicts
```

#### Batch Mode
```typescript
service.setBatchMode(true)   // Pause real-time updates
// ... bulk operations ...
service.setBatchMode(false)  // Resume and recalculate
```

## 🔧 Troubleshooting

### Common Issues

#### HUD Not Displaying
1. Check master toggle in popup
2. Verify game type filters
3. Ensure `configLoaded` state
4. Check console for errors

#### Statistics Issues
1. Verify WebSocket connection
2. Check `playerId` is set
3. Clear cache if stale
4. Validate filters

#### Import Problems

| Issue | Cause | Solution |
|-------|-------|----------|
| Stack overflow | Large array spread | Use reduce() instead |
| Duplicate keys | Existing data | Use bulkPut (idempotent) |
| Missing session info | Import data lacks context | Fixed: EntityConverter extracts |
| Transaction conflicts | READONLY/READWRITE mix | Use toArray() then process |
| Stats not calculating | Missing ActionDetails | Fixed: Unified detection |

### Debug Mode
```javascript
// In background.ts
const DEBUG = true  // Enable verbose logging
```

---

# Important Development Notes

- **ActionDetail Detection**: Always implement in statistics modules for consistency
- **Batch Operations**: Use for imports to improve performance
- **Transaction Safety**: Complete READONLY before READWRITE operations
- **Memory Management**: Process large datasets in chunks
- **Cache Invalidation**: 5-second TTL prevents stale data
- **Real-time Stats**: Hero-only feature, updates per action/street
- **HUD Widths**: Regular HUD 240px, Real-time stats 200px
- **Parallel Streams**: Real-time stats process independently from main pipeline

# Known Issues & TODOs

## Technical Debt
- **poker-evaluator.ts**: `cards: []` TODO - Extract actual cards for hand display
- **Input Validation**: Missing duplicate card checks and range validation
- **Magic Numbers**: Color codes (#00ff00, #ff6666) should be constants

## Future Enhancements
- **Error Boundaries**: Add around real-time stats to prevent crashes
- **WebWorker**: Move probability calculations off main thread
- **Implied Odds**: Extend pot odds calculator
- **Multi-way Pots**: Enhance win rate calculations
- **Toggle Feature**: Show/hide real-time stats option

# Claude Code Instructions
- Focus on architectural principles
- Maintain existing patterns
- Prefer editing over creating files
- Never create docs unless requested