# E2E QA harness

A permanent, deterministic end-to-end harness that loads the *real, built*
extension into a *real* Chromium and drives *real* gameplay data through the
extension's actual WebSocket interception path -- so both scripted
assertions (`e2e:smoke`) and step-by-step AI-agent exploratory QA can run
against a live HUD.

Nothing here is wired into CI yet (the CI runner doesn't have the Chrome
for Testing cache) -- run it locally.

## Quick start

```sh
npm run e2e:smoke
# Session-end persistence regression:
npm run e2e:playerid
```

This builds the e2e extension variant, launches Chrome for Testing headless,
replays the anonymized fixture over a real WebSocket, and asserts the HUD
+ popup work. Screenshots land in `e2e/out/`.

First run downloads Chrome for Testing (~200MB) into `~/.cache/puppeteer/`
(puppeteer's standard cache location, shared across worktrees -- override
with `E2E_BROWSER_CACHE_DIR`) -- later runs reuse the cache and take a few
seconds.

## How it works: the replay seam

The extension has two moving parts relevant here (see
`src/content_script.ts` and `src/web_accessible_resource.ts`):

1. **`web_accessible_resource.ts`** is injected as a real `<script>` tag
   into the page and monkey-patches `window.WebSocket` -- for **every**
   socket the page opens, with **no URL filter**. It decodes each binary
   frame with `@msgpack/msgpack`, and if the decoded object has a numeric
   `ApiTypeId`, re-emits it via
   `window.postMessage({...decoded, timestamp: Date.now()}, POKER_CHASE_ORIGIN)`.
2. **`content_script.ts`** listens for `window.message` events where
   `event.origin === POKER_CHASE_ORIGIN` and forwards the payload to the
   background service worker over a `chrome.runtime.connect` port, which is
   what ultimately drives `PokerChaseService` -> stats -> the HUD.

Because there's no WS URL filter, **any** page that opens **any**
WebSocket and receives msgpack-encoded, `ApiTypeId`-bearing binary frames
gets the exact same treatment the real game gets. So the harness:

- Serves a tiny fixture page (`e2e/public/fixture.html`) containing
  `<div id="unity-container">` (required -- `content_script.ts`'s
  `mountApp()` does a synchronous, one-shot
  `document.querySelector('#unity-container')` at inject time, so this
  must already be in the initial HTML) that opens a `WebSocket` to a local
  replay server and sets `binaryType = 'arraybuffer'` (browsers default to
  `'blob'`, which the interceptor's `data instanceof ArrayBuffer` check
  would silently reject).
- The local server (`e2e/fixture-server.ts`) reads an NDJSON fixture (one
  decoded API event per line -- see `docs/api-events.md`), msgpack-encodes
  each line with `@msgpack/msgpack`, and sends it as a binary WS frame.

**The only thing standing between "any localhost page" and this working is
`POKER_CHASE_ORIGIN`.** It's computed once, at *build* time, in
`src/constants/runtime.ts`:

```ts
export const POKER_CHASE_ORIGIN = new URL(content_scripts[0]!.matches[0]!).origin
```

i.e. it's whatever origin is first in `manifest.json`'s
`content_scripts[0].matches`. In production that's
`https://game.poker-chase.com`. `window.postMessage(data, POKER_CHASE_ORIGIN)`
only actually delivers the message if the page's own origin matches that
target origin -- so a fixture page served from `http://localhost:18923`
would never receive anything from a production-built extension, and
`content_script.js` wouldn't even be injected there in the first place
(manifest match patterns gate injection too).

### `npm run build:e2e`

`npm run build:e2e` (-> `e2e/tools/build-e2e.ts`) produces a **separate,
gitignored** build at `e2e/.build/extension/` that is never shipped:

1. `e2e/tools/generate-e2e-manifest.ts` reads the real, checked-in
   `manifest.json` (read-only -- it is never written), clones it, and
   *prepends* `http://localhost:<port>/*` to
   `content_scripts[0].matches` and `web_accessible_resources[0].matches`.
   Prepending (not appending) matters: it becomes `matches[0]`, so
   `POKER_CHASE_ORIGIN` resolves to the fixture origin in this build. The
   production match is kept as a second entry (additive).
2. `esbuild.config.ts` gained two env vars, both unset (and therefore
   inert) during a normal `npm run build`:
   - `E2E_OUTDIR` -- build into this directory instead of `dist/`.
   - `E2E_MANIFEST` -- redirect every `manifest.json` import esbuild
     resolves while bundling (`content_script.ts`, `background.ts`,
     `constants/runtime.ts`) to this file instead of the real one, via an
     `onResolve` plugin.
3. The generated manifest and `icons/` are copied alongside the built
   `dist/` into `e2e/.build/extension/`, producing a directory Chrome can
   load with `--load-extension`.

**Verifying production is untouched:** `npm run build` was diffed
byte-for-byte (`diff -rq`) against a pre-change baseline of `dist/` and
`manifest.json` after this change, and the CI-relevant scripts
(`typecheck`, `jest`, `build`) were re-run green -- see the PR/commit
description for the exact commands.

### The `document_idle` race (and the fix)

`content_script.ts` runs at the default `"document_idle"`, which is
strictly *after* an inline `<script>` in the fixture page's `<body>` would
run (that fires synchronously while the HTML is still parsing, well before
`document_idle`). If the fixture page opened its WebSocket immediately, it
would very likely do so against the *original*, unpatched
`window.WebSocket` -- before `web_accessible_resource.js` has even been
fetched and executed -- and nothing would ever be intercepted. The real
game doesn't hit this because its Unity WebGL client takes far longer to
open its first socket than any of this takes. The fixture page works
around it by polling `!window.WebSocket.toString().includes('[native code]')`
before opening the socket -- i.e. it waits for proof the patch is actually
live, not just that the extension's `<script>` tag has appeared in the DOM
(that alone isn't sufficient -- the tag's `src` fetch+execute is
asynchronous).

This is the one timing-sensitive wait in the harness; it's a `setTimeout`
poll with a 10s deadline (see `e2e/public/fixture.html`), not a fixed
sleep, so it resolves as soon as the hook is live and only fails if it
genuinely never loads.

## Fixture data

`e2e/fixtures/session-3hands.ndjson` (~11KB, 29 events / 3 hands) is a
small, **anonymized** slice extracted from a real capture. Nothing from
`~/Downloads/pokerchase_raw_data_*.ndjson`-style raw captures is ever
committed (`*.ndjson` is gitignored repo-wide; the fixture file is
explicitly un-ignored).

### Regenerating / extracting a new fixture

```sh
npx tsx e2e/tools/extract-fixture.ts <path-to-raw-capture.ndjson> [output.ndjson] [--hands N]
```

- Starts at the first `EVT_ENTRY_QUEUED` (201) in the source file (a clean
  session start) and includes everything up to and including the Nth
  `EVT_HAND_RESULTS` (306) after it (default N=3), so the fixture always
  ends on a complete hand boundary. See `docs/api-events.md` for the event
  sequence this relies on -- no events are invented.
- Anonymizes every `UserId`/`UserName` pair it finds
  (`e2e/tools/anonymize.ts`, unit tested in
  `e2e/tools/anonymize.test.ts` via `npx jest`) to a deterministic
  synthetic id space (`1001, 1002, ...` / `"Player1", "Player2", ..."`).
  The same real id always maps to the same synthetic id across the whole
  extraction, so seat tracking / VPIP / etc. behave identically on the
  anonymized fixture. `-1` (empty seat) is left untouched. Cosmetic fields
  (character/costume/emblem ids, rank, deco ids) are left as-is -- they're
  game cosmetics, not personal data, and keeping them makes the fixture
  look like a real capture.
- Default output is `e2e/fixtures/session-3hands.ndjson`; re-running with
  the same source and options is deterministic (byte-identical output).

### Table backdrop (`table-backdrop.js`)

Both `fixture.html` and `no-replay.html` include `e2e/public/table-backdrop.js`,
a small script that, when opted in (see "Default off" below), renders
`e2e/public/assets/table-backdrop.jpg` -- a real, owner-provided PokerChase
6-max table screenshot (hero holding K♦K♣ at the BB preflop, facing a
raise) -- full-bleed as a sibling *behind* `#unity-container` (not a child
of it -- see below). It exists purely so screenshots/QA sessions can read
as "HUD overlaying a real poker game" instead of a plain green void. The
asset is strictly cropped to the game page's own
viewport (no macOS window chrome, browser tab strip, URL bar, or rounded
window corners/shadow) and has all six seat name plates (the five opponents
plus the hero) anonymized in-image -- drawn natively over the original
plates, not blurred/redacted -- to `Hero` / `プレイヤーA`..`プレイヤーE`. It
is entirely inert: `pointer-events: none` throughout, `z-index: 1` (below
the HUD's own `z-index: 9999`, see `src/components/Hud.tsx`), it never
touches `window.WebSocket`, and it adds no element that matches any
`smoke.ts` selector.

It is mounted as a **preceding sibling** of `#unity-container`, not a child
-- `harness.ts`'s `waitForHudMount()` polls
`#unity-container`'s own children for a `position: fixed` descendant as its
proxy for "the HUD mounted", and the backdrop's wrapper is itself
`position: fixed`; nesting it inside `#unity-container` would satisfy that
check the instant this script runs, before the extension ever mounts,
producing a false-positive HUD mount. `position: fixed` stacking is
viewport-relative regardless of DOM parent, so this has no visual effect.

The `<img>` uses `object-fit: fill` (stretch, not crop) so the screenshot
fills any viewport aspect exactly (the asset is ~1.73:1; the README shot is
16:9, the store shots 16:10) -- deliberate, since it keeps every in-image
seat plate at a **fixed percentage position** of the viewport, the same
scheme `Hud.tsx`'s own `SEAT_POSITIONS` uses for its panels, so a HUD panel
can always be aligned under its plate regardless of viewport size. Hero
hole cards are baked into the screenshot (K♦K♣, no longer
query-param-configurable -- the old canvas backdrop's `?heroCards=`/
`?heroLabel=` params died with it); for imagery whose HUD content must not
contradict them, `e2e/tools/capture-store-imagery.ts` derives a fixture
whose final hero hand is KK and whose player names match the backdrop's
plates -- see that file's module doc comment and its `SEAT_ANCHORS` table
for the full alignment mechanics.

Default OFF (scene-neutral, bare page): `smoke.ts` and `run.ts` both replay
`DEFAULT_FIXTURE` (`session-3hands.ndjson`) unless told otherwise, which
ends on hero's real J♣8♦ hand -- painting this backdrop's baked-in K♦K♣
scene under those paths by default would make the HUD's own content
contradict what's behind it. Append `?backdrop=1` to either page's URL
(e.g. `http://localhost:<port>/fixture.html?backdrop=1`, or
`launchHarness`'s `fixtureQuery: 'backdrop=1'` option) to opt in; only
`e2e/tools/capture-store-imagery.ts` does, since it derives its own fixture
specifically to end on a KK hand matching this scene.

`e2e/fixtures/session-bust.ndjson` (544 events, one full SNG) covers the
busted-player-dim feature: extracted with the one-off
`e2e/tools/extract-bust-fixture.ts` (not `extract-fixture.ts` -- this
scenario needs a specific mid-file session plus its trailing
`EVT_SESSION_RESULTS`, which `extract-fixture.ts`'s "first
`EVT_ENTRY_QUEUED` in the file, stop on a hand boundary" rule can't
express) from source lines 1381-1924 of the 2026-07-04 raw capture (the
same one `docs/api-events.md`'s "実データ（393,830イベント）" analysis is
drawn from, reused here since it's already known-good). Reuses
`anonymize.ts` directly. A player at raw seat 0 busts mid-session
(`EVT_HAND_RESULTS` `Ranking:6`), a second player at raw seat 2 busts
several hands later, and the table keeps dealing to the remaining seats
throughout -- both busted seats' HUD panels should stay dimmed, not clear,
until the fixture's closing `EVT_SESSION_RESULTS`. Being a fixed-field SNG,
no new player ever takes either vacated seat (no reseating mid-tournament),
so this fixture alone can't exercise seat-takeover replacement -- that path
is covered by `src/components/App.test.tsx`'s unit tests instead.

### `no-replay.html`: a fresh mount with zero WS events

`e2e/public/no-replay.html` is a second static page served by the same
fixture server, at `http://localhost:<port>/no-replay.html`. It has the
same `#unity-container` shell `content_script.ts` needs, but -- unlike
`fixture.html` -- **no inline script ever opens a WebSocket**, so navigating
to it triggers zero replay/API events. It exists to test the pre-game hero
stats fallback (`getLatestSessionStats({ preGame: true })`,
`background/import-export.ts`): replay the standard fixture once (so the
extension's DB + persisted `service.playerId` are populated), then navigate
the *same* browser to `no-replay.html` (`page.goto`, not `close`+`launch` --
the background service worker and its storage must survive the navigation)
to get a genuinely fresh HUD mount with no live lineup, and assert the hero
panel (seat 0) still renders real stats. There's no dedicated CLI
subcommand for this navigation step (`e2e/run.ts` has no `goto`) -- drive it
with a short one-off script using `attachHarness()` + `h.gamePage.goto(...)`
(see `e2e/harness.ts`'s exported `attachHarness`), the same pattern
`e2e/run.ts`'s own subcommands use internally.

## Harness API

`e2e/harness.ts` is importable directly for programmatic/scripted use
(see `e2e/scenarios/smoke.ts`):

```ts
import { launchHarness } from './e2e/harness.ts'

const h = await launchHarness({ headed: false }) // or true to watch it
await h.waitForHudMount()
await h.waitForReplayDone()
const handDeadline = Date.now() + 10_000
let maxHandCount = 0
while (Date.now() < handDeadline && maxHandCount === 0) {
  maxHandCount = await h.evaluate(() => Math.max(
    0,
    ...Array.from(document.querySelectorAll('[data-stat-id="hands"]'), (cell) =>
      Number((cell.textContent || '').match(/\d+/)?.[0] || 0)
    )
  ))
  if (maxHandCount === 0) await new Promise((resolve) => setTimeout(resolve, 100))
}
if (maxHandCount === 0) {
  await h.screenshot('e2e/out/hand-timeout.png')
  throw new Error('HAND remained 0 for 10s after replay; see e2e/out/hand-timeout.png')
}
await h.screenshot('e2e/out/hud.png')
const popup = await h.openPopup()
await popup.screenshot({ path: 'e2e/out/popup.png' })
await h.close()
```

Key methods: `evaluate`, `screenshot`, `domSnapshotText`, `domSnapshotHtml`,
`openPopup`, `waitForHudMount`, `waitForReplayDone`, `close`. `gamePage`
and `browser` (raw `puppeteer-core` objects) are also exposed for anything
not covered by the helpers.

`launchHarness` downloads (once, cached under `~/.cache/puppeteer/`, see
`BROWSER_CACHE_DIR` in `e2e/config.ts`) and launches a pinned Chrome for
Testing build (see `CHROME_BUILD_ID` in `e2e/config.ts`) with
`--load-extension`/`--disable-extensions-except`
pointed at `e2e/.build/extension/`. Headless was verified to work fine for
this harness (Chrome for Testing supports extensions in headless mode) and
is the default; pass `{ headed: true }` to watch it.

The default viewport is **1920x1080** (`DEFAULT_VIEWPORT` in
`e2e/config.ts`), not puppeteer's own ~1280x800 default -- real gameplay
runs on a fullscreen ~1920x1080 Unity WebGL canvas, and the HUD
(`src/components/Hud.tsx`) positions player panels with percentage
coordinates plus fixed 240px widths, so a smaller viewport visibly crowds
or overlaps panels that don't overlap in the real game. Override it with
`{ viewport: { width, height } }` on `launchHarness`, `--viewport WxH` on
`e2e/run.ts launch`, or `--viewport WxH` on `e2e/scenarios/smoke.ts`.

## AI-agent QA: the step-by-step CLI

For exploratory QA (by a human or an AI agent), `e2e/run.ts` gives you a
`launch` once, then any number of independent shell commands against the
*same* running browser -- state (HUD, hand log, any drilldown panel
you've opened, popup tabs, etc.) persists across calls until `close`.

```sh
# Start a session (builds the e2e extension automatically if none exists).
npx tsx e2e/run.ts launch                       # headless, default fixture, 1920x1080 viewport
npx tsx e2e/run.ts launch --headed               # watch the browser
npx tsx e2e/run.ts launch --fixture path/to.ndjson --replay-delay 300
npx tsx e2e/run.ts launch --viewport 1280x800    # override the default (game-realistic) viewport

npx tsx e2e/run.ts status                        # is a session running? where?
npx tsx e2e/run.ts wait-hud                       # block until the HUD mounts
npx tsx e2e/run.ts screenshot e2e/out/step1.png
npx tsx e2e/run.ts dom-text                       # plain-text render of the page
npx tsx e2e/run.ts dom-html                       # <body> outerHTML
sleep 2                                           # let the worker process and broadcast replayed events
npx tsx e2e/run.ts eval "Math.max(0,...[...document.querySelectorAll('[data-stat-id=\"hands\"]')].map(e=>Number((e.textContent||'').match(/\\d+/)?.[0]||0)))"
npx tsx e2e/run.ts popup-screenshot e2e/out/popup.png

npx tsx e2e/run.ts close                          # tears down the browser + fixture server
```

`npm run e2e` is a shorthand for `tsx e2e/run.ts` (i.e. `npm run e2e --
launch --headed`).

This is the intended agent loop: **launch -> act -> screenshot/eval ->
assert -> repeat -> close**. Each command is a short-lived process that
connects to the already-running browser via its CDP WebSocket endpoint
(recorded in the gitignored `e2e/.build/session.json` by a detached daemon
process `launch` spawns), so there's no long-running foreground process to
manage and no state lost between commands. Always `close` when done --
`launch` refuses to start a second session on top of one that looks
active, and an orphaned Chrome process left behind after a crashed agent
run can be cleaned up with `kill <pid>` (the pid is in
`e2e/.build/session.json` / `run.ts status`).

## Smoke scenario

`e2e/scenarios/smoke.ts` (`npm run e2e:smoke`) is the scripted, CI-shaped
check: build -> launch -> replay -> assert, non-zero exit + a screenshot
and DOM dump on any failure. It covers fixture replay completion, HUD mounting
and non-zero hand data, positional drill-down availability, popup rendering
without uncaught errors, and the initial popup configuration viewport. On
success it writes `smoke-hud.png` and `smoke-popup.png` under `e2e/out/` (or
the directory selected with `--screenshot-dir`).

`e2e/scenarios/playerid-session-persistence.ts` (`npm run e2e:playerid`)
replays the spectator/session-end fixture, navigates the same browser to the
zero-event page, and verifies that the persisted hero identity still drives
pre-game stats. It writes `playerid-before-reload.png`,
`playerid-no-replay-hud.png`, and `playerid-no-replay-hud.txt` on success.

## Flaky bits / timing waits

- **Idle-compositor screenshot stall (headless Chrome for Testing 151)**:
  after a page sits idle for a few minutes (typical agent think-time between
  `run.ts` CLI commands), the compositor stops producing on-demand frames
  and every CDP `Page.captureScreenshot` hangs until protocol timeout --
  while `evaluate` on the same page keeps working, so the session *looks*
  healthy right up until the screenshot call. `--disable-gpu` does not fix
  it. The harness works around this permanently by injecting an invisible
  1x1px element with an infinite CSS animation into every page it owns
  (`ensureCompositorKeepalive` in `harness.ts`: on fixture-page load, on
  popup open, and re-asserted before every `screenshot()` call), which
  keeps BeginFrames flowing so the stall never happens -- and, because
  injection also *recovers* an already-stalled compositor, the
  pre-screenshot re-assert self-heals page reloads and sessions started by
  an older build. Discovered and verified live 2026-07-20 during a
  README/store screenshot session.
- **Same compositor issue, different symptom -- silently truncated
  `fullPage` screenshots**: `e2e/tools/capture-popup-themes.ts` seeds
  `chrome.storage.sync` then calls `popupPage.reload()` before
  screenshotting, and `reload()` wipes the keepalive element injected at
  `openPopup()` time (fresh document). Without a fresh re-assert *after* the
  reload, `page.screenshot({ fullPage: true })` on the reloaded page
  intermittently (not every run) captures a frame sized to the *viewport*
  instead of the full scrollable content height -- `Page.getLayoutMetrics`
  reports the correct full content height throughout, so this isn't a
  layout bug, just a stale/short compositor frame. Fix (2026-07 popup-polish
  session): re-assert `ensureCompositorKeepalive` (now exported from
  `harness.ts`) right after the reload, *and* verify the captured PNG's
  actual height (read straight from its IHDR chunk, no image-decoding
  dependency needed) against the expected content height before accepting
  it, retrying a few times if they disagree -- the re-assert alone was not
  reliably sufficient in testing, only the verify+retry loop was.
- The `document_idle` WebSocket-patch race described above -- mitigated
  with a bounded poll on an observable effect (`window.WebSocket` no
  longer being native code), not a fixed sleep.
- After `waitForReplayDone()`, the smoke scenario and CLI examples above
  add a short fixed delay (~1-1.5s) before asserting on stats, to give the
  background service worker time to finish processing the final hand's
  events and push updated stats down through the port. This is the one
  remaining fixed sleep; it was sized generously against local runs. If
  this ever flakes, prefer polling `HAND` text via `evaluate` in a
  `waitForFunction`-style loop over increasing the sleep.
- `run.ts launch` polls for the daemon's session file (up to 30s) rather
  than sleeping a fixed amount, since Chrome download+launch time varies
  (near-instant when cached, ~a few seconds cold).

## File map

```
e2e/
  config.ts                 shared port/paths/pinned Chrome build id
  harness.ts                launchHarness / attachHarness + primitives
  fixture-server.ts         HTTP (fixture page) + WS (NDJSON replay) server
  run.ts                    step-by-step CLI (launch/status/screenshot/eval/close/...)
  public/fixture.html       minimal page with #unity-container + WS client
  public/no-replay.html     same shell, no WS client -- fresh mount, zero events (pre-game hero stats)
  public/table-backdrop.js  shared real-gameplay table backdrop for both pages above (off by default; ?backdrop=1 to enable)
  public/assets/table-backdrop.jpg   the backdrop's real, anonymized PokerChase screenshot (committed)
  fixtures/session-3hands.ndjson   anonymized fixture (committed)
  fixtures/session-3hands-spectator-end.ndjson   session-end/playerId regression fixture (committed)
  fixtures/session-bust.ndjson     anonymized SNG fixture w/ mid-session busts + session end (committed)
  fixtures/session-recent-hands.ndjson   anonymized recent-hands fixture (committed)
  scenarios/smoke.ts        scripted pass/fail smoke test
  scenarios/playerid-session-persistence.ts   persisted hero identity regression scenario
  tools/
    generate-e2e-manifest.ts   writes e2e/.build/manifest.e2e.json
    build-e2e.ts               orchestrates the full e2e build
    extract-fixture.ts         CLI to regenerate fixtures from a raw capture
    anonymize.ts / .test.ts    pure UserId/UserName remapping (jest-tested)
    capture-store-imagery.ts  regenerates README.png + docs/store-assets/store-{1,2,5}-*.png
    capture-popup-themes.ts   regenerates docs/store-assets/store-{3,4}-popup-*.png
  .build/    gitignored -- generated manifest + built e2e extension + session.json
  out/       gitignored -- default screenshot/DOM-output directory
```

Chrome for Testing downloads are *not* under `e2e/`: they live in
`~/.cache/puppeteer/` (puppeteer's standard, worktree-independent cache
location; see `BROWSER_CACHE_DIR` in `e2e/config.ts`).
