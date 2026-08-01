# AGENTS.md — PokerChase HUD

Canonical instructions for all coding agents (Codex CLI, GitHub Codex review,
Claude Code — which loads this through the `CLAUDE.md` import file). This file is the
single source of truth for agent guidance; deep event semantics live in
[docs/api-events.md](docs/api-events.md) and design rationale in
[docs/architecture.md](docs/architecture.md).

> 📅 Last Updated: 2026-08-01

## 📦 Project Overview

Chrome extension providing real-time poker statistics overlay and hand history tracking for PokerChase.

### Key Features

- Real-time HUD with 15+ statistics — compact display mode (default) with click-to-expand full grid, threshold color coding, per-stat tooltips
- Player-type classification icons (🦈💣🪨🐟 quadrant + 🐳 whale override)
- Per-player drill-downs: positional stats and recent hands (switchable 10/25/50/100 rows, dealt-in hands only, a default-on 参加のみ filter, per-street action notation, four-color hole cards in BB-denominated results; hero's own dealt cards always shown, opponents' only at showdown — mucked showdown hands filled from stored replay details when the replay import flag is enabled, flag-only, no popup control)
- Pre-game hero stats (career-to-date panel before the first deal)
- Busted-player dim display (stats persist muted until seat turnover / session end)
- All-player SPR/pot odds display
- Hero hand improvement probabilities
- Hand history log with PokerStars export
- Import/export functionality
- Game type / table size (full/4p/3p/HU) / hand count filtering
- Cloud backup with automatic sync to Firebase
- Manual sync controls (upload/download) for cloud storage
- Forced update (auto-apply between games + remote min-version gate) and per-version GitHub Release links
- Dark/light themed popup
- BigQuery integration for data analysis

### Technical Stack

- **Extension**: Chrome Manifest V3
- **Frontend**: React 19 + TypeScript
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
  - Runs from pushes to `main`; `workflow_dispatch` can also rerun the workflow
  - A created release builds and uploads both ZIP and signed CRX artifacts
  - Protected main branch with CODEOWNERS
  - Workflow details: `.github/workflows/build.yml` (the `release-please` job)

## Working Conventions

- **Language**: respond to the user in Japanese. Which language text is written
  in follows from what the text *is* — normativity and description are kept
  apart deliberately:
  - **Normative text** (rules on what agents/contributors may or must do):
    English, using the uppercase requirement keywords defined below. This
    covers this file, its nested copies under `src/`, and `CONTRIBUTING.md`.
    Note the rule/fact split: the Code Review Rules tell reviewers to verify
    against `docs/api-events.md`, but that reference does not make docs/
    normative — the rule itself lives here (English), while the referenced
    document records the facts the rule points at (Japanese).
  - **Factual description** (what the system and the PokerChase server actually
    do, and why — `README.md`, `docs/` generally): Japanese.
  - **User-facing text** (UI strings, stat `helpText`, GitHub Release bodies):
    Japanese. Existing English UI strings (e.g. `Waiting for Hand...`,
    `No Data`) are exempt until the string itself is next edited — do not
    batch-translate them as a side effect of unrelated changes.
  - **Code comments**: Japanese (see CONTRIBUTING.md "Code Style"). Existing
    comments — in either language — need not be retroactively rewritten. A new
    or edited comment stating an invariant or requirement embeds the
    applicable uppercase keyword defined below.
  For an existing file, **match the language the file already uses** — a
  blanket "docs are English" rule stopped describing this repo once `README.md`
  was deliberately rewritten in Japanese (#302), and reviewers keep flagging
  Japanese additions to Japanese files because of it. Currently English: this
  file (and its nested copies), `CONTRIBUTING.md`, `PRIVACY.md`,
  `e2e/README.md`, `docs/file-organization.md`, `docs/observability.md`.
  Currently Japanese: `README.md`, `docs/api-events.md`,
  `docs/api-event-examples.md` (its bulk is ASCII JSON payloads, but the prose
  is Japanese), `docs/architecture.md`, `docs/hand-analysis.md`,
  `docs/pokerstars-export.md`, `docs/firebase-setup.md`,
  `docs/battle-type-coverage-audit.md`, `docs/chrome-web-store-release.md`,
  `docs/replay-api.md`.
  A file whose current language does not match its category above (e.g.
  `PRIVACY.md`: user-facing but English today) keeps its current language until
  it is deliberately rewritten as a whole — do not mix languages within one
  file. A new file takes the language of its category.
- **Commits**: Conventional Commits (common scopes: `hud`, `stats`, `ui`, `api`, `build`; breaking changes via `feat!` / `BREAKING CHANGE:`). Write the subject and body prose in Japanese — commit messages reach users through the Release-Please changelog and GitHub Release bodies, and user-facing text is Japanese (see Language above). The machine-parsed tokens stay English/ASCII: type, scope (`feat(ui):` …), and the `BREAKING CHANGE:` footer keyword.
- **Tests**: Jest, co-located with sources (`foo.ts` → `foo.test.ts`); jest roots are `src/` and `e2e/` (live-browser scenarios under `e2e/scenarios/` are separate from Jest/CI). Run `npm run test` and `npm run typecheck` before finishing a change; changes touching entity derivation or statistics additionally run `npm run verify-stats -- <file.ndjson>` (see CONTRIBUTING.md). A test that constructs a `PokerChaseService` MUST wrap it in `trackServiceForTeardown()` (`src/utils/test-service-teardown.ts`) — an uncancelled 500ms debounced `persistState()` timer leaks the defunct instance's state into a later test through the shared `chrome.storage.local` mock (CONTRIBUTING.md "Test conventions").
- **Service Worker code** (`src/background/`): no `window`; global timer functions only; assume the SW can die at any await (MV3 lifecycle).
- **Code review requests** (2026-08-01): codex-connector's automatic per-push
  review is disabled for this repository — a review fires only on an explicit
  `@codex review` mention. A non-trivial PR MUST get such a review before
  merge. You MUST NOT mention the same head twice: batch all fixes for a
  review round into one push, then re-mention the new head if another round
  is needed. Each review consumes the shared Codex weekly quota (measured
  ≈0.6% per review), so per-push or per-finding fix→push→review loops MUST
  NOT be run against this repository; automated review-responders (auto-fix
  style) SHOULD batch a whole round before pushing. While waiting for a
  review reply (typically 2–11 min), do not busy-poll with model turns — use
  a single bounded shell wait.
- **Docs**: prefer updating existing documents; keep this file and docs/ in sync with behavior changes you ship.

### Requirement Keywords (RFC 2119)

The normative documents of this repo (this file, its nested copies under
`src/`, and `CONTRIBUTING.md`) use the key words MUST, MUST NOT, SHOULD,
SHOULD NOT, and MAY as described in RFC 2119 / RFC 8174: they carry their
requirement-level meaning **only when written in UPPERCASE**. How to read and
write rules here:

- **MUST / MUST NOT** mark absolute requirements and prohibitions — the things
  code review blocks on.
- **SHOULD / SHOULD NOT** mark strong defaults; a change MAY deviate with a
  stated reason.
- **MAY** marks genuinely optional behavior.
- Lowercase "never" / "always" (and similar) in descriptive prose state how the
  system in fact behaves ("the resolver never infers lifecycle order"), not a
  requirement. New prohibitions MUST be written as MUST NOT, not as a lowercase
  "never".
- Plain imperative sentences ("Do not add another effect…", "Use
  `processInChunks()`") remain binding instructions; the keywords exist to make
  the requirement level explicit wherever "is this a rule or a description?"
  could otherwise be ambiguous.
- Japanese documents under `docs/` are descriptive, not normative — rules that
  gate changes or review live here and in `CONTRIBUTING.md` (see Language
  above). Japanese code comments stating an invariant embed the uppercase
  keyword (see CONTRIBUTING.md "Code Style").

Operational prohibitions that were historically stated only in docs/ are
anchored here so the descriptive status of docs/ does not demote them; the
procedures and rationale stay in the linked documents:

- Telemetry MUST NOT attach raw API events, player names, account IDs, chat
  text, Firebase document paths, auth objects, or tokens to Sentry; the
  schema-validation snapshot MUST be produced by `buildSchemaDiagnostic`
  (details and verification: `docs/observability.md`).
- The Sentry ingest origin MUST stay in `optional_host_permissions` — moving
  it to required `host_permissions` can disable existing installs until users
  re-approve the permission (`docs/chrome-web-store-release.md`).
- A telemetry-enabled release MUST complete the disclosure procedure in
  `docs/chrome-web-store-release.md` before submission (store listing /
  privacy-policy / release-notes updates).
- The CRX signing key MUST NOT be stored in the repository or in a Google
  account; handle and back it up per `docs/chrome-web-store-release.md`
  "Signing key".
- Raw event payloads or query output that may contain identifiers (display
  names, `UserId`, `SeatUserIds`, observer/session/auth IDs, received
  timestamps) MUST NOT be pasted into issues, PRs, chat, or shared logs —
  share only partial excerpts anonymized per `docs/api-event-examples.md`'s
  掲載・匿名化方針.
- `SENTRY_AUTH_TOKEN` is a build secret and MUST NOT be committed
  (`docs/observability.md`).

### Build & Tool Commands

- `npm run build` - Production build
- `npm run pack:crx` - Package a signed CRX (requires a signing key)
- `npm run mockup` - Serve deterministic UI mockups
- `npm run typecheck` - TypeScript validation
- `npm run test` - Run test suite
- `npm run postbuild` - Create `extension.zip` (also runs automatically after `npm run build`)
- `npm run build:e2e` - Build the gitignored localhost E2E extension variant
- `npm run e2e:smoke` / `npm run e2e:playerid` - Run local real-browser scenarios (not CI jobs)
- `npm run e2e -- <command>` - Drive the persistent E2E browser CLI; see `e2e/README.md`
- `npm run validate-schema` - Validate API events in NDJSON files
- `npm run schema-diff` - Detect API schema changes (additions/removals) in NDJSON files
- `npm run verify-stats -- <file.ndjson>` - Cross-check stats pipeline output against an independent oracle
- `npm run firebase:deploy` / `firebase:deploy:rules` / `firebase:deploy:indexes` / `firebase:emulators` - Firestore deployment & local emulator

Release management: Release-Please runs from pushes to `main` (`.github/workflows/build.yml`, the `release-please` job); a created release builds and uploads ZIP + signed CRX. Keep each published GitHub Release user-facing: begin the body with a concise Japanese summary and main updates, then retain the generated PR/commit list under a later `技術的な変更一覧` section. Release-Please's own body is technical-only, so this rewrite is a manual step — the procedure (timing, template, `gh release edit`) is in [docs/chrome-web-store-release.md](docs/chrome-web-store-release.md#release-notes).

### Incident Diagnosis Practices

Learned from the 2026-07 season-3 silent-drop incident (a PokerChase payload change silently broke the `EVT_SESSION_RESULTS`/309 schema and stopped auto-sync for ~2 months — see "Raw Event Lake" below and the `AutoSyncService.onNewSessionStart()` fallback under "Cloud Sync & Firebase Integration") — apply when diagnosing missing/inconsistent data:

- **Declare observability**: any claimed mechanism ("X stopped arriving", "the game changed Y") MUST state where in the causal chain the evidence sits and which rival hypotheses it CANNOT distinguish. Storage tiers differ: local IndexedDB (`apiEvents`) and its exports are the Raw Event Lake — every event with a numeric `timestamp`+`ApiTypeId` is stored regardless of Zod validation (see "Raw Event Lake" below), so a gap there is real evidence of non-arrival at the client. Only the cloud path (Firestore/BQ) is filtered to validation-passing application events before upload, so a gap in Firestore/BQ alone cannot distinguish "never arrived" from "arrived locally but failed validation/wasn't application-typed" — check the local Lake before drawing conclusions from cloud-only data.
- **Prefer direct observation over inference**: before concluding from stored data, check whether the boundary can be observed directly (service-worker console, a single live session capture, packet-level logs). One console log settled in minutes what hours of stored-data inference could not.
- Write mechanisms as falsifiable predictions and check them; have a second pass with a DIFFERENT observation channel attempt to refute a mechanism before documenting it as fact.

## Code Review Rules

### Documented protocol gaps are normal — verify against docs/api-events.md before flagging

- Before flagging a "missing", "skipped", or "inconsistent" event sequence as a
  defect — or suggesting a strict continuity / sequence-completeness check —
  confirm the shape is not one of the server's documented behaviors in
  [docs/api-events.md](docs/api-events.md). Known-normal shapes include: no BB
  `EVT_ACTION` when action is skipped (31.9% of real hands), `EVT_DEAL_ROUND`
  omitted entirely for all-in runouts (board arrives in
  `EVT_HAND_RESULTS.CommunityCards`), no FOLD event on timeout, `EVT_DEAL`
  without a `Player` field in spectator mode, and absent `EVT_SESSION_DETAILS`.
- Why it matters here: a past "fix" that enforced `NextActionSeat` continuity
  silently destroyed 778 valid hands. Conversely, the server's event **order is
  causally consistent** (poker is a strongly consistent game; the client
  intercepts the same stream the game itself renders from) — so proposals to
  reconstruct or defend against out-of-order *arrival* add complexity for a
  condition that cannot occur. Observed misordering in exports has been an
  export-side sorting artifact, not an arrival property.
- Safe path: handle documented shapes explicitly (see `getMissingBBCheck`, the
  FLOP-phase synthesis for all-in runouts) and cite the relevant
  docs/api-events.md section. A genuinely new payload variant is captured as
  evidence (`npm run schema-diff`) and the schema widened — it MUST NOT be
  rejected at ingestion.

### Raw Event Lake: validation gates pipelines, never storage or sync progress

- Flag any change where schema/Zod validation decides whether a raw WebSocket
  event is **stored**, or where a sync/export cursor can permanently advance
  past an application-typed row that currently fails to parse.
- Why it matters here: a PokerChase payload change once broke one event's
  schema and the then-current code discarded those events before storage —
  six months of session results were unrecoverable, and auto-sync silently
  stopped. The Lake (`apiEvents`) is the recovery mechanism: rebuild
  re-validates stored raw rows against the *current* schema, so a later schema
  fix retroactively recovers them — but only if the raw row was stored and the
  sync watermark did not skip it (`syncUnparseableFloor` in
  `auto-sync-service.ts` exists for exactly this).
- Safe path: store anything with a numeric `timestamp`+`ApiTypeId` first;
  validate only at pipeline entry (`filterValidApplicationEvents()`);
  unparseable application-typed rows MUST be treated as recoverable (hold the
  sync floor), never as noise.

### Derived data changes need dual-pipeline parity and loss-proof rewrites

- Flag (a) changes to hand/phase/action derivation or statistics that touch
  only one of `entity-converter.ts` / `write-entity-stream.ts`; (b) changes to
  write-time derivation without a `REBUILD_ADVISORY_VERSION` bump; (c)
  destructive operations on derived tables (clear / delete-then-put) that can
  fail midway and leave *less* derived data than before the operation.
- Why it matters here: live play and rebuild/import MUST produce identical
  entities (`src/cross-path-parity.test.ts` and `npm run verify-stats` guard
  this; a real regression shipped when only one path was updated). A rebuild
  that cleared tables before conversion could wipe all derived data on an
  mid-rebuild failure — strictly worse than the staleness it fixed.
- Safe path: mirror derivation changes in both pipelines and run
  `npm run verify-stats`; bump the advisory version for already-recorded data;
  commit destructive rewrites atomically (single Dexie rw transaction or
  staging swap) so any failure preserves the prior state, and assert the end
  state deep-equals a from-scratch rebuild. Repair paths MUST NOT delete raw
  `apiEvents` rows.

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
    - Auto sync after a 100+ new-event backlog at session end, with session start as the fallback trigger (upload only)
    - Upload: Only events newer than cloud's latest timestamp
    - Download: Cloud as complete source of truth
    - Manual sync controls for user-initiated operations
12. **Operation Exclusivity**: Only one long-running operation (export/import/rebuild) at a time, enforced in background.ts via `currentOperationState`
13. **Optimistic UI + Server Guard**: Popup sets state immediately on click (responsive UX), background validates and rejects if busy (correctness)
14. **Cache-First Rendering**: Frequently needed state (Firebase auth) cached in `chrome.storage.local` for instant popup rendering
15. **Rebuild Advisory Versioning**: Bump `REBUILD_ADVISORY_VERSION` (`src/constants/database.ts`) whenever a change alters write-time entity derivation for already-recorded data, so existing users get prompted (badge/notification/popup banner via `src/background/rebuild-advisory.ts`) to run データ再構築 after updating (version 2, 2026-07: the WTSD/WWSF DEAL_ROUND-omission FLOP-phase synthesis fix described under "Confirmed Statistical Definitions" below; version 7, 2026-08: the street-attribution and Ring mid-hand-rebuy derivation fixes described under "Confirmed Statistical Definitions" and "Recent hands drill-down" below)
16. **Raw Event Lake**: `apiEvents` is the raw wire log — any event with a numeric `timestamp`+`ApiTypeId` is stored, independent of whether it parses under the current Zod schema or is an application type. Validation gates only the real-time pipeline (streams/stats/entity generation), never storage. This is what makes データ再構築 an actual recovery path after a PokerChase payload change breaks a schema: rebuild re-validates every stored raw row against the *current* schema, so a later schema fix retroactively recovers rows that failed to parse when first received — no separate promotion mechanism needed. See "ApiEvent Architecture" and `docs/architecture.md` for the full rationale and history.
17. **Synthetic Lake events (private ApiTypeId range)**: a record the extension itself produces — not received from PokerChase — is stored in `apiEvents` under an ApiTypeId in the private 90000 range (currently only `ApiType.REPLAY_HAND_DETAIL` = 90001, the opt-in replay-detail import). Such an event MUST be an application event for storage/sync purposes, so that NDJSON export/import, Firestore incremental sync and downstream ingestion carry it with no changes to those paths; and it MUST stay invisible to `EntityConverter` / `WriteEntityStream` / statistics / `verify-stats`, which dispatch on known game ApiTypeIds only. That invisibility is behavior, not an accident of `switch` fall-through — it is pinned by `src/replay/synthetic-event-invisibility.test.ts`, and a new synthetic type MUST extend that test. Credentials (a rotating `session` token, `requestKey`) MUST NOT appear in a synthetic event or in any table it is projected into.
18. **Forced Update (auto-apply + remote kill switch, sola承認)**: `src/background/update-manager.ts` auto-applies a downloaded extension update (`chrome.runtime.reload()`) as soon as it's SAFE, and `src/services/min-version-gate.ts` can remotely disable cloud sync on old versions. See "Forced Update" under Cloud Sync & Firebase Integration for the full safe-window definition, badge precedence, and fail-open semantics.

### Data Flow

#### Real-time Processing

```
WebSocket Events (from content_script)
    │
    ├─► Database (content dedup + sequenced apiEvents add) ─── Persistent storage
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
- **Duplicate Prevention**: reconnect resends are identified by canonical payload content (ignoring storage-only `sequence`), not by timestamp+ApiTypeId alone. Distinct payloads sharing the same millisecond and type are both retained.

#### Import Processing

```
NDJSON File (.ndjson)
    ↓
Chunk Processing
    ├─► Indexed content dedup within each timestamp+ApiTypeId group
    ├─► Raw Event Storage: every line with numeric timestamp+ApiTypeId is
    │   bulkAdd'ed to apiEvents (the Lake), regardless of Zod validity
    └─► Valid Application Events Collection (subset that also parses AND
        isApplicationApiEvent — tracked only for rows confirmed stored)
         ↓
    DB was empty before this import?
    ├─► YES: EntityConverter (direct generation, fed only the new
    │   valid-application events) → Bulk Database Insert (bulkPut) into
    │   hands/phases/actions → Statistics Refresh (batch mode)
    └─► NO, and ≥1 new row was actually stored: full rebuild
        (`performFullRebuild`, the same path `rebuildAllData` / the
        popup's "データ再構築" button uses) over the entire apiEvents
        Lake — clears hands/phases/actions and regenerates them from
        scratch. No new rows stored (pure-duplicate import) → nothing to
        do, existing derived data is already consistent.
```

**Why a full rebuild on non-empty-DB imports:** an import into a non-empty
DB can partially overlap existing rows — e.g. the DB already has a hand's
DEAL and RESULTS but is missing the middle ACTIONs, and the import brings
those missing ACTIONs. Feeding only the *new* events to `EntityConverter`
can't reconstruct that hand: `EntityConverter` tracks hand boundaries via
local state within a single call and never sees the already-stored
DEAL/RESULTS, so the hand — and everything derived from it (stats) — stays
silently stale. An incremental "repair only the affected range" approach
was attempted (PR #203) and abandoned after 11 review rounds failed to make
it converge — it ends up re-implementing full-rebuild semantics piecemeal.
Running the already-trusted full rebuild instead is simple, trivially
reviewable, and guarantees the post-import state is byte-identical to what
manually clicking "データ再構築" would produce. The tradeoff is import time
on large DBs (bounded, local work; import is a rare operation).

**Import Optimizations:**

- Designed for processing tens of thousands of records
- **Popup-safe import UI**: the action popup never reads or transfers the
  selected file. Its import button opens (or focuses, without duplicating) the
  extension-owned `dist/index.html?mode=import` tab, and that long-lived page
  owns file selection plus the 5 MiB chunk transfer. Closing the action popup
  therefore cannot abandon an import. `getOperationState` distinguishes file
  transfer, raw-row processing, and an import-origin post-import rebuild; the
  terminal success/error summary is also stored in
  `chrome.storage.local.lastImportResult` so either UI can restore the result
  after being closed or reloaded. A transfer error sends an idempotent
  `importDataCancel` message so the in-memory chunk session releases its
  operation slot immediately; once `importDataProcess` detaches the complete
  session, the same message is a no-op and cannot interrupt storage/rebuild.
- Batch mode disables real-time updates during import
- Direct entity conversion (empty-DB path) bypasses stream overhead
- Legacy exports without `sequence` are assigned a per-timestamp/type sequence during import; re-importing the same payload is content-deduplicated against both existing and earlier rows in the same chunk
- Storage and entity generation are decoupled: a line that fails to parse (or
  is a known non-application type) is still stored raw — it just doesn't
  reach `EntityConverter`/rebuild. See "Raw Event Lake" (Design Principles #16).
- A failed post-import rebuild surfaces as an import error (not a silent
  success) — the raw rows already committed to the Lake are kept as-is.

**Critical Design Constraints (learned 2026-03):**

> **Data model & event edge cases** are consolidated in [docs/api-events.md](docs/api-events.md) — see "Data Constraints & Edge Cases", "Field Relationships", and "Enum Reference" sections.

- **EntityConverter state**: `convertEventsToEntities()` tracks hand boundaries via internal local variables (`currentHandEvents`). It MUST NOT be called in chunks — a hand spanning chunk boundaries will be lost. All events MUST be passed in a single call.
- **EntityConverter/HandLogProcessor never see raw, unvalidated rows**: both read required fields (e.g. `EVT_DEAL.Game.SmallBlind`) via unguarded `switch (event.ApiTypeId)` dispatch, with no `default:` case protecting against a well-known-ApiTypeId-but-malformed payload. Every call site that reads from `apiEvents` (the raw Lake) preserves complete raw equal-ms groups through replay ordering and only then re-validates: unpaged consumers use `orderAndFilterApplicationEventsForReplay()`; `AutoSyncService.rebuildLocalEntities` receives already-ordered raw chunks from `processInReplayChunks()` before calling `filterValidApplicationEvents()`. This re-validation on every rebuild is also the *entire* recovery mechanism for a PokerChase schema break — a later schema fix makes previously-unparseable rows parse on the next rebuild automatically, no promotion step required.
- **Dexie Collection reuse**: `.offset(n).limit(m)` on a single, already-built Collection object is NOT safe pagination -- Dexie Collections accumulate query modifiers instead of replacing them, so a second `.offset()/.limit()` call on the SAME Collection stacks on top of the first rather than re-querying (a prior version of `processInChunks()` did exactly this and silently only ever processed the first chunk). `processInChunks()` (`src/utils/database-utils.ts`) now takes a `Dexie.Table` and issues a fresh query per chunk, cursor-pagination style: `where('[timestamp+ApiTypeId+sequence]').above(lastKey).limit(N)`. Any new caller MUST pass the Table, not a pre-built Collection, and MUST retain all three cursor components across pages.
- **Equal-millisecond replay**: primary/cloud identity stays `[timestamp+ApiTypeId+sequence]`. Stateful readers use `processInReplayChunks()` or `orderAndFilterApplicationEventsForReplay()`, holding equal-ms groups across primary-key page boundaries. Only an isolated two-event snapshot/action pair proven by exact phase/actor/stack/Pot deltas may be reversed; compound groups stay entirely canonical. The resolver MUST see the complete raw group before Zod/application filtering, or noise removal can turn a compound group into a false pair. It deliberately does not infer session/hand lifecycle order without prior state. Primary-key/NDJSON line order MUST NOT be treated as the original arrival order.
- **Export size limits**: Service Worker → content_script message limit is 64MiB. Data URL limit is ~2MB. Large exports use chunked message passing with Blob-based download in content_script.
- **PokerStars hand history format**: `calls` shows additional call amount (not total bet). `Dealt to` is hero-only. Summary uses `folded on the Flop/Turn/River`. See [docs/pokerstars-export.md](docs/pokerstars-export.md).
- **Side pot handling**: `collected X from main pot` / `from side pot` / `from side pot-N` (PS format). Winner determination uses `HandRanking` with `RewardChip` fallback. Main pot winner may not be eligible for side pots (e.g., ante all-in). Relies on invariant `Pot + sum(SidePot) == sum(RewardChip)`.
- **Ante all-in chip estimation**: When multiple players have `Chip=0, BetChip=0`, `Progress.Pot/SidePot` tier differences are used to reconstruct actual contributions (`buildAnteAllInChipsMap`). `EVT_HAND_RESULTS.RewardChip` resolves correct seat assignment (`fixAnteAllInChips`). Seat index ≠ stack order.
- **BB action skip**: PokerChase skips BB action when all other players are all-in or folded. Measured on the 393,830-event real-data audit: **31.9% of hands (9,979/31,301)** hit this path (e.g. walks) — a mainline case, not a rare edge case. `getMissingBBCheck` inserts `checks` (excluded for `NO_CALL` wins).
- **Winner definition (unified, #97)**: Both pipelines (`EntityConverter` and `WriteEntityStream`) define a hand winner as **contested chips actually won**, not `HandRanking===1` — the latter misses legitimate side-pot winners whose hand wasn't the overall best. `deriveHandSettlement()` (`src/utils/hand-chip-accounting.ts`) resolves this per contribution tier and sets `Hand.winningPlayerIds` from `contestedAward > 0`, i.e. `RewardChip` **minus the uncalled return**. Raw `RewardChip > 0` is *not* the test: `RewardChip` includes a player's own over-bet coming back when nobody could call it, and getting your own chips returned is not winning a portion of the pot. Cross-checking 2,019 hands against the server's own records found 30 hands where the two differ, and the tier-based resolution was correct in all 30. See also `src/entity-converter.ts` and `src/streams/write-entity-stream.ts`.
- **Position derivation (#95)**: Positions are derived from explicit `Game.ButtonSeat`/`SmallBlindSeat`/`BigBlindSeat` via `getPositionMap()` (`src/utils/position-utils.ts`), not by rotating `seatUserIds` — the rotation heuristic mislabeled positions whenever a seat was empty (58% of real hands have at least one empty seat).
- **SHOWDOWN phase gating (#94)**: A SHOWDOWN phase requires **≥2 showdown-participant `RankType`s** (`isShowdownParticipant()` in `src/types/game.ts`: ranks 0-9 or `SHOWDOWN_MUCK`/11), not merely `Results.length > 1` — `NO_CALL`/`FOLD_OPEN` reveals don't count.
- **HandLogExporter batch optimization**: `exportMultipleHands` prefetches all hands and API events in 2 DB queries, then processes in memory. Avoids N+1 query pattern (previously 100 hands = 300+ DB queries). Single-hand `exportHand` retains per-hand DB queries for simplicity.
- **Popup ↔ Background state synchronization**: Long-running operations (export/import/rebuild) track state in `currentOperationState` global variable in background.ts. Popup queries via `getOperationState` on mount to restore UI after close/reopen. Progress messages (`processing` state) MUST also set the active operation state (not just `started`), because popup may miss `started` during close/reopen window.
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
- **ActionDetail Detection**: stat-specific flags derivable from the per-action context MUST be implemented in statistics modules (`detectActionDetails`) for consistency. Structural/outcome-dependent flags are the documented exception — e.g. `ALL_IN` (action normalization) and `RIVER_CALL_WON` (assigned after winner determination) live inside both write pipelines, and such flags MUST stay mirrored across `entity-converter.ts` / `write-entity-stream.ts` (see Code Review Rules)
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
- **Empty Seats**: Show "Waiting for Hand..." in UI -- but only for a seat that has *never* had a player. A seat that drops to `SeatUserIds[i] === -1` after previously holding a real player (bust, MTT table-move-away, SNG退出) does **not** collapse to this state; see "Busted-player dim" below.
- **Busted-player dim** (sola spec, 2026-07): `App.tsx` keeps a per-*display-seat* cache (`dimCacheRef`, keyed by the same post-rotation index `Hud` uses, `seat-${actualSeatIndex}`) of each seat's last live `ExistPlayerStats`. When a fresh lineup shows `-1` at a seat that has a cached entry, `Hud` renders that cached snapshot muted (`opacity: 0.45` on the whole panel + an orange "離席" badge in the header, `HudHeader.tsx`/`Hud.tsx`'s `isDimmed` prop) instead of collapsing to "Waiting for Hand...". Full opacity is restored on hover so drill-down interactions stay comfortable; drill-down panels (positional/recent-hands) keep working off the cached `playerId` regardless. **Seat turnover is immediate and cannot be masked by the cache**: any lineup entry with a real (non `-1`) `playerId` always overwrites that seat's cache entry outright -- covers a brand-new player taking the vacated seat (MTT/cash reseating) and the same player returning (rebuy/reconnect) identically, per `SeatUserIds` alone (no cross-hand identity inference). `content_script.ts` dispatches a local `PokerChaseSessionEndEvent` window event the instant it observes a raw `EVT_SESSION_RESULTS` (no new background↔content_script channel -- it already sees 309 firsthand before forwarding to the service worker); `App.tsx` subscribes and clears every non-hero seat (dim cache included) back to empty on it, leaving the hero panel (seat 0) untouched (pre-game career-stats persistence, see below, is unaffected). Import/batch-refresh lineups (`latestStats` chrome message) bypass the dim cache/mute state entirely -- they're a one-shot DB recompute, not the live per-hand pipeline.
- **Pre-game hero stats**: The hero's own panel (always UI seat 0) renders immediately on HUD mount, before the session's first `EVT_DEAL`, if the hero's identity is already known (`service.playerId` persisted in `chrome.storage.local`, see Service State Persistence). `content_script.ts`'s `mountApp()` sends `{ action: 'requestLatestStats', preGame: true }`; `getLatestSessionStats()` (`background/import-export.ts`) computes career-to-date stats for a hero-only lineup via `ReadEntityStream.calcStats()` — the exact function the live pipeline uses, respecting the active battleType/tableSize/handLimit filters — and pads the other 5 seats with the same `{ playerId: -1 }` empty-seat sentinel `App.tsx`'s default state uses, so it's the same 6-element shape `App.tsx` always keys panels by (`seat-${actualSeatIndex}`, 0-5). No extra "career stats" label: the existing HAND count already communicates it's not a single-hand snapshot, same as any other HUD panel. When the real `EVT_DEAL` arrives, the live broadcast simply replaces `stats` state via the same seat-0 key — no remount, no duplicate panel (seamless takeover). The `preGame: true` flag matters: it's what lets `getLatestSessionStats()` skip its pre-existing "always return `[]`" behavior *only* for this mount-triggered call — the older post-import `refreshStats` round-trip (`preGame` omitted) keeps returning `[]` unconditionally, since import completion already triggers its own real recompute+broadcast moments earlier and enabling the fallback there too would risk a stale hero-only response arriving second and clobbering the fresher full lineup. If `service.playerId` isn't known in memory yet (e.g. a freshly-loaded unpacked extension instance, or persisted state restored before any live `EVT_DEAL` this browser session), `getLatestSessionStats()` first tries `findLatestPlayerDealEvent(db)` — the same DB-recovery derivation `PokerChaseService.recalculateAllStats()` uses on batch-mode exit — and assigns the recovered id through the `service.playerId` setter (persisting it via the normal debounced save) before falling back to a silent no-op only if the DB has no hero deal event either.
- **Chrome Extension**: Work within Manifest V3 constraints
- **HUD display modes** (#143, `UIConfig.hudDisplayMode: 'full' | 'compact'`, default `'compact'`): `'compact'` (`CompactStatDisplay.tsx`) shows one classic-HUD line (`VPIP/PFR/3B (HAND)`, rounded integers) plus a secondary AF/CB/STL line, suppressing zero-opportunity secondary stats instead of rendering `'-'`. `'full'` (`StatDisplay.tsx`) is the existing 16-stat grid, unchanged. The popup labels the two 簡易/詳細 (not コンパクト/フル) so both words are two characters, matching 非表示/表示 in the shared fixed-width toggle beside it (`toggleGroupStyles.ts`); the stored values are still `'compact' | 'full'`. Clicking the compact stat body toggles the full grid inline for that player (local per-`Hud`-instance state, so multiple panels can be expanded independently); the click handler `stopPropagation()`s so it doesn't trigger the HUD's click-to-copy or the `#128` positional drill-down chevron. Existing `uiConfig` missing these keys (pre-#143) resolve to the new defaults via the `{...DEFAULT_UI_CONFIG, ...stored}` merge in both `App.tsx` and `Popup.tsx`.
- **HUD color coding** (#143, always on -- the `UIConfig.hudColorCoding` opt-out was removed because threshold coloring is HUD legibility, not a taste setting): threshold-based value coloring for VPIP/PFR/3bet/AF in both display modes, data-driven in `src/components/hud/statColorRules.ts` (`STAT_COLOR_RULES`). n-gated: a stat is only colored once its own `[numerator, denominator]` has `denominator >= 20`; below that it keeps the existing dimmed low-confidence gray (`#888888`).
- **Stat tooltips** (#143, `src/components/hud/statTooltip.ts`): every stat cell (compact segments and full-grid rows) gets a native `title` composed of a base line — the stat's dynamic `StatDefinition.tooltip(context)` (#130, e.g. `vpipF`'s per-layer breakdown) if defined, else `"{name}: {value (num/den)}"` — followed by `StatDefinition.helpText`, a static one-line Japanese explanation defined per stat in `src/stats/core/*.ts`.
- **Player-type classification icon** (HM-style auto-rate, `src/components/hud/playerTypeRules.ts` → `classifyPlayerType`, rendered by `PlayerTypeIcons.tsx` at the HUD header's left edge — immediately before the player name, `HudHeader.tsx`'s first child, `flexShrink: 0` so a long name truncates instead of squashing the icon — both display modes): a single emoji + native `title` tooltip (real numbers, Japanese) replacing the old decorative 🐟/🦈 placeholder pair. Data-driven thresholds (`PLAYER_TYPE_THRESHOLDS`), same tuning philosophy as `statColorRules.ts`:
  - **Quadrant** (VPIP × AF, boundaries inclusive on the loose/aggressive side): 🦈 TAG (tight+aggressive) / 💣 LAG (loose+aggressive) / 🪨 ニット (tight+passive) / 🐟 フィッシュ (loose+passive). Tight `< 25%` VPIP `≤` loose; passive `< 1.5` AF `≤` aggressive.
  - **🐳 Whale override**: full-table-layer VPIP (`vpipF`, not raw `vpip`) `≥ 50%` overrides the quadrant icon entirely regardless of AF. Uses `vpipF` specifically — not raw `vpip` — because VPIP is structurally inflated at short-handed tables (see the `vpipF` entry below); a player sampled mostly at HU/short tables would otherwise be mislabeled a whale off raw VPIP alone.
  - **n-gates**: no icon at all until `vpip` denominator `≥ 30` (baseline track-record gate). Whale additionally needs its own `vpipF` denominator `≥ 30` and fires on `vpipF` alone even when AF is under-sampled (whale ignores AF by definition). Quadrant classification additionally needs `af` denominator `≥ 20`; if AF's sample is too thin but VPIP's is fine, nothing is shown rather than guessing an unplaceable axis.
  - **Required-stat forcing**: `vpipF` is opt-in (`enabled: false` by default) and would otherwise never reach the classifier for users who haven't turned its HUD row on. `src/stats/compactStats.ts` exports `CLASSIFIER_REQUIRED_STAT_IDS = ['vpip', 'af', 'vpipF']` alongside the existing `COMPACT_REQUIRED_STAT_IDS`; `read-entity-stream.ts` forces the union of both sets into `calculateWithConfig` regardless of the user's `statDisplayConfigs.enabled` flags, same mechanism/rationale as #143's compact-line forcing (widens only what's *calculated*, not what the full grid *displays*).
- **HUD developer badge** (`src/components/hud/DeveloperBadge.tsx`, sola承認): a gold `DEV` text chip + native `title` 「PokerChase HUD 開発者」 rendered immediately to the *right* of the player name, reusing the 離席 badge's chip styling (at 8-10px a text chip is unambiguous where a second emoji would be read as another classification, and the left-edge emoji vocabulary is already spoken for by the player-type icon above). Keyed on `DEVELOPER_PLAYER_IDS`, a hard-coded set of PokerChase `UserId`s — **not** on hero identity, which would badge every user's own seat. Self-gating (renders `null` for everyone else, like `PlayerTypeIcons`), so both header call sites — `HudHeader.tsx` and `Hud.tsx`'s statless "No Data" branch — just drop it in unconditionally; the empty-seat branch has no player and is skipped. Name + badge are bundled in one left flex group because the header row is `space-between` (a bare third child would float to the center); the badge is `flexShrink: 0` so a long name truncates around it. Needs `position: relative` + `zIndex: 1` or `DragHandle`'s overlay eats the hover and the `title` never fires — same fix as `PlayerTypeIcons.tsx`/`PositionalPanelTrigger.tsx`.
- **Recent hands drill-down** (`getRecentHands`, `src/services/recent-hands-service.ts`, `src/components/hud/RecentHandsPanel.tsx` + `RecentHandsPanelTrigger.tsx`): HM3/PT4 "Last Hands" + Hand2Note "recent showdown hole cards" pattern, cloning the `#128` positional drill-down's architecture (indexed `hands`/`actions`/`phases` queries batched by `handId`, 30s cache keyed on `playerId`+filters (NOT `limit` -- see below), chevron trigger next to it in `HudHeader.tsx`, App-level `openPanel: { playerId, kind: 'positional' | 'recentHands' } | null` state making the two drill-downs mutually exclusive). Lists the player's last N hands (default 25, own `limit` param -- independent of `handLimitFilter`, which only bounds the aggregate stats), newest hand-id first. Key design points:
  - **Hole cards: OPPONENTS from the `Hand` entity, HERO from the Lake**: for every player other than hero, visibility is derived entirely from the already-persisted `Hand` entity and never touches `apiEvents` -- `hand.results` (persisted straight from `EVT_HAND_RESULTS.Results` by `write-entity-stream.ts`/`entity-converter.ts`) already carries each result row's `HoleCards`, and the server itself only ever sends valid card indices for cards that were actually shown, so the gate is `isShowdownParticipant(result)` (RankType 0-9 or 11 SHOWDOWN_MUCK) AND the `HoleCards` array actually holding valid values. RankType 10 NO_CALL and 12 FOLD_OPEN never show cards even though the server does send real values for a voluntary post-fold reveal (12) -- for opponents this panel is specifically "recent *showdown* hole cards". **Hero's own row is the deliberate exception** (#353): hero's dealt cards are hero's information from the moment they were dealt, they exist nowhere in the `Hand` entity, and they are read from the Raw Event Lake at read time -- see "Hero's own dealt hole cards" below. Do not "restore" a no-`apiEvents` invariant over that path; the two rules coexist by design and are split on whose cards they are.
  - **Preflop-line taxonomy** (`derivePreflopLine`, full doc comment on `PreflopLine` in `src/types/stats.ts`): a simplified `Open`/`3Bet`/`NBet`/`Limp`/`ColdCall`/`Call`/`Check`/`Walk`/`Fold` label per hand, derived from the player's own PREFLOP actions plus a locally-recomputed `phasePrevBetCount` (same formula as `write-entity-stream.ts`, replayed over a batched `actions.where('handId').anyOf(handIds)` fetch covering all seats -- own actions alone can't tell you what bet count you faced). The label reflects the *last* action taken; if that's a FOLD and there was a preceding line, it gets a `-F` suffix (e.g. `3Bet-F`).
  - **Hand count switcher & cache granularity** (#341): `RECENT_HANDS_LIMIT_OPTIONS` (10/25/50/100, `src/utils/recent-hands-config.ts`) drives a compact switcher in the panel header; the choice persists in `chrome.storage.local` (device-local, like `uiScale` -- `storage.sync` has per-minute write quotas a switcher trivially trips) and every open panel follows it through a `storage.onChanged` subscription. The service always assembles and caches up to `MAX_RECENT_HANDS_LIMIT` entries and satisfies the caller's `limit` by slicing, so the cache key deliberately omits `limit`: switching counts costs no extra DB round-trip and does not fan the cache out into four copies of the same data. The constants live in a leaf module rather than in the service because the content-script panel needs them and MUST NOT pull Dexie/`background/replay-import` into its bundle. No virtualization: 100 rows x 6 cells is a fixed, small DOM (HandLog uses `react-window` because its row count is unbounded); the panel caps its body height and scrolls with a sticky header instead.
  - **Dealt-in only** (`isDealtIn`, #341): a hand is listed only when the player is in `hand.seatUserIds` (the `EVT_DEAL` lineup -- authoritative for "was this player dealt in", per docs/battle-type-coverage-audit.md's bust -> spectator -> rebuy fixture, where the busted seat becomes the `-1` sentinel). This is enforced as an explicit predicate rather than being left to the multi-entry index's equality: `playerId === -1` is the empty-seat sentinel, not a player, and feeding it to the index matches every hand containing a vacant seat -- exactly the post-bust spectator tables that motivated the issue. There is deliberately NO toggle to show non-dealt-in hands: such a row has no position, no cards, no line, and no chip accounting, so the option would only offer empty rows.
  - **Per-street actions with pot-relative sizing** (`derivePostflopLines`, taxonomy on `StreetAction`/`PostflopLines` in `src/types/stats.ts`): each hand carries the player's own FLOP/TURN/RIVER actions as compact per-street notation (`X`/`B`/`C`/`R`/`F`, `!` for an action the pipeline normalized away from `ActionType.ALL_IN` and recorded in `actionDetails`), with a pot-relative percentage appended to `B`/`R` only -- rendered as `XC/B33`, `R120` for overbets, `B75!` for an all-in bet. Street attribution reads `Action.phase`, the authoritative `Progress.Phase` the action event itself carries since #340/#346, so all-in runouts (no `EVT_DEAL_ROUND`) still land on the right street. No extra query: the batched `actions` fetch already covers it.
  - **Bet-size arithmetic — the two WS semantics that make it work** (#354). Both were verified against raw captures rather than assumed, and a change here MUST re-verify rather than reason from the field names:
    1. `Action.bet` (= `EVT_ACTION.BetChip`) is **street-cumulative** and resets at each street boundary. The numerator is therefore an *increment* — `bet` minus the same player's previous `bet` on that street — never the raw cumulative value: using the cumulative amount for a raise double-counts the chips already matched against the opponent's bet.
    2. `Action.pot`/`Action.sidePot` (= `Progress.Pot`/`SidePot`) are **post-action** snapshots that already include the acting player's chips, so `potBefore = pot + ΣsidePot - increment`. Side pots MUST be summed in: all-ins tier the pot and chips move between `Pot` and `SidePot[]`, so `Pot` alone is not the money on the table.
    Evidence: across the two committed raw captures (2026-07-04 and 2026-08-01), restricted to hands satisfying the independent settlement invariant `Pot + ΣSidePot == Σ Results[].RewardChip`, the formula reproduces the preceding event's pot total for **80,758 postflop aggressive actions at 99.995% / 99.998%**; the 2 residual rows are the documented capture-anomaly class (docs/api-events.md「クロージングコールの欠落」). Measuring this *without* the invariant filter yields a misleading ~73% — the raw multi-tab export interleaves tables, so any bet-sizing verification MUST isolate well-formed hands first.
  - **Preflop sizing is tooltip-only** (`derivePreflopRaiseTo`, #354): the player's last aggressive preflop action's raise-TO amount is exposed as `preflopRaiseToBB`/`preflopRaiseToChips` and rendered in the line cell's `title`, not inside the `preflopLine` string. Two reasons: `preflopLine` is a documented, separately-tested taxonomy whose `-F` suffix (`'Open-F'`, `'3Bet-F'`) leaves no natural slot for a number, and the line column's width is already set by its widest label (`ColdCall`). Preflop `Action.bet` is the street-cumulative total, which for preflop *is* the raise-to (blinds are already inside it).
  - **Participation filter** (`isVoluntaryParticipation`, #353): a default-ON 「参加のみ」 toggle next to the row-count switcher drops hands with no voluntary chip investment. It keys off the already-computed `preflopLine` rather than re-deriving VPIP from actions, and excludes exactly `'Fold'` (the player's FIRST preflop action was a fold — anything after a line becomes `'Open-F'` etc. and stays) and `'Walk'`. `'Check'` deliberately stays: a BB option-check is VPIP-negative but the hand still reaches a flop and may have real postflop play, and dropping it would hide hands the player actually played. `preflopLine === null` (missing player data) stays too — undecidable, so never guessed away. It also requires the hand to have actually ended there for that player (`!sawFlop && !wentToShowdown`): `'Walk'` only means "no BB `EVT_ACTION`", and the server omits the BB's check in 31.9% of real hands and sends no action for a BB who is all-in from the forced post — label alone would drop hands that reached a board. The filter runs **before** the row-count slice, over a cache assembled at `RECENT_HANDS_ASSEMBLY_LIMIT` (3x the display cap) rather than the display cap itself — assembling only 100 would make "100 + 参加のみ" unsatisfiable by construction. Still one batched query per table and the cache key is unchanged (the cache is always stored unfiltered); if even that window cannot fill the count, the panel returns what it has.
  - **Hero's own dealt hole cards** (`readHeroDealtHoleCardsByHandId`, #353): `hand.results[].HoleCards` only carries cards the server *published* (showdown), so hero's own hand showed blank on every non-showdown row. Hero's dealt cards exist only in `EVT_DEAL.Player.HoleCards`, which the `Hand` entity does not persist — so the panel reads them from the Raw Event Lake at read time (`holeCardsSource: 'dealt'`). Read-time rather than a new entity field: adding `heroHoleCards` to `Hand` would be a derivation change needing a `REBUILD_ADVISORY_VERSION` bump plus a full rebuild, whereas the Lake read works retroactively for every already-recorded hand. Correlation is `hand.approxTimestamp` (which *is* the `EVT_DEAL` timestamp in both pipelines) through the `[ApiTypeId+timestamp]` index in one batched `anyOf`, accepted only when `SeatUserIds` matches the hand's lineup exactly (same-millisecond deals from another table must not cross-contaminate). Gated on `service.playerId === playerId`, snapshotted **once before the first await** so the cache key and the Lake read cannot disagree if hero identity changes mid-fetch; and the deal's own observer (`SeatUserIds[Player.SeatIndex]`) MUST be re-checked against the target player, because after an account switch — or when another account's Lake was imported — the historical observer is not necessarily today's hero. **The Lake read MUST NOT gate on whole-event Zod validation** (`isApiEventType`) — that is a pipeline-entry gate, and making display depend on it means one unrelated `EVT_DEAL` schema drift blanks every hole card; only the needed `SeatUserIds`/`Player.HoleCards` shape is checked, per-row. Rows still legitimately blank: hands whose `approxTimestamp` predates that field (need a Lake rebuild), table-move deals (`HoleCards: []`), and opponents' non-showdown hands.
  - **Display conventions** (#353, from sola's DEV-build feedback): no time column (時刻は不要); results are shown in big blinds (`formatNetBigBlinds`, signed one decimal) divided by **that hand's own** `bigBlind`, because SNG/MTT levels escalate and raw chips are not comparable across a list — the raw chip amount stays as the cell's `title` rather than a second column, and a row whose `bigBlind` is unusable falls back to chips instead of being hidden; the F/T/R column uses tabular numerals so the size digits do not make the column width jitter row to row (worst realistic row `B150/R80/B66!` measures ~207px against the table's ~228px budget, and the street cell is the one allowed to wrap rather than be clipped); hole cards use a four-color deck (`suitColor`/`SUIT_COLORS` in `card-utils.ts`, spades default / hearts red / diamonds `#4da6ff` / clubs `#66cc66` — lightened so they hold up on the translucent-black panel).
  - **netChips**: exact signed per-hand chip result for every seat: `grossPayout - totalContribution`, where `grossPayout` is `RewardChip` (including uncalled returns) and `totalContribution = startingStack + grossPayout - finalStack`. `src/utils/hand-chip-accounting.ts` shares the DEAL ante/blind semantics with `HandLogProcessor`, validates the causal DEAL/RESULTS lineup, payout conservation, stack snapshots, and `BattleType`-specific table conservation, and persists `Hand.playerChipAccounting` through both the live writer and Raw Event Lake rebuild converter. The UI renders `+N`, `-N`, and `0`; ambiguous short-ante tiers, incomplete snapshots, legacy hands awaiting rebuild, or inconsistent accounting stay `null`/`-` rather than being estimated. Tournament types (0/1/2/6) require `ΣstartingStack === ΣfinalStack`; Ring types (4/5) allow rake outflow (`ΣfinalStack <= ΣstartingStack`) but reject chip creation. **Ring mid-hand rebuy/add-on** (#339) is the one documented inflow that is not chip creation: `deriveMidHandChipInflow` recovers it per seat from the hand's own snapshots (within a street `Chip + BetChip` is invariant; across a street boundary it drops by exactly that street's last `BetChip`; a final check of the same identity against `EVT_HAND_RESULTS` catches the auto top-up that appears only there), subtracts it from the final stack, and only then applies conservation. Any snapshot DECREASE below that invariant is a fused-buffer/dropped-event signature and makes the whole hand's inflow unknown, keeping conservation strict; the RESULTS pass counts an excess only, never a shortfall. Inflow tolerance is Ring-only — a tournament has no mid-hand top-up, so an increase there stays a corruption signal. Derived-data changes MUST bump `REBUILD_ADVISORY_VERSION` so old hands are rebuilt.

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
- **Service Worker Keepalive**: 25s interval during active games. Armed on `EVT_ENTRY_QUEUED`(201) / `EVT_DEAL`(303, only when the raw `Player` field is present — spectator-mode deals MUST NOT arm it) / `EVT_SESSION_DETAILS`(308); disarmed on `EVT_SESSION_RESULTS`(309) / `EVT_ENTRY_CANCELLED`(203). The same trigger set drives the Service Worker's session-activity tri-state in `event-ingestion.ts` (see Forced Update). Prevents 30s timeout.

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

**Hand-log layout lifecycle**: `HandLog.tsx` owns movement, resizing, scale,
viewport dimensions, async device-layout loading, normalization, and
persistence in one component-local state machine. The machine's concrete
`HandLogLayout` is the only rendered layout source. Every input enters through
`transitionHandLogLayout()`, which keeps a new viewport/scale pending during an
active pointer interaction, rejects layout-load callbacks bound to an older
request or scale, and emits at most one persistence effect from the common
interaction exit. Do not add another effect/ref that mutates or saves hand-log
coordinates outside that transition outlet. **The `reset` action is the one
input that MUST NOT trust the machine's own `environment`**: it carries a
freshly read `readHandLogEnvironment()` and adopts it. Reset exists to rescue a
panel the user cannot find, and a stale cached viewport is one of the ways a
panel gets lost — computing the default *and* the in-viewport clamp from the
same stale value cannot detect the mismatch, so the rescue silently reproduces
it. For the same reason the default position moved to a fixed top-left offset
(`HAND_LOG_DEFAULT_LEFT`/`TOP`) from the former right/bottom-anchored
`viewportWidth - margin - width*scale`: that formula is only ever as correct as
the viewport reading behind it, and a too-large reading put the panel outside
the window (real report: window at half the display, reset made the log vanish,
maximizing revealed it). A constant has no such failure mode at all. It also
landed on the *outermost* point of the coordinate box — the first place to fall
out of view if the reference frame is off — wedged between the bottom seat HUD
panels and the action-button strip. The top-left default does overlap the
game's own menu / SB·BB / ante chrome; that is accepted (sola: the user can
just move it), and at the default scale it still stops short of the seat name
plates, which carry the chip stacks. There is no header bar: the
upper-right grip (16px, `hand-log-move-grip`) is the move handle and the
lower-right corner is resize-only, so the whole panel height belongs to the log
body. The grip is deliberately upper-*right*: it overlays the log body, and a
line's start is always occupied by text while its end is usually blank. Normalization keeps the entire rendered panel inside the viewport on both
axes and applies to loaded, default, reset, external, pointer, and
viewport/scale-driven layouts. Normalization's size clamping is display-only:
it enforces the minimums but never shrinks the stored width/height to fit the
viewport, so merely narrowing the window (or moving the panel) leaves the
user's size intact and restores it when the window grows back. A *resize*
gesture is the one path that does rewrite the stored size — it deliberately
starts from the rendered size and is capped at the scaled viewport, so the
result is WYSIWYG. That rewrite is per-axis and conditional on the rendered
size actually changing: an axis already pinned to its viewport limit (stored
size larger than the viewport, or a viewport too small for the minimum) keeps
its stored value when the gesture cannot move it, so the axis the user did not
drag — and an outward drag with nowhere to grow — cannot silently collapse a
stored size down to the current screen.
Position is always clamped (there is no "display-only" position), and a
viewport dimension that reads as `0` — observed transiently right after a
navigation — suspends only that axis' *upper* bound, never the `0` lower bound,
so a panel cannot vanish or latch off-screen while the viewport is unknown.
Growing past an edge is resolved by the position clamp pulling the panel back
rather than by refusing to grow: the default bottom-right position leaves only
10px of slack, so edge-stopping would make the panel effectively non-resizable.
The container is `border-box` so its rendered footprint equals the clamped
width/height exactly; the log body is that minus `HAND_LOG_BORDER_WIDTH*2`.

**Hand-log row height**: the virtual list positions rows from `getItemSize()`,
so that estimate has to predict CSS wrapping or rows overlap. The whole
calculation runs in **pixels, per grapheme cluster** — never in character
counts, and never per code point. `canvas.measureText()` is called for each
distinct cluster at the actual font/size (cached per `fontSize|cluster`), which
is what makes mixed-width text correct in both directions: the monospace stack
has no Japanese glyphs, so a CJK player name falls back to a ~1 em Japanese font
while ASCII stays ~0.6 em (measured at 8px: `0` = 4.8px, `あ` = 8px) — an
ASCII-derived width under-counts such a line by up to ~1.7×, a row overlap; and
a decomposed cluster (`は` + U+3099) is one rendered glyph, so measuring its
code points separately over-counts it and leaves phantom blank rows. Where
canvas is unavailable (jsdom) the fallback is per cluster too: 0.6 em narrow /
1 em wide / 0 for combining-only clusters, each deliberately the widest
plausible value. Wrapping follows the same rules the CSS does — word
boundaries, `break-word` only for tokens that cannot fit a line by themselves,
hanging trailing spaces, break opportunities between ideographic characters,
and kinsoku (no break after an opening bracket, none before closing brackets or
punctuation) — plus the timestamp prefix's width charged to the first line.

Break opportunity is its own class, **not** "is full width": Chrome breaks
between halfwidth kana (4px) and between emoji (10px), but not around `♠♥♦♣`,
`★`, `→` or `①`. Emoji are matched with `\p{Emoji_Presentation}` —
`\p{Extended_Pictographic}` also matches `♠`, which would shred every card
line — and ideographs with `\p{Ideographic}`, so supplementary-plane kanji
(`𠮷`, `𩸽`) are covered; a BMP-only range list silently demotes them to
narrow non-breaking text. Whitespace is likewise its own class: `\s` is wrong
because it matches NBSP and friends, which CSS never breaks around (`aa<NBSP>bb`
is one word to the browser, verified). The kinsoku sets likewise include ASCII (`:` `,` `)` `(` …), because
`{Japanese name}: raises` — the shape of every action line — puts an ASCII
colon straight after a wide character. All three sets (break opportunities,
line-start kinsoku, line-end kinsoku) were derived by measuring Chrome's
default `line-break: auto`, which notably *does* allow breaking before small
kana and `ー`; adding those would over-count instead. Re-measure against the
browser before changing any of them — the tests encode the measured
expectations, not a specification.

The available width is the log body width, minus `getScrollbarSize()`, minus
`EntryRow`'s horizontal padding. Both subtractions are load-bearing: `EntryRow`
pins `boxSizing: border-box` so host-page CSS cannot move the padding boundary,
and the `List` pins `scrollbarGutter: stable` so a non-overlay scrollbar
(Windows/Linux) narrows the row by the same amount whether or not the log is
currently scrolling. That width is re-measured with `getScrollbarSize(true)`
whenever `devicePixelRatio` changes (page zoom, monitor move): the scrollbar's
physical width is constant, so its CSS-pixel width — the thing being
subtracted — moves with zoom, and both `getScrollbarSize`'s own module cache
and a mount-time `useMemo` would otherwise pin the first value forever. Derive the width from the *displayed* size, never the
stored one: a viewport narrower than the stored width shrinks only the render,
and that is where the wrapping actually happens. Do not reintroduce a fixed
chars-per-line constant: the panel resizes down to `HAND_LOG_MIN_WIDTH`
(200px), where the original 60-chars-per-line assumption under-counted lines
and rows overlapped. Every input to the wrap calculation MUST stay in
`getItemSize`'s `useCallback` deps — react-window rebuilds its row-bounds cache
only when the `rowHeight` identity changes.

**Popup theming**: `src/components/popup/theme.ts` defines two MUI themes -- `dark-felt` (default look, shares the HUD overlay's dark/gold palette) and `modern-light`. Which one renders is controlled by the `popupTheme` setting (`'auto' | 'dark' | 'light'`, default `'auto'`; テーマ control in `PopupHeader.tsx`, a single icon button that cycles 自動→ライト→ダーク). `'auto'` resolves against the live OS `prefers-color-scheme` via `useMediaQuery` in `Popup.tsx` (`resolvePopupThemeVariant()` in `theme.ts` is the pure resolver, unit-tested independent of the DOM). Persisted to its own `chrome.storage.sync` key (`popupTheme`, see `popup-theme-storage.ts`) -- deliberately **not** a field on `UIConfig`, because `UIScaleSection`/`HudDisplaySection` broadcast every `uiConfig` write to all open game tabs (`chrome.tabs.sendMessage(..., 'updateUIConfig')`) to trigger a HUD re-render; the popup's own chrome has nothing to do with the HUD overlay, so nesting it there would fire that broadcast on every theme change for no reason. `popup.ts` pre-fetches the persisted mode before the first `render()` call so the popup never paints with the wrong theme and then swaps.

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

### Confirmed Statistical Definitions (PT4-aligned, audited 2026-03, re-aligned 2026-07 #115, DEAL_ROUND-omission fix 2026-07, street-attribution fix 2026-08 #340)

These definitions were validated by hand-tracing 22 hands from the integration test suite (2026-03), then cross-checked against PT4/HM3 official documentation and an independent oracle over a 393,830-event real-data capture (2026-07, #115 — see `npm run verify-stats`):

- **Street attribution** (#340, the population every phase-scoped stat below is built on): an action's street comes from that action's own `EVT_ACTION.Progress.Phase`, resolved by the single shared helper `resolveActionPhase` (`src/utils/action-phase.ts`) in both pipelines — never from a counter advanced by `EVT_DEAL_ROUND`. The counter lags whenever 304 rows are stored ahead of the 305 that opens their street (equal-timestamp reconnect bursts order by ApiTypeId, and `orderApiEventsForReplay` only reverses isolated 2-event groups — `docs/api-events.md`), when `EVT_DEAL_ROUND` never arrives, and on fused table-move buffers. **The hand-ending row (`Progress.NextActionSeat === -2`) MUST be excluded from the override**: its `Phase` is pinned to 3 regardless of the real street, so it keeps the running street instead. Real-data measurement (2026-08-01 capture, 40,932 hands / 345,016 actions): 29 hands / 63 actions change street under the fix, while 28,637 hand-ending rows would have been mis-promoted to RIVER without the exclusion.
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
- **Validation gates the pipeline, never storage** (Raw Event Lake — see Design Principles #16 and `docs/architecture.md`): the content-deduplicating raw merge in `src/background/event-ingestion.ts` runs before `parseApiEvent`/`isApplicationApiEvent` and stores anything with a numeric `timestamp`+`ApiTypeId` — non-application events (202/205 keepalive/timer), ApiTypeIds unknown to `apiEventSchemas`, and app-type events that currently fail to parse are all persisted. The same event is only forwarded to `eventLogger`/`handLogStream`/`handAggregateStream`/`realTimeStatsStream` when it *does* parse as a known application event. Any code path that reads raw `apiEvents` rows and feeds them into `EntityConverter` or `HandLogProcessor` (which read required fields like `EVT_DEAL.Game.SmallBlind` without guards) MUST preserve raw group size through replay ordering and re-validate afterward — use `orderAndFilterApplicationEventsForReplay()` for unpaged reads, or `processInReplayChunks()` followed by `filterValidApplicationEvents()` for ordered raw chunks.
- **Cloud sync is application-type-only** (cost decision): `AutoSyncService.syncToCloud()` filters each raw chunk to `isApplicationApiEvent` before upload — non-application noise (202/205 keepalive/timer, or any ApiTypeId outside `ApiTypeValues`) never leaves the device. The upload cursor still advances on the *raw* chunk boundary (not the filtered subset) for these rows, otherwise a chunk that's 100% noise would never advance and the sync loop would refetch it forever.
- **Watermark never advances past a recoverable unparseable row** (PR #142 review r3611258695, fixed in `fix/sync-watermark-unparseable`): an application-typed row that currently fails Zod validation (e.g. a 309 broken by a PokerChase payload change; see the season-3 incident under "Incident Diagnosis Practices") is *not* treated like noise for watermark purposes — `isUnparseableApplicationEvent()` (`src/types/api.ts`) tells them apart by ApiTypeId membership in `ApiTypeValues` alone (not full schema success), since `isApplicationApiEvent` collapses both to `false`. Naively advancing the raw-chunk cursor past such a row is a **permanent loss**, not a delay: once a *later* valid event uploads, Firestore's own max timestamp (`getCloudMaxTimestamp()`) moves past the unparseable row, and every future `.where('timestamp').above(cloudMaxTimestamp)` query excludes it forever — even after a future schema fix makes it parseable, since the raw Lake copy is never re-offered to the query. `AutoSyncService` persists the earliest such row's timestamp in `meta` (`syncUnparseableFloor`) and rewinds each sync's scan floor to just before it until it resolves, re-offering it to `isApplicationApiEvent` (and therefore to upload) on every sync. This can't starve the loop (only rows that structurally *should* eventually parse hold the floor back — known noise still advances immediately) and can't silently lose data (the marker persists across Service Worker restarts and is only cleared once a full scan finds nothing pending). See the tradeoff comment at the top of `AutoSyncService.syncToCloud()` for alternatives considered (never-advance-at-all reintroduces the SPOF-era starvation; uploading unparsed rows as opaque blobs pollutes Firestore's document shape; rebuild-triggered-only re-scan misses the ship-then-sync-before-rebuild race).

### Database Schema

Defined in `src/db/poker-chase-db.ts` (Dexie/IndexedDB). See [docs/architecture.md](docs/architecture.md) for design rationale.

#### Tables (v7)

| Table | Primary Key | Key Indexes | Purpose |
|---|---|---|---|
| `apiEvents` | `[timestamp+ApiTypeId+sequence]` | `[timestamp+ApiTypeId]`, `[ApiTypeId+timestamp]` | Raw WebSocket events — the full Lake (see above), not just application events |
| `hands` | `id` (auto) | `*seatUserIds`, `approxTimestamp` | Processed hand data |
| `phases` | `[handId+phase]` | `handId`, `*seatUserIds` | Per-street state |
| `actions` | `[handId+index]` | `[playerId+phase]`, `[playerId+actionType]`, `*actionDetails` | Player actions with stat markers |
| `meta` | `id` | `updatedAt` | Import status, stats cache, sync state, replay-import queue/status |
| `replayDetails` | `handId` | `fetchedAt` | Replay detail payloads (opt-in replay import; projection of the ApiTypeId 90001 rows in the Lake) |

v3 added composite indexes for player-specific queries. v6 changes the Raw Lake primary key to `[timestamp+ApiTypeId+sequence]`. v7 adds the `replayDetails` store only — no existing store or write-time derivation changes, so `REBUILD_ADVISORY_VERSION` stays put. Since IndexedDB cannot change an object-store primary key in place, v4 copies old rows to a staging store with `sequence: 0`, v5 drops the old store, and v6 recreates/copies it transactionally. Existing rows were already unique under the old key, so this is mechanical and does not change `hands`/`phases`/`actions`; `REBUILD_ADVISORY_VERSION` therefore remains 3.

**Storage growth**: `apiEvents` now also durably stores non-application noise (202/205 keepalive/timer events at roughly the same volume as application events per session — expect apiEvents row count to grow, not just its "useful" subset). IndexedDB quota is browser-managed and generally GB-scale (much larger than `storage.local`'s ~10MB), so this is not expected to be a practical problem. There is currently **no automatic pruning** of `apiEvents`: the existing quota-exceeded handling in `src/services/poker-chase-service.ts` (`cleanupOldStorageData`) and `src/utils/database-utils.ts` (`withTransaction`'s `QuotaExceededError` branch) targets `chrome.storage.local` service-state persistence and IndexedDB transaction errors respectively — neither actively prunes `apiEvents` rows. Users can reset via the popup's "全データ削除" if this ever becomes a real problem; revisit with active pruning only if it does.

### Configuration & Storage

#### Chrome Storage

- **`storage.sync`**: Cross-device preferences (`options`, `uiConfig` excluding
  the device-local `scale`, `handLogConfig`, `popupTheme`). Legacy
  `uiConfig.scale` and `hudPosition_*` values may remain for mixed-version
  compatibility, but current clients do not use synchronized positions.
- **`storage.local`**: Device-local layout (`uiScale`,
  `hudPosition_0`–`hudPosition_5`, and real-time HUD positions
  `hudPosition_100`–`hudPosition_105`, plus `handLogLayout` for the hand-log
  window's pixel `left`/`top`/`width`/`height`) plus service state
  (`pokerChaseServiceState` — playerId, latestEvtDeal, session). Layout access
  is routed through the trusted background via `getDeviceUILayout`,
  `setDeviceUIScale`, `setDeviceHudPosition`, `getDeviceHandLogLayout`,
  `setDeviceHandLogLayout`, and `resetDeviceUILayout`; content scripts do
  not access the restricted local area directly.
- **Layout reset is one operation over every device-local appearance key**:
  the popup's 「位置とサイズをリセット」 (`UIScaleSection.tsx`) sends a single
  `resetDeviceUILayout`, and the background removes `handLogLayout` and every
  `hudPosition_*` key in one `chrome.storage.local.remove` call, then writes
  `uiScale` back to its default in a `set` — a *missing* local `uiScale` means
  "not migrated to device-local" (`getDeviceUILayout`'s `needsScaleMigration`),
  so removing it would re-migrate from the legacy synced value and resurrect
  the pre-reset scale. There is no atomic remove+set in `chrome.storage`, so
  the reachable guarantee is not "both or neither" but **whatever persisted is
  always broadcast**: if the `set` fails after the `remove` succeeded, the
  layout reset is still delivered to open tabs and the response reports the
  failure, so storage and open tabs never disagree and the (idempotent)
  operation can just be retried. Scale is in scope because the button means
  "back to the default look" (sola): leaving a large scale behind returns the
  panels to default positions computed for a size they no longer are, so the
  hand log's default slot above the seat plate stops fitting. Keys come from `HUD_POSITION_STORAGE_KEYS`
  (`ui-config-storage.ts`), built from the valid position ids rather than by
  prefix-scanning `storage.local`, which also holds unrelated keys. Clearing
  storage alone does not move anything on an open tab — neither `HandLog` nor
  `useDraggable` watches storage — so the background also broadcasts one
  `resetUILayout` message that `content_script.ts` fans out into the
  `resetHandLogLayout` and `resetHudPositions` window events those two
  subscribe to. Scale rides its own existing channel
  (`updateDeviceUIScale`) rather than being folded into `resetUILayout`:
  `App.tsx` already owns scale as `uiConfig.scale` and that broadcast is its
  only update path. The popup does not subscribe to either broadcast, so
  `UIScaleSection` resets its own displayed scale from the success response.

#### Config Interfaces

| Interface | Location | Key Fields |
|---|---|---|
| `UIConfig` | `src/types/hand-log.ts` | `displayEnabled`; `scale` (0.5–2.0) is runtime state persisted separately as device-local `uiScale` |
| `HandLogConfig` | `src/types/hand-log.ts` | `enabled`, `maxHands`, `position`, `width`, `height`, `fontSize`, `opacity` |
| `HandLogLayout` | `src/types/hand-log.ts` | Device-local pixel `left`, `top`, `width`, and `height`, persisted as `handLogLayout` |
| `FilterOptions` | `src/types/filters.ts` | `gameTypes` (sng/mtt/ring), `tableSize` (full/4p/3p/hu players-dealt layer, `src/utils/table-size.ts`, missing key = all layers/no filter; popup label "テーブル人数", edited as a **contiguous range** on a two-thumb slider — the layers are ordered by player count and a gap in the middle has no meaning, so per-layer checkboxes could express states no user wants; `src/utils/table-size-range.ts` converts between the range and the stored per-layer booleans and folds a legacy non-contiguous selection into the smallest span covering it), `handLimit`, `statDisplayConfigs` |
| `PopupThemeMode` | `src/components/popup/theme.ts` | `'auto' \| 'dark' \| 'light'` (default `'auto'`), persisted standalone as `popupTheme` (`popup-theme-storage.ts`) — popup-only, not part of `UIConfig`/its all-tabs broadcast |
| `HudPosition` | `src/components/Hud.tsx` | `top`, `left` (percentage) |

#### Data Flow

Synchronized preference edits go from Popup → background →
`chrome.storage.sync`; open extension contexts reconcile from storage changes
or scoped broadcasts. Device-layout reads/writes go from Popup/content script
→ fixed `chrome.runtime` messages → trusted background →
`chrome.storage.local`.

#### Service State Persistence

Key `pokerChaseServiceState` in `storage.local`. Auto-saved with 500ms debounce on setter calls. Restored on Service Worker startup. Handles quota exceeded with automatic cleanup.

- **Hero `playerId` must survive spectator-mode deals** (field report, sola 2026-07-20): `EVT_DEAL.Player` is `undefined` in "観戦モード" (spectator mode — e.g. after the hero busts out of a tournament but the client keeps receiving deal events for other players' tables; see `docs/api-events.md` "EVT_DEAL: Playerフィールドの欠落"). `AggregateEventsStream`'s `EVT_DEAL` case only assigns `service.playerId`/`service.latestEvtDeal` when `event.Player?.SeatIndex !== undefined` — a spectator-mode deal leaves both untouched rather than clobbering them to `undefined`. Before this fix, any such deal near session end wiped the already-known hero identity and persisted the `undefined` through the 500ms debounce, so a reload (Service Worker restart, restoring from `storage.local`) came back with no hero identity and the pre-game hero stats panel (`#158`) didn't render — a plain cloud-download + `rebuildAllData`/`importData` masked the bug because those paths re-derive `playerId` via `findLatestPlayerDealEvent()` (`src/utils/database-utils.ts`), which explicitly filters for deals where `Player.SeatIndex` is present. A different account logging in still overwrites `playerId` correctly, since that always arrives as a deal *with* `Player` present. `SessionState.reset()` (session/table-scoped: id/battleType/name/players, triggered on `EVT_ENTRY_QUEUED`) intentionally does **not** touch `playerId`/`latestEvtDeal` — those are hero-identity state, not session state, and MUST outlive any single session/table.

---

## Cloud Sync & Firebase Integration

### Architecture

- **Service Worker Compatible**: Firebase SDK v12+ with chrome.identity authentication
- **Data Structure**: `/users/{userId}/apiEvents/{timestamp_ApiTypeId}` for sequence 0 (legacy-compatible), `/users/{userId}/apiEvents/{timestamp_ApiTypeId_sequence}` for later rows in the same timestamp/type burst
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

Firebase project configuration and deployment prerequisites are documented in
[docs/firebase-setup.md](docs/firebase-setup.md); keep this overview focused on the
runtime contract and use that guide as the setup source of truth.

### Forced Update (auto-apply + remote kill switch)

sola-approved mechanism to get users onto a fixed/current version without waiting for Chrome's own lazy update cadence. Two independent pieces:

**1. Auto-apply downloaded updates (`src/background/update-manager.ts`)**

- **Safe-window definition** (`isSafeToUpdate()`): SAFE = no active game session AND `!AutoSyncService.isSyncing` AND `currentOperationState.type === 'idle'`. Session activity is tracked independently in the Service Worker (`markSessionActive()`/`markSessionInactive()`) as a tri-state: ACTIVE on `EVT_ENTRY_QUEUED`(201) / `EVT_DEAL`(303, only with the raw `Player` field present — spectator deals never arm) / `EVT_SESSION_DETAILS`(308); INACTIVE on `EVT_SESSION_RESULTS`(309) / `EVT_ENTRY_CANCELLED`(203) — the same trigger set `content_script.ts`'s keepalive gate mirrors, tracked separately because the SW can't see the content script's in-memory state. All transitions are applied inside `event-ingestion.ts`'s serialized ingestion queue **after** the durability barrier and content dedup (duplicates/resends never move the state; a dropped write of a session-START event still applies ACTIVE — fail closed; a dropped INACTIVE write does not fail open). Defaults to `'unknown'` on every SW (re)start and is treated as **unsafe** until a session end is actually observed — conservative by design, per spec. **Reload commit point**: every *forced-update* path that can reach `chrome.runtime.reload()` (update-available, operation-complete recheck, SW-startup recheck, 309/203-triggered recheck, manual apply) funnels through `commitReloadIfStillSafe()` (`update-manager.ts`), which awaits `awaitIngestionDrain()` (loop-until-stable, fails closed at its iteration cap), re-checks the queue tail synchronously, evaluates `isSafeToUpdate()`, and holds a double-commit guard — with zero awaits between the final check and the reload. (`deleteAllData()`'s reload in `src/background/import-export.ts` is deliberately outside this funnel — it runs after the user explicitly wiped all data, where session/sync state is moot.) Pending-update state is persisted **before** draining so a SW kill mid-drain leaves a durable trace.
- **Trigger**: `chrome.runtime.onUpdateAvailable` → SAFE now? `chrome.runtime.reload()` immediately. Not SAFE? persist `{pending: true, version}` to `chrome.storage.local` (`PENDING_UPDATE_STORAGE_KEY = 'pendingUpdate'`) and badge the icon.
- **Re-check points** (`recheckPendingUpdate()`), exactly 4: (a) session end (`EVT_SESSION_RESULTS`/309) — hooked in `event-ingestion.ts` right next to `AutoSyncService.onGameSessionEnd()`'s call site; (a') entry cancellation (`EVT_ENTRY_CANCELLED`/203) — same queue-side hook, added with the 203 INACTIVE trigger; (b) long-running operation completion — `operation-state.ts` exposes `onOperationBecameIdle()`, a non-idle→idle transition listener registry, so `update-manager.ts` can subscribe without `operation-state.ts` depending on it; (c) Service Worker startup — called directly from `initUpdateManager()`.
- **Accelerated checks**: `chrome.runtime.requestUpdateCheck()` once on SW startup, plus a `chrome.alarms` alarm (`pokerchase-hud-update-check`, `periodInMinutes: 360`) so the check survives SW death (alarms wake the SW; a `setInterval` would not).
- **Popup UI** (`src/components/popup/UpdateSection.tsx`): reads `pendingUpdate`/`minVersionGateState` straight from `chrome.storage.local` (same pattern as rebuild-advisory/undecoded-event banners) and shows a 「新しいバージョンが待機中です」 MUI `Alert` with a 「今すぐ適用」 button → `applyPendingUpdate` message → `applyUpdateNow()` re-checks safety server-side and either reloads or returns a Japanese reason string (session/sync/operation) that the popup displays inline. Optimistic UI is deliberately *not* used here (unlike export/import/rebuild) — applying is fire-and-confirm since a false "applied" would just look like nothing happened when the popup gets torn down by the reload anyway.
- **Badge precedence**: rebuild-advisory's badge (`src/background/rebuild-advisory.ts`, data-correctness action) always wins. `update-manager.ts`'s `setBadge()`/`clearBadge()` both no-op whenever `getRebuildAdvisoryState().pendingVersion` is set — one-directional: rebuild-advisory is unmodified and always sets/clears unconditionally. Once rebuild-advisory resolves, the next `recheckPendingUpdate()` call (any of the 3 re-check points) re-asserts the update badge if still pending.

**2. Remote minimum-version gate / kill switch (`src/services/min-version-gate.ts`)**

- **Fetch shape**: unauthenticated `GET https://firestore.googleapis.com/v1/projects/pokerchase-hud/databases/(default)/documents/config/client?key=<firebaseConfig.apiKey>` — same REST base URL shape as `firestore-backup-service.ts`'s `baseUrl`, but with the public API key in the query string instead of an `Authorization: Bearer` header (public-read doc, no signed-in user required).
- **Firestore rule**: `firebase/firestore.rules` adds `match /config/client { allow read: if true; allow write: if false; }` — public read of exactly this one doc, nothing else loosened.
- **Fail-open matrix** (every path returns `{supported: true}` and logs one `console.warn`): network/fetch error, non-OK HTTP status (incl. 404 = doc not created yet), invalid JSON body, missing `minSupportedVersion` field, non-numeric-dotted version string (comparator returns `null` from `src/utils/version-compare.ts`'s `compareVersions()`, `isVersionBelow()` treats `null` as "not below"). The gate can only ever make the extension *more* restrictive when explicitly configured — never brick it by omission or misconfiguration.
- **Cache**: 12h TTL in `chrome.storage.local` (`MIN_VERSION_GATE_STORAGE_KEY = 'minVersionGateState'`), checked once on SW startup (`background.ts`) so normal operation never re-fetches on every wake.
- **Enforcement**: `AutoSyncService.performSync()` is the single choke point all sync entry points funnel through (manual sync, `onGameSessionEnd`/`onNewSessionStart` triggers, `initialize()`'s first-time sync) — it calls `isCloudSyncBlockedByMinVersionGate()` and, if blocked, sets `syncState.error` and returns without syncing. **The HUD keeps working** — stats are computed entirely from local IndexedDB, so this only ever stops the cloud round-trip, never the overlay.
- **Popup UI**: same `UpdateSection.tsx`, an `error`-severity banner: 「このバージョンはサポートが終了しました。Chromeを再起動すると更新が適用されます」 + a 「今すぐ適用」 button that reuses the exact same `applyPendingUpdate` → `applyUpdateNow()` reload path as the auto-apply feature above (best-effort: only actually reloads onto a newer version if Chrome has already downloaded one).

**Owner follow-ups** (not automatable from an agent session): deploy `firebase/firestore.rules` (`npm run firebase:deploy:rules`) once the Firebase CLI is authenticated interactively, and create the `config/client` document (e.g. `minSupportedVersion: "5.0.0"` as a starting floor) via the Firebase Console or an authenticated Admin SDK script — client writes to this doc are rejected by rule (`allow write: if false`), so it cannot be seeded from the extension or an unauthenticated script. Until the doc exists, the gate fails open (everyone stays "supported") — this is safe by design, not a broken state.

### Update information (GitHub Releases)

sola-approved: GitHub Releases are the single source of truth for user-facing update information. The popup does not embed release-note bodies.

- **Popup link** (`src/components/popup/PopupHeader.tsx`): next to the running `chrome.runtime.getManifest().version`, show an 「更新情報」 link to the **fixed** Releases index `https://github.com/solavrc/pokerchase-hud/releases` (`GITHUB_RELEASES_URL`, `src/constants/release-info.ts`) with `target="_blank"` and `rel="noopener noreferrer"`. Deliberately **not** a per-version `releases/tag/pokerchase-hud-v${version}` URL: that 404s whenever the running version has no published Release (locally built / unpacked builds, or a Release not published yet), while the index always resolves and still shows the latest notes first. Do not hard-code release dates or version-specific prose in the extension.
- **Release body contract**: every published Release begins with a concise Japanese summary (`## 概要`) and a `## 主な更新` list for users. Preserve Release-Please's generated PR/commit links under a later `技術的な変更一覧` `<details>` section rather than replacing or dropping that history. Since the extension embeds no release prose at all, this body is the *only* channel for user-facing update information — the manual rewrite step, its timing (right after the release workflow, before Chrome Web Store submission) and the `gh release edit` commands are documented in [docs/chrome-web-store-release.md](docs/chrome-web-store-release.md#release-notes).
- **Badge logic** (`src/background/whats-new-badge.ts`): `chrome.runtime.onInstalled` (`reason === 'update'` only — fresh installs do not get an update badge) records every running version in the legacy-compatible `whatsNewUnseenVersion` storage key, independent of whether a Release can be fetched. `PopupHeader` sends the idempotent `acknowledgeWhatsNew` message after the version and the Releases link are visible.
- **Badge precedence (3-way): rebuild-advisory > update-manager > whats-new.** `resolveActiveBadge()` remains the single source of truth and is covered by all eight boolean combinations. The informational badge sets `N` only when neither higher-priority badge is active, and it never clears a higher-priority badge.
- **Service Worker startup reassertion**: `reassertWhatsNewBadgeOnStartup()` runs after `initUpdateManager()` finishes its startup cleanup. A still-unseen informational badge suppressed by rebuild/update state can therefore be promoted on a later startup without extra session/operation hooks.
