/**
 * Utility functions for card formatting
 */

const SUITS = ['s', 'h', 'd', 'c'] as const
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const

/**
 * Convert card numbers to string representation
 * @param cards Array of card numbers (0-51)
 * @returns Space-separated string of cards (e.g. "As Kd Qh")
 */
export function formatCards(cards: number[]): string {
  return cards.map(card => {
    const rank = RANKS[Math.floor(card / 4)]
    const suit = SUITS[card % 4]
    return rank ? `${rank}${suit}` : ''
  }).filter(Boolean).join(' ')
}

/**
 * Convert card numbers to array of card strings
 * @param cards Array of card numbers (0-51)
 * @returns Array of card strings (e.g. ["As", "Kd", "Qh"])
 */
export function formatCardsArray(cards: number[]): string[] {
  return cards.map(card => {
    const rank = RANKS[Math.floor(card / 4)]
    const suit = SUITS[card % 4]
    return rank ? `${rank}${suit}` : ''
  }).filter(Boolean)
}