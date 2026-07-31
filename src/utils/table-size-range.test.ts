import { DEFAULT_TABLE_SIZE_FILTER, type TableSizeFilter } from './table-size'
import {
  TABLE_SIZE_SLIDER_LAYERS,
  TABLE_SIZE_SLIDER_MAX,
  TABLE_SIZE_SLIDER_MIN,
  rangeToTableSizeFilter,
  tableSizeFilterToRange,
} from './table-size-range'

describe('table-size-range', () => {
  it('スライダーの並びは人数の少ない順（左がHU、右がフル）', () => {
    expect([...TABLE_SIZE_SLIDER_LAYERS]).toEqual(['hu', '3p', '4p', 'full'])
    expect(TABLE_SIZE_SLIDER_MIN).toBe(1)
    expect(TABLE_SIZE_SLIDER_MAX).toBe(4)
  })

  it('既定（全層）は両端いっぱい＝フィルタなし', () => {
    expect(tableSizeFilterToRange(DEFAULT_TABLE_SIZE_FILTER)).toEqual([1, 4])
  })

  it.each<[string, TableSizeFilter, [number, number]]>([
    ['HUのみ', { full: false, '4p': false, '3p': false, hu: true }, [1, 1]],
    ['フルのみ', { full: true, '4p': false, '3p': false, hu: false }, [4, 4]],
    ['3人以下', { full: false, '4p': false, '3p': true, hu: true }, [1, 2]],
    ['4人以上', { full: true, '4p': true, '3p': false, hu: false }, [3, 4]],
  ])('%s は連続した区間へ畳まれる', (_label, filter, expected) => {
    expect(tableSizeFilterToRange(filter)).toEqual(expected)
  })

  it('全解除は全選択と同じ扱い（既存の「何も選ばれていない＝フィルタなし」規約）', () => {
    expect(
      tableSizeFilterToRange({ full: false, '4p': false, '3p': false, hu: false })
    ).toEqual([1, 4])
  })

  it('連続していない旧設定は、選択層をすべて含む最小区間へ丸める', () => {
    // 旧チェックボックスUIでのみ作れた状態（HUとフルだけ）。間の層が増える
    // 方向へしか動かないので、選んだ層が消えることはない。
    expect(
      tableSizeFilterToRange({ full: true, '4p': false, '3p': false, hu: true })
    ).toEqual([1, 4])
  })

  it('区間から層ごとのbooleanへ戻せる', () => {
    expect(rangeToTableSizeFilter([2, 3])).toEqual({
      full: false, '4p': true, '3p': true, hu: false,
    })
    expect(rangeToTableSizeFilter([1, 4])).toEqual(DEFAULT_TABLE_SIZE_FILTER)
  })

  it('連続した選択なら往復して元へ戻る', () => {
    for (let min = TABLE_SIZE_SLIDER_MIN; min <= TABLE_SIZE_SLIDER_MAX; min++) {
      for (let max = min; max <= TABLE_SIZE_SLIDER_MAX; max++) {
        const range: [number, number] = [min, max]
        expect(tableSizeFilterToRange(rangeToTableSizeFilter(range))).toEqual(range)
      }
    }
  })
})
