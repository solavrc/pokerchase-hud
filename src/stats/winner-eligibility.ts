import type { Hand } from '../types/entities'

/** 人物同一性により勝者不明と保存されたhandだけを除外し、旧データは互換にする。 */
export const getWinnerIdentityUnprovenHandIds = (hands: readonly Hand[]): Set<number> =>
  new Set(hands.filter(hand => hand.winnerIdentityUnproven === true).map(hand => hand.id))
