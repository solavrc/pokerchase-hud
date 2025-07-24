# File Organization

> Detailed directory structure and file descriptions for the PokerChase HUD Chrome extension.

## Directory Structure

```
/                          # Project root
├── manifest.json          # Chrome extension manifest
├── package.json           # Node.js dependencies and scripts
├── tsconfig.json          # TypeScript configuration
├── esbuild.config.ts      # Build configuration
├── jest.config.cjs        # Test configuration (jsdom environment)
├── release-please-config.json  # Release automation config
├── CLAUDE.md              # AI agent documentation
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
    │                      # Exports type guards: isApiEventType, parseApiEvent, getValidationError
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
    │   ├── Popup.tsx     # Extension popup interface
    │   ├── hud/          # HUD-specific components
    │   │   ├── DragHandle.tsx           # Draggable UI handle
    │   │   ├── HudHeader.tsx             # Player name, rank, and pot odds display
    │   │   ├── PlayerTypeIcons.tsx        # Player type icons display
    │   │   ├── RealTimeStatsDisplay.tsx # Real-time statistics HUD
    │   │   ├── StatDisplay.tsx          # Statistics display grid
    │   │   └── hooks/
    │   │       └── useDraggable.ts      # Drag functionality hook
    │   └── popup/        # Popup-specific components
    │       ├── FirebaseAuthSection.tsx    # Firebase authentication UI
    │       ├── GameTypeFilterSection.tsx  # Game type filtering
    │       ├── HandLimitSection.tsx       # Hand count controls
    │       ├── ImportExportSection.tsx    # Import/export functionality
    │       ├── StatisticsConfigSection.tsx # Statistics configuration
    │       ├── SyncStatusSection.tsx      # Cloud sync status display
    │       └── UIScaleSection.tsx         # UI scale adjustment
    ├── constants/         # Centralized configuration
    │   └── database.ts   # Database-related constants
    ├── db/
    │   └── poker-chase-db.ts  # Database definition (PokerChaseDB)
    ├── docs/              # Architecture documentation
    │   └── adr/          # Architecture Decision Records
    │       ├── 001-data-storage-architecture.md
    │       └── 002-database-index-optimization.md
    ├── services/
    │   ├── poker-chase-service.ts      # Main service class
    │   ├── firebase-auth-service.ts    # Firebase authentication
    │   ├── firebase-config.ts          # Firebase configuration
    │   ├── firestore-backup-service.ts # Cloud sync logic (incremental upload, full download)
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
    ├── test-setup.ts     # Jest setup for React Testing Library
    ├── tools/             # Development tools
    │   └── validate-schemas.ts  # NDJSON event validator
    ├── types/             # TypeScript type definitions
    │   ├── api.ts        # API event types, Zod schemas, type guards
    │   ├── entities.ts   # Entity types with Zod schemas
    │   ├── errors.ts     # Error types and handling
    │   ├── filters.ts, game.ts, hand-log.ts
    │   ├── messages.ts, stats.ts
    │   └── index.ts      # Central export point (types, schemas, functions)
    └── utils/             # Utility modules
        ├── array-utils.ts    # Array manipulation
        ├── card-utils.ts     # Card formatting
        ├── database-utils.ts # Database operation utilities
        ├── error-handler.ts  # Error handling
        ├── hand-log-exporter.ts      # Export functionality
        ├── hand-log-processor.ts     # PokerStars format
        ├── logger.ts         # Structured logging
        ├── poker-evaluator.ts        # Hand evaluation
        ├── river-probabilities.ts    # River probability tables
        └── starting-hand-rankings.ts # Starting hand rankings
```

## Key Directories

### `/src/components/`
React UI components organized by feature:
- Main components for HUD, hand log, and popup
- Sub-components organized in feature-specific directories
- Custom hooks for reusable functionality

### `/src/services/`
Core business logic and service layers:
- `poker-chase-service.ts`: Central state management
- Firebase integration for cloud sync
- Authentication services

### `/src/streams/`
Data processing pipelines using Node.js streams:
- Event aggregation and entity conversion
- Real-time statistics calculation
- Hand history generation

### `/src/stats/`
Statistics calculation modules:
- Individual statistic definitions in `core/`
- Registry for dynamic statistic management
- Helper functions for common calculations

### `/src/types/`
TypeScript type definitions with Zod runtime validation:
- API event types and schemas
- Entity definitions
- Application-specific types

### `/src/utils/`
Utility functions and helpers:
- Database operations
- Card formatting and evaluation
- Error handling
- Export functionality