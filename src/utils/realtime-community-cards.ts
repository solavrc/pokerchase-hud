import { PhaseType } from '../types/game'

/**
 * 公開カードの位置とベッティングの進行は別に保持する。
 * ACTIONが先行しても、遅着したROUNDを別ストリートのカードとして扱わない。
 * 欠けたカードを詰めて、ターンやリバーをフロップへ繰り上げない（MUST NOT）。
 */
export class RealtimeCommunityCards {
  private cards: Array<number | undefined> = []

  reset(): void {
    this.cards = []
  }

  apply(phase: PhaseType, incoming: readonly number[]): number[] {
    const expected = phase === PhaseType.FLOP ? 3
      : phase === PhaseType.TURN ? 4
      : phase === PhaseType.RIVER ? 5 : 0
    if (expected === 0 || incoming.some(card => !Number.isInteger(card) || card < 0 || card > 51)) {
      return this.getCards()
    }

    if (incoming.length === expected) {
      // 累積形式のsnapshotは既知の先頭を更新し、後続streetのカードは残す。
      incoming.forEach((card, index) => { this.cards[index] = card })
    } else if (expected > 3 && incoming.length === 1) {
      this.cards[expected - 1] = incoming[0]
    }
    return this.getCards()
  }

  getCards(): number[] {
    const contiguous: number[] = []
    for (const card of this.cards) {
      if (card === undefined) break
      contiguous.push(card)
    }
    return contiguous
  }
}

/** 盤面が未到着なら、古いカードから現在streetの役確率を算出しない。 */
export function hasBoardForPhase(phase: PhaseType, cards: readonly number[]): boolean {
  const expected = phase === PhaseType.PREFLOP ? 0
    : phase === PhaseType.FLOP ? 3
    : phase === PhaseType.TURN ? 4 : 5
  return cards.length >= expected && cards.length <= 5
}
