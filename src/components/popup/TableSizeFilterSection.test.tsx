import { act, render, screen } from '@testing-library/react'
import { useState } from 'react'
import type { TableSizeFilter } from '../../types'
import { rangeToTableSizeFilter } from '../../utils/table-size-range'
import { TableSizeFilterSection } from './TableSizeFilterSection'

/**
 * jsdomはレイアウトを持たない（getBoundingClientRectが全て0）ので、MUI Sliderの
 * ポインタ経路は矩形を与えないと座標→値の変換ができない。既存のPopup.test.tsxは
 * fireEvent.change（隠しinput＝キーボードと同じ経路）しか叩いておらず、
 * ポインタ経路は一切カバーされていなかった。
 */
const TRACK_WIDTH = 300

const stubSliderRect = () => {
  const root = document.querySelector('.MuiSlider-root')
  if (!root) throw new Error('slider root not found')
  root.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: TRACK_WIDTH, bottom: 20,
    width: TRACK_WIDTH, height: 20, toJSON: () => {},
  })
  return root
}

/** 値(1-4)をトラック上のx座標へ。min=1, max=4。 */
const xForValue = (value: number) => ((value - 1) / 3) * TRACK_WIDTH

const Harness = ({ initial }: { initial: TableSizeFilter }) => {
  const [filter, setFilter] = useState(initial)
  return (
    <>
      <TableSizeFilterSection
        tableSizeFilter={filter}
        handleTableSizeFilterChange={(_event, value) => {
          if (!Array.isArray(value) || value.length !== 2) return
          setFilter(rangeToTableSizeFilter([value[0]!, value[1]!]))
        }}
      />
      <output data-testid="applied">{JSON.stringify(filter)}</output>
    </>
  )
}

const applied = () =>
  JSON.parse(screen.getByTestId('applied').textContent!) as TableSizeFilter

/**
 * jsdomには`PointerEvent`が無く、`fireEvent.pointerDown`が作るイベントは
 * `button`を持たない。MUIは`event.button !== 0`で即returnするので、それだと
 * ハンドラへ到達すらしない（＝何をテストしても素通りで通ってしまう）。
 * `button`を持つ`MouseEvent`をpointerdown名で投げる。
 * `fireEvent`と違い生の`dispatchEvent`はactで包まれないので、ここで包む。
 */
const dispatchPointer = (
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  value: number
) => {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: xForValue(value),
    clientY: 10,
    button: 0,
  })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  Object.defineProperty(event, 'pointerType', { value: 'mouse' })
  act(() => {
    target.dispatchEvent(event)
  })
}

/** 移動を伴わない単発クリック（トラックパッドのタップ・静止したマウス）。 */
const clickTrackAt = (root: Element, value: number) => {
  dispatchPointer(root, 'pointerdown', value)
  dispatchPointer(document, 'pointerup', value)
}

beforeAll(() => {
  // Pointer Capture APIはjsdomに無い
  Object.assign(Element.prototype, {
    hasPointerCapture: () => false,
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  })
})

describe('TableSizeFilterSection のポインタ操作', () => {
  it('単一層（フルのみ）から1回のクリックで範囲を広げられる', () => {
    // つまみが両方とも最大端に重なった状態。MUIのfindClosestは同値タイで
    // 上側のつまみを選ぶので、disableSwapを付けていると小さい側への最初の
    // クリックがクランプで握り潰され、無反応になっていた。
    // 「フルのみ」はこのフィルタの主要な使い方なので、そこから抜けられない
    // のは致命的に紛らわしい（見た目つまみは1つなので「固まった」と読める）。
    render(<Harness initial={{ full: true, '4p': false, '3p': false, hu: false }} />)
    const root = stubSliderRect()

    clickTrackAt(root, 2) // 「3人」

    expect(applied()).toEqual({ full: true, '4p': true, '3p': true, hu: false })
  })

  it('単一層（3人のみ）から左方向へ1回のクリックで広げられる', () => {
    render(<Harness initial={{ full: false, '4p': false, '3p': true, hu: false }} />)
    const root = stubSliderRect()

    clickTrackAt(root, 1) // 「HU」

    expect(applied()).toEqual({ full: false, '4p': false, '3p': true, hu: true })
  })

  it('つまみを越えて動かしても下限と上限が入れ替わらない', () => {
    // disableSwapを外したので、区間の不変条件はMUI側の整列に依存する
    // （setValueIndexが常にsort(asc)して返す）。ここを固定しておく。
    render(<Harness initial={{ full: false, '4p': false, '3p': true, hu: true }} />)
    const root = stubSliderRect()

    // 下限つまみ(HU=1)を掴んで、上限(3人=2)を越えて「フル」(=4)まで動かす
    dispatchPointer(root, 'pointerdown', 1)
    dispatchPointer(document, 'pointermove', 4)
    dispatchPointer(document, 'pointerup', 4)

    const result = applied()
    // どの層が選ばれるかは掴んだつまみ次第だが、連続した区間であることは崩れない
    const selected = (['hu', '3p', '4p', 'full'] as const).map(layer => result[layer])
    const first = selected.indexOf(true)
    const last = selected.lastIndexOf(true)
    expect(first).toBeGreaterThanOrEqual(0)
    expect(selected.slice(first, last + 1).every(Boolean)).toBe(true)
  })
})
