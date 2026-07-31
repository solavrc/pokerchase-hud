# Sentry observability

PokerChase HUD uses the dedicated
[`sola-works/pokerchase-hud`](https://sola-works.sentry.io/issues/?project=4511816450637824)
Sentry project for production error detection.

Sentry is initialized in the background service worker, content script, and
popup only after the user enables **診断情報を送信** in the popup.
Enabling it grants the Sentry ingest origin as an optional host permission;
existing installations are not disabled during an extension update.
Revoking that permission in Chrome settings clears the shared consent bit and
stops already-open extension runtimes through `storage.onChanged`.
Firebase credentials keep the entire `chrome.storage.local` area restricted to
trusted extension contexts. The background service worker therefore exposes
only the non-secret, permission-validated consent boolean through
`chrome.storage.session`; content scripts never read local auth storage. The
session area is reserved for this mirror while it is visible to content
scripts.
It is deliberately **not** initialized in `web_accessible_resource.ts`, which
runs in the game page's main world and handles raw WebSocket payloads.

Enabling waits for every live game tab to acknowledge the transition and rolls
the opt-in back — including the optional host grant just given — when a content
script refuses. Only a genuine refusal may count. A build with telemetry
compiled out (see "Builds and source maps" below) has no transport to start in
any runtime, and a content script whose session consent mirror is not readable
yet self-heals through `storage.onChanged`; both acknowledge the opt-in rather
than failing it. Reporting either as a failure made **診断情報を送信**
impossible to turn on while a game tab was open, surfacing only as
「診断情報の設定を更新できませんでした。」. Revocation stays strictly
fail-closed.

## What is reported

- Unhandled exceptions and unhandled promise rejections in the three extension
  runtimes
- ERROR/FATAL failures passing through `ErrorHandler`
- Auto-sync failures, Raw Event Lake write failures, and fatal runtime-port
  delivery failures
- Destructive PokerChase API schema mismatches, grouped by `ApiTypeId`
  (`ApiTypeId` itself being invalid uses one dedicated bounded bucket)

Schema mismatch events contain:

- `ApiTypeId`
- Zod issue paths (for example `Results[].Ranking`)
- Zod issue codes (for example `invalid_type`)
- Zod's expected type and the received JSON type
- a bounded structural payload shape: field names, nesting, array element
  shapes, and JSON types
- a bounded semantic event snapshot, with direct identifiers pseudonymized
  before the Sentry SDK receives it
- extension version and runtime

The structural shape proves the received types independently of the sanitized
values. For example:

```text
$: object
ApiTypeId: integer
Results: array
Results[]: object
Results[].Ranking: integer
```

The semantic snapshot keeps values needed to interpret poker behavior, such as
`BattleType`, `HandId`, stacks, bets, pots, action types, hole cards, boards,
rankings, and rewards. Relationships between players remain inspectable, but
direct identifiers are replaced with stable per-event aliases (`user#1`,
`user#2`, ...). User/player/friend names, chat and other free text,
credentials and authentication/session tokens, email/IP fields, URL query
strings, dynamic map keys, and unknown string values are redacted client-side.
Top-level property names are retained as server-owned protocol field names so
a new event schema can be reconstructed; their values remain subject to the
same identifier, free-text, secret, string, and large-number sanitizers.
For an object container not defined by the current protocol, or an unexpected
child inside a known fixed-shape container, child keys are treated as
potentially user-controlled map keys and replaced with stable structural
aliases; the value shape remains available for schema repair.
Only an explicit allow-list of machine-readable protocol IDs (for example
`CharaId`, `RankId`, and `ItemId`) retains string values. Numeric and boolean
poker state remains available for semantic interpretation; identifier-sized
unknown numbers are redacted unless their field is an explicit continuity or
poker-state key such as `HandId`, `timestamp`, `Chip`, `Pot`, or `Blind`.

When numeric `timestamp` and `ApiTypeId` storage keys exist, the exact original
event remains available in the local Raw Event Lake and may follow the
separately documented, user-controlled Firestore cloud-sync path. If either
storage key is invalid, the raw row cannot be keyed; Sentry's sanitized
diagnostic and the Popup's persistent invalid-ID counter preserve the failure
signal instead. The page-world interceptor identifies the current official
`*.api-poker-chase.com` WebSocket independently of the event body, so a global
removal or rename of `ApiTypeId` remains observable from the first decoded
object. A distinctive required-field fingerprint from a known PokerChase event
is retained only as a fallback for a future endpoint migration, preventing
unrelated MessagePack sockets from entering the diagnostic path without
injecting the full schema bundle into the game page. Up to five objects from an
unknown endpoint are retained and forwarded in arrival order only if that same
socket subsequently matches the protocol fallback. The content script strips
the envelope and sends the payload through the same bounded runtime-port queue
as normal events.
Sentry receives only the pseudonymized semantic snapshot, never the
byte-for-byte raw event. The Sentry project also has default data scrubbing and
IP-address scrubbing enabled as a second privacy layer. Server-side scrubbing
is not the primary protection because a newly introduced field name may be
unknown.

## Privacy boundary

`src/observability/sentry.ts` is the final client-side privacy boundary.
It disables Replay, tracing, breadcrumbs, request capture, cookies, headers,
request/response bodies, query parameters, stack-frame variables, and source
context lines. Before sending, it removes user, request, extra, transaction,
and non-allow-listed context/tag fields and redacts email addresses, bearer
tokens, JWTs, UUIDs, long numeric identifiers, and URL query/hash data.
Arbitrary exception messages are discarded entirely; stack frames, exception
type, runtime, and the allow-listed operation tag remain for diagnosis.
It also sends a non-routable placeholder IP so Sentry cannot derive city or
region metadata from the network request; the server-side IP scrubber removes
that placeholder before storage. Sentry client-report envelopes are disabled
because they bypass `beforeSend`; every emitted envelope therefore remains
inside the same sanitizer and per-runtime budget.

The Sentry project also has default data scrubbing and IP-address scrubbing
enabled. Each background/content/popup runtime sends at most 20 events before
it is restarted, limiting the effect of an error loop. Each monitored runtime
also installs a bounded five-error bootstrap buffer synchronously while its
asynchronous consent and permission checks are pending. A content script keeps
that buffer while the background worker is still creating the session consent
mirror after browser startup, flushes it if the mirror becomes `true`, and
discards it if the mirror explicitly becomes `false`. The schema-validation
snapshot is the only permitted API-event context and must be produced by
`buildSchemaDiagnostic`. Its construction is gated lazily after consent,
runtime budget, and per-`ApiTypeId` deduplication so opted-out users do not pay
the traversal cost. Do not attach the exact raw event, player names,
account IDs, chat text, Firebase document paths, auth objects, or tokens
directly to Sentry.

## Builds and source maps

Normal local/CI/E2E builds keep telemetry disabled. The release workflow sets
`SENTRY_ENABLED=true`, but the runtime still requires the user's per-profile
opt-in and optional host grant. Its `SENTRY_AUTH_TOKEN` repository secret
enables the esbuild plugin to:

1. build release `pokerchase-hud@<manifest version>`;
2. upload minified JavaScript and source maps;
3. finalize the Sentry release;
4. delete `.map` files before `extension.zip` is created.

The authentication token is a build secret and must never be committed. The
public DSN is intentionally bundled into the extension.

To test a telemetry-enabled local build without uploading source maps:

```sh
SENTRY_ENABLED=true npm run build
```

To exercise the complete upload path, set a Sentry organization token with
project release permissions in `SENTRY_AUTH_TOKEN`.

## Operational limits

Sentry detects exceptions and explicit integrity alarms; it cannot prove that a
successful-looking sync did not silently omit data. Raw Event Lake durability,
watermark/cursor invariants, local undecoded-event counters, and upload/download
consistency checks remain the authoritative controls for silent data-loss
paths.
