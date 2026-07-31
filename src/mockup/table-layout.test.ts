import { ACTION_BAR } from './table-layout'

/**
 * ベット額スライダーだけは実機スクリーンショットの実測値をそのまま使わず、
 * 周囲のチップとの関係で決めている（sola指摘）。関係は目視でしか確認できない
 * ので、ここで数値として固定する。プリセットの座標を後から動かしたときに
 * 「はみ出し」と「◆のずれ」が黙って戻らないようにするのが目的。
 */
describe('betSliderInvariants', () => {
  const right = (rect: { l: number, w: number }) => rect.l + rect.w
  const allIn = ACTION_BAR.multipliers[ACTION_BAR.multipliers.length - 1]!

  it('最後のプリセットはオールイン', () => {
    // 右端の基準にしているので、並び替えられたら気付けるようにする
    expect(allIn.label).toBe('オールイン')
  })

  it('トラックの右端はオールインの右端で止まる', () => {
    expect(right(ACTION_BAR.slider)).toBeCloseTo(right(allIn), 5)
  })

  it('トラックは＋ボタンとバー枠からはみ出さない', () => {
    // 実測値(93.9%)のままだと、＋ボタン(92.2%)もバー枠(93%)も越えていた
    expect(right(ACTION_BAR.slider)).toBeLessThanOrEqual(right(ACTION_BAR.plus))
    expect(right(ACTION_BAR.slider)).toBeLessThanOrEqual(right(ACTION_BAR.frame))
  })

  it('◆はトラックの上下中央に乗る', () => {
    const trackCenter = ACTION_BAR.slider.t + ACTION_BAR.slider.h / 2
    expect(ACTION_BAR.sliderKnob.t).toBeCloseTo(trackCenter, 5)
  })

  it('◆はトラックの左右の範囲に収まる', () => {
    expect(ACTION_BAR.sliderKnob.l).toBeGreaterThanOrEqual(ACTION_BAR.slider.l)
    expect(ACTION_BAR.sliderKnob.l).toBeLessThanOrEqual(right(ACTION_BAR.slider))
  })
})
