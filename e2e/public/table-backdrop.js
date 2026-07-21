/**
 * Real-gameplay backdrop for the E2E fixture pages.
 *
 * Presentation only -- gives visual context to HUD screenshots/QA sessions
 * ("this overlays a real poker game", not a void). The backdrop is a real
 * PokerChase 6-max table screenshot (owner-provided, hero holding K♦K♣ at
 * the BB preflop facing a raise), cropped strictly to the game page
 * viewport (no macOS window chrome, browser tab strip, URL bar, or rounded
 * window corners) and with ALL SIX seat name plates anonymized in-image
 * (hero -> "Hero", opponents -> プレイヤーA..E, drawn natively over the
 * original plates). It replaced the earlier ORIGINAL canvas-drawn generic
 * table (felt oval + seat plates + CSS props) per owner direction: README /
 * Chrome Web Store imagery should show the HUD over the real game, not a
 * synthetic stand-in. Asset: `e2e/public/assets/table-backdrop.jpg`
 * (3452x1992, 2x of the game's ~1726x996 logical viewport).
 *
 * Stretch, not cover: the <img> uses `object-fit: fill`, so the screenshot
 * is stretched independently in x/y to fill any viewport aspect exactly
 * (the asset is ~1.73:1; the README shot is 16:9, the store shots 16:10).
 * That slight distortion is deliberate -- it keeps every in-image seat
 * plate at a FIXED percentage position of the viewport, the same
 * percentage-of-viewport scheme `Hud.tsx`'s SEAT_POSITIONS / saved
 * `hudPosition_<seat>` positions use, so HUD panels can be aligned to the
 * baked-in seats at ANY viewport size (see
 * e2e/tools/capture-store-imagery.ts for the seat anchor table).
 *
 * Hero hole cards are baked into the screenshot (K♦K♣). For imagery whose
 * HUD content must not contradict them, replay a fixture whose final hero
 * hand is KK -- `e2e/tools/capture-store-imagery.ts` derives one
 * deterministically. (The old canvas backdrop's `?heroCards=`/`?heroLabel=`
 * params died with it -- cards are no longer drawn by this script.)
 *
 * Entirely inert w.r.t. the extension: it never touches window.WebSocket,
 * never adds elements matching any smoke-scenario selector, sits OUTSIDE
 * `#unity-container` (a sibling, not a child -- see below) so it can never
 * be confused with the HUD's own mount there, and sits at a lower z-index
 * (1) than the HUD's own overlay (9999, see Hud.tsx), with
 * pointer-events:none so it can never intercept a click/hover the HUD or
 * popup would otherwise receive.
 *
 * Why a sibling, not a child of #unity-container: `e2e/harness.ts`'s
 * `waitForHudMount()` polls for
 * `container.children.length > 0 && container.querySelector('[style*="position: fixed"]')`
 * on `#unity-container` as its proxy for "the HUD actually mounted"
 * (App.tsx mounts a child div there, and Hud.tsx's own panel wrapper has
 * an inline `position: fixed` style). This backdrop's wrapper also uses
 * `position:fixed` (so it fills the viewport regardless of
 * `#unity-container`'s own box); if it were inserted as a child of
 * `#unity-container`, it alone would satisfy both conditions the instant
 * this script runs -- before the extension's content script even mounts App
 * -- making `waitForHudMount()` (and thus `npm run e2e:smoke` /
 * `npx tsx e2e/run.ts wait-hud`) report a false mount. Mounting as a
 * preceding sibling keeps `#unity-container`'s own subtree exactly what it
 * was pre-backdrop (empty until App actually mounts), while still rendering
 * visually behind it purely via z-index (`position:fixed` stacking is
 * viewport-relative regardless of DOM parent).
 *
 * Default OFF (scene-neutral, bare page): the normal e2e paths --
 * `smoke.ts` and `run.ts`, both of which replay `DEFAULT_FIXTURE`
 * (`session-3hands.ndjson`) unless told otherwise -- end on hero's real
 * J♣8♦ hand, which would directly contradict this backdrop's baked-in
 * K♦K♣ preflop-raise scene if it were painted underneath by default.
 * Append `?backdrop=1` to the fixture URL to opt in; only
 * `e2e/tools/capture-store-imagery.ts` does, via `launchHarness`'s
 * `fixtureQuery` option, because it derives its own fixture specifically to
 * match this scene (see that file's module doc comment).
 */
;(function () {
  var params = new URLSearchParams(location.search)
  if (params.get('backdrop') !== '1') return

  var container = document.getElementById('unity-container')
  if (!container || !container.parentNode) return

  var wrap = document.createElement('div')
  wrap.id = 'e2e-table-backdrop'
  wrap.setAttribute('aria-hidden', 'true')
  wrap.style.cssText = 'position:fixed;inset:0;z-index:1;pointer-events:none;overflow:hidden;'

  var img = document.createElement('img')
  img.src = 'assets/table-backdrop.jpg'
  img.alt = ''
  img.style.cssText = 'display:block;width:100%;height:100%;object-fit:fill;'
  wrap.appendChild(img)

  // Sibling of #unity-container (inserted immediately before it), NOT a
  // child -- see the "Why a sibling, not a child" doc comment above.
  container.parentNode.insertBefore(wrap, container)
})()
