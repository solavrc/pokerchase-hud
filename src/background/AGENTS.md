# AGENTS.md — src/background (service worker)

Applies to the MV3 service worker modules in this directory. Root
[AGENTS.md](../../AGENTS.md) rules also apply.

## Code Review Rules

### Session-activity transitions live inside the serialized ingestion queue

- Flag changes that move session-activity (ACTIVE/INACTIVE) transitions out of
  `event-ingestion.ts`'s serialized queue, apply them before the raw-write
  durability barrier and content dedup, or let a deduplicated resend (canonical
  payload identical, storage-only `sequence` excluded) move the state. Distinct
  events that merely share a millisecond and ApiTypeId are NOT duplicates —
  each gets its own sequence and is processed normally, including its activity
  transition.
- Why it matters here: this ordering was converged over eight review rounds of
  real races (optimistic marking, arrival-order inversion, duplicate resends
  re-arming activity). The settled invariants: queue order = arrival order;
  dedup runs *before* the activity decision; asymmetric failure handling — a
  dropped write of a session-START event still applies ACTIVE (fail closed for
  reload safety), a dropped session-END write does **not** apply INACTIVE.
- Safe path: keep transitions queue-internal and post-dedup; solve read-side
  staleness on the reader (drain barrier), not by making writes optimistic.

### Every forced-update reload goes through the single commit point

- Flag any new forced-update path that can reach `chrome.runtime.reload()`
  without passing `commitReloadIfStillSafe()` (`update-manager.ts`), any await
  inserted between its final safety check and the reload, or a drain-cap
  exhaustion path that proceeds (fail-open) instead of refusing to reload.
- Why it matters here: a reload at the wrong moment aborts an in-flight raw
  write or interrupts a live hand; scattered per-path guards repeatedly
  reopened check-then-act races until all paths were funneled through one
  atomic commit point. `deleteAllData()`'s reload is the one documented
  exception (runs after the user wiped all data).
- Safe path: route new reload triggers through the existing funnel; persist
  pending-update state *before* any drain/await so a SW kill leaves a durable
  trace.
