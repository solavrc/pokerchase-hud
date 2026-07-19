import { getStatValueColor, LOW_SAMPLE_COLOR, MIN_DENOMINATOR_FOR_COLOR } from './statColorRules'

describe('statColorRules', () => {
  describe('n-gate（サンプルサイズ）', () => {
    it('分母がMIN_DENOMINATOR_FOR_COLOR未満の場合は既存の低信頼度グレーを返す', () => {
      expect(getStatValueColor('vpip', [3, MIN_DENOMINATOR_FOR_COLOR - 1])).toBe(LOW_SAMPLE_COLOR)
    })

    it('分母がMIN_DENOMINATOR_FOR_COLORちょうどの場合は帯に従って着色する', () => {
      // 25% VPIP, n=20 -> tight/loose境界内（20-28）でデフォルト色（null）
      expect(getStatValueColor('vpip', [5, 20])).toBeNull()
    })

    it('分母が0の場合はnull（"-"表示なので着色対象外）', () => {
      expect(getStatValueColor('vpip', [0, 0])).toBeNull()
    })
  })

  describe('VPIP/PFRの帯', () => {
    it('20%未満はタイト/ブルー', () => {
      expect(getStatValueColor('vpip', [10, 100])).toBe('#64b5f6')
      expect(getStatValueColor('pfr', [10, 100])).toBe('#64b5f6')
    })

    it('20-28%はデフォルト色（null）', () => {
      expect(getStatValueColor('vpip', [24, 100])).toBeNull()
    })

    it('28-40%はルース/オレンジ', () => {
      expect(getStatValueColor('vpip', [35, 100])).toBe('#ffb74d')
    })

    it('40%超は非常にルース/レッド', () => {
      expect(getStatValueColor('vpip', [45, 100])).toBe('#e57373')
    })

    it('境界値はちょうどの上限側の帯に属する（上限inclusive、#143 review）', () => {
      // 20.0% ちょうど -> ブルー帯の上限（次の帯にフォールスルーしない）
      expect(getStatValueColor('vpip', [20, 100])).toBe('#64b5f6')
      // 28.0% ちょうど -> デフォルト帯の上限
      expect(getStatValueColor('vpip', [28, 100])).toBeNull()
      // 40.0% ちょうど -> オレンジ帯の上限（レッドに繰り上がらない）
      expect(getStatValueColor('vpip', [40, 100])).toBe('#ffb74d')
      expect(getStatValueColor('pfr', [40, 100])).toBe('#ffb74d')
    })
  })

  describe('3betの帯', () => {
    it('6%未満はブルー', () => {
      expect(getStatValueColor('3bet', [3, 100])).toBe('#64b5f6')
    })

    it('6-10%はデフォルト色（null）', () => {
      expect(getStatValueColor('3bet', [8, 100])).toBeNull()
    })

    it('10%超はオレンジ', () => {
      expect(getStatValueColor('3bet', [15, 100])).toBe('#ffb74d')
    })

    it('境界値はちょうどの上限側の帯に属する（上限inclusive、#143 review）', () => {
      // 6.0% ちょうど -> ブルー帯の上限
      expect(getStatValueColor('3bet', [6, 100])).toBe('#64b5f6')
      // 10.0% ちょうど -> デフォルト帯の上限（オレンジに繰り上がらない）
      expect(getStatValueColor('3bet', [10, 100])).toBeNull()
    })
  })

  describe('AFの帯', () => {
    it('1.5未満はブルー', () => {
      expect(getStatValueColor('af', [10, 100])).toBe('#64b5f6')
    })

    it('1.5-3はデフォルト色（null）', () => {
      expect(getStatValueColor('af', [200, 100])).toBeNull()
    })

    it('3超はレッド', () => {
      expect(getStatValueColor('af', [400, 100])).toBe('#e57373')
    })

    it('境界値はちょうどの上限側の帯に属する（上限inclusive、#143 review）', () => {
      // 分母はn-gate(MIN_DENOMINATOR_FOR_COLOR=20)以上にする -- 未満だと
      // 帯にかかわらず低信頼度グレーになるため
      // 1.5 ちょうど -> ブルー帯の上限
      expect(getStatValueColor('af', [30, 20])).toBe('#64b5f6')
      // 3.0 ちょうど -> デフォルト帯の上限（レッドに繰り上がらない）
      expect(getStatValueColor('af', [60, 20])).toBeNull()
    })
  })

  describe('ルール未定義の統計・不正な値', () => {
    it('しきい値ルールを持たない統計IDはnullを返す', () => {
      expect(getStatValueColor('hands', [67, 67])).toBeNull()
      expect(getStatValueColor('wtsd', [30, 100])).toBeNull()
    })

    it('[num, den]形式でない値はnullを返す', () => {
      expect(getStatValueColor('vpip', 42)).toBeNull()
      expect(getStatValueColor('vpip', 'TestPlayer')).toBeNull()
    })
  })
})
