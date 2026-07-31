/**
 * テーブル人数フィルタの「連続した範囲」表現。
 *
 * 層は人数の順に並んでいて（HU < 3人 < 4人 < フル）、実際に選びたいのは
 * 常にその連続した一区間になる ―― 「HUとフルは対象だが4人は対象外」という
 * 選び方に意味のある状況が無いから（sola）。チェックボックスの多選択は
 * その無意味な組み合わせまで表現できてしまうので、両端だけを持つ
 * レンジとして扱う。
 *
 * 保存形式（`TableSizeFilter` の層ごとのboolean）は変えない。フィルタの
 * 適用側（`selectedTableSizeLayers` / `matchesTableSizeFilter`）も
 * そのまま使えるし、旧版と設定を共有しても壊れない。
 */
import {
  ALL_TABLE_SIZE_LAYERS,
  type TableSizeFilter,
  type TableSizeLayer,
} from './table-size'

/**
 * スライダーの目盛り順。左が少人数、右が満席。`ALL_TABLE_SIZE_LAYERS`
 * （フル→HU）の逆順で、スライダーは左から右へ増えるのが自然なため。
 */
export const TABLE_SIZE_SLIDER_LAYERS: readonly TableSizeLayer[] = [
  ...ALL_TABLE_SIZE_LAYERS,
].reverse()

/** スライダー値（1始まり）の範囲。目盛りラベルは呼び出し側が持つ。 */
export const TABLE_SIZE_SLIDER_MIN = 1
export const TABLE_SIZE_SLIDER_MAX = TABLE_SIZE_SLIDER_LAYERS.length

/**
 * 層ごとのbooleanを、スライダーの両端 `[min, max]` へ畳む。
 *
 * 連続していない選択（旧版のチェックボックスで作れてしまった状態）は、
 * 選択されている層をすべて含む最小の区間へ丸める。間の層が増える方向へ
 * しか動かないので、「選んだはずの層が消える」ことは起きない。
 * 全解除は全選択と同じ扱い（`selectedTableSizeLayers` の既存の規約:
 * 何も選ばれていない＝フィルタなし）。
 */
export const tableSizeFilterToRange = (
  filter: TableSizeFilter
): [number, number] => {
  const selected = TABLE_SIZE_SLIDER_LAYERS
    .map((layer, index) => (filter[layer] ? index + 1 : null))
    .filter((value): value is number => value !== null)

  if (selected.length === 0) return [TABLE_SIZE_SLIDER_MIN, TABLE_SIZE_SLIDER_MAX]
  return [Math.min(...selected), Math.max(...selected)]
}

/** スライダーの両端から層ごとのbooleanへ戻す。 */
export const rangeToTableSizeFilter = (
  range: [number, number]
): TableSizeFilter => {
  const [min, max] = range
  const filter = {} as TableSizeFilter
  TABLE_SIZE_SLIDER_LAYERS.forEach((layer, index) => {
    const value = index + 1
    filter[layer] = value >= min && value <= max
  })
  return filter
}
