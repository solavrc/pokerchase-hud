# File Organization

> Directory structure and file descriptions for the PokerChase HUD Chrome extension.
> Test files are co-located with their sources (`foo.ts` → `foo.test.ts`) and omitted below.

## Directory Structure

```
/                              # Project root
├── manifest.json              # Chrome extension manifest (MV3)
├── package.json               # Dependencies and scripts
├── package-lock.json          # Lockfile
├── tsconfig.json              # TypeScript configuration
├── esbuild.config.ts          # Build configuration
├── mockup.config.ts           # UI visual mockup server (npm run mockup)
├── jest.config.cjs            # Test configuration (jsdom environment)
├── firebase.json              # Firebase project configuration
├── .firebaserc                # Firebase project settings
├── firestore.rules            # Firestore security rules (incl. public-read config/client)
├── firestore.indexes.json     # Firestore index definitions
├── release-please-config.json # Release automation config
├── .release-please-manifest.json # Release version tracking
├── renovate.json              # Dependency update config
├── CLAUDE.md                  # AI agent documentation
├── README.md                  # Project overview
├── README.drawio.png          # Architecture diagram
├── CONTRIBUTING.md            # Contribution guidelines
├── CHANGELOG.md               # Version history (auto-generated)
├── .github/
│   └── workflows/
│       ├── ci.yml             # PR CI: typecheck, Jest, build, signed-CRX packaging smoke
│       └── build.yml          # Build, release-please job, signed CRX upload to the GitHub Release
│                              #   (Chrome Web Store submission itself is manual — docs/chrome-web-store-release.md)
├── docs/                      # Technical documentation (flat)
│   ├── api-events.md          # WebSocket API event reference (canonical event semantics)
│   ├── architecture.md        # Design decisions & rationale (ADR)
│   ├── battle-type-coverage-audit.md / .sql # BattleType evidence and reproducible query
│   ├── chrome-web-store-release.md # Store submission procedure
│   ├── file-organization.md   # This file
│   ├── firebase-setup.md      # Firebase setup guide
│   ├── hand-analysis.md       # 22-hand statistics audit trail (pre-#115 definitions)
│   ├── pokerstars-export.md   # PokerStars export specification
│   └── store-assets/          # Chrome Web Store screenshots + promo tiles (440×280 / 1400×560)
│       └── src/               # Promo tile HTML generators (capture-promo-tiles.ts renders these)
├── e2e/                       # E2E QA harness (WS replay into the real extension; see e2e/README.md)
│   ├── README.md              # Canonical harness documentation
│   ├── config.ts              # Paths, ports, BROWSER_CACHE_DIR (~/.cache/puppeteer)
│   ├── harness.ts             # Chrome-for-Testing launcher + fixture replay driver
│   ├── fixture-server.ts      # Local fixture page/WS server
│   ├── run.ts                 # Interactive exploration CLI
│   ├── scenarios/             # Automated checks (smoke, playerid, ...)
│   ├── fixtures/              # Anonymized NDJSON replay fixtures
│   ├── public/                # Fixture pages + assets (incl. anonymized real-table backdrop, opt-in via ?backdrop=1)
│   └── tools/                 # capture-store-imagery.ts / capture-promo-tiles.ts (store imagery)
├── icons/                     # Extension icons
│   ├── icon_16px.png
│   ├── icon_48px.png
│   └── icon_128px.png
├── scripts/                   # Signed-CRX packager and hand verification helper
└── src/                       # Source code
    ├── app.ts                 # Re-export layer (type guards)
    ├── background.ts          # Service worker entry (wires modules below)
    ├── content_script.ts      # Bridge between page and extension (keepalive, session events)
    ├── web_accessible_resource.ts  # WebSocket interception
    ├── entity-converter.ts    # Direct event-to-entity conversion (rebuild/import)
    ├── popup.ts               # Extension popup entry point
    ├── popup-boot.ts          # Synchronous pre-paint popup theme bootstrap
    ├── index.html             # Extension HTML
    ├── test-setup.ts          # Jest setup for React Testing Library
    │
    ├── background/            # Service worker modules
    │   ├── auto-sync-boot.ts        # Auth-ready auto-sync initialization (init race guard)
    │   ├── event-ingestion.ts       # Raw Event Lake ingestion: serialized queue, durability
    │   │                            #   barrier, content dedup + sequence assignment,
    │   │                            #   session-activity transitions (201/303/308 → 309/203)
    │   ├── hud-config-sync.ts       # UIConfig broadcast to game tabs
    │   ├── import-export.ts         # Import/export/rebuild (performFullRebuild), pre-game hero stats
    │   ├── message-router.ts        # chrome.runtime message dispatch
    │   ├── operation-state.ts       # Long-operation exclusivity + idle-transition listeners
    │   ├── ports.ts                 # Port lifecycle, stats broadcast, hand-completion epoch
    │   ├── rebuild-advisory.ts      # データ再構築 advisory (REBUILD_ADVISORY_VERSION, badge)
    │   ├── undecoded-event-tracker.ts # Dropped/undecoded event counters (popup alert)
    │   ├── update-manager.ts        # Forced update: safe-window, drain barrier,
    │   │                            #   commitReloadIfStillSafe(), pending-update persistence
    │   └── whats-new-badge.ts       # Post-update badge (3-way badge precedence resolver)
    │
    ├── components/            # React UI components
    │   ├── App.tsx            # Root component (state, seat rotation, busted-player dim cache)
    │   ├── Hud.tsx            # Draggable HUD overlay
    │   ├── HandLog.tsx        # Virtualized hand history log
    │   ├── Popup.tsx          # Extension popup interface
    │   ├── hud/               # HUD-specific components
    │   │   ├── CompactStatDisplay.tsx   # Compact display mode (default): classic 1-line stats
    │   │   ├── DragHandle.tsx
    │   │   ├── HudHeader.tsx            # Player name, rank, pot odds, 離席 badge
    │   │   ├── PlayerTypeIcons.tsx      # 🦈💣🪨🐟 + 🐳 classification icon
    │   │   ├── playerTypeRules.ts       # Quadrant/whale thresholds + n-gates
    │   │   ├── PositionalPanelTrigger.tsx / PositionalStatsPanel.tsx  # Positional drill-down
    │   │   ├── RecentHandsPanelTrigger.tsx / RecentHandsPanel.tsx     # Recent-hands drill-down
    │   │   ├── RealTimeStatsDisplay.tsx
    │   │   ├── StatDisplay.tsx          # Full 16-stat grid (click-to-expand from compact)
    │   │   ├── statColorRules.ts        # Threshold-based value coloring (n-gated)
    │   │   ├── statTooltip.ts           # Per-stat tooltip composition
    │   │   └── hooks/
    │   │       └── useDraggable.ts
    │   └── popup/             # Popup-specific components
    │       ├── FirebaseAuthSection.tsx
    │       ├── GameTypeFilterSection.tsx
    │       ├── HandLimitSection.tsx
    │       ├── HudDisplaySection.tsx    # Display mode / color coding toggles
    │       ├── ImportExportSection.tsx
    │       ├── PopupHeader.tsx          # Theme control (自動/ダーク/ライト)
    │       ├── SectionCard.tsx / SectionHeading.tsx / SegmentRadio.tsx / ToggleChip.tsx
    │       ├── StatisticsConfigSection.tsx
    │       ├── SyncStatusSection.tsx
    │       ├── TableSizeFilterSection.tsx # テーブル人数 filter (full/4p/3p/hu)
    │       ├── UIScaleSection.tsx
    │       ├── UndecodedEventSection.tsx  # Dropped-event alert
    │       ├── UpdateSection.tsx          # Forced-update / min-version banners
    │       ├── WhatsNewSection.tsx        # 更新情報 (whats-new entries)
    │       ├── popup-boot-theme.ts / popup-theme-storage.ts / theme.ts  # Dark/light theming
    │       └── send-message.ts
    │
    ├── constants/
    │   ├── database.ts        # DATABASE_CONSTANTS, REBUILD_ADVISORY_VERSION
    │   ├── runtime.ts         # Runtime constants
    │   ├── update.ts          # Forced-update constants (side-effect-free)
    │   └── whats-new.ts       # WHATS_NEW_ENTRIES (curated per-version release notes)
    │
    ├── db/
    │   └── poker-chase-db.ts  # Dexie database definition (v6 schema: sequence-key Lake)
    │
    ├── services/
    │   ├── poker-chase-service.ts      # Central state management + persistence
    │   ├── firebase-auth-service.ts    # Chrome identity → Firebase auth (authGeneration)
    │   ├── firebase-config.ts          # Firebase project config
    │   ├── firestore-backup-service.ts # Cloud sync REST client (bounded transport, doc IDs)
    │   ├── auto-sync-service.ts        # Auto sync triggers, watermark/floor, compound cursor
    │   ├── min-version-gate.ts         # Remote kill switch (config/client, fail-open)
    │   ├── positional-stats-service.ts # Positional drill-down queries (epoch-invalidated cache)
    │   └── recent-hands-service.ts     # Recent-hands drill-down queries (epoch-invalidated cache)
    │
    ├── stats/
    │   ├── index.ts           # Module exports
    │   ├── registry.ts        # Statistics registry (auto-discovery)
    │   ├── compactStats.ts    # Compact-line + classifier required-stat forcing
    │   ├── helpers.ts         # Common helper functions
    │   ├── utils.ts           # Formatting utilities
    │   └── core/              # Statistic definitions
    │       ├── index.ts       # Core stats barrel export
    │       ├── 3bet.ts / 3bet-fold.ts / af.ts / afq.ts / cbet.ts / cbet-fold.ts
    │       ├── hands.ts / pfr.ts / player-name.ts / vpip.ts
    │       ├── vpip-full.ts   # VPIP·F (full-table layer, opt-in)
    │       ├── steal.ts / fold-to-steal.ts
    │       ├── wsd.ts / wtsd.ts / wwsf.ts
    │       ├── wtsd-no-ai.ts / wwsf-no-ai.ts  # WTSDa/WWSFa opt-in variants
    │       ├── river-call-accuracy.ts  # RCA (HUD-original)
    │       └── example-4bet.ts.example  # Template for new stats
    │
    ├── streams/               # Data processing pipelines
    │   ├── aggregate-events-stream.ts  # Event aggregation by hand
    │   ├── write-entity-stream.ts      # Entity persistence
    │   ├── read-entity-stream.ts       # Statistics calculation
    │   ├── hand-log-stream.ts          # Hand history generation
    │   ├── realtime-stats-stream.ts    # Real-time stats (parallel)
    │   └── simple-transform.ts         # Stream utility
    │
    ├── realtime-stats/        # Real-time statistics
    │   ├── index.ts
    │   ├── hand-improvement.ts         # Hand improvement probabilities
    │   ├── pot-odds.ts                 # Pot odds / SPR calculator
    │   └── realtime-stats-service.ts   # Service coordination
    │
    ├── mockup/                # UI visual mockup entry (npm run mockup, deterministic data)
    │
    ├── test-fixtures/         # Shared typed lifecycle fixtures used by Jest tests
    │
    ├── tools/                 # Development & debugging tools
    │   ├── detect-schema-diff.ts  # API schema change detection
    │   ├── trace-hands.ts         # Hand event tracing
    │   ├── validate-schemas.ts    # NDJSON event validator
    │   └── verify-stats.ts (+ verify-stats/)  # Independent stats oracle cross-check
    │
    ├── types/                 # TypeScript definitions + Zod schemas
    │   ├── index.ts           # Central export point
    │   ├── api.ts             # API event types and Zod schemas
    │   ├── entities.ts        # Entity types (Hand, Phase, Action)
    │   ├── errors.ts          # Error types
    │   ├── filters.ts         # Filter options (game type, table size, hand limit)
    │   ├── game.ts            # Game enums (ActionType, PhaseType, etc.)
    │   ├── hand-log.ts        # Hand log & UI config types
    │   ├── messages.ts        # Chrome message passing types
    │   └── stats.ts           # Statistics interfaces (incl. PreflopLine)
    │
    └── utils/                 # Utility modules
        ├── api-event-key.ts   # Sequence-key helpers (canonical payload dedup)
        ├── array-utils.ts     # Array manipulation (rotateArrayFromIndex)
        ├── card-utils.ts      # Card formatting ([37,51] → ['Jh','Ac'])
        ├── database-utils.ts  # DB operations (saveEntities, processInChunks, filterValidApplicationEvents)
        ├── error-handler.ts   # Error handling utilities
        ├── hand-log-exporter.ts       # Multi-hand export (batch optimized)
        ├── hand-log-processor.ts      # PokerStars format generation
        ├── hand-log-text.ts           # Shared PokerStars hand-text formatting
        ├── hand-order.ts              # Stable hand ordering helpers
        ├── logger.ts          # Structured logging
        ├── options-storage.ts # chrome.storage helpers
        ├── pending-stats-cache.ts
        ├── poker-evaluator.ts # Bit-manipulation hand evaluator
        ├── position-utils.ts  # getPositionMap (explicit button/blind seats)
        ├── river-probabilities.ts     # River probability tables
        ├── runtime-port-manager.ts
        ├── starting-hand-rankings.ts  # 169 starting hand rankings
        ├── table-size.ts      # classifyTableSizeLayer (full/4p/3p/hu)
        ├── test-utils.tsx     # Shared test helpers
        └── version-compare.ts # Numeric-dotted version comparator
```

## Generated artifacts

- `dist/` and `extension.zip`: produced by `npm run build` (`postbuild` is an npm lifecycle hook).
- `extension.crx`: produced by `npm run pack:crx` when a signing key is available.
- `e2e/.build/`: generated localhost manifest, unpacked E2E extension, and persistent CLI session metadata.
- `e2e/out/`: screenshots, DOM dumps, and other E2E evidence.

All of these paths are gitignored. Chrome for Testing itself is cached outside the
repository; see [e2e/README.md](../e2e/README.md).
