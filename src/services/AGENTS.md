# AGENTS.md — src/services (sync, auth, cloud)

Applies to the cloud-sync and auth services in this directory. Root
[AGENTS.md](../../AGENTS.md) rules also apply (especially the Raw Event Lake /
watermark rule).

## Code Review Rules

### Lake pagination uses the full three-part cursor, never reused Collections

- Flag pagination over `apiEvents` that (a) drops any component of the
  `[timestamp+ApiTypeId+sequence]` compound cursor (timestamp-only or two-part
  comparisons skip or duplicate same-millisecond rows), or (b) reuses a single
  Dexie `Collection` across pages with `.offset()/.limit()` — Dexie
  Collections accumulate query modifiers, so the second page silently
  re-applies the first page's window.
- Why it matters here: both defects shipped as release blockers — a reused
  Collection made chunked processing handle only the first chunk (rebuilds and
  exports silently truncated), and a timestamp-only upload cursor skipped
  same-millisecond events from cloud backup.
- Safe path: issue a fresh `where('[timestamp+ApiTypeId+sequence]').above(lastKey)`
  query per chunk from the `Dexie.Table` (the `processInChunks()` pattern) and
  carry all three key components across pages.

### Account identity is generation-checked across every auth await

- Flag authenticated flows (token acquisition, refresh, 401 retry, sync
  bookkeeping writes) that await without snapshotting `authGeneration`
  beforehand and re-verifying it at the commit point, or that add an unbounded
  await on token acquisition/refresh inside the request funnel. Ordering: the
  SW-startup auth restore (`firebaseAuthService.ready()`) itself bumps the
  generation, so the snapshot is taken *after* awaiting `ready()` and *before*
  the first token acquisition — a rule-following change must not treat the
  initial restore as an account switch.
- Why it matters here: users switch Google accounts mid-session. A uid-only
  comparison is blind to A→B→A round trips (a stale refresh response from the
  first A session overwrote the fresh session's tokens), and per-account sync
  bookkeeping must stay correct across switches — cross-account uploads are an
  accepted residual risk, corrupted watermarks are not. A hung token endpoint
  once latched the sync-in-flight flag forever, which also blocks forced
  updates.
- Safe path: snapshot the generation before the first auth await, re-check
  before committing any state, abort without commit on mismatch; bound every
  auth await with the transport timeout; keep exactly one owner per retry
  class (e.g. 429 handling lives in one layer, not stacked).
