/**
 * Utility functions for card formatting
 *
 * Card encoding: 0-3: 2s-2c, 4-7: 3s-3c, ..., 48-51: As-Ac
 * Rank = card / 4, Suit = card % 4 (s=0, h=1, d=2, c=3)
 *
 * Card mapping:
 *  0: 2♠   1: 2♥   2: 2♦   3: 2♣
 *  4: 3♠   5: 3♥   6: 3♦   7: 3♣
 *  8: 4♠   9: 4♥  10: 4♦  11: 4♣
 * 12: 5♠  13: 5♥  14: 5♦  15: 5♣
 * 16: 6♠  17: 6♥  18: 6♦  19: 6♣
 * 20: 7♠  21: 7♥  22: 7♦  23: 7♣
 * 24: 8♠  25: 8♥  26: 8♦  27: 8♣
 * 28: 9♠  29: 9♥  30: 9♦  31: 9♣
 * 32: T♠  33: T♥  34: T♦  35: T♣
 * 36: J♠  37: J♥  38: J♦  39: J♣
 * 40: Q♠  41: Q♥  42: Q♦  43: Q♣
 * 44: K♠  45: K♥  46: K♦  47: K♣
 * 48: A♠  49: A♥  50: A♦  51: A♣
 */

export const SUITS = ['s', 'h', 'd', 'c'] as const
export const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'] as const
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const

export type SuitFormat = 'letters' | 'symbols'

interface FormatOptions {
  suitFormat?: SuitFormat
}

/**
 * Get rank index from card number (0-12: 2-A)
 * @param card Card number (0-51)
 * @returns Rank index (0-12)
 */
export function getCardRank(card: number): number {
  return Math.floor(card / 4)
}

/**
 * Get suit index from card number (0-3: s,h,d,c)
 * @param card Card number (0-51)
 * @returns Suit index (0-3)
 */
export function getCardSuit(card: number): number {
  return card % 4
}

/**
 * Get rank and suit indices from card number
 */
function getCardComponents(card: number): { rank: number; suit: number } {
  return {
    rank: getCardRank(card),
    suit: getCardSuit(card)
  }
}

/**
 * Convert a single card number to string representation
 * @param card Card number (0-51)
 * @param options Format options
 * @returns Card string (e.g. "As" or "A♠")
 */
export function formatCard(card: number, options: FormatOptions = {}): string {
  const { suitFormat = 'letters' } = options
  const { rank, suit } = getCardComponents(card)

  const rankStr = RANKS[rank]
  const suitStr = suitFormat === 'symbols' ? SUIT_SYMBOLS[suit] : SUITS[suit]

  return rankStr && suitStr ? `${rankStr}${suitStr}` : ''
}

/**
 * Convert card numbers to string representation
 * @param cards Array of card numbers (0-51)
 * @param options Format options
 * @returns Space-separated string of cards (e.g. "As Kd Qh" or "A♠ K♦ Q♥")
 */
export function formatCards(cards: number[], options: FormatOptions = {}): string {
  return cards.map(card => formatCard(card, options)).filter(Boolean).join(' ')
}

/**
 * Convert card numbers to array of card strings
 * @param cards Array of card numbers (0-51)
 * @param options Format options
 * @returns Array of card strings (e.g. ["As", "Kd", "Qh"])
 */
export function formatCardsArray(cards: number[], options: FormatOptions = {}): string[] {
  return cards.map(card => formatCard(card, options)).filter(Boolean)
}

/**
 * Four-color deck palette, tuned for the HUD's translucent-black panel
 * (#353 -- sola: 4色表現が助かります). Spades keep the panel's default text
 * color rather than pure white so they don't outshine every other row; the
 * diamond blue and club green are lightened well past pure #0000ff/#008000,
 * which go muddy and fail contrast on a dark, semi-transparent background.
 *
 * Exported so display code and its tests share one source of truth.
 */
export const SUIT_COLORS = {
  s: '#dddddd',
  h: '#e57373',
  d: '#4da6ff',
  c: '#66cc66',
} as const

/**
 * Rank portion of an already-formatted card string (`'As'` -> `'A'`,
 * `'Th'` -> `'T'`). Used by the recent-hands panel, which renders rank-only
 * cards and carries the suit in the 4-color coding instead of a letter
 * (#356 -- the 240px HUD cannot fit rank+suit for a 5-card board alongside
 * every other column). Ten stays `'T'`, matching the rest of the UI.
 *
 * MUST be paired with the full `R s` notation somewhere reachable (the cell's
 * tooltip): rank-only display relies on color alone, which is a real loss for
 * anyone who cannot separate the four hues.
 */
export function cardRankLabel(card: string): string {
  return card.length > 1 ? card.slice(0, -1) : card
}

/**
 * Four-color-deck text color for one card. Accepts the raw 0-51 card number
 * or a single formatted card string (e.g. "Ah"), like `isRedSuit`.
 * An unrecognized suit falls back to the spade/default color rather than
 * throwing -- a card display MUST NOT be able to crash the HUD (#127).
 */
export function suitColor(card: number | string): string {
  const suitChar = typeof card === 'number' ? SUITS[getCardSuit(card)] : card.slice(-1)
  return SUIT_COLORS[suitChar as keyof typeof SUIT_COLORS] ?? SUIT_COLORS.s
}
