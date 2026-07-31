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
 * asset. Values marked "mirrored"/"estimated" could not be read off the
 * reference because that seat had folded (no bet chips) or held no badge in
 * the captured hand; they are derived from the measured seats by symmetry.
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
export const POT: Rect = { h: 5.4, l: 37.5, t: 30.7, w: 25 }

export interface SeatLayout {
  /** Face-down cards for an opponent still holding a hand. */
  cards: Rect
  /** Chip-stack anchor on the felt; the amount pill flows to its right. */
  bet: Point
  /** Blind/dealer marker anchor on the felt, beside the plate. */
  badge: Point
  /** Action bubble ("フォールド" / "レイズ"), floating above the portrait. */
  bubble: Point
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
    badge: { l: 52.3, t: 64 },
    bet: { l: 46.5, t: 58.8 },
    bubble: { l: 50.6, t: 61 },
    cards: { h: 0, l: 0, t: 0, w: 0 },
    plate: { h: 11.9, l: 53, t: 67.9, w: 19.7 },
    portrait: { h: 29, l: 29.5, t: 56, w: 11 },
  },
  {
    // プレイヤーA -- bottom left.
    badge: { l: 16.7, t: 58.8 }, // mirrored from seat 5
    bet: { l: 30.3, t: 49.4 }, // mirrored from seat 5
    bubble: { l: 3.3, t: 47.3 },
    cards: { h: 8.4, l: 11.5, t: 51, w: 8.5 },
    plate: { h: 8, l: 5.8, t: 57.8, w: 14.4 },
    portrait: { h: 29, l: 2.5, t: 41, w: 10 },
  },
  {
    // プレイヤーB -- top left.
    badge: { l: 26.8, t: 26.1 }, // mirrored from seat 4
    bet: { l: 30.3, t: 35.5 }, // estimated: folded in the reference hand
    bubble: { l: 9.8, t: 11.3 },
    cards: { h: 7.6, l: 18.4, t: 16.5, w: 7.5 },
    plate: { h: 8, l: 12.1, t: 23.6, w: 14.4 },
    portrait: { h: 25, l: 5.5, t: 6, w: 9.5 },
  },
  {
    // プレイヤーC -- top centre.
    badge: { l: 41.2, t: 25.9 }, // estimated: held no badge in the reference hand
    bet: { l: 43.5, t: 23.9 },
    bubble: { l: 42.3, t: 1.3 },
    cards: { h: 8.5, l: 55.5, t: 8.5, w: 7.5 },
    plate: { h: 8, l: 44.5, t: 14.8, w: 14.4 },
    portrait: { h: 22, l: 41, t: 1, w: 9 },
  },
  {
    // プレイヤーD -- top right.
    badge: { l: 69.8, t: 26.1 },
    bet: { l: 67.7, t: 35.5 }, // estimated: folded in the reference hand
    bubble: { l: 74.5, t: 11.3 },
    cards: { h: 7.6, l: 83.1, t: 16.9, w: 7.5 },
    plate: { h: 8, l: 76.9, t: 23.4, w: 14.4 },
    portrait: { h: 25, l: 74, t: 6, w: 9.5 },
  },
  {
    // プレイヤーE -- bottom right.
    badge: { l: 79.3, t: 58.8 },
    bet: { l: 67.7, t: 49.4 },
    bubble: { l: 79.5, t: 47.3 },
    cards: { h: 8, l: 88, t: 51, w: 8 },
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
/** Hero's remaining-decision-time badge. */
export const HERO_TIMER: Rect = { h: 3.9, l: 31.25, t: 57.4, w: 6.25 }

/** Fixed game chrome outside the table. */
export const CHROME = {
  /** Yellow emoji/sticker button, top right. */
  emoji: { h: 11, l: 91.6, t: 2.5, w: 8.2 } as Rect,
  /** "Ctrl ガイド表示/非表示" hint. */
  guide: { h: 4, l: 84.5, t: 74.8, w: 14.5 } as Rect,
  /** ヘルプ bracket button, top right. */
  help: { h: 8.3, l: 74.4, t: 1.2, w: 14.5 } as Rect,
  /** Rotated-square menu button, top left. */
  menu: { h: 14, l: 1.2, t: 1, w: 7.3 } as Rect,
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
  allIn: { h: 4.3, l: 77.2, t: 85.5, w: 7.2 } as Rect,
  buttons: [
    { h: 11.6, l: 11.1, t: 84.7, w: 9.7 },
    { h: 11.6, l: 22.2, t: 84.7, w: 10 },
    { h: 11.6, l: 32.8, t: 84.7, w: 10 },
  ] as Rect[],
  frame: { h: 18.5, l: 1, t: 81.5, w: 92 } as Rect,
  minus: { h: 10.7, l: 43.9, t: 85.2, w: 6.1 } as Rect,
  multiplier: { h: 6.3, l: 50.8, t: 84.3, w: 8.1 } as Rect,
  plus: { h: 11.2, l: 85.6, t: 84.7, w: 6.6 } as Rect,
  preAction: { h: 15.5, l: 1.7, t: 83.3, w: 8 } as Rect,
  slider: { h: 1.5, l: 50.3, t: 93.9, w: 43.6 } as Rect,
  sliderKnob: { h: 4.3, l: 80.5, t: 92, w: 4.5 } as Rect,
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
