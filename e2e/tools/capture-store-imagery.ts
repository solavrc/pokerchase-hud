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
 * Builds the e2e extension itself (same `buildE2E()` call `smoke.ts` makes)
 * before launching, so the command above works standalone on a fresh
 * checkout without a separate `npm run build:e2e` first.
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
 *      - keep the first 11 complete hands, NOT the SNG's full 29-hand,
 *        full-6-seat stretch (first bust at hand 30) -- the donor fixture's
 *        own blind level climbs every few hands (Lv1 100/200/50 for hands
 *        1-4, Lv2 140/280/70 -- the backdrop's own stakes -- for hands
 *        5-11, Lv3 200/400/100 from hand 12 on), and the hand log panel's
 *        visible tail shows whichever real hand is retained immediately
 *        before the appended synthetic one verbatim (its own "posts ...",
 *        blind/ante lines, read from that hand's own EVT_DEAL
 *        `Game.SmallBlind`/`BigBlind`/`Ante`, not from anything this tool
 *        controls). Cutting at hand 11 -- the last Lv2 hand -- means every
 *        real hand left visible in the log already carries the backdrop's
 *        own 140/280/70, so it never contradicts the synthetic hand
 *        appended after it; hands 1-11 are still well within the
 *        full-6-seat stretch, so no seat is busted/empty;
 *      - rename the anonymized players to the same dummy names baked onto
 *        the backdrop's plates (Hero / プレイヤーA..E), keyed by display
 *        position so every HUD panel name matches the plate it sits on;
 *      - append one synthetic partial hand built to match the backdrop's
 *        own numbers rather than continuing the source fixture's chip
 *        progression: SB/BB/ante 140/280/70, each seat's post-ante chip stack
 *        read off its nameplate (`BACKDROP_CHIPS_AFTER_ANTE`), hero posts
 *        the BB with HoleCards [46, 47] (K♦K♣ per src/utils/card-utils.ts's
 *        rank=floor(card/4), suit=card%4 encoding). Preflop action follows
 *        genuine seat order (button=5, SB=0, BB=hero=1, so it opens at seat
 *        2/UTG): UTG/MP (seats 2, 3) fold, プレイヤーC (seat 4, CO) limps in
 *        for the bare BB rather than folding or raising yet, BTN/SB (seats
 *        5, 0) fold, and only THEN does hero -- last to act as BB -- raise
 *        her own blind to 1,400 (a distinct EVT_ACTION, not just baked into
 *        her posted BetChip -- see HERO_ALREADY_COMMITTED below) so the hand
 *        log actually narrates how her chips got in. That raise reopens the
 *        action to プレイヤーC, the only other player still live, who
 *        re-raises to 7,840 (matching her bet stack in the screenshot), and
 *        the replay stops there with the action back on the hero -- exactly
 *        the preflop raise-vs-BB spot the screenshot shows. No
 *        EVT_HAND_RESULTS is appended, so the partial hand never pollutes
 *        per-player stats; it only drives the hand log tail + real-time KK
 *        panel.
 *
 * The fixture replays twice per session (once on the initial navigation,
 * once after the position-seeding reload); that is idempotent for stats --
 * hand/phase/action entities are keyed by HandId and bulkPut'ed, and
 * apiEvents dedupes on timestamp+ApiTypeId -- which the tool asserts by
 * checking the hero panel's HAND stat is exactly KEEP_HANDS after the reload.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchHarness, type Harness } from '../harness.ts'
import { E2E_DIR, REPO_ROOT, BUILD_DIR } from '../config.ts'
import { buildE2E } from './build-e2e.ts'

const SRC_FIXTURE = join(E2E_DIR, 'fixtures', 'session-bust.ndjson')
const DERIVED_FIXTURE = join(BUILD_DIR, 'store-imagery-fixture.ndjson')

/**
 * Complete hands to keep from the source fixture: through its last hand at
 * the SAME blind level the backdrop shows (Lv2, SB/BB/ante 140/280/70),
 * NOT its whole full-6-seat stretch (which runs through hand 29, climbing
 * blind levels along the way -- see the module doc comment above).
 */
const KEEP_HANDS = 11

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
  // badge). Button is seat 5, so preflop action opens at seat 2 (UTG) and
  // runs 2 -> 3 -> 4 -> 5 -> 0 -> 1 (hero, BB, last to act in this first
  // pass) -- see HERO_ALREADY_COMMITTED below for why hero and プレイヤーC
  // (seat 4) each get a second turn once that first pass closes.
  const SB = 140, BB = 280, ANTE = 70
  const sbSeat = 0, bbSeat = heroSeat, btnSeat = 5

  // Hero's own pre-raise commitment, read off the chip stack baked directly
  // onto the felt in front of her BB badge in the screenshot ("1,400" --
  // distinct from, and 5x, the official BB of 280; the backdrop's own real
  // hand history that produced this frame isn't available to this tool, so
  // this is taken as given rather than re-derived). Because
  // HandLogProcessor.handleDealEvent() always sources the "posts big blind"
  // line's displayed amount from `Game.BigBlind` (never from a seat's
  // `Chip`/`BetChip`), this can't be baked into the EVT_DEAL Player's own
  // `BetChip` -- it has to be a genuine EVT_ACTION raise (`heroCommit`
  // below) so HandLogProcessor.formatAction() actually narrates it
  // ("Hero: raises 1,120 to 1,400"). And because hero is the BB, she's the
  // LAST seat to act in the first preflop pass (2 -> 3 -> 4 -> 5 -> 0 -> 1)
  // -- she can only raise here at all once everyone ahead of her has
  // folded or limped, never as her first action off the deal (that was the
  // bug this fixes: an impossible BB-acts-first order -- see the review
  // finding this addresses). The only seat still live in front of her
  // after that first pass is プレイヤーC (seat 4), who limps in for the bare
  // BB below instead of folding or raising, so when hero raises to 1,400
  // the action reopens to プレイヤーC alone, who then re-raises to the
  // backdrop's baked-in 7,840 (RAISE_TO below). This constant still feeds
  // the same pot/call arithmetic the backdrop's action bar pins to: Pot
  // 9,800, and Hero's own call cost 6,440 (= RAISE_TO 7,840 - 1,400). Both
  // are asserted by construction below.
  const HERO_ALREADY_COMMITTED = 1400
  // Pot right after blinds + antes only (before any preflop action) --
  // this is the EVT_DEAL snapshot's Pot.
  const potAfterBlinds = SB + BB + 6 * ANTE
  // Pot after プレイヤーC limps in for the bare BB (her first action, seat
  // order permitting -- see HERO_ALREADY_COMMITTED above).
  const potAfterCCall = potAfterBlinds + BB
  // Pot after hero's own raise (to HERO_ALREADY_COMMITTED) closes out the
  // first pass.
  const potAfterHeroRaise = potAfterCCall + (HERO_ALREADY_COMMITTED - BB)
  // Pot after プレイヤーC's reopened re-raise to RAISE_TO (defined below,
  // alongside BACKDROP_CHIPS_AFTER_ANTE) -- must land on the backdrop's own
  // baked-in "Pot : 9,800", asserted once RAISE_TO is in scope.
  let ts = kept[kept.length - 1]!.timestamp as number

  const progress = (over: Record<string, unknown>) => ({
    Phase: 0, SidePot: [], NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 12, ...over,
  })

  /**
   * Chip stack behind each seat right after antes (and, for the SB seat,
   * its blind; for the BB/hero seat, HERO_ALREADY_COMMITTED) are posted --
   * i.e. exactly what's printed in each seat's nameplate on the backdrop at
   * the moment it was captured, EXCEPT プレイヤーC (seat 4), whose plate
   * already shows her stack AFTER the raise below (14,579); her pre-raise,
   * post-ante figure (22,419) is derived here as 14,579 + RAISE_TO so the
   * deal event -- which predates her raise -- is itself consistent. Keyed
   * by original seat index (same indexing as `seatUserIds`), not display
   * position. Hardcoded straight from the screenshot rather than derived
   * from the source fixture's
   * closing chip counts (which belong to an unrelated real hand and have
   * no relationship to this backdrop) -- see the finding this fixes:
   * synthetic stakes/stacks must match the scene, not just continue
   * whatever the donor fixture happened to have.
   */
  const RAISE_TO = 7840 // matches the bet stack under プレイヤーC's raise
  const BACKDROP_CHIPS_AFTER_ANTE: Record<number, number> = {
    0: 17790 + SB, // プレイヤーE (SB): plate shows 17,790 (post ante+SB)
    // Hero (BB): plate shows 21,974 (post ante+her actual 1,400 commit, not
    // just the 280 BB -- see HERO_ALREADY_COMMITTED above). Cross-checks
    // against a second baked-in number: 21,974 + 1,400 = 23,374, exactly
    // the store screenshot's "レイズ 23,374" all-in button (Hero's total
    // stack = her remaining chips plus what she's already committed).
    [heroSeat]: 21974 + HERO_ALREADY_COMMITTED,
    2: 21818, // プレイヤーA: plate shows 21,818 (post ante, folded before betting)
    3: 18830, // プレイヤーB: plate shows 18,830 (post ante, folded before betting)
    4: 14579 + RAISE_TO, // プレイヤーC: plate shows 14,579 (post ante+raise)
    5: 15209, // プレイヤーD (button): plate shows 15,209 (post ante, folded before betting)
  }

  // Pot after プレイヤーC's reopened re-raise to RAISE_TO -- must land on
  // the backdrop's own baked-in "Pot : 9,800" (see potAfterHeroRaise above
  // for the earlier stages of this same sum: blinds+antes, then プレイヤーC's
  // limp, then hero's raise).
  const potAfterCRaise = potAfterHeroRaise + (RAISE_TO - BB)
  if (potAfterCRaise !== 9800) {
    throw new Error(`synthetic pot arithmetic drifted from the backdrop's baked-in 9,800 (got ${potAfterCRaise}) -- check SB/BB/ANTE/HERO_ALREADY_COMMITTED/RAISE_TO`)
  }

  const deal: ApiEventRecord = {
    ApiTypeId: 303,
    timestamp: (ts += 2000),
    SeatUserIds: seatUserIds,
    Game: {
      CurrentBlindLv: 2, SmallBlind: SB, BigBlind: BB, Ante: ANTE,
      ButtonSeat: btnSeat, SmallBlindSeat: sbSeat, BigBlindSeat: bbSeat,
      NextBlindUnixSeconds: Math.floor(ts / 1000) + 300,
    },
    Player: {
      // Only the official BB (280) is posted here -- her extra 1,120 is a
      // separate EVT_ACTION (`heroCommit` below), not baked into this
      // event's BetChip, so it shows up in the hand log (see
      // HERO_ALREADY_COMMITTED above). `Chip + BetChip` still sums to
      // BACKDROP_CHIPS_AFTER_ANTE[heroSeat] (her post-ante stack), matching
      // HandLogProcessor.getPlayerChipsAfterAnte()'s expectation and
      // leaving the Seat-line stack total (and the "レイズ 23,374" all-in
      // cross-check) unaffected by this split.
      SeatIndex: heroSeat, BetStatus: 1, HoleCards: HERO_HOLE_CARDS,
      Chip: BACKDROP_CHIPS_AFTER_ANTE[heroSeat]! - BB, BetChip: BB,
    },
    OtherPlayers: [0, 2, 3, 4, 5].map((seat) => ({
      SeatIndex: seat, Status: 0, BetStatus: 1,
      Chip: BACKDROP_CHIPS_AFTER_ANTE[seat]! - (seat === sbSeat ? SB : 0),
      BetChip: seat === sbSeat ? SB : 0,
    })),
    // Preflop action opens at seat 2 (UTG), the seat immediately left of
    // hero's own BB -- NOT at hero's own seat (see HERO_ALREADY_COMMITTED's
    // doc comment above for why hero can't act first).
    Progress: progress({ Pot: potAfterBlinds, MinRaise: 2 * BB, NextActionSeat: 2 }),
  }

  const action = (seat: number, type: number, betChip: number, chip: number, over: Record<string, unknown>): ApiEventRecord => ({
    ApiTypeId: 304, timestamp: (ts += 1500), SeatIndex: seat, ActionType: type,
    BetChip: betChip, Chip: chip, Progress: progress(over),
  })

  const FOLD = 2, CALL = 3, RAISE = 4

  // Hero's own preflop raise, from her posted BB (280) up to the backdrop's
  // baked-in 1,400 (HERO_ALREADY_COMMITTED) -- see that constant's doc
  // comment above for why this needs to be a distinct EVT_ACTION rather
  // than folded into the deal event's BetChip, and why it can only happen
  // once the first pass (2 -> 3 -> 4 -> 5 -> 0) has already closed on hero.
  // HandLogProcessor.formatAction() derives the printed raise amount from
  // the prior "posts big blind" line (still only 280 at this point --
  // プレイヤーC's own limp call below doesn't touch it, only bet/raise lines
  // do), so this renders as "Hero: raises 1,120 to 1,400" -- and because
  // it's the most recent bet/raise line, it reopens the action to プレイヤー
  // C (the only other player still live), whose own re-raise below is in
  // turn computed relative to 1,400, not 280.
  const heroCommit = action(
    heroSeat, RAISE, HERO_ALREADY_COMMITTED, BACKDROP_CHIPS_AFTER_ANTE[heroSeat]! - HERO_ALREADY_COMMITTED,
    { Pot: potAfterHeroRaise, MinRaise: 2 * HERO_ALREADY_COMMITTED - BB, NextActionSeat: 4 }
  )

  const synthetic = [
    deal,
    action(2, FOLD, 0, BACKDROP_CHIPS_AFTER_ANTE[2]!, { Pot: potAfterBlinds, MinRaise: 2 * BB, NextActionSeat: 3 }),
    action(3, FOLD, 0, BACKDROP_CHIPS_AFTER_ANTE[3]!, { Pot: potAfterBlinds, MinRaise: 2 * BB, NextActionSeat: 4 }),
    // プレイヤーC limps in for the bare BB rather than folding or opening a
    // raise herself -- her own raise only makes sense as a RE-raise once
    // hero has committed 1,400 (see HERO_ALREADY_COMMITTED's doc comment
    // above), so her first turn here has to be a call, not that raise.
    action(4, CALL, BB, BACKDROP_CHIPS_AFTER_ANTE[4]! - BB, { Pot: potAfterCCall, MinRaise: 2 * BB, NextActionSeat: 5 }),
    action(5, FOLD, 0, BACKDROP_CHIPS_AFTER_ANTE[5]!, { Pot: potAfterCCall, MinRaise: 2 * BB, NextActionSeat: 0 }),
    action(0, FOLD, SB, BACKDROP_CHIPS_AFTER_ANTE[0]! - SB, { Pot: potAfterCCall, MinRaise: 2 * BB, NextActionSeat: heroSeat }),
    heroCommit,
    // プレイヤーC's reopened re-raise, matching her bet stack in the
    // screenshot (7,840); computed against hero's 1,400 (the most recent
    // bet/raise line), it renders as "raises 6,440 to 7,840" -- exactly the
    // backdrop's baked-in pending-call amount. Replay stops here, action
    // back on hero.
    action(4, RAISE, RAISE_TO, BACKDROP_CHIPS_AFTER_ANTE[4]! - RAISE_TO, { Pot: potAfterCRaise, MinRaise: 2 * RAISE_TO - HERO_ALREADY_COMMITTED, NextActionSeat: heroSeat }),
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
  // The real-gameplay backdrop (table-backdrop.js) is opt-in, off by
  // default, so the normal e2e paths (smoke.ts / run.ts, replaying
  // DEFAULT_FIXTURE) never paint a scene their own replayed hand
  // contradicts -- see that file's module doc comment. This tool's own
  // fixture is derived specifically to match the backdrop's baked-in KK
  // scene, so it explicitly opts in here via `fixtureQuery`.
  const h = await launchHarness({ viewport: plan.viewport, fixturePath, replayDelayMs: REPLAY_DELAY_MS, fixtureQuery: 'backdrop=1' })
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
  // On a fresh checkout (or after cleaning e2e/.build/), e2e/.build/extension/
  // doesn't exist yet -- launchHarness() defaults to loading it regardless,
  // so without building it first Chrome starts with no extension, the
  // replay hook never appears, and every wait below eventually times out.
  // smoke.ts calls this same buildE2E() before launching for the identical
  // reason; mirrored here so the documented
  // `npx tsx e2e/tools/capture-store-imagery.ts` invocation works standalone.
  console.log('[capture-store-imagery] building e2e extension (npm run build:e2e logic)...')
  const extensionDir = buildE2E()
  console.log(`[capture-store-imagery] extension built at ${extensionDir}`)

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
