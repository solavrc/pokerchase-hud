import { vpipFullStat, classifyVpipFLayer } from './vpip-full'
import { ActionDetail, PhaseType } from '../../types/game'
import type { Hand } from '../../types/entities'
import { makeCalcContext } from './__test-helpers'

/** Minimal Hand fixture builder for these tests (only fields vpip-full.ts reads). */
const makeHand = (overrides: Partial<Hand> & { id: number, seatUserIds: number[] }): Hand => ({
  winningPlayerIds: [],
  smallBlind: 0,
  bigBlind: 0,
  session: {},
  results: [],
  ...overrides
} as Hand)

describe('vpipFullStat', () => {
  it('is disabled by default (opt-in variant)', () => {
    expect(vpipFullStat.enabled).toBe(false)
  })

  describe('classifyVpipFLayer', () => {
    // 6-max table (seatUserIds.length === 6)
    it('classifies a 6-max hand with all 6 seats dealt as full', () => {
      expect(classifyVpipFLayer({ seatUserIds: [1, 2, 3, 4, 5, 6] })).toBe('full')
    })

    it('classifies a 6-max hand with 5 dealt (1 empty seat) as full', () => {
      expect(classifyVpipFLayer({ seatUserIds: [1, 2, 3, 4, 5, -1] })).toBe('full')
    })

    it('classifies a 6-max hand with 4 dealt as the 4p layer (excluded from full)', () => {
      expect(classifyVpipFLayer({ seatUserIds: [1, 2, 3, 4, -1, -1] })).toBe('4p')
    })

    it('classifies a 6-max hand with 3 dealt as the 3p layer', () => {
      expect(classifyVpipFLayer({ seatUserIds: [1, 2, 3, -1, -1, -1] })).toBe('3p')
    })

    it('classifies a 6-max hand with 2 dealt as the hu layer', () => {
      expect(classifyVpipFLayer({ seatUserIds: [1, 2, -1, -1, -1, -1] })).toBe('hu')
    })

    it('returns null for a 6-max hand with only 1 dealt seat (degenerate)', () => {
      expect(classifyVpipFLayer({ seatUserIds: [1, -1, -1, -1, -1, -1] })).toBeNull()
    })

    // 4-max table (seatUserIds.length === 4)
    it('classifies a 4-max hand with all 4 seats dealt as full', () => {
      expect(classifyVpipFLayer({ seatUserIds: [1, 2, 3, 4] })).toBe('full')
    })

    it('classifies a 4-max hand with 3 dealt as the 3p layer (excluded from full)', () => {
      expect(classifyVpipFLayer({ seatUserIds: [1, 2, 3, -1] })).toBe('3p')
    })

    it('classifies a 4-max hand with 2 dealt as the hu layer', () => {
      expect(classifyVpipFLayer({ seatUserIds: [1, 2, -1, -1] })).toBe('hu')
    })

    it('returns null for an unexpected table size', () => {
      expect(classifyVpipFLayer({ seatUserIds: [1, 2, 3] })).toBeNull()
      expect(classifyVpipFLayer({ seatUserIds: [1, 2, 3, 4, 5] })).toBeNull()
    })
  })

  describe('calculate', () => {
    it('restricts numerator/denominator to full-layer hands only (6-max)', () => {
      const hands = [
        makeHand({ id: 1, seatUserIds: [1, 2, 3, 4, 5, 6] }),     // full (6 dealt)
        makeHand({ id: 2, seatUserIds: [1, 2, 3, 4, 5, -1] }),    // full (5 dealt)
        makeHand({ id: 3, seatUserIds: [1, 2, 3, 4, -1, -1] }),   // 4p - excluded from vpipF
        makeHand({ id: 4, seatUserIds: [1, 2, -1, -1, -1, -1] }), // hu - excluded from vpipF
      ]
      const actions = [
        { handId: 1, phase: PhaseType.PREFLOP, actionDetails: [ActionDetail.VPIP] },
        { handId: 2, phase: PhaseType.PREFLOP, actionDetails: [] },
        // Hand 3/4 actions must not leak into the vpipF calculation even though they exist.
        { handId: 3, phase: PhaseType.PREFLOP, actionDetails: [ActionDetail.VPIP] },
        { handId: 4, phase: PhaseType.PREFLOP, actionDetails: [ActionDetail.VPIP] },
      ]
      const result = vpipFullStat.calculate(makeCalcContext({ playerId: 1, actions: actions as any, hands }))
      // Only hands 1 and 2 (full layer) count: 1 VPIP out of 2 opportunity hands.
      expect(result).toEqual([1, 2])
    })

    it('includes 4-max hands with all 4 seats dealt as full', () => {
      const hands = [
        makeHand({ id: 1, seatUserIds: [1, 2, 3, 4] }),    // full (4-max, 4 dealt)
        makeHand({ id: 2, seatUserIds: [1, 2, 3, -1] }),   // 3p - excluded from vpipF
      ]
      const actions = [
        { handId: 1, phase: PhaseType.PREFLOP, actionDetails: [ActionDetail.VPIP] },
        { handId: 2, phase: PhaseType.PREFLOP, actionDetails: [ActionDetail.VPIP] },
      ]
      const result = vpipFullStat.calculate(makeCalcContext({ playerId: 1, actions: actions as any, hands }))
      expect(result).toEqual([1, 1])
    })

    it('returns [0, 0] when the player has no full-layer hands', () => {
      const hands = [
        makeHand({ id: 1, seatUserIds: [1, 2, -1, -1, -1, -1] }), // hu only
      ]
      const result = vpipFullStat.calculate(makeCalcContext({ playerId: 1, hands }))
      expect(result).toEqual([0, 0])
    })

    it('returns [0, 0] for an empty hand list', () => {
      const result = vpipFullStat.calculate(makeCalcContext({ playerId: 1, hands: [] }))
      expect(result).toEqual([0, 0])
    })

    it('applies walk exclusion (#115) within the full layer', () => {
      const hands = [
        // Walk: player 1 is BB, no preflop action taken this hand -> excluded from denominator.
        makeHand({ id: 1, seatUserIds: [1, 2, 3, 4, 5, 6], bigBlindUserId: 1 }),
        // Non-walk full-layer hand: player 1 folded preflop (a decision) -> counted, no VPIP.
        makeHand({ id: 2, seatUserIds: [1, 2, 3, 4, 5, 6], bigBlindUserId: 2 }),
      ]
      const actions = [
        { handId: 2, phase: PhaseType.PREFLOP, actionDetails: [] }, // fold, no VPIP flag
      ]
      const result = vpipFullStat.calculate(makeCalcContext({ playerId: 1, actions: actions as any, hands }))
      // Hand 1 (walk) excluded; hand 2 retained as an opportunity with no VPIP.
      expect(result).toEqual([0, 1])
    })

    it('does not exclude a walk hand outside the full layer from leaking into the full-layer denominator', () => {
      const hands = [
        // Walk at the hu layer -- irrelevant to vpipF since it's not in the full layer at all.
        makeHand({ id: 1, seatUserIds: [1, 2, -1, -1, -1, -1], bigBlindUserId: 1 }),
        makeHand({ id: 2, seatUserIds: [1, 2, 3, 4, 5, 6], bigBlindUserId: 2 }),
      ]
      const actions = [
        { handId: 2, phase: PhaseType.PREFLOP, actionDetails: [ActionDetail.VPIP] },
      ]
      const result = vpipFullStat.calculate(makeCalcContext({ playerId: 1, actions: actions as any, hands }))
      expect(result).toEqual([1, 1])
    })
  })

  describe('format', () => {
    it('formats as percentage like the base vpip stat', () => {
      expect(vpipFullStat.format!([1, 2])).toBe('50.0% (1/2)')
    })
  })

  describe('tooltip', () => {
    it('renders a per-layer breakdown with n for each of full/4p/3p/hu', () => {
      const hands = [
        makeHand({ id: 1, seatUserIds: [1, 2, 3, 4, 5, 6] }),      // full
        makeHand({ id: 2, seatUserIds: [1, 2, 3, 4, -1, -1] }),    // 4p
        makeHand({ id: 3, seatUserIds: [1, 2, 3, -1, -1, -1] }),   // 3p
        makeHand({ id: 4, seatUserIds: [1, 2, -1, -1, -1, -1] }),  // hu
      ]
      const actions = [
        { handId: 1, phase: PhaseType.PREFLOP, actionDetails: [ActionDetail.VPIP] },
        { handId: 2, phase: PhaseType.PREFLOP, actionDetails: [ActionDetail.VPIP] },
        { handId: 3, phase: PhaseType.PREFLOP, actionDetails: [] },
        { handId: 4, phase: PhaseType.PREFLOP, actionDetails: [ActionDetail.VPIP] },
      ]
      const tooltip = vpipFullStat.tooltip!(makeCalcContext({ playerId: 1, actions: actions as any, hands }))
      expect(tooltip).toBe('VPIP·F 100.0% (n=1) | 4p 100.0% (n=1) | 3p 0.0% (n=1) | HU 100.0% (n=1)')
    })

    it('shows "-" for layers with no opportunity hands (n=0)', () => {
      const hands = [
        makeHand({ id: 1, seatUserIds: [1, 2, 3, 4, 5, 6] }), // full only
      ]
      const actions = [
        { handId: 1, phase: PhaseType.PREFLOP, actionDetails: [ActionDetail.VPIP] },
      ]
      const tooltip = vpipFullStat.tooltip!(makeCalcContext({ playerId: 1, actions: actions as any, hands }))
      expect(tooltip).toBe('VPIP·F 100.0% (n=1) | 4p - (n=0) | 3p - (n=0) | HU - (n=0)')
    })
  })
})
