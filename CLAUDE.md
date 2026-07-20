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

Learned from the 2026-07 season-3 silent-drop incident (a PokerChase payload change silently broke the `EVT_SESSION_RESULTS`/309 schema and stopped auto-sync for ~2 months — see "Raw Event Lake" below and the `AutoSyncService.onNewSessionStart()` fallback under "Cloud Sync & Firebase Integration") — apply when diagnosing missing/inconsistent data:

- **Declare observability**: any claimed mechanism ("X stopped arriving", "the game changed Y") must state where in the causal chain the evidence sits and which rival hypotheses it CANNOT distinguish. Storage tiers differ: local IndexedDB (`apiEvents`) and its exports are the Raw Event Lake — every event with a numeric `timestamp`+`ApiTypeId` is stored regardless of Zod validation (see "Raw Event Lake" below), so a gap there is real evidence of non-arrival at the client. Only the cloud path (Firestore/BQ) is filtered to validation-passing application events before upload, so a gap in Firestore/BQ alone cannot distinguish "never arrived" from "arrived locally but failed validation/wasn't application-typed" — check the local Lake before drawing conclusions from cloud-only data.
- **Prefer direct observation over inference**: before concluding from stored data, check whether the boundary can be observed directly (service-worker console, a single live session capture, packet-level logs). One console log settled in minutes what hours of stored-data inference could not.
- Write mechanisms as falsifiable predictions and check them; have a second pass with a DIFFERENT observation channel attempt to refute a mechanism before documenting it as fact.

#### Codex Review Loop Protocol

PRs in this repo are reviewed by Codex automatically — **auto-review is enabled for solavrc/* repos: the connector reviews on PR creation AND on every push. Do not comment `@codex review`** (it doubles the review cost); the mention is only a fallback after confirming an auto-review did not fire (no verdict for the head SHA on any channel after the in-progress signal clears / ~10min). While a review is in progress, an **eyes reaction sits on the PR description**. Codex review is valued for **diversity**: a different model reading the diff in a clean context catches problems the authoring agent's self-review structurally cannot. Self-review (reading the final commit's full diff) is always performed in addition, never as a substitute.

**Convergence condition (when is a PR merge-ready?)**
- Semantics-bearing changes (sync/watermark logic, statistics, session/state management, event processing): keep the fix → re-request loop running until **two consecutive clean outcomes** on the head commit. A clean outcome is detected STRUCTURALLY: a codex response bound to the current head SHA exists AND that pass produced zero `Badge`-marked inline findings. Do not string-match the verdict message — its wording varies (the "Didn't find any major issues" stem has at least 17 known flavor-text variants and may change entirely); treat verdict text as a secondary signal only.
- Docs and trivially-mechanical changes: one clean verdict suffices.
- A fix commit that goes beyond finding-scoped local patches (new mechanism, rebase integration, cross-file ripple) always needs a fresh review pass before merge — never merge such a commit on an older verdict.

**Loop guards (these are what prevent cost blow-up — the loop has no natural termination otherwise)**
- Reviews are triggered by pushes, not requests: push the fix commit and wait for its auto-review. A manual mention may only follow a confirmed-unreviewed head commit, at most once.
- **Verdict detection must be deterministic and cover ALL delivery channels.** Codex's verdict arrives variably as (a) an issue comment, (b) a review object, or (c) a 👍 reaction on the trigger comment, with inline finding comments carrying `P1/P2/P3 Badge` markers. A watcher that polls only a subset will false-negative and provoke redundant (costly) re-triggers. Check all channels before declaring silence, and **bind every verdict to its `Reviewed commit` SHA — only a verdict for the current head SHA counts** (a clean verdict for a stale commit is not convergence evidence).
- If ~6 total passes elapse without two consecutive cleans, STOP: escalate to the repo owner with the open findings instead of merging or continuing the loop.

**Division of labor (learned 2026-07-20, from an actual runaway-loop incident)**: completion detection, retry decisions, and termination conditions must be encoded deterministically (string/marker checks, bounded counters) — never left to in-context judgment, which is exactly how the incident's redundant re-triggers happened (a deterministic-but-incomplete watcher missed the verdict channel, and an unbounded judgment call re-triggered on the false silence). What stays with the reviewing agent's judgment: whether a finding is valid, and how to scope the fix.

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
15. **Rebuild Advisory Versioning**: Bump `REBUILD_ADVISORY_VERSION` (`src/constants/database.ts`) whenever a change alters write-time entity derivation for already-recorded data, so existing users get prompted (badge/notification/popup banner via `src/background/rebuild-advisory.ts`) to run データ再構築 after updating (version 2, 2026-07: the WTSD/WWSF DEAL_ROUND-omission FLOP-phase synthesis fix described under "Confirmed Statistical Definitions" below)
16. **Raw Event Lake**: `apiEvents` is the raw wire log — any event with a numeric `timestamp`+`ApiTypeId` is stored, independent of whether it parses under the current Zod schema or is an application type. Validation gates only the real-time pipeline (streams/stats/entity generation), never storage. This is what makes データ再構築 an actual recovery path after a PokerChase payload change breaks a schema: rebuild re-validates every stored raw row against the *current* schema, so a later schema fix retroactively recovers rows that failed to parse when first received — no separate promotion mechanism needed. See "ApiEvent Architecture" and `docs/architecture.md` for the full rationale and history.
17. **Forced Update (auto-apply + remote kill switch, sola承認)**: `src/background/update-manager.ts` auto-applies a downloaded extension update (`chrome.runtime.reload()`) as soon as it's SAFE, and `src/services/min-version-gate.ts` can remotely disable cloud sync on old versions. See "Forced Update" under Cloud Sync & Firebase Integration for the full safe-window definition, badge precedence, and fail-open semantics.

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
- **Overlap imports re-derive from the Lake, not from new events alone**: when
  the DB already contained events before the import, the entity pass re-reads
  the affected range from `apiEvents` — expanded back to the last *valid*
  `EVT_HAND_RESULTS` (306) strictly before the earliest new event (the
  previous completed-hand boundary), then to the last *valid*
  `EVT_ENTRY_QUEUED` (201) at/before that boundary (session-context anchor —
  anchoring on the 201 nearest the new events directly would be wrong, since
  an MTT table-move 201 can land mid-hand and cut off the opening
  `EVT_DEAL`), and forward to the first *valid pre-existing* 306 at/after the
  latest new event (newly-imported 306s are skipped, so the range always
  reaches the end of the OLD derivation's hand pairing — e.g. a DEAL that a
  capture gap had mis-paired with a later 306) — so a hand split between
  existing and imported rows (e.g. re-importing a complete export into a DB
  missing the hand's middle ACTIONs) gets its derived entities repaired. Boundary candidates are re-validated
  with the current Zod schema before use, because the Lake intentionally
  stores unparseable rows (a malformed 306 must not truncate the range). New
  events alone cannot form such a hand's 303→306 boundary. The converter is
  seeded with the empty default session only when the range actually starts
  at a found 201 anchor; otherwise (incremental hands without a 201) the
  live `service.session` seeds it, matching the direct path and the #104
  SessionState-seeding regression. Saving is delete-then-put in one
  transaction: derived hands whose `approxTimestamp` falls in the stale
  window (previous completed-hand boundary exclusive → end boundary
  inclusive) are deleted with their phases/actions before the regenerated
  bundle is `bulkPut` — upsert alone (idempotent for hands present in both
  derivations via deterministic entity keys) would leave rows that existed
  only in the old derivation (a mis-paired hand's id absent from the new
  derivation, or leftover `[handId+index]` action tails), double-counting
  stats. Every hand in that window is re-derivable from the range by
  construction; the Raw Event Lake is never touched. See
  `collectOverlapRepairEvents()` in `src/background/import-export.ts`
  (independent release-audit finding #7; boundary/session/stale-deletion
  refinements from PR #203 codex review). A fresh import into an empty DB
  keeps the direct new-events path.

**Critical Design Constraints (learned 2026-03):**

> **Data model & event edge cases** are consolidated in [docs/api-events.md](docs/api-events.md) — see "Data Constraints & Edge Cases", "Field Relationships", and "Enum Reference" sections.

- **EntityConverter state**: `convertEventsToEntities()` tracks hand boundaries via internal local variables (`currentHandEvents`). Must NOT be called in chunks — a hand spanning chunk boundaries will be lost. Always pass all events in a single call.
- **EntityConverter/HandLogProcessor never see raw, unvalidated rows**: both read required fields (e.g. `EVT_DEAL.Game.SmallBlind`) via unguarded `switch (event.ApiTypeId)` dispatch, with no `default:` case protecting against a well-known-ApiTypeId-but-malformed payload. Every call site that reads from `apiEvents` (the raw Lake) and feeds either of them re-validates first with `filterValidApplicationEvents()` (`src/utils/database-utils.ts`): `rebuildAllData`, `AutoSyncService.rebuildLocalEntities`, `HandLogExporter.exportHand`/`exportMultipleHands`. This re-validation on every rebuild is also the *entire* recovery mechanism for a PokerChase schema break — a later schema fix makes previously-unparseable rows parse on the next rebuild automatically, no promotion step required.
- **Dexie Collection reuse**: `.offset(n).limit(m)` on a single, already-built Collection object is NOT safe pagination -- Dexie Collections accumulate query modifiers instead of replacing them, so a second `.offset()/.limit()` call on the SAME Collection stacks on top of the first rather than re-querying (a prior version of `processInChunks()` did exactly this and silently only ever processed the first chunk). `processInChunks()` (`src/utils/database-utils.ts`) now takes a `Dexie.Table` and issues a fresh query per chunk, cursor-pagination style: `where('[timestamp+ApiTypeId]').above(lastKey).limit(N)`. Any new caller must pass the Table, not a pre-built Collection.
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
- **Empty Seats**: Show "Waiting for Hand..." in UI -- but only for a seat that has *never* had a player. A seat that drops to `SeatUserIds[i] === -1` after previously holding a real player (bust, MTT table-move-away, SNG退出) does **not** collapse to this state; see "Busted-player dim" below.
- **Busted-player dim** (sola spec, 2026-07): `App.tsx` keeps a per-*display-seat* cache (`dimCacheRef`, keyed by the same post-rotation index `Hud` uses, `seat-${actualSeatIndex}`) of each seat's last live `ExistPlayerStats`. When a fresh lineup shows `-1` at a seat that has a cached entry, `Hud` renders that cached snapshot muted (`opacity: 0.45` on the whole panel + an orange "離席" badge in the header, `HudHeader.tsx`/`Hud.tsx`'s `isDimmed` prop) instead of collapsing to "Waiting for Hand...". Full opacity is restored on hover so drill-down interactions stay comfortable; drill-down panels (positional/recent-hands) keep working off the cached `playerId` regardless. **Seat turnover is immediate and cannot be masked by the cache**: any lineup entry with a real (non `-1`) `playerId` always overwrites that seat's cache entry outright -- covers a brand-new player taking the vacated seat (MTT/cash reseating) and the same player returning (rebuy/reconnect) identically, per `SeatUserIds` alone (no cross-hand identity inference). `content_script.ts` dispatches a local `PokerChaseSessionEndEvent` window event the instant it observes a raw `EVT_SESSION_RESULTS` (no new background↔content_script channel -- it already sees 309 firsthand before forwarding to the service worker); `App.tsx` subscribes and clears every non-hero seat (dim cache included) back to empty on it, leaving the hero panel (seat 0) untouched (pre-game career-stats persistence, see below, is unaffected). Import/batch-refresh lineups (`latestStats` chrome message) bypass the dim cache/mute state entirely -- they're a one-shot DB recompute, not the live per-hand pipeline.
- **Pre-game hero stats**: The hero's own panel (always UI seat 0) renders immediately on HUD mount, before the session's first `EVT_DEAL`, if the hero's identity is already known (`service.playerId` persisted in `chrome.storage.local`, see Service State Persistence). `content_script.ts`'s `mountApp()` sends `{ action: 'requestLatestStats', preGame: true }`; `getLatestSessionStats()` (`background/import-export.ts`) computes career-to-date stats for a hero-only lineup via `ReadEntityStream.calcStats()` — the exact function the live pipeline uses, respecting the active battleType/tableSize/handLimit filters — and pads the other 5 seats with the same `{ playerId: -1 }` empty-seat sentinel `App.tsx`'s default state uses, so it's the same 6-element shape `App.tsx` always keys panels by (`seat-${actualSeatIndex}`, 0-5). No extra "career stats" label: the existing HAND count already communicates it's not a single-hand snapshot, same as any other HUD panel. When the real `EVT_DEAL` arrives, the live broadcast simply replaces `stats` state via the same seat-0 key — no remount, no duplicate panel (seamless takeover). The `preGame: true` flag matters: it's what lets `getLatestSessionStats()` skip its pre-existing "always return `[]`" behavior *only* for this mount-triggered call — the older post-import `refreshStats` round-trip (`preGame` omitted) keeps returning `[]` unconditionally, since import completion already triggers its own real recompute+broadcast moments earlier and enabling the fallback there too would risk a stale hero-only response arriving second and clobbering the fresher full lineup. If `service.playerId` isn't known in memory yet (e.g. a freshly-loaded unpacked extension instance, or persisted state restored before any live `EVT_DEAL` this browser session), `getLatestSessionStats()` first tries `findLatestPlayerDealEvent(db)` — the same DB-recovery derivation `PokerChaseService.recalculateAllStats()` uses on batch-mode exit — and assigns the recovered id through the `service.playerId` setter (persisting it via the normal debounced save) before falling back to a silent no-op only if the DB has no hero deal event either.
- **Chrome Extension**: Work within Manifest V3 constraints
- **HUD display modes** (#143, `UIConfig.hudDisplayMode: 'full' | 'compact'`, default `'compact'`): `'compact'` (`CompactStatDisplay.tsx`) shows one classic-HUD line (`VPIP/PFR/3B (HAND)`, rounded integers) plus a secondary AF/CB/STL line, suppressing zero-opportunity secondary stats instead of rendering `'-'`. `'full'` (`StatDisplay.tsx`) is the existing 16-stat grid, unchanged. Clicking the compact stat body toggles the full grid inline for that player (local per-`Hud`-instance state, so multiple panels can be expanded independently); the click handler `stopPropagation()`s so it doesn't trigger the HUD's click-to-copy or the `#128` positional drill-down chevron. Existing `uiConfig` missing these keys (pre-#143) resolve to the new defaults via the `{...DEFAULT_UI_CONFIG, ...stored}` merge in both `App.tsx` and `Popup.tsx`.
- **HUD color coding** (#143, `UIConfig.hudColorCoding: boolean`, default `true`): threshold-based value coloring for VPIP/PFR/3bet/AF in both display modes, data-driven in `src/components/hud/statColorRules.ts` (`STAT_COLOR_RULES`). n-gated: a stat is only colored once its own `[numerator, denominator]` has `denominator >= 20`; below that it keeps the existing dimmed low-confidence gray (`#888888`).
- **Stat tooltips** (#143, `src/components/hud/statTooltip.ts`): every stat cell (compact segments and full-grid rows) gets a native `title` composed of a base line — the stat's dynamic `StatDefinition.tooltip(context)` (#130, e.g. `vpipF`'s per-layer breakdown) if defined, else `"{name}: {value (num/den)}"` — followed by `StatDefinition.helpText`, a static one-line Japanese explanation defined per stat in `src/stats/core/*.ts`.
- **Player-type classification icon** (HM-style auto-rate, `src/components/hud/playerTypeRules.ts` → `classifyPlayerType`, rendered by `PlayerTypeIcons.tsx` in the HUD header, both display modes): a single emoji + native `title` tooltip (real numbers, Japanese) replacing the old decorative 🐟/🦈 placeholder pair. Data-driven thresholds (`PLAYER_TYPE_THRESHOLDS`), same tuning philosophy as `statColorRules.ts`:
  - **Quadrant** (VPIP × AF, boundaries inclusive on the loose/aggressive side): 🦈 TAG (tight+aggressive) / 💣 LAG (loose+aggressive) / 🪨 ニット (tight+passive) / 🐟 フィッシュ (loose+passive). Tight `< 25%` VPIP `≤` loose; passive `< 1.5` AF `≤` aggressive.
  - **🐳 Whale override**: full-table-layer VPIP (`vpipF`, not raw `vpip`) `≥ 50%` overrides the quadrant icon entirely regardless of AF. Uses `vpipF` specifically — not raw `vpip` — because VPIP is structurally inflated at short-handed tables (see the `vpipF` entry below); a player sampled mostly at HU/short tables would otherwise be mislabeled a whale off raw VPIP alone.
  - **n-gates**: no icon at all until `vpip` denominator `≥ 30` (baseline track-record gate). Whale additionally needs its own `vpipF` denominator `≥ 30` and fires on `vpipF` alone even when AF is under-sampled (whale ignores AF by definition). Quadrant classification additionally needs `af` denominator `≥ 20`; if AF's sample is too thin but VPIP's is fine, nothing is shown rather than guessing an unplaceable axis.
  - **Required-stat forcing**: `vpipF` is opt-in (`enabled: false` by default) and would otherwise never reach the classifier for users who haven't turned its HUD row on. `src/stats/compactStats.ts` exports `CLASSIFIER_REQUIRED_STAT_IDS = ['vpip', 'af', 'vpipF']` alongside the existing `COMPACT_REQUIRED_STAT_IDS`; `read-entity-stream.ts` forces the union of both sets into `calculateWithConfig` regardless of the user's `statDisplayConfigs.enabled` flags, same mechanism/rationale as #143's compact-line forcing (widens only what's *calculated*, not what the full grid *displays*).
- **Recent hands drill-down** (`getRecentHands`, `src/services/recent-hands-service.ts`, `src/components/hud/RecentHandsPanel.tsx` + `RecentHandsPanelTrigger.tsx`): HM3/PT4 "Last Hands" + Hand2Note "recent showdown hole cards" pattern, cloning the `#128` positional drill-down's architecture (indexed `hands`/`actions`/`phases` queries batched by `handId`, 30s cache keyed on `playerId`+filters+`limit`, chevron trigger next to it in `HudHeader.tsx`, App-level `openPanel: { playerId, kind: 'positional' | 'recentHands' } | null` state making the two drill-downs mutually exclusive). Lists the player's last N hands (default 10, own `limit` param -- independent of `handLimitFilter`, which only bounds the aggregate stats), newest hand-id first. Key design points:
  - **Hole cards without touching `apiEvents`**: `hand.results` (persisted straight from `EVT_HAND_RESULTS.Results` by `write-entity-stream.ts`/`entity-converter.ts`) already carries each result row's `HoleCards`, and the server itself only ever sends valid card indices for cards that were actually shown -- so visibility is derived entirely from the already-persisted `Hand` entity, gated on `isShowdownParticipant(result)` (RankType 0-9 or 11 SHOWDOWN_MUCK) AND the `HoleCards` array actually holding valid values. RankType 10 NO_CALL and 12 FOLD_OPEN never show cards here even though the server does send real values for a voluntary post-fold reveal (12) -- this panel is specifically "recent *showdown* hole cards".
  - **Preflop-line taxonomy** (`derivePreflopLine`, full doc comment on `PreflopLine` in `src/types/stats.ts`): a simplified `Open`/`3Bet`/`NBet`/`Limp`/`ColdCall`/`Call`/`Check`/`Walk`/`Fold` label per hand, derived from the player's own PREFLOP actions plus a locally-recomputed `phasePrevBetCount` (same formula as `write-entity-stream.ts`, replayed over a batched `actions.where('handId').anyOf(handIds)` fetch covering all seats -- own actions alone can't tell you what bet count you faced). The label reflects the *last* action taken; if that's a FOLD and there was a preceding line, it gets a `-F` suffix (e.g. `3Bet-F`).
  - **netChips**: ships `result.RewardChip` when `won` (`RewardChip > 0`), else `null` -- a gross winnings amount, not a reconstructed true net profit/loss (that would need full side-pot contribution accounting per hand, not worth it for a glanceable row).

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

**Popup theming**: `src/components/popup/theme.ts` defines two MUI themes -- `dark-felt` (default look, shares the HUD overlay's dark/gold palette) and `modern-light`. Which one renders is controlled by the `popupTheme` setting (`'auto' | 'dark' | 'light'`, default `'auto'`; テーマ control in `PopupHeader.tsx`, a 自動/ダーク/ライト 3-way `SegmentRadio`). `'auto'` resolves against the live OS `prefers-color-scheme` via `useMediaQuery` in `Popup.tsx` (`resolvePopupThemeVariant()` in `theme.ts` is the pure resolver, unit-tested independent of the DOM). Persisted to its own `chrome.storage.sync` key (`popupTheme`, see `popup-theme-storage.ts`) -- deliberately **not** a field on `UIConfig`, because `UIScaleSection`/`HudDisplaySection` broadcast every `uiConfig` write to all open game tabs (`chrome.tabs.sendMessage(..., 'updateUIConfig')`) to trigger a HUD re-render; the popup's own chrome has nothing to do with the HUD overlay, so nesting it there would fire that broadcast on every theme change for no reason. `popup.ts` pre-fetches the persisted mode before the first `render()` call so the popup never paints with the wrong theme and then swaps.

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

### Confirmed Statistical Definitions (PT4-aligned, audited 2026-03, re-aligned 2026-07 #115, DEAL_ROUND-omission fix 2026-07)

These definitions were validated by hand-tracing 22 hands from the integration test suite (2026-03), then cross-checked against PT4/HM3 official documentation and an independent oracle over a 393,830-event real-data capture (2026-07, #115 — see `npm run verify-stats`):

- **CBet (CB)**: PFR opens betting on flop (phasePrevBetCount=0, cBetter=playerId). Extended to turn/river while initiative retained.
- **CBetFold (CBF)**: Fold rate **only when a CBet was actually executed** (`cBetExecuted=true`). If PFR checked (no CBet), subsequent bets by others do NOT create CBetFold opportunities. Scoped to the same street as the CBet (`cBetPhase` tracking).
- **WTSD** (PT4 built-in definition): Flops seen → showdown, where "flops seen" **includes preflop all-ins** — PT4 staff: "Those stats are based on flops seen, not based on flops seen when not all-in, so all-in spots will count." Phase membership for FLOP is normally `BetStatus === BET_ABLE || BetStatus === ALL_IN` at the FLOP `EVT_DEAL_ROUND`, in both `entity-converter.ts` and `write-entity-stream.ts` (#115); FOLDED players remain excluded (the original #97 fix stays in place — only the all-in carve-out was reversed). `SHOWDOWN_MUCK (RankType=11)` counts as showdown. **DEAL_ROUND-omitted shape** (post-#115 fix): when every remaining player is all-in preflop, PokerChase skips `EVT_DEAL_ROUND` entirely for the rest of the hand and ships the whole remaining board in `EVT_HAND_RESULTS.CommunityCards` instead (`docs/api-events.md`), so no BetStatus snapshot for FLOP ever exists. Both pipelines detect this (no FLOP phase pushed yet, and the accumulated board reaches ≥3 cards once `EVT_HAND_RESULTS` arrives) and synthesize the FLOP phase from `EVT_HAND_RESULTS` instead: membership is every dealt seat that did **not** take a PREFLOP `FOLD` action (the only way to leave before an unconditional preflop-all-in runout), and `communityCards` is the first 3 cards of the merged board. This closes the gap flagged in PR #115's unresolved review thread, where these hands silently kept a zero "flops seen" denominator despite reaching showdown. Real-data measurement (2026-07-04 capture, 393,830 events / 31,392 hands): 3,071 hands (9.8%) hit this path, adding 6,348 player-hand pairs to the WTSD/WWSF population.
- **W$SD**: ALL showdowns including preflop ALL_IN. `SHOWDOWN_MUCK` counts as showdown. `NO_CALL (RankType=10)` does NOT count as showdown.
- **WWSF** (PT4 built-in definition): Flops seen → won, same "flops seen incl. preflop all-ins" population as WTSD above, including the DEAL_ROUND-omitted synthesis described there.
- **WTSDa / WWSFa** (opt-in variants, disabled by default, #115): Preserve the pre-#115 decision-focused semantics as an explicit choice rather than the primary definition. Lineage: PT4's custom stat "WTSD without preflop all-ins" and Hand2Note's "Flop Any Action"-based variants. Base (denominator) is hands where the player took **≥1 action with `phase === FLOP`** — a `BET_ABLE` flop-seer always acts at least once; a preflop all-in player never does, reproducing the "no preflop all-ins" population without a second BetStatus re-derivation. WTSDa numerator: base hands that reached a SHOWDOWN phase. WWSFa numerator: base hands in `winningHandIds`. Implemented purely in `calculate()` (no schema changes). Enable from the popup's HUD display settings (`StatisticsConfigSection`); `defaultStatDisplayConfigs` respects `StatDefinition.enabled !== false`, and `mergeStatDisplayConfigs` appends them disabled for existing users.
- **AF** (PT4 official definition, postflop-only): `(BET+RAISE) / CALL`, **counting only actions with `phase !== PREFLOP`**. PT4: "Ratio of the times a player makes a POSTFLOP aggressive action (bet or raise) to the times they call." CHECK and FOLD excluded from both numerator and denominator; preflop opens/3-bets/etc. are excluded entirely (previously counted across all streets — corrected in #115).
- **AFq** (postflop-only, same scope as AF): `(BET+RAISE) / (BET+RAISE+CALL+FOLD)`, postflop actions only. CHECK excluded from denominator.
- **VPIP / PFR** (PT4/HM walk-exclusion standard, #115): Denominator is **hands − walks**, not all hands played. A hand is excluded from the denominator when the player was the BB (`Hand.bigBlindUserId`, derived from `Game.BigBlindSeat` at EVT_DEAL in both `entity-converter.ts` and `write-entity-stream.ts`) **and** took zero preflop actions in that hand — this covers both a true walk (everyone folds to the BB) and the documented "BB action skip" path (`NextActionSeat=-2`, no BB EVT_ACTION emitted; 31.9% of hands per the real-data audit). In both cases the BB had no voluntary preflop decision to make. A non-BB player who folded preflop still made a decision and remains counted as an opportunity. `Hand.bigBlindUserId` is a non-indexed optional field (no Dexie schema version bump required).
- **VPIP·F (vpipF)**: **HUD-original stat with no tracker equivalent** (トラッカー非互換のHUD独自指標, like RCA below) — opt-in, disabled by default. Same numerator/denominator logic as VPIP above (including walk exclusion, #115), restricted to "full-table-layer" hands only, computed **table-type relative**: a 6-max hand (`Hand.seatUserIds.length === 6`) qualifies when ≥5 of the 6 seats are dealt (non `-1`); a 4-max hand (`length === 4`) qualifies only when all 4 seats are dealt (a 4-max hand with 3 dealt is already short-handed behavior and is excluded). Rationale: real-data cross-check against the poker-warehouse analysis (hero=sola, 1,980 recent hands) shows VPIP inflates structurally as table size shrinks in SNG play — 5-6p 35.2% vs 4p 47.0% vs 3p 56.1% vs HU 71.9%, a 30+pt spread — because (a) VPIP mechanically approaches 100% heads-up, and (b) the high-VPIP zone (≤3 players left) is only reached by players who survived that far, so late-game hands' share of a player's sample is itself a function of their results (survivorship), distorting cross-player comparison on the plain aggregate. `vipF` restricts the primary number to the structurally comparable full-table population. Implemented purely in `calculate()` off `context.hands[].seatUserIds` (`src/stats/core/vpip-full.ts`, `classifyVpipFLayer` — re-exports the shared `classifyTableSizeLayer` from `src/utils/table-size.ts`, the single implementation of this rule) — no schema/entity-converter/write-entity-stream changes, no `REBUILD_ADVISORY_VERSION` bump, same opt-in wiring as WTSDa/WWSFa. A `StatDefinition.tooltip(context)` hook (new, generic — see `types/stats.ts`) renders a per-layer breakdown (`VPIP·F 35.2% (n=1252) | 4p 47.0% (n=279) | 3p 56.1% (n=221) | HU 71.9% (n=146)`) surfaced via the HUD stat cell's native `title` attribute; the cell itself still shows only the plain VPIP·F percentage. See `workspace/reports/pokerchase-hud-vpip-f-handover.md` for the full analysis this is based on. The C案 table-size *filter* (`FilterOptions.tableSize`, popup テーブル人数 section) applies this same full/4p/3p/hu split to every HUD stat, at the same application point/ordering as `gameTypes` (filter, then `handLimit`) — see the `FilterOptions` row above.
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
- **Cloud sync is application-type-only** (cost decision): `AutoSyncService.syncToCloud()` filters each raw chunk to `isApplicationApiEvent` before upload — non-application noise (202/205 keepalive/timer, or any ApiTypeId outside `ApiTypeValues`) never leaves the device. The upload cursor still advances on the *raw* chunk boundary (not the filtered subset) for these rows, otherwise a chunk that's 100% noise would never advance and the sync loop would refetch it forever.
- **Watermark never advances past a recoverable unparseable row** (PR #142 review r3611258695, fixed in `fix/sync-watermark-unparseable`): an application-typed row that currently fails Zod validation (e.g. a 309 broken by a PokerChase payload change, see `docs/postmortems/2026-07-session-results-drop.md`) is *not* treated like noise for watermark purposes — `isUnparseableApplicationEvent()` (`src/types/api.ts`) tells them apart by ApiTypeId membership in `ApiTypeValues` alone (not full schema success), since `isApplicationApiEvent` collapses both to `false`. Naively advancing the raw-chunk cursor past such a row is a **permanent loss**, not a delay: once a *later* valid event uploads, Firestore's own max timestamp (`getCloudMaxTimestamp()`) moves past the unparseable row, and every future `.where('timestamp').above(cloudMaxTimestamp)` query excludes it forever — even after a future schema fix makes it parseable, since the raw Lake copy is never re-offered to the query. `AutoSyncService` persists the earliest such row's timestamp in `meta` (`syncUnparseableFloor`) and rewinds each sync's scan floor to just before it until it resolves, re-offering it to `isApplicationApiEvent` (and therefore to upload) on every sync. This can't starve the loop (only rows that structurally *should* eventually parse hold the floor back — known noise still advances immediately) and can't silently lose data (the marker persists across Service Worker restarts and is only cleared once a full scan finds nothing pending). See the tradeoff comment at the top of `AutoSyncService.syncToCloud()` for alternatives considered (never-advance-at-all reintroduces the SPOF-era starvation; uploading unparsed rows as opaque blobs pollutes Firestore's document shape; rebuild-triggered-only re-scan misses the ship-then-sync-before-rebuild race).

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

- **`storage.sync`**: User preferences (`options`, `uiConfig`, `handLogConfig`, `popupTheme`) and HUD positions (`hudPosition_0`–`hudPosition_5`, `hudPosition_100`)
- **`storage.local`**: Service state persistence (`pokerChaseServiceState` — playerId, latestEvtDeal, session)

#### Config Interfaces

| Interface | Location | Key Fields |
|---|---|---|
| `UIConfig` | `src/types/hand-log.ts` | `displayEnabled`, `scale` (0.5–2.0) |
| `HandLogConfig` | `src/types/hand-log.ts` | `enabled`, `maxHands`, `position`, `width`, `height`, `fontSize`, `opacity` |
| `FilterOptions` | `src/types/filters.ts` | `gameTypes` (sng/mtt/ring), `tableSize` (full/4p/3p/hu players-dealt layer, `src/utils/table-size.ts`, opt-out multiselect, missing key = all layers/no filter; popup label "テーブル人数"), `handLimit`, `statDisplayConfigs` |
| `PopupThemeMode` | `src/components/popup/theme.ts` | `'auto' \| 'dark' \| 'light'` (default `'auto'`), persisted standalone as `popupTheme` (`popup-theme-storage.ts`) — popup-only, not part of `UIConfig`/its all-tabs broadcast |
| `HudPosition` | `src/components/Hud.tsx` | `top`, `left` (percentage) |

#### Data Flow

Popup → `chrome.runtime.sendMessage` → Background → forwarded to game tabs → React re-render.

#### Service State Persistence

Key `pokerChaseServiceState` in `storage.local`. Auto-saved with 500ms debounce on setter calls. Restored on Service Worker startup. Handles quota exceeded with automatic cleanup.

- **Hero `playerId` must survive spectator-mode deals** (field report, sola 2026-07-20): `EVT_DEAL.Player` is `undefined` in "観戦モード" (spectator mode — e.g. after the hero busts out of a tournament but the client keeps receiving deal events for other players' tables; see `docs/api-events.md` "EVT_DEAL: Playerフィールドの欠落"). `AggregateEventsStream`'s `EVT_DEAL` case only assigns `service.playerId`/`service.latestEvtDeal` when `event.Player?.SeatIndex !== undefined` — a spectator-mode deal leaves both untouched rather than clobbering them to `undefined`. Before this fix, any such deal near session end wiped the already-known hero identity and persisted the `undefined` through the 500ms debounce, so a reload (Service Worker restart, restoring from `storage.local`) came back with no hero identity and the pre-game hero stats panel (`#158`) didn't render — a plain cloud-download + `rebuildAllData`/`importData` masked the bug because those paths re-derive `playerId` via `findLatestPlayerDealEvent()` (`src/utils/database-utils.ts`), which explicitly filters for deals where `Player.SeatIndex` is present. A different account logging in still overwrites `playerId` correctly, since that always arrives as a deal *with* `Player` present. `SessionState.reset()` (session/table-scoped: id/battleType/name/players, triggered on `EVT_ENTRY_QUEUED`) intentionally does **not** touch `playerId`/`latestEvtDeal` — those are hero-identity state, not session state, and must outlive any single session/table.

---

## Cloud Sync & Firebase Integration

### Architecture

- **Service Worker Compatible**: Firebase SDK v12+ with chrome.identity authentication
- **Data Structure**: `/users/{userId}/apiEvents/{timestamp_ApiTypeId}`
- **Sync Strategy**: Incremental upload, full download (cloud as source of truth)
- **Cost Optimized**: 100+ event threshold, no periodic sync
- **Application-type-only sync**: unlike local `apiEvents` (the full Raw Event Lake), Firestore only ever receives application-type events that currently parse — `AutoSyncService.syncToCloud()` filters each raw chunk with `isApplicationApiEvent` before upload. Non-application noise (202/205 keepalive/timer) stays local-only; this is a cost decision (Firestore write/storage cost), not a data-loss risk, since the local Lake already has the raw copy and noise is never meant to reach Firestore. Application-typed rows that currently fail to parse are different: they're also excluded from upload, but `AutoSyncService` tracks them separately (`meta.syncUnparseableFloor`) and keeps re-offering them to every future sync instead of letting the watermark pass them by — see "Watermark never advances past a recoverable unparseable row" above.

### Key Features

- **Auto Sync**: Triggers on two independent events, both gated by the same 100+ new-event backlog threshold (`AutoSyncService.EVENTS_THRESHOLD`) via a shared `syncIfBacklogExceedsThreshold()` helper:
  - **Primary — session end** (`EVT_SESSION_RESULTS`/309): `AutoSyncService.onGameSessionEnd()`
  - **Fallback — session start** (`EVT_ENTRY_QUEUED`/201 or `EVT_SESSION_DETAILS`/308): `AutoSyncService.onNewSessionStart()`. Added after the 2026 season-3 incident (see "Incident Diagnosis Practices" above) where 309 alone was a single point of failure — a PokerChase payload change broke its schema and silently stopped auto-sync for ~2 months. Session start is a safe moment to sync (no hand is in flight), and reusing the same threshold check means a broken 309 now costs at most one session's lag instead of indefinite silence. No extra debounce is needed: the in-flight guard (`isSyncing`) and the fact that a successful sync advances `lastSyncTime` (shrinking the backlog below threshold) together prevent a double-fire when 309 fired normally just before session start.
- **Manual Sync**: Upload/download controls in popup
- **BigQuery Export**: Automatic daily snapshots for analysis
- **Free Tier Friendly**: Typical usage stays within limits

**Important**: Update `src/services/firebase-config.ts` with your Firebase configuration.

For detailed setup instructions, see [docs/firebase-setup.md](docs/firebase-setup.md).

### Forced Update (auto-apply + remote kill switch)

sola-approved mechanism to get users onto a fixed/current version without waiting for Chrome's own lazy update cadence. Two independent pieces:

**1. Auto-apply downloaded updates (`src/background/update-manager.ts`)**

- **Safe-window definition** (`isSafeToUpdate()`): SAFE = no active game session AND `!AutoSyncService.isSyncing` AND `currentOperationState.type === 'idle'`. Session activity is tracked independently in the Service Worker (`markSessionActive()`/`markSessionInactive()`, called from `event-ingestion.ts` on `EVT_SESSION_DETAILS`/`EVT_SESSION_RESULTS` — the same ApiTypeId boundary `content_script.ts`'s keepalive gate (`isGameActive`) uses, tracked separately because the SW can't see the content script's in-memory state). Defaults to `'unknown'` on every SW (re)start and is treated as **unsafe** until an actual `EVT_SESSION_RESULTS` is observed — conservative by design, per spec.
- **Trigger**: `chrome.runtime.onUpdateAvailable` → SAFE now? `chrome.runtime.reload()` immediately. Not SAFE? persist `{pending: true, version}` to `chrome.storage.local` (`PENDING_UPDATE_STORAGE_KEY = 'pendingUpdate'`) and badge the icon.
- **Re-check points** (`recheckPendingUpdate()`), exactly 3: (a) session end — hooked in `event-ingestion.ts` right next to `AutoSyncService.onGameSessionEnd()`'s call site; (b) long-running operation completion — `operation-state.ts` exposes `onOperationBecameIdle()`, a non-idle→idle transition listener registry, so `update-manager.ts` can subscribe without `operation-state.ts` depending on it; (c) Service Worker startup — called directly from `initUpdateManager()`.
- **Accelerated checks**: `chrome.runtime.requestUpdateCheck()` once on SW startup, plus a `chrome.alarms` alarm (`pokerchase-hud-update-check`, `periodInMinutes: 360`) so the check survives SW death (alarms wake the SW; a `setInterval` would not).
- **Popup UI** (`src/components/popup/UpdateSection.tsx`): reads `pendingUpdate`/`minVersionGateState` straight from `chrome.storage.local` (same pattern as rebuild-advisory/undecoded-event banners) and shows a 「新しいバージョンが待機中です」 MUI `Alert` with a 「今すぐ適用」 button → `applyPendingUpdate` message → `applyUpdateNow()` re-checks safety server-side and either reloads or returns a Japanese reason string (session/sync/operation) that the popup displays inline. Optimistic UI is deliberately *not* used here (unlike export/import/rebuild) — applying is fire-and-confirm since a false "applied" would just look like nothing happened when the popup gets torn down by the reload anyway.
- **Badge precedence**: rebuild-advisory's badge (`src/background/rebuild-advisory.ts`, data-correctness action) always wins. `update-manager.ts`'s `setBadge()`/`clearBadge()` both no-op whenever `getRebuildAdvisoryState().pendingVersion` is set — one-directional: rebuild-advisory is unmodified and always sets/clears unconditionally. Once rebuild-advisory resolves, the next `recheckPendingUpdate()` call (any of the 3 re-check points) re-asserts the update badge if still pending.

**2. Remote minimum-version gate / kill switch (`src/services/min-version-gate.ts`)**

- **Fetch shape**: unauthenticated `GET https://firestore.googleapis.com/v1/projects/pokerchase-hud/databases/(default)/documents/config/client?key=<firebaseConfig.apiKey>` — same REST base URL shape as `firestore-backup-service.ts`'s `baseUrl`, but with the public API key in the query string instead of an `Authorization: Bearer` header (public-read doc, no signed-in user required).
- **Firestore rule**: `firestore.rules` adds `match /config/client { allow read: if true; allow write: if false; }` — public read of exactly this one doc, nothing else loosened.
- **Fail-open matrix** (every path returns `{supported: true}` and logs one `console.warn`): network/fetch error, non-OK HTTP status (incl. 404 = doc not created yet), invalid JSON body, missing `minSupportedVersion` field, non-numeric-dotted version string (comparator returns `null` from `src/utils/version-compare.ts`'s `compareVersions()`, `isVersionBelow()` treats `null` as "not below"). The gate can only ever make the extension *more* restrictive when explicitly configured — never brick it by omission or misconfiguration.
- **Cache**: 12h TTL in `chrome.storage.local` (`MIN_VERSION_GATE_STORAGE_KEY = 'minVersionGateState'`), checked once on SW startup (`background.ts`) so normal operation never re-fetches on every wake.
- **Enforcement**: `AutoSyncService.performSync()` is the single choke point all sync entry points funnel through (manual sync, `onGameSessionEnd`/`onNewSessionStart` triggers, `initialize()`'s first-time sync) — it calls `isCloudSyncBlockedByMinVersionGate()` and, if blocked, sets `syncState.error` and returns without syncing. **The HUD keeps working** — stats are computed entirely from local IndexedDB, so this only ever stops the cloud round-trip, never the overlay.
- **Popup UI**: same `UpdateSection.tsx`, an `error`-severity banner: 「このバージョンはサポートが終了しました。Chromeを再起動すると更新が適用されます」 + a 「今すぐ適用」 button that reuses the exact same `applyPendingUpdate` → `applyUpdateNow()` reload path as the auto-apply feature above (best-effort: only actually reloads onto a newer version if Chrome has already downloaded one).

**Owner follow-ups** (not automatable from an agent session): deploy `firestore.rules` (`npm run firebase:deploy:rules`) once the Firebase CLI is authenticated interactively, and create the `config/client` document (e.g. `minSupportedVersion: "5.0.0"` as a starting floor) via the Firebase Console or an authenticated Admin SDK script — client writes to this doc are rejected by rule (`allow write: if false`), so it cannot be seeded from the extension or an unauthenticated script. Until the doc exists, the gate fails open (everyone stays "supported") — this is safe by design, not a broken state.

### What's New (per-version release notes)

sola-approved: a curated, in-popup "更新情報" section plus a one-shot post-update badge, so users learn what changed without leaving the extension. Two pieces:

**1. Curated content (`src/constants/whats-new.ts`)**

- `WHATS_NEW_ENTRIES: WhatsNewEntry[]` — newest first, each entry is `{ version, date, title, points: [{ text, why? }] }`. Hand-written Japanese copy (sola reviews it), not auto-generated from commit messages — CHANGELOG.md/release-please's PR-title list is the *source material*, not the copy itself.
- **This is release-process housekeeping, not just a docs nice-to-have: appending a `WHATS_NEW_ENTRIES` entry for the new version is part of the release procedure**, done alongside (or right after) the release-please version bump. If you skip it, `selectWhatsNewEntry()` silently falls back to the newest *older* curated entry (see below) instead of erroring — nothing breaks, but users on the new version see stale notes and never get the post-update badge (`markWhatsNewOnUpdate()` only marks a version that has a matching entry).
- `selectWhatsNewEntry(currentVersion, entries?)`: exact match on `chrome.runtime.getManifest().version` first; falls back to the newest entry `<= currentVersion` via `compareVersions()` (`src/utils/version-compare.ts`, the same comparator `min-version-gate.ts` uses). Returns `undefined` (renders nothing) if no entry is `<=` the current version at all.
- `GITHUB_RELEASES_URL` / `WHATS_NEW_STORAGE_KEY` (`'whatsNewUnseenVersion'`) live in the same side-effect-free file, importable from popup code without pulling in `whats-new-badge.ts`'s `chrome.action`/background-module dependency chain (same reasoning as `constants/update.ts`, PR #150).

**2. Badge + Popup UI**

- **Popup** (`src/components/popup/WhatsNewSection.tsx`): a `SectionCard` placed right after `UpdateSection` (forced-update banners) and before the first settings `SectionCard` — high enough to be seen every time the popup opens, but below anything that needs immediate action. Shows the selected entry's points; older entries collapse under a native `<details>`/`<summary>`; footer links to `GITHUB_RELEASES_URL` (`target="_blank"`, `rel="noopener noreferrer"`). Renders nothing if `selectWhatsNewEntry()` returns `undefined`. On mount, fires `acknowledgeWhatsNew` (fire-and-forget, `sendMessageWithTimeout`) to clear the badge — idempotent, safe even with nothing pending.
- **Badge logic** (`src/background/whats-new-badge.ts`): `chrome.runtime.onInstalled` (`reason === 'update'` only — `background.ts` never calls `markWhatsNewOnUpdate()` for `'install'`, so a fresh install never gets a badge) marks `chrome.storage.local[WHATS_NEW_STORAGE_KEY]` with the current version, but only if `WHATS_NEW_ENTRIES` actually has a matching entry (see the release-process note above). `acknowledgeWhatsNew()` (message-router.ts, called from the popup mount effect) clears it.
- **Badge precedence (3-way): rebuild-advisory > update-manager > whats-new.** `resolveActiveBadge()` in `whats-new-badge.ts` is the single source of truth for this ordering (also exercised directly by an 8-case table test in `whats-new-badge.test.ts`, one per combination of the three boolean inputs). `rebuild-advisory.ts` is unmodified and still always wins unconditionally; `update-manager.ts` is unmodified and still only checks rebuild-advisory. `whats-new-badge.ts`'s `syncBadge()` is the one new piece that checks **both** other modules' storage state before touching the badge — it sets the `'N'` badge only when `resolveActiveBadge()` returns `'whats-new'`, and only clears the badge (empty text) when it returns `null` (nothing pending anywhere); if it returns `'rebuild'`/`'update'`, whats-new-badge does nothing so it never clobbers a higher-priority badge that's currently showing.
- **No dedicated re-check hooks** (unlike update-manager's 3 re-check points tied to session end / operation completion / SW startup) — adding more re-check plumbing for a purely informational badge wasn't judged worth the extra coupling. Instead, `reassertWhatsNewBadgeOnStartup()` runs once per Service Worker startup (`background.ts`, right after `initUpdateManager()`) and re-evaluates precedence for any still-unseen version — so a suppressed whats-new badge gets promoted the next time the SW restarts after the higher-priority badge resolves, mirroring update-manager's SW-startup re-check without duplicating its session/operation hooks.

---

## Important Reminders

- **Do what has been asked; nothing more, nothing less.**
- **NEVER create files unless they're absolutely necessary for achieving your goal.**
- **ALWAYS prefer editing an existing file to creating a new one.**
- **NEVER proactively create documentation files (\*.md) or README files. Only create documentation files if explicitly requested by the User.**
