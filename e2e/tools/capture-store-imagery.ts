/**
 * Regenerates every piece of committed imagery derived from the fixture-page
 * table backdrop: `README.png` (1920x1080 hero image) and the Chrome Web
 * Store screenshots `docs/store-assets/store-1-hud.png`,
 * `store-2-drilldown.png`, `store-5-handlog.png` (exactly 1280x800 each --
 * the Web Store requirement). `store-3`/`store-4` are popup-only composites
 * with no table backdrop and are NOT produced here (see
 * e2e/tools/capture-popup-themes.ts).
 *
 *   npx tsx e2e/tools/capture-store-imagery.ts
 *
 * Backdrop: `e2e/public/assets/table-backdrop.jpg`, a real PokerChase 6-max
 * screenshot (anonymized in-image; hero holds K♦K♣ at the BB preflop facing
 * a raise) -- see `e2e/public/table-backdrop.js`. Because the backdrop is a
 * real screenshot, two things must line up with it:
 *
 * 1. **Seat alignment.** The six in-image name plates sit at fixed
 *    percentage positions of the (stretched, `object-fit: fill`) backdrop.
 *    `SEAT_ANCHORS` below carries those percentages, measured once on the
 *    cropped asset. The HUD's per-seat panel positions are seeded through
 *    the extension's own persistence (`chrome.storage.sync`
 *    `hudPosition_<displaySeat>` keys, the exact mechanism a user dragging
 *    a panel uses -- see src/components/hud/hooks/useDraggable.ts) so each
 *    stat panel lands just under its plate, then the fixture page is
 *    reloaded so the freshly-mounted HUD picks the seeded positions up.
 *    No production positioning code is touched.
 *
 * 2. **Fixture coherence.** The replayed HUD content must not contradict
 *    the baked-in scene: the hand log's final "Dealt to ..." line and the
 *    hero's real-time hand-improvement panel both surface the hero's hole
 *    cards (K♦K♣), and the hand log's blind/ante/raise lines surface the
 *    blinds, ante, and stack sizes -- all of which the backdrop's own
 *    game-info panel and nameplates also print, so they must match
 *    (SB/BB 140/280, ante 70, プレイヤーC's raise to 7,840). No committed
 *    fixture ends on a KK hand at those stakes, so this tool derives one
 *    deterministically from `e2e/fixtures/session-bust.ndjson` (into the
 *    gitignored `e2e/.build/`):
 *      - keep the first 29 complete hands (the full-6-seat stretch of that
 *        SNG -- the first bust happens at hand 30, and a busted/empty seat
 *        would contradict the backdrop's six occupied seats);
 *      - rename the anonymized players to the same dummy names baked onto
 *        the backdrop's plates (Hero / プレイヤーA..E), keyed by display
 *        position so every HUD panel name matches the plate it sits on;
 *      - append one synthetic partial hand built to match the backdrop's
 *        own numbers rather than continuing the source fixture's chip
 *        progression: SB/BB/ante 140/280/70, each seat's post-ante chip stack
 *        read off its nameplate (`BACKDROP_CHIPS_AFTER_ANTE`), hero posts
 *        the BB with HoleCards [46, 47] (K♦K♣ per src/utils/card-utils.ts's
 *        rank=floor(card/4), suit=card%4 encoding), プレイヤーC raises to
 *        7,840 (matching her bet stack in the screenshot), the others
 *        fold, and the replay stops with the action on the hero -- exactly
 *        the preflop raise-vs-BB spot the screenshot shows. No
 *        EVT_HAND_RESULTS is appended, so the partial hand never pollutes
 *        per-player stats; it only drives the hand log tail + real-time KK
 *        panel.
 *
 * The fixture replays twice per session (once on the initial navigation,
 * once after the position-seeding reload); that is idempotent for stats --
 * hand/phase/action entities are keyed by HandId and bulkPut'ed, and
 * apiEvents dedupes on timestamp+ApiTypeId -- which the tool asserts by
 * checking the hero panel's HAND stat is exactly 29 after the reload.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchHarness, type Harness } from '../harness.ts'
import { E2E_DIR, REPO_ROOT, BUILD_DIR } from '../config.ts'

const SRC_FIXTURE = join(E2E_DIR, 'fixtures', 'session-bust.ndjson')
const DERIVED_FIXTURE = join(BUILD_DIR, 'store-imagery-fixture.ndjson')

/** Complete hands to keep from the source fixture (its full-6-seat stretch). */
const KEEP_HANDS = 29

/**
 * Dummy names baked onto the backdrop's plates, keyed by the player's
 * ORIGINAL seat in the source fixture. The hero (1002, seat 1) displays at
 * HUD position 0; the HUD rotates the remaining seats so original seats
 * 2,3,4,5,0 land at display positions 1..5 (verified live against
 * src/components/App.tsx's rotateArrayFromIndex).
 */
const PLAYER_NAMES: Record<number, string> = {
  1002: 'Hero', // display 0: bottom center
  1003: 'プレイヤーA', // display 1: bottom left
  1004: 'プレイヤーB', // display 2: top left
  1005: 'プレイヤーC', // display 3: top center
  1006: 'プレイヤーD', // display 4: top right
  1001: 'プレイヤーE', // display 5: bottom right
}

/** K♦ K♣ (rank = floor(card/4) -> 11 = K; suit = card%4 -> 2 = d, 3 = c). */
const HERO_HOLE_CARDS = [46, 47]

/**
 * Seat plate anchors measured on the cropped backdrop asset (percent of
 * image width/height): `x` is the plate's name-centering axis, `plateBottomY`
 * its bottom edge, `plateTopY` its top edge (hero only -- the hero panel
 * sits above the plate so it never covers the baked hero hole cards).
 * Indexed by HUD display position (0 = hero).
 */
const SEAT_ANCHORS = [
  // Hero: the panel sits ABOVE the baked hero hole cards (their top edge is
  // at 65.8% -- higher than the plate itself), so the K♦K♣ stay fully
  // visible at every viewport size.
  { x: 62.8, plateTopY: 65.8 },
  { x: 13.0, plateBottomY: 65.8 }, // プレイヤーA
  { x: 19.3, plateBottomY: 31.6 }, // プレイヤーB
  { x: 51.7, plateBottomY: 22.8 }, // プレイヤーC
  { x: 84.1, plateBottomY: 31.4 }, // プレイヤーD
  { x: 90.0, plateBottomY: 65.8 }, // プレイヤーE
] as const

/** Real-time (pot odds / hand improvement) panel anchor -- clear felt left of the hero. */
const REALTIME_ANCHOR = { x: 31, y: 66 }

/** Gap between a plate edge and the panel edge, px. */
const PLATE_GAP_PX = 4

interface ApiEventRecord { ApiTypeId: number; timestamp: number; [key: string]: unknown }

// ---------------------------------------------------------------------------
// Fixture derivation
// ---------------------------------------------------------------------------

const renameUsers = (value: unknown): void => {
  if (Array.isArray(value)) {
    for (const item of value) renameUsers(item)
    return
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.UserId === 'number' && typeof obj.UserName === 'string' && PLAYER_NAMES[obj.UserId]) {
      obj.UserName = PLAYER_NAMES[obj.UserId]
    }
    for (const key of Object.keys(obj)) renameUsers(obj[key])
  }
}

export const buildStoreFixture = (): string => {
  const lines = readFileSync(SRC_FIXTURE, 'utf8').trim().split('\n')
  const events: ApiEventRecord[] = lines.map((l) => JSON.parse(l))

  // Truncate right before the (KEEP_HANDS+1)-th EVT_DEAL.
  let deals = 0
  let cut = events.length
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.ApiTypeId === 303 && ++deals === KEEP_HANDS + 1) { cut = i; break }
  }
  const kept = events.slice(0, cut)
  for (const e of kept) renameUsers(e)

  // The last kept hand's EVT_HAND_RESULTS establishes hero's seat (must be
  // seat 1 -- see the seat-rotation note on PLAYER_NAMES above); the closing
  // chip counts themselves are NOT used for the synthetic hand below (see
  // BACKDROP_CHIPS_AFTER_ANTE's doc comment for why).
  const lastResults = [...kept].reverse().find((e) => e.ApiTypeId === 306) as any
  if (!lastResults) throw new Error('source fixture has no EVT_HAND_RESULTS')
  const heroSeat = lastResults.Player.SeatIndex as number // 1
  const seatUserIds = [1001, 1002, 1003, 1004, 1005, 1006]

  // Stakes read directly off the backdrop's own baked-in game-info panel
  // (top-left: "SB/BB 140/280", "アンティ 70") -- the synthetic hand MUST
  // use these, not the source fixture's level-6 structure (SB 550/BB 1100/
  // ante 280), or the hand log's "posts small/big blind"/"posts the ante"
  // lines directly contradict what's visibly printed on the table felt.
  // Hero posts the BB; seat 0 posts the SB (matching the backdrop, where
  // the bottom-right seat -- プレイヤーE, original seat 0 -- wears the SB
  // badge).
  const SB = 140, BB = 280, ANTE = 70
  const sbSeat = 0, bbSeat = heroSeat, btnSeat = 5
  const pot0 = SB + BB + 6 * ANTE
  let ts = kept[kept.length - 1]!.timestamp as number

  const progress = (over: Record<string, unknown>) => ({
    Phase: 0, SidePot: [], NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 12, ...over,
  })

  /**
   * Chip stack behind each seat right after antes (and, for the SB seat,
   * its blind) are posted -- i.e. exactly what's printed in each seat's
   * nameplate on the backdrop at the moment it was captured, EXCEPT
   * プレイヤーC (seat 4), whose plate already shows her stack AFTER the
   * raise below (14,579); her pre-raise, post-ante figure (22,419) is
   * derived here as 14,579 + RAISE_TO so the deal event -- which predates
   * her raise -- is itself consistent. Keyed by original seat index (same
   * indexing as `seatUserIds`), not display position. Hardcoded straight
   * from the screenshot rather than derived from the source fixture's
   * closing chip counts (which belong to an unrelated real hand and have
   * no relationship to this backdrop) -- see the finding this fixes:
   * synthetic stakes/stacks must match the scene, not just continue
   * whatever the donor fixture happened to have.
   */
  const RAISE_TO = 7840 // matches the bet stack under プレイヤーC's raise
  const BACKDROP_CHIPS_AFTER_ANTE: Record<number, number> = {
    0: 17790 + SB, // プレイヤーE (SB): plate shows 17,790 (post ante+SB)
    [heroSeat]: 21974 + BB, // Hero (BB): plate shows 21,974 (post ante+BB)
    2: 21818, // プレイヤーA: plate shows 21,818 (post ante, folded before betting)
    3: 18830, // プレイヤーB: plate shows 18,830 (post ante, folded before betting)
    4: 14579 + RAISE_TO, // プレイヤーC: plate shows 14,579 (post ante+raise)
    5: 15209, // プレイヤーD (button): plate shows 15,209 (post ante, folded before betting)
  }

  const deal: ApiEventRecord = {
    ApiTypeId: 303,
    timestamp: (ts += 2000),
    SeatUserIds: seatUserIds,
    Game: {
      CurrentBlindLv: 6, SmallBlind: SB, BigBlind: BB, Ante: ANTE,
      ButtonSeat: btnSeat, SmallBlindSeat: sbSeat, BigBlindSeat: bbSeat,
      NextBlindUnixSeconds: Math.floor(ts / 1000) + 300,
    },
    Player: {
      SeatIndex: heroSeat, BetStatus: 1, HoleCards: HERO_HOLE_CARDS,
      Chip: BACKDROP_CHIPS_AFTER_ANTE[heroSeat]! - BB, BetChip: BB,
    },
    OtherPlayers: [0, 2, 3, 4, 5].map((seat) => ({
      SeatIndex: seat, Status: 0, BetStatus: 1,
      Chip: BACKDROP_CHIPS_AFTER_ANTE[seat]! - (seat === sbSeat ? SB : 0),
      BetChip: seat === sbSeat ? SB : 0,
    })),
    Progress: progress({ Pot: pot0, MinRaise: 2 * BB, NextActionSeat: 2 }),
  }

  const action = (seat: number, type: number, betChip: number, chip: number, over: Record<string, unknown>): ApiEventRecord => ({
    ApiTypeId: 304, timestamp: (ts += 1500), SeatIndex: seat, ActionType: type,
    BetChip: betChip, Chip: chip, Progress: progress(over),
  })

  const FOLD = 2, RAISE = 4
  const synthetic = [
    deal,
    action(2, FOLD, 0, BACKDROP_CHIPS_AFTER_ANTE[2]!, { Pot: pot0, MinRaise: 2 * BB, NextActionSeat: 3 }),
    action(3, FOLD, 0, BACKDROP_CHIPS_AFTER_ANTE[3]!, { Pot: pot0, MinRaise: 2 * BB, NextActionSeat: 4 }),
    action(4, RAISE, RAISE_TO, BACKDROP_CHIPS_AFTER_ANTE[4]! - RAISE_TO, { Pot: pot0 + RAISE_TO, MinRaise: 2 * RAISE_TO - BB, NextActionSeat: 5 }),
    action(5, FOLD, 0, BACKDROP_CHIPS_AFTER_ANTE[5]!, { Pot: pot0 + RAISE_TO, MinRaise: 2 * RAISE_TO - BB, NextActionSeat: 0 }),
    action(0, FOLD, SB, BACKDROP_CHIPS_AFTER_ANTE[0]! - SB, { Pot: pot0 + RAISE_TO, MinRaise: 2 * RAISE_TO - BB, NextActionSeat: heroSeat }),
  ]

  const out = [...kept, ...synthetic].map((e) => JSON.stringify(e)).join('\n') + '\n'
  // e2e/.build/ is gitignored and absent on a fresh checkout -- create it
  // before writing into it so `npx tsx e2e/tools/capture-store-imagery.ts`
  // (the documented invocation) doesn't throw ENOENT as its first act.
  mkdirSync(BUILD_DIR, { recursive: true })
  writeFileSync(DERIVED_FIXTURE, out)
  return DERIVED_FIXTURE
}

// ---------------------------------------------------------------------------
// Capture choreography
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Races `promise` against a timeout so a step that depends on something
 * that may never happen (e.g. the fixture page never opening its replay
 * WebSocket, because the extension failed to load/inject) fails with a
 * diagnosable error instead of hanging this script -- and the harness's
 * `finally` cleanup -- forever. Mirrors `withTimeout` in
 * e2e/scenarios/smoke.ts, which wraps the same `waitForReplayDone()` call
 * for the identical failure mode.
 */
export const withTimeout = <T,>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> =>
  new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms -- did the fixture page open its replay WebSocket? (extension missing/not loaded, or the page failed to hook the WS)`)),
      timeoutMs
    )
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value) },
      (err) => { clearTimeout(timer); reject(err) }
    )
  })

/** Waits until the fixture page has received every replayed WS frame. */
const waitForReplayEvents = async (h: Harness, total: number): Promise<void> => {
  await h.gamePage.waitForFunction(
    (n: number) => (window as any).__e2eReplayEvents >= n,
    { timeout: 30000 },
    total
  )
}

/**
 * Seeds the per-seat HUD panel positions (and the real-time panel's) through
 * the extension's own chrome.storage.sync persistence, sized against the
 * panels' measured pixel heights so each panel's edge sits PLATE_GAP_PX from
 * its plate edge at the given viewport.
 */
interface SeatOverride {
  /** Override the anchor's x (percent). */
  x?: number
  /** Position for this panel height (px) instead of the measured compact one. */
  panelHeight?: number
}

const seedPositions = async (
  h: Harness,
  viewport: { width: number; height: number },
  overrides?: Record<number, SeatOverride>
): Promise<void> => {
  const heights: number[] = await h.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid=hud-panel]')).map((p) => p.getBoundingClientRect().height)
  )
  if (heights.length !== 6) throw new Error(`expected 6 HUD panels, got ${heights.length}`)

  const seed: Record<string, { top: string; left: string }> = {}
  SEAT_ANCHORS.forEach((anchor, displaySeat) => {
    const override = overrides?.[displaySeat]
    const panelHeight = override?.panelHeight ?? heights[displaySeat]!
    const half = (panelHeight / 2 + PLATE_GAP_PX) / viewport.height * 100
    const top = 'plateTopY' in anchor
      ? anchor.plateTopY - half // hero: panel bottom just above the plate
      : anchor.plateBottomY + half // others: panel top just under the plate
    const left = override?.x ?? anchor.x
    seed[`hudPosition_${displaySeat}`] = { top: `${top.toFixed(2)}%`, left: `${left}%` }
  })
  seed['hudPosition_100'] = { top: `${REALTIME_ANCHOR.y}%`, left: `${REALTIME_ANCHOR.x}%` } // real-time panel (seat 0 + 100 offset)

  const popup = await h.openPopup()
  await popup.evaluate(
    (s: Record<string, unknown>) => new Promise<void>((res) => chrome.storage.sync.set(s, () => res())),
    seed
  )
  await popup.close()
}

/** Removes the fixture page's own debug status line so it never appears in imagery. */
const hideStatusLine = (h: Harness) => h.evaluate(() => { document.getElementById('e2e-status')?.remove() })

/** Expands プレイヤーC's (display seat 3) compact panel into the full 16-stat grid. */
const expandPanelGrid = (h: Harness, displaySeat: number) => h.evaluate((i: number) => {
  const panel = document.querySelectorAll('[data-testid=hud-panel]')[i]!
  ;(panel.querySelector('[data-stat-id="vpip"]') as HTMLElement).click()
}, displaySeat)

/** Toggles the positional drill-down panel on the given display seat. */
const togglePositional = (h: Harness, displaySeat: number) => h.evaluate((i: number) => {
  const panel = document.querySelectorAll('[data-testid=hud-panel]')[i]!
  ;(panel.querySelector('button[title="ポジション別スタッツ"]') as HTMLElement).click()
}, displaySeat)

interface ShotPlan {
  viewport: { width: number; height: number }
  shots: Array<{ path: string; compose: (h: Harness) => Promise<void> }>
}

/**
 * Per-event replay delay. A zero-delay replay overwhelms the live pipeline
 * and silently drops most hand boundaries (observed: HAND (5) instead of
 * (28) for this very fixture); 30ms paces the ~360 events across ~11s,
 * which processes losslessly.
 */
const REPLAY_DELAY_MS = 30

const runPlan = async (fixturePath: string, totalEvents: number, plan: ShotPlan): Promise<void> => {
  const h = await launchHarness({ viewport: plan.viewport, fixturePath, replayDelayMs: REPLAY_DELAY_MS })
  try {
    await h.waitForHudMount()
    // Bounded: if the fixture page never opens its WebSocket, the harness's
    // replayDone promise would otherwise never settle and this script would
    // hang before ever reaching the `finally` cleanup below (see smoke.ts's
    // identical guard around the same call).
    await withTimeout(h.waitForReplayDone(), 20000, 'fixture replay')
    await sleep(1500)

    await seedPositions(h, plan.viewport)
    await h.gamePage.reload({ waitUntil: 'domcontentloaded' })
    await h.waitForHudMount()
    await waitForReplayEvents(h, totalEvents)
    await sleep(1500)
    await hideStatusLine(h)

    // Stats sanity + idempotence guard: after the second replay the hero's
    // HAND count must still be ~KEEP_HANDS (the paced replay is lossless
    // modulo the source's first, partial-info hand; a double count -- e.g.
    // 2x hands -- would mean the replay stopped being idempotent).
    const heroHands: string = await h.evaluate(() => {
      const hero = document.querySelectorAll('[data-testid=hud-panel]')[0]!
      return (hero.querySelector('[data-stat-id="hands"]') as HTMLElement).innerText
    })
    const handCount = Number(heroHands.replace(/[()]/g, ''))
    if (!(handCount >= KEEP_HANDS - 2 && handCount <= KEEP_HANDS)) {
      throw new Error(`hero HAND stat is ${heroHands}, expected ~(${KEEP_HANDS}) -- lossy or non-idempotent replay?`)
    }

    for (const shot of plan.shots) {
      await shot.compose(h)
      await sleep(600)
      await h.screenshot(shot.path)
      console.log(`[capture-store-imagery] wrote ${shot.path}`)
    }
  } finally {
    await h.close()
  }
}

const main = async (): Promise<void> => {
  const fixturePath = buildStoreFixture()
  const totalEvents = readFileSync(fixturePath, 'utf8').trim().split('\n').length
  console.log(`[capture-store-imagery] derived fixture: ${fixturePath} (${totalEvents} events)`)

  // Chrome Web Store screenshots: exactly 1280x800.
  //
  // Shot order is deliberately MONOTONIC (each shot only ever ADDS DOM
  // content relative to the previous one, never removes/shrinks it) to
  // dodge a real Chrome-for-Testing-151-headless screenshot staleness bug
  // found while building this tool: closing プレイヤーC's positional
  // drill-down (unmounting `PositionalStatsPanel`, confirmed via `evaluate`
  // -- `aria-expanded` flips to `false`, `document.body.outerHTML.length`
  // shrinks by ~7.6kB) does NOT get picked up by the next
  // `target.screenshot()` -- the PNG keeps showing the drill-down, even
  // after a 3s wait and multiple back-to-back screenshot calls. `evaluate`
  // (and everything else) sees the correct, current DOM throughout; only
  // the captured pixels are stale, which points at the same
  // idle-compositor-class CDP `Page.captureScreenshot` bug documented in
  // `e2e/README.md`'s "Flaky bits" -- just triggered by a shrinking
  // repaint instead of an idle page. No amount of extra delay fixed it in
  // testing, so the shots below never ask for one. store-5 (grid expanded,
  // no drill-down, hand log hovered) is captured BEFORE store-2 (same grid
  // state, drill-down additionally opened) so store-2 only ever adds the
  // drill-down on top of already-correctly-rendered content.
  await runPlan(fixturePath, totalEvents, {
    viewport: { width: 1280, height: 800 },
    shots: [
      { path: join(REPO_ROOT, 'docs', 'store-assets', 'store-1-hud.png'), compose: async () => {} },
      {
        path: join(REPO_ROOT, 'docs', 'store-assets', 'store-5-handlog.png'),
        compose: async (h) => {
          await expandPanelGrid(h, 3)
          // Hover the hand log (bottom-right, DEFAULT_HAND_LOG_CONFIG:
          // width 400 / height 100 / bottom 135 / right 10, so at 1280x800
          // it occupies x:[870,1270] y:[565,665]) so it expands to half
          // height. A point outside those bounds (as an earlier version of
          // this tool used) never triggers the panel's onMouseEnter at all.
          await h.gamePage.mouse.move(1070, 615)
        },
      },
      {
        path: join(REPO_ROOT, 'docs', 'store-assets', 'store-2-drilldown.png'),
        compose: async (h) => {
          await h.gamePage.mouse.move(50, 50) // un-hover the hand log from the previous shot
          await togglePositional(h, 3) // grid stays expanded from the previous shot; only add the drill-down
        },
      },
    ],
  })

  // README hero image: 1920x1080 (game-realistic viewport).
  await runPlan(fixturePath, totalEvents, {
    viewport: { width: 1920, height: 1080 },
    shots: [
      {
        path: join(REPO_ROOT, 'README.png'),
        compose: async (h) => { await expandPanelGrid(h, 3); await togglePositional(h, 3) },
      },
    ],
  })
}

// Guard so this module can be imported (e.g. from a test, to exercise
// `buildStoreFixture`/`withTimeout` in isolation) without also kicking off
// the full launch-Chrome-and-screenshot pipeline as an import side effect --
// same pattern as build-e2e.ts/generate-e2e-manifest.ts/extract-fixture.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[capture-store-imagery] FAILED:', err)
    process.exitCode = 1
  })
}
