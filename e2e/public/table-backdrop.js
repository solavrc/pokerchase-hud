/**
 * ORIGINAL, generic poker-table backdrop for the E2E fixture pages.
 *
 * Presentation only -- gives visual context to HUD screenshots/QA sessions
 * ("this overlays a real poker game", not a void). Nothing here is
 * PokerChase artwork: no character art, no logos, no UI copied from the
 * game -- just a felt table, seat plates, chips, and generic card faces
 * built from CSS + inline SVG.
 *
 * The seat plate / chip positions intentionally reuse SEAT_POSITIONS from
 * src/components/Hud.tsx (the HUD's own default per-seat panel anchors) so
 * each plate sits visually paired with (mostly behind) its panel:
 *   0: {top:65%, left:65%}   1: {top:70%, left:10%}   2: {top:35%, left:10%}
 *   3: {top:20%, left:65%}   4: {top:35%, left:90%}   5: {top:70%, left:90%}
 * If those defaults ever change, update SEAT_POSITIONS below to match.
 *
 * Positioning: every prop (seat plate, card back, chip stack, dealer
 * button, pot, hero cards) is a plain HTML/CSS element anchored with
 * top/left PERCENTAGES -- the same percentage-of-viewport scheme Hud.tsx
 * uses for its own panels -- with any decorative offset from that anchor
 * expressed in fixed px via `calc()`. That keeps every prop paired with its
 * seat's HUD panel at ANY viewport aspect ratio, not just 16:9 (see
 * table-backdrop.js:83 history: an earlier version positioned everything
 * inside one 1920x1080-viewBox SVG with `preserveAspectRatio="xMidYMid
 * slice"`, which crops/misaligns on non-16:9 viewports -- e.g. the
 * documented 1280x800 store-image viewport is 16:10, not 16:9). Only the
 * felt/table art itself (background, oval felt, rail rim, vignette) stays
 * in an SVG, and that SVG uses `preserveAspectRatio="none"` (stretch, not
 * slice) so it fills the viewport exactly with no crop -- acceptable for
 * background art that has no HUD-alignment requirement.
 *
 * Default ON. Append `?plain=1` to the fixture URL to render the old plain
 * felt-void page (e.g. for a scenario that specifically needs sterility).
 *
 * Hero hole cards (bottom-center) are configurable via `?heroCards=<4
 * chars>` (rank+suit, rank+suit -- e.g. `Qd4h`, suit letters s/h/d/c) and
 * `?heroLabel=<text>` (e.g. `Q4+オフスート`, `+` decodes to a space). The
 * DEFAULT (no query params) is `Jc8d` / "J8 オフスート", which is this
 * repo's committed `e2e/fixtures/session-3hands.ndjson` fixture's actual
 * FINAL hero hand -- decoded straight from the fixture: its third (last)
 * `ApiTypeId:303` (EVT_DEAL) event carries `Player.HoleCards:[39,26]`
 * (the first EVT_DEAL has `HoleCards:[]` -- table-move/no-Player case per
 * docs/api-events.md -- and the second is an earlier, non-final hand with
 * `HoleCards:[22,28]`). Per src/utils/card-utils.ts's encoding
 * (rank = floor(card/4) into '2'..'A', suit = card%4 into s/h/d/c):
 * 39 -> rank 9 ('J'), suit 3 ('c') -> Jc; 26 -> rank 6 ('8'), suit 2 ('d')
 * -> 8d. So the committed fixture's out-of-box replay ends on hero holding
 * J♣8♦ ("J8 オフスート"), which is what an unmodified `npm run e2e:smoke` /
 * `wait-hud` session actually shows -- keep this in sync if the fixture
 * ever changes. The *other* documented recipe, the gitignored 400-hand
 * fixture used for the committed README.png / store-assets screenshots,
 * has a different final hero hand (Q♦4♥, cards 42/9) and passes it
 * explicitly via these same query params -- see
 * e2e/.build/capture-table-backdrop.ts (not committed; e2e/.build/ is
 * gitignored).
 *
 * Entirely inert w.r.t. the extension: it never touches window.WebSocket,
 * never adds elements matching any smoke-scenario selector, sits OUTSIDE
 * `#unity-container` (a sibling, not a child -- see below) so it can never
 * be confused with the HUD's own mount there, and sits at a lower z-index
 * (1) than the HUD's own overlay (9999, see Hud.tsx), with
 * pointer-events:none throughout so it can never intercept a click/hover
 * the HUD or popup would otherwise receive.
 *
 * Why a sibling, not a child of #unity-container: `e2e/harness.ts`'s
 * `waitForHudMount()` polls for
 * `container.children.length > 0 && container.querySelector('[style*="position: fixed"]')`
 * on `#unity-container` as its proxy for "the HUD actually mounted"
 * (App.tsx mounts a child div there, and Hud.tsx's own panel wrapper has
 * an inline `position: fixed` style). This backdrop's wrapper also uses
 * `position:fixed` (so it fills the viewport regardless of
 * `#unity-container`'s own box); if it were inserted as a child of
 * `#unity-container` (as an earlier version did), it alone would satisfy
 * both conditions the instant this script runs -- before the extension's
 * content script even mounts App -- making `waitForHudMount()` (and thus
 * `npm run e2e:smoke` / `npx tsx e2e/run.ts wait-hud`) report a false
 * mount and let scripted QA proceed too early. Mounting as a preceding
 * sibling of `#unity-container` instead keeps `#unity-container`'s own
 * subtree exactly what it was pre-backdrop (empty until App actually
 * mounts), while still rendering visually behind it purely via z-index
 * (`position:fixed` stacking is viewport-relative regardless of DOM
 * parent, so sibling-vs-child makes no visual difference here).
 */
;(function () {
  var params = new URLSearchParams(location.search)
  if (params.get('plain') === '1') return

  var container = document.getElementById('unity-container')
  if (!container || !container.parentNode) return

  // Percentages of the viewport, same anchors Hud.tsx's SEAT_POSITIONS uses.
  var SEAT_POSITIONS = [
    { top: 65, left: 65 }, // 0: hero
    { top: 70, left: 10 }, // 1
    { top: 35, left: 10 }, // 2
    { top: 20, left: 65 }, // 3
    { top: 35, left: 90 }, // 4
    { top: 70, left: 90 }, // 5
  ]

  // ---- hero cards (query-param configurable, see doc comment above) ----
  var DEFAULT_HERO_CARDS = 'Jc8d'
  var DEFAULT_HERO_LABEL = 'J8 オフスート'
  var SUIT_SYMBOLS = { s: '♠', h: '♥', d: '♦', c: '♣' }
  var CARD_RE = /^([2-9TJQKA][shdc]){2}$/i

  var parseHeroCards = function (raw) {
    if (!raw || !CARD_RE.test(raw)) return null
    return [raw.slice(0, 2), raw.slice(2, 4)].map(function (tok) {
      return { rank: tok.charAt(0).toUpperCase(), suit: SUIT_SYMBOLS[tok.charAt(1).toLowerCase()] }
    })
  }

  var heroCards = parseHeroCards(params.get('heroCards')) || parseHeroCards(DEFAULT_HERO_CARDS)
  var heroLabel = params.get('heroLabel') || DEFAULT_HERO_LABEL

  var svgNS = 'http://www.w3.org/2000/svg'

  // ---- felt/table art: the only piece that stays inside a scaled SVG ----
  var buildFeltSvg = function () {
    var VB_W = 1920
    var VB_H = 1080
    var parts = []
    parts.push(
      '<svg xmlns="' + svgNS + '" viewBox="0 0 ' + VB_W + ' ' + VB_H + '" width="100%" height="100%" ' +
      'preserveAspectRatio="none" style="position:absolute;inset:0;display:block;">'
    )

    parts.push(
      '<defs>' +
      '<radialGradient id="e2e-vignette" cx="50%" cy="46%" r="75%">' +
      '<stop offset="0%" stop-color="#000000" stop-opacity="0" />' +
      '<stop offset="72%" stop-color="#000000" stop-opacity="0" />' +
      '<stop offset="100%" stop-color="#000000" stop-opacity="0.72" />' +
      '</radialGradient>' +
      '<radialGradient id="e2e-felt" cx="50%" cy="42%" r="68%">' +
      '<stop offset="0%" stop-color="#1f7a45" />' +
      '<stop offset="60%" stop-color="#14612f" />' +
      '<stop offset="100%" stop-color="#0c421f" />' +
      '</radialGradient>' +
      '</defs>'
    )

    // Room/backdrop base.
    parts.push('<rect x="0" y="0" width="' + VB_W + '" height="' + VB_H + '" fill="#07100a" />')

    // Felt oval + rail rim. `preserveAspectRatio="none"` above stretches
    // this independently in x/y to fill any container aspect -- acceptable
    // for background art with no HUD-alignment requirement (unlike the
    // seat plates/props below, which are positioned outside this SVG).
    var cx = 960, cy = 500, rx = 860, ry = 420
    parts.push('<ellipse cx="' + cx + '" cy="' + cy + '" rx="' + (rx + 34) + '" ry="' + (ry + 34) + '" fill="#3a2415" stroke="#1c1209" stroke-width="6" />')
    parts.push('<ellipse cx="' + cx + '" cy="' + cy + '" rx="' + (rx + 14) + '" ry="' + (ry + 14) + '" fill="#4a2e1a" />')
    parts.push('<ellipse cx="' + cx + '" cy="' + cy + '" rx="' + rx + '" ry="' + ry + '" fill="url(#e2e-felt)" stroke="#0a3319" stroke-width="10" />')
    parts.push('<ellipse cx="' + cx + '" cy="' + cy + '" rx="' + (rx - 26) + '" ry="' + (ry - 26) + '" fill="none" stroke="#2f8a52" stroke-width="2" opacity="0.5" />')

    // Vignette on top.
    parts.push('<rect x="0" y="0" width="' + VB_W + '" height="' + VB_H + '" fill="url(#e2e-vignette)" />')

    parts.push('</svg>')
    return parts.join('')
  }

  // ---- seat plates / props: plain HTML, % anchor + px `calc()` offset ----

  /** `top`/`left` calc() expressions anchored at `seat`'s percentage, offset by `dxPx`/`dyPx`. */
  var anchor = function (seat, dxPx, dyPx) {
    var top = dyPx ? 'calc(' + seat.top + '% + ' + dyPx + 'px)' : seat.top + '%'
    var left = dxPx ? 'calc(' + seat.left + '% + ' + dxPx + 'px)' : seat.left + '%'
    return 'top:' + top + ';left:' + left + ';'
  }

  var seatPlateHtml = function (seat) {
    return '<div style="position:absolute;' + anchor(seat, 0, 0) +
      'transform:translate(-50%,-50%);width:336px;height:140px;border-radius:50%;' +
      'background:#0a2f16;border:2.5px solid #2c7a48;opacity:0.5;"></div>'
  }

  var cardBackHtml = function (seat, dxPx, dyPx, rotateDeg) {
    return '<div style="position:absolute;' + anchor(seat, dxPx, dyPx) +
      'transform:translate(-50%,-50%) rotate(' + rotateDeg + 'deg);width:74px;height:90px;opacity:0.92;">' +
      '<div style="position:absolute;top:0;left:0;width:60px;height:84px;border-radius:7px;' +
      'background:#2a2a2a;border:2.5px solid #e8e8e8;box-sizing:border-box;"></div>' +
      '<div style="position:absolute;top:8px;left:8px;width:44px;height:68px;border-radius:4px;' +
      'border:1.5px solid #c9a24a;box-sizing:border-box;"></div>' +
      '<div style="position:absolute;top:6px;left:14px;width:60px;height:84px;border-radius:7px;' +
      'background:#2a2a2a;border:2.5px solid #e8e8e8;box-sizing:border-box;"></div>' +
      '<div style="position:absolute;top:14px;left:22px;width:44px;height:68px;border-radius:4px;' +
      'border:1.5px solid #c9a24a;box-sizing:border-box;"></div>' +
      '</div>'
  }

  var chipStackHtml = function (seat, dxPx, dyPx, colors, label) {
    var html = '<div style="position:absolute;' + anchor(seat, dxPx, dyPx) + 'transform:translate(-50%,-50%);">'
    for (var i = 0; i < colors.length; i++) {
      html += '<div style="position:absolute;bottom:' + (i * 6) + 'px;left:50%;' +
        'transform:translateX(-50%);width:34px;height:14px;border-radius:50%;' +
        'background:' + colors[i] + ';border:1.5px solid #111;box-sizing:border-box;"></div>'
    }
    if (label) {
      html += '<div style="position:absolute;bottom:' + (colors.length * 6 + 16) + 'px;left:50%;' +
        'transform:translateX(-50%);white-space:nowrap;font-family:monospace;font-size:18px;' +
        'color:#f2e9d8;text-shadow:0 0 3px #000,0 0 3px #000;">' + label + '</div>'
    }
    html += '</div>'
    return html
  }

  var dealerButtonHtml = function (seat, dxPx, dyPx) {
    return '<div style="position:absolute;' + anchor(seat, dxPx, dyPx) +
      'transform:translate(-50%,-50%);width:32px;height:32px;border-radius:50%;' +
      'background:#f4ecd8;border:2px solid #8a6d3b;box-sizing:border-box;display:flex;' +
      'align-items:center;justify-content:center;font-family:Georgia, serif;font-weight:bold;' +
      'font-size:16px;color:#7a5a20;">D</div>'
  }

  var buildPropsHtml = function () {
    var parts = []

    // Seat plates (behind panels).
    SEAT_POSITIONS.forEach(function (seat) { parts.push(seatPlateHtml(seat)) })

    // Card backs peeking from two seats (2 and 4), offset toward the felt
    // center so they sit on the table surface rather than off the rail.
    parts.push(cardBackHtml(SEAT_POSITIONS[2], 130, 40, 8))
    parts.push(cardBackHtml(SEAT_POSITIONS[4], -130, 40, -8))

    // Bet chips near a few seats, offset inward from the plate toward pot.
    parts.push(chipStackHtml(SEAT_POSITIONS[0], -150, -70, ['#7a1f2b', '#7a1f2b'], '300'))
    parts.push(chipStackHtml(SEAT_POSITIONS[1], 150, -40, ['#1f5c8a'], '25'))
    parts.push(chipStackHtml(SEAT_POSITIONS[3], -40, 110, ['#1f5c8a', '#7a1f2b'], '300'))
    parts.push(chipStackHtml(SEAT_POSITIONS[5], -150, -60, ['#3a7a2b'], '50'))

    // Dealer button, tucked between seat 1 and the pot.
    parts.push(dealerButtonHtml(SEAT_POSITIONS[1], 210, -90))

    // Center pot -- anchored at the felt's own center (50%, ~46.3%, same
    // point buildFeltSvg's ellipse is centered on: cy 500 / VB_H 1080).
    parts.push(chipStackHtml({ top: 46.3, left: 50 }, 0, -30, ['#7a1f2b', '#1f5c8a', '#3a7a2b'], 'Pot 975'))

    return parts.join('')
  }

  var buildHtmlOverlay = function () {
    // Text-bearing pieces stay HTML (crisper font rendering, easier to
    // tweak) rather than SVG <text>.
    var html = ''

    html += '<div style="position:absolute;top:22px;left:22px;display:flex;gap:10px;' +
      'font-family:monospace;font-size:16px;color:#f2f2f2;">' +
      '<div style="background:rgba(0,0,0,0.55);border:1px solid rgba(255,255,255,0.18);' +
      'border-radius:6px;padding:4px 10px;">SB/BB 25/50</div>' +
      '<div style="background:rgba(0,0,0,0.55);border:1px solid rgba(255,255,255,0.18);' +
      'border-radius:6px;padding:4px 10px;">アンティ 0</div>' +
      '<div style="background:rgba(20,40,70,0.65);border:1px solid rgba(255,255,255,0.18);' +
      'border-radius:6px;padding:4px 10px;">プリフロップ</div>' +
      '</div>'

    // Hero hole cards, bottom-center -- the extension itself never renders
    // hole cards (that's Unity's job in the real game); the fixture has no
    // Unity, so this is the only source of "hero has cards" in the shot.
    // Configurable via ?heroCards=/?heroLabel= -- see the module doc
    // comment at the top of this file for the default's derivation and
    // sync requirements.
    var suitColor = function (s) { return (s === '♥' || s === '♦') ? '#c0392b' : '#111' }
    var card = function (rank, suit) {
      return '<div style="width:96px;height:132px;border-radius:10px;background:#f7f3e8;' +
        'border:2px solid #cfc6ad;box-shadow:0 6px 14px rgba(0,0,0,0.5);' +
        'display:flex;flex-direction:column;justify-content:space-between;padding:8px;' +
        'font-family:Georgia, serif;color:' + suitColor(suit) + ';">' +
        '<div style="font-size:26px;font-weight:bold;line-height:1;">' + rank + '<br/>' + suit + '</div>' +
        '<div style="font-size:34px;text-align:right;">' + suit + '</div>' +
        '</div>'
    }
    html += '<div style="position:absolute;bottom:26px;left:50%;transform:translateX(-50%);' +
      'display:flex;flex-direction:column;align-items:center;gap:8px;">' +
      '<div style="display:flex;gap:10px;">' + card(heroCards[0].rank, heroCards[0].suit) + card(heroCards[1].rank, heroCards[1].suit) + '</div>' +
      '<div style="background:rgba(0,0,0,0.6);border:1px solid rgba(255,255,255,0.18);' +
      'border-radius:5px;padding:3px 12px;font-family:monospace;font-size:13px;color:#f2e9d8;">' + heroLabel + '</div>' +
      '</div>'

    return html
  }

  var wrap = document.createElement('div')
  wrap.id = 'e2e-table-backdrop'
  wrap.setAttribute('aria-hidden', 'true')
  wrap.style.cssText = 'position:fixed;inset:0;z-index:1;pointer-events:none;overflow:hidden;'
  wrap.innerHTML = buildFeltSvg() + buildPropsHtml() + buildHtmlOverlay()
  // Sibling of #unity-container (inserted immediately before it), NOT a
  // child -- see the "Why a sibling, not a child" doc comment above.
  container.parentNode.insertBefore(wrap, container)
})()
