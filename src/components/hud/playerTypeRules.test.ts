import { classifyPlayerType, PLAYER_TYPE_META } from './playerTypeRules'
import type { StatResult } from '../../types/stats'

const stat = (id: string, value: [number, number]): StatResult => ({
  id,
  name: id.toUpperCase(),
  value,
})

/** Builds a statResults array from a partial id -> [num, den] map, omitting ids not provided. */
const results = (fractions: Partial<Record<'vpip' | 'af' | 'vpipF', [number, number]>>): StatResult[] =>
  Object.entries(fractions).map(([id, value]) => stat(id, value!))

describe('classifyPlayerType', () => {
  describe('quadrants', () => {
    it('TAG: tight VPIP + aggressive AF', () => {
      const r = classifyPlayerType(results({ vpip: [20, 100], af: [40, 20] })) // 20% VPIP, AF 2.0
      expect(r?.type).toBe('tag')
      expect(r?.icon).toBe(PLAYER_TYPE_META.tag.icon)
      expect(r?.label).toBe('TAG')
      expect(r?.reason).toBe(
        'プレイヤータイプ: TAG (タイト・アグレッシブ)\nVPIP 20% (n=100) < 25 / AF 2.0 (n=20) ≥ 1.5'
      )
    })

    it('LAG: loose VPIP + aggressive AF', () => {
      const r = classifyPlayerType(results({ vpip: [40, 100], af: [40, 20] })) // 40% VPIP, AF 2.0
      expect(r?.type).toBe('lag')
      expect(r?.icon).toBe(PLAYER_TYPE_META.lag.icon)
      expect(r?.label).toBe('LAG')
      expect(r?.reason).toContain('LAG (ルース・アグレッシブ)')
    })

    it('ニット (nit): tight VPIP + passive AF', () => {
      const r = classifyPlayerType(results({ vpip: [20, 100], af: [15, 30] })) // 20% VPIP, AF 0.5
      expect(r?.type).toBe('nit')
      expect(r?.icon).toBe(PLAYER_TYPE_META.nit.icon)
      expect(r?.label).toBe('ニット')
      expect(r?.reason).toContain('ニット (タイト・パッシブ)')
    })

    it('フィッシュ (fish): loose VPIP + passive AF -- matches the spec example exactly', () => {
      const r = classifyPlayerType(results({ vpip: [50, 120], af: [36, 45] })) // 42% VPIP (rounds to 42), AF 0.8
      expect(r?.type).toBe('fish')
      expect(r?.icon).toBe(PLAYER_TYPE_META.fish.icon)
      expect(r?.reason).toBe(
        'プレイヤータイプ: フィッシュ (ルース・パッシブ)\nVPIP 42% (n=120) ≥ 25 / AF 0.8 (n=45) < 1.5'
      )
    })

    it('VPIP boundary (25%) is inclusive on the loose side', () => {
      const r = classifyPlayerType(results({ vpip: [25, 100], af: [30, 30] })) // exactly 25%, AF 1.0 (passive)
      expect(r?.type).toBe('fish') // loose (>=25) + passive
    })

    it('VPIP just under the boundary (24%) is tight', () => {
      const r = classifyPlayerType(results({ vpip: [24, 100], af: [15, 30] })) // 24%, AF 0.5 (passive)
      expect(r?.type).toBe('nit')
    })

    it('AF boundary (1.5) is inclusive on the aggressive side', () => {
      const r = classifyPlayerType(results({ vpip: [20, 100], af: [30, 20] })) // 20% VPIP (tight), AF exactly 1.5
      expect(r?.type).toBe('tag') // tight + aggressive (>=1.5)
    })

    it('AF just under the boundary (1.4) is passive', () => {
      const r = classifyPlayerType(results({ vpip: [20, 100], af: [28, 20] })) // AF 1.4
      expect(r?.type).toBe('nit')
    })
  })

  describe('whale override', () => {
    it('fires when full-table-layer VPIP (vpipF) >= 50%, matching the spec example exactly', () => {
      const r = classifyPlayerType(results({ vpip: [30, 100], vpipF: [44, 80] })) // vpipF 55%
      expect(r?.type).toBe('whale')
      expect(r?.icon).toBe(PLAYER_TYPE_META.whale.icon)
      expect(r?.reason).toBe(
        'プレイヤータイプ: ホエール (超ルース)\nフルテーブルVPIP 55% (n=80) ≥ 50%'
      )
    })

    it('does not fire below the 50% vpipF boundary', () => {
      const r = classifyPlayerType(results({ vpip: [30, 100], vpipF: [39, 80], af: [45, 30] })) // vpipF 48.75%, AF 1.5
      expect(r?.type).not.toBe('whale')
    })

    it('vpipF boundary (50%) is inclusive', () => {
      const r = classifyPlayerType(results({ vpip: [30, 100], vpipF: [40, 80] })) // exactly 50%
      expect(r?.type).toBe('whale')
    })

    it('whale-despite-low-AF: fires even when AF sample is under the af n-gate (whale ignores AF)', () => {
      const r = classifyPlayerType(results({ vpip: [30, 100], vpipF: [50, 80], af: [5, 10] })) // af n=10 < 20
      expect(r?.type).toBe('whale')
    })

    it('whale-despite-TAG-quadrant: overrides a quadrant that would otherwise classify as TAG', () => {
      // vpip 20% (tight), af 2.0 (aggressive), af n=20 (sufficient) -> would be TAG,
      // but vpipF 60% overrides to whale
      const r = classifyPlayerType(results({ vpip: [20, 100], af: [40, 20], vpipF: [48, 80] }))
      expect(r?.type).toBe('whale')
    })

    it('whale-despite-TAG-quadrant: overrides a quadrant that would otherwise classify as fish/lag too', () => {
      const r = classifyPlayerType(results({ vpip: [50, 100], af: [15, 30], vpipF: [45, 80] })) // vpipF 56.25%
      expect(r?.type).toBe('whale')
    })
  })

  describe('n-gates', () => {
    it('vpip n < 30: no icon at all, even if af and vpipF would otherwise qualify', () => {
      const r = classifyPlayerType(results({ vpip: [10, 29], af: [30, 20], vpipF: [50, 80] }))
      expect(r).toBeNull()
    })

    it('vpip n === 30 (boundary): eligible', () => {
      const r = classifyPlayerType(results({ vpip: [6, 30], af: [30, 20] })) // 20% VPIP, AF 1.5
      expect(r).not.toBeNull()
    })

    it('vpip n >= 30, af n < 20, vpipF absent: no icon (axis unplaceable, no whale data)', () => {
      const r = classifyPlayerType(results({ vpip: [20, 100], af: [10, 19] }))
      expect(r).toBeNull()
    })

    it('vpip n >= 30, af n >= 20, vpipF n < 30: quadrant classification proceeds (whale check skipped)', () => {
      const r = classifyPlayerType(results({ vpip: [20, 100], af: [30, 20], vpipF: [20, 29] }))
      expect(r?.type).toBe('tag')
    })

    it('vpip n >= 30, af n < 20, vpipF n >= 30 with ratio < 50%: no icon (whale does not fire, quadrant gated out)', () => {
      const r = classifyPlayerType(results({ vpip: [20, 100], af: [10, 19], vpipF: [10, 30] })) // vpipF 33%
      expect(r).toBeNull()
    })

    it('af n === 20 (boundary): eligible for quadrant classification', () => {
      const r = classifyPlayerType(results({ vpip: [20, 100], af: [30, 20] }))
      expect(r).not.toBeNull()
    })

    it('vpipF n === 30 (boundary): eligible for whale check', () => {
      const r = classifyPlayerType(results({ vpip: [20, 100], vpipF: [15, 30] })) // 50%
      expect(r?.type).toBe('whale')
    })
  })

  describe('missing-stat robustness', () => {
    it('undefined statResults -> null', () => {
      expect(classifyPlayerType(undefined)).toBeNull()
    })

    it('empty statResults -> null', () => {
      expect(classifyPlayerType([])).toBeNull()
    })

    it('vpip missing entirely -> null', () => {
      const r = classifyPlayerType(results({ af: [30, 20], vpipF: [50, 80] }))
      expect(r).toBeNull()
    })

    it('af and vpipF both missing, vpip sufficient -> null (nothing to classify on)', () => {
      const r = classifyPlayerType(results({ vpip: [20, 100] }))
      expect(r).toBeNull()
    })

    it('malformed StatValue (not a [num, den] tuple) is treated as absent', () => {
      const statResults: StatResult[] = [
        { id: 'vpip', name: 'VPIP', value: 42 }, // plain number, not a fraction
        { id: 'af', name: 'AF', value: [30, 20] },
      ]
      expect(classifyPlayerType(statResults)).toBeNull()
    })

    it('zero-denominator vpip -> null', () => {
      const r = classifyPlayerType(results({ vpip: [0, 0], af: [30, 20] }))
      expect(r).toBeNull()
    })
  })
})
