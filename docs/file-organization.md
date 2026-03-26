# File Organization

> Directory structure and file descriptions for the PokerChase HUD Chrome extension.

## Directory Structure

```
/                              # Project root
├── manifest.json              # Chrome extension manifest (MV3)
├── package.json               # Dependencies and scripts
├── package-lock.json          # Lockfile
├── tsconfig.json              # TypeScript configuration
├── esbuild.config.ts          # Build configuration
├── jest.config.cjs            # Test configuration (jsdom environment)
├── offscreen.html             # Chrome offscreen document
├── firebase.json              # Firebase project configuration
├── .firebaserc                # Firebase project settings
├── firestore.rules            # Firestore security rules
├── firestore.indexes.json     # Firestore index definitions
├── release-please-config.json # Release automation config
├── .release-please-manifest.json # Release version tracking
├── renovate.json              # Dependency update config
├── CLAUDE.md                  # AI agent documentation
├── README.md                  # Project overview
├── README.png                 # README screenshot
├── README.drawio.png          # Architecture diagram
├── CONTRIBUTING.md            # Contribution guidelines
├── CHANGELOG.md               # Version history (auto-generated)
├── .github/
│   └── workflows/
│       ├── ci.yml             # CI pipeline (test, typecheck)
│       └── build.yml          # Build and release workflow
├── docs/                      # Technical documentation (flat)
│   ├── api-events.md          # WebSocket API event reference
│   ├── architecture.md        # Design decisions & rationale
│   ├── file-organization.md   # This file
│   ├── firebase-setup.md      # Firebase setup guide
│   ├── hand-analysis.md       # 22-hand statistics audit trail
│   └── pokerstars-export.md   # PokerStars export specification
├── icons/                     # Extension icons
│   ├── icon_16px.png
│   ├── icon_48px.png
│   └── icon_128px.png
└── src/                       # Source code
    ├── app.ts                 # Re-export layer (type guards)
    ├── background.ts          # Service worker (persistence, operations)
    ├── content_script.ts      # Bridge between page and extension
    ├── web_accessible_resource.ts  # WebSocket interception
    ├── entity-converter.ts    # Direct event-to-entity conversion
    ├── popup.ts               # Extension popup entry point
    ├── index.html             # Extension HTML
    ├── test-setup.ts          # Jest setup for React Testing Library
    │
    ├── components/            # React UI components
    │   ├── App.tsx            # Root component with state management
    │   ├── Hud.tsx            # HUD overlay component
    │   ├── HandLog.tsx        # Hand history log component
    │   ├── Popup.tsx          # Extension popup interface
    │   ├── hud/               # HUD-specific components
    │   │   ├── DragHandle.tsx
    │   │   ├── HudHeader.tsx            # Player name, rank, pot odds
    │   │   ├── PlayerTypeIcons.tsx
    │   │   ├── RealTimeStatsDisplay.tsx
    │   │   ├── StatDisplay.tsx          # Statistics display grid
    │   │   └── hooks/
    │   │       └── useDraggable.ts
    │   └── popup/             # Popup-specific components
    │       ├── FirebaseAuthSection.tsx
    │       ├── GameTypeFilterSection.tsx
    │       ├── HandLimitSection.tsx
    │       ├── ImportExportSection.tsx
    │       ├── StatisticsConfigSection.tsx
    │       ├── SyncStatusSection.tsx
    │       └── UIScaleSection.tsx
    │
    ├── constants/
    │   └── database.ts        # Database-related constants
    │
    ├── db/
    │   └── poker-chase-db.ts  # Dexie database definition (v3 schema)
    │
    ├── services/
    │   ├── poker-chase-service.ts      # Central state management
    │   ├── firebase-auth-service.ts    # Chrome identity → Firebase auth
    │   ├── firebase-config.ts          # Firebase project config
    │   ├── firestore-backup-service.ts # Cloud sync (incremental up, full down)
    │   └── auto-sync-service.ts        # Game-end auto sync (100+ events)
    │
    ├── stats/
    │   ├── index.ts           # Module exports
    │   ├── registry.ts        # Statistics registry (auto-discovery)
    │   ├── helpers.ts         # Common helper functions
    │   ├── utils.ts           # Formatting utilities
    │   └── core/              # Statistic definitions
    │       ├── index.ts       # Core stats barrel export
    │       ├── 3bet.ts        # 3-bet %
    │       ├── 3bet-fold.ts   # Fold to 3-bet %
    │       ├── af.ts          # Aggression factor
    │       ├── afq.ts         # Aggression frequency %
    │       ├── cbet.ts        # Continuation bet %
    │       ├── cbet-fold.ts   # Fold to c-bet %
    │       ├── hands.ts       # Total hands played
    │       ├── pfr.ts         # Pre-flop raise %
    │       ├── player-name.ts # Player name with rank
    │       ├── river-call-accuracy.ts  # River call accuracy %
    │       ├── vpip.ts        # Voluntarily put $ in pot %
    │       ├── wsd.ts         # Won $ at showdown %
    │       ├── wtsd.ts        # Went to showdown %
    │       ├── wwsf.ts        # Won when saw flop %
    │       └── example-4bet.ts.example  # Template for new stats
    │
    ├── streams/               # Data processing pipelines
    │   ├── aggregate-events-stream.ts  # Event aggregation by hand
    │   ├── write-entity-stream.ts      # Entity persistence
    │   ├── read-entity-stream.ts       # Statistics calculation
    │   ├── hand-log-stream.ts          # Hand history generation
    │   └── realtime-stats-stream.ts    # Real-time stats (parallel)
    │
    ├── realtime-stats/        # Real-time statistics
    │   ├── index.ts
    │   ├── hand-improvement.ts         # Hand improvement probabilities
    │   ├── pot-odds.ts                 # Pot odds / SPR calculator
    │   └── realtime-stats-service.ts   # Service coordination
    │
    ├── tools/                 # Development & debugging tools
    │   ├── detect-schema-diff.ts  # API schema change detection
    │   ├── trace-hands.ts         # Hand event tracing
    │   └── validate-schemas.ts    # NDJSON event validator
    │
    ├── types/                 # TypeScript definitions + Zod schemas
    │   ├── index.ts           # Central export point
    │   ├── api.ts             # API event types and Zod schemas
    │   ├── entities.ts        # Entity types (Hand, Phase, Action)
    │   ├── errors.ts          # Error types
    │   ├── filters.ts         # Filter options (game type, hand limit)
    │   ├── game.ts            # Game enums (ActionType, PhaseType, etc.)
    │   ├── hand-log.ts        # Hand log & UI config types
    │   ├── messages.ts        # Chrome message passing types
    │   └── stats.ts           # Statistics interfaces
    │
    └── utils/                 # Utility modules
        ├── array-utils.ts     # Array manipulation (rotateArrayFromIndex)
        ├── card-utils.ts      # Card formatting ([37,51] → ['Jh','Ac'])
        ├── database-utils.ts  # DB operations (saveEntities, processInChunks)
        ├── error-handler.ts   # Error handling utilities
        ├── hand-log-exporter.ts       # Multi-hand export (batch optimized)
        ├── hand-log-processor.ts      # PokerStars format generation
        ├── logger.ts          # Structured logging
        ├── poker-evaluator.ts # Bit-manipulation hand evaluator
        ├── river-probabilities.ts     # River probability tables
        └── starting-hand-rankings.ts  # 169 starting hand rankings
```
