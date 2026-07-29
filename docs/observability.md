# Sentry observability

PokerChase HUD uses the dedicated
[`sola-works/pokerchase-hud`](https://sola-works.sentry.io/issues/?project=4511816450637824)
Sentry project for production error detection.

Sentry is initialized in the background service worker, content script, and
popup. It is deliberately **not** initialized in `web_accessible_resource.ts`,
which runs in the game page's main world and handles raw WebSocket payloads.

## What is reported

- Unhandled exceptions and unhandled promise rejections in the three extension
  runtimes
- ERROR/FATAL failures passing through `ErrorHandler`
- Auto-sync failures, Raw Event Lake write failures, and fatal runtime-port
  delivery failures
- Destructive PokerChase API schema mismatches, grouped by `ApiTypeId`

Schema mismatch events contain only:

- `ApiTypeId`
- Zod issue paths (for example `Results.0.Ranking`)
- Zod issue codes (for example `invalid_type`)
- extension version and runtime

The original event JSON remains in the local Raw Event Lake and is never
attached to Sentry.

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
that placeholder before storage.

The Sentry project also has default data scrubbing and IP-address scrubbing
enabled. Each background/content/popup runtime sends at most 20 events before
it is restarted, limiting the effect of an error loop. Do not add raw API
events, player names, user IDs, hand histories,
Firebase document paths, auth objects, or tokens to telemetry.

## Builds and source maps

Normal local/CI/E2E builds keep telemetry disabled. The release workflow sets
`SENTRY_ENABLED=true`; its `SENTRY_AUTH_TOKEN` repository secret enables the
esbuild plugin to:

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
