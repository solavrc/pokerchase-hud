/**
 * Scene geometry for the visual mockup's table, measured from
 * `e2e/public/assets/table-backdrop.jpg` -- the same real 6-max PokerChase
 * screenshot the E2E fixture page and the Chrome Web Store imagery use
 * (3452x1992 = 1.733:1, i.e. 2x the game's ~1726x996 logical viewport; see
 * e2e/public/table-backdrop.js for the asset's provenance).
 *
 * **Every number here is a percent of the VIEWPORT** -- the same coordinate
 * space `Hud.tsx`'s `SEAT_POSITIONS` and the persisted `hudPosition_<seat>`
 * values live in. That is the whole point of the mockup being percent-based
 * rather than laid out in a fixed-aspect box: a HUD panel dropped onto this
 * scene sits in the same relation to a seat plate as it does over the real
 * game at any window size, exactly like the E2E backdrop's `object-fit: fill`
 * <img> (which deliberately stretches so its baked-in plates keep fixed
 * viewport percentages).
 *
 * The six plate centers and bottom edges agree with `SEAT_ANCHORS` in
 * e2e/tools/capture-store-imagery.ts, measured independently on the same
 * asset.
 *
 * Scope: only what the table ALWAYS shows -- the seats, the felt, the fixed
 * chrome and the betting bar's own controls. Per-hand state (bet chips, blind
 * markers, who folded, who is the aggressor) is deliberately NOT reproduced:
 * the mockup exists to review the HUD's own rendering (see README), and the
 * scene is its backdrop, not a second game client. Showing the real game's
 * hand state is `e2e/public/table-backdrop.js`'s job, which overlays the HUD
 * on the actual screenshot.
 *
 * Re-measuring: render a percent grid over the asset and read edges off it.
 * The felt outline is NOT an ellipse -- fitting per-row widths gives a rounded
 * rectangle whose corner radii are 25% of its width by 50% of its height
 * (`FELT_RADIUS` below), which reproduces the measured profile to within
 * ~0.5% of viewport width at every sampled row.
 */

/** Rectangle in percent-of-viewport units. */
export interface Rect {
  h: number
  l: number
  t: number
  w: number
}

/** Point in percent-of-viewport units. */
export interface Point {
  l: number
  t: number
}

/** Dark padded rail: the table's outer body. */
export const RAIL: Rect = { h: 63, l: 13, t: 14.5, w: 74 }

/** Green playing surface, inset inside {@link RAIL}. */
export const FELT: Rect = { h: 46.9, l: 19.3, t: 22.5, w: 61.3 }

/** Corner radii of the felt/rail silhouette, as `<x-radius> / <y-radius>`. */
export const FELT_RADIUS = '25% / 50%'
export const RAIL_RADIUS = '29% / 49.5%'

/**
 * Diamond studs decorating the rail. Only the six that are unobstructed in
 * the reference are reproduced; the rest of the ring is hidden behind plates
 * and cards there, so their spacing could not be read reliably.
 */
export const RAIL_STUDS: readonly Point[] = [
  { l: 16.2, t: 46.3 },
  { l: 83.8, t: 46.3 },
  { l: 40.9, t: 18.5 },
  { l: 59.1, t: 18.5 },
  { l: 40.9, t: 73.5 },
  { l: 59.1, t: 73.5 },
] as const

/** Where the community cards / pot sit on the felt (the reference hand was preflop). */
export const BOARD_CENTER: Point = { l: 50, t: 46.3 }
/**
 * Board slots always drawn, dealt or not. The reference is a preflop hand so
 * it shows nothing here -- reserving all five is a deliberate departure, so
 * that the river's footprint is visible on every scenario.
 */
export const BOARD_SLOTS = 5
export const POT: Rect = { h: 5.4, l: 37.5, t: 30.7, w: 25 }

export interface SeatLayout {
  /** Face-down cards for an opponent still holding a hand. */
  cards: Rect
  /** Name plate: stack on top, player name below. */
  plate: Rect
  /**
   * Character portrait. The real game paints licensed character art here; the
   * mockup only reserves the same footprint with an abstract silhouette so
   * HUD contrast is judged against a realistically busy backdrop.
   */
  portrait: Rect
}

/**
 * Indexed by HUD display position: 0 = hero (bottom centre), then clockwise
 * from bottom-left, matching `Hud.tsx`'s `SEAT_POSITIONS` ordering and the
 * plate names baked into the reference asset (Hero / プレイヤーA..E).
 */
export const SEATS: readonly SeatLayout[] = [
  {
    // Hero: larger plate with the active cyan frame. Hero's own hole cards are
    // rendered separately (HERO_CARDS) -- `cards` is the face-down slot the
    // other seats use and is unused for the hero.
    cards: { h: 0, l: 0, t: 0, w: 0 },
    plate: { h: 11.9, l: 53, t: 67.9, w: 19.7 },
    portrait: { h: 29, l: 29.5, t: 56, w: 11 },
  },
  {
    // プレイヤーA -- bottom left.
    cards: { h: 8.4, l: 12.2, t: 51.4, w: 7.5 },
    plate: { h: 8, l: 5.8, t: 57.8, w: 14.4 },
    portrait: { h: 29, l: 2.5, t: 41, w: 10 },
  },
  {
    // プレイヤーB -- top left.
    cards: { h: 7.6, l: 18.4, t: 16.5, w: 7.5 },
    plate: { h: 8, l: 12.1, t: 23.6, w: 14.4 },
    portrait: { h: 25, l: 5.5, t: 6, w: 9.5 },
  },
  {
    // プレイヤーC -- top centre. Like every other seat, the cards sit just
    // inside the plate's right edge (58.35 vs the plate's 58.9); the plate is
    // painted after them, so their lower half is occluded as in the reference.
    cards: { h: 8.5, l: 50.9, t: 8.1, w: 7.45 },
    plate: { h: 8, l: 44.5, t: 14.8, w: 14.4 },
    portrait: { h: 22, l: 41, t: 1, w: 9 },
  },
  {
    // プレイヤーD -- top right.
    cards: { h: 7.6, l: 83.1, t: 16.9, w: 7.5 },
    plate: { h: 8, l: 76.9, t: 23.4, w: 14.4 },
    portrait: { h: 25, l: 74, t: 6, w: 9.5 },
  },
  {
    // プレイヤーE -- bottom right.
    cards: { h: 8.4, l: 89.5, t: 51.4, w: 7.4 },
    plate: { h: 8, l: 82.8, t: 57.8, w: 14.4 },
    portrait: { h: 25, l: 82.5, t: 41, w: 9 },
  },
] as const

/** Hero's face-up hole cards; the right card is dealt lower than the left. */
export const HERO_CARDS: Rect = { h: 15.8, l: 40, t: 63.6, w: 12.3 }
/** Vertical stagger of hero's second card, in percent of viewport height. */
export const HERO_CARD_STAGGER = 3.5
/**
 * Made-hand caption under hero's cards ("ワンペア"). Anchored by its centre --
 * the client sizes this chip to its text, and Japanese hand names vary in
 * width (ワンペア vs ストレートフラッシュ).
 */
export const HERO_HAND_LABEL: Point = { l: 46.5, t: 78.9 }

/** Fixed game chrome outside the table. */
export const CHROME = {
  /** Yellow emoji/sticker button, top right. A 45°-rotated square. */
  emoji: { h: 12.5, l: 91.68, t: 3.41, w: 7.24 } as Rect,
  /** "Ctrl ガイド表示/非表示" hint. */
  guide: { h: 4, l: 84.5, t: 74.8, w: 14.5 } as Rect,
  /** ヘルプ bracket button, top right. */
  help: { h: 8.3, l: 74.4, t: 1.2, w: 14.5 } as Rect,
  /** Rotated-square menu button, top left. */
  menu: { h: 13.5, l: 0.5, t: 2.51, w: 7.79 } as Rect,
  /** Promo banner on the right rail. */
  promo: { h: 14, l: 92, t: 19, w: 7.5 } as Rect,
  /** Blind level row, and the ante row directly under it. */
  stakes: { h: 3.95, l: 10.1, t: 1.7, w: 16.3 } as Rect,
  ante: { h: 4.15, l: 10.1, t: 6.5, w: 16.3 } as Rect,
  /** Hand clock, and the street name directly under it. */
  clock: { h: 3.95, l: 27, t: 1.7, w: 10, } as Rect,
  street: { h: 4.15, l: 27, t: 6.5, w: 10 } as Rect,
} as const

/** Bottom action bar. Rendered for realism only -- nothing here is clickable. */
export const ACTION_BAR = {
  buttons: [
    { h: 11.6, l: 11.1, t: 84.7, w: 9.7 },
    { h: 11.6, l: 22.2, t: 84.7, w: 10 },
    { h: 11.6, l: 32.8, t: 84.7, w: 10 },
  ] as Rect[],
  frame: { h: 18.5, l: 1, t: 81.5, w: 92 } as Rect,
  minus: { h: 10.7, l: 43.9, t: 85.2, w: 6.1 } as Rect,
  /**
   * Bet-size presets. x2.5 and オールイン are measured off the reference; the
   * x3 / x4 chips between them were not visible in that frame (the client only
   * offers the sizes the acting stack can cover), so they are spaced evenly
   * across the same run and share x2.5's box.
   */
  multipliers: [
    { h: 6.3, l: 50.8, t: 84.3, w: 8.1, label: 'x2.5' },
    { h: 6.3, l: 59.6, t: 84.3, w: 8.1, label: 'x3' },
    { h: 6.3, l: 68.4, t: 84.3, w: 8.1, label: 'x4' },
    // The only preset whose label is a word rather than a multiplier, so it
    // needs the smaller type to fit the same box.
    { h: 6.3, l: 77.2, t: 84.3, w: 8.1, label: 'オールイン', wordLabel: true },
  ] as Array<Rect & { label: string; wordLabel?: boolean }>,
  plus: { h: 11.2, l: 85.6, t: 84.7, w: 6.6 } as Rect,
  preAction: { h: 15.5, l: 1.7, t: 83.3, w: 8 } as Rect,
  slider: { h: 1.5, l: 50.3, t: 93.9, w: 43.6 } as Rect,
  /**
   * Centre of the slider's diamond handle. A centre, not a Rect: the handle is
   * a 45°-rotated square and so must be square in PIXELS, which a Rect cannot
   * express (its width and height are percentages of different axes). Its side
   * lives with the other diamonds in `styles.css`.
   */
  sliderKnob: { l: 83.52, t: 95.08 } as Point,
} as const

/** CSS positioning for a {@link Rect}, in percent-of-viewport units. */
export const rectStyle = (rect: Rect) => ({
  height: `${rect.h}%`,
  left: `${rect.l}%`,
  top: `${rect.t}%`,
  width: `${rect.w}%`,
})

/** CSS positioning for a {@link Point} (size comes from the stylesheet). */
export const pointStyle = (point: Point) => ({
  left: `${point.l}%`,
  top: `${point.t}%`,
})
