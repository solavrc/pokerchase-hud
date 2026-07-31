import type { StatDisplayConfig } from '../../types/filters'

/**
 * ポップアップの並べ替えリストに載らない統計。
 *
 * `playerName`はHUDヘッダーに常時表示されるため、ユーザーが順序を操作できる
 * 対象ではない（StatisticsConfigSectionの一覧から除外される）。
 */
const HIDDEN_STAT_IDS: readonly string[] = ['playerName']

export const isStatListedInPopup = (config: StatDisplayConfig): boolean =>
  !HIDDEN_STAT_IDS.includes(config.id)

/**
 * ポップアップの並べ替えリストに表示される統計を、表示順（orderの昇順）で返す。
 *
 * これがユーザーに見えている唯一の順序であり、↑↓の移動単位・
 * disabled判定（先頭/末尾）はすべてこのリスト基準でなければならない。
 */
export const getStatConfigsInDisplayOrder = (
  configs: StatDisplayConfig[]
): StatDisplayConfig[] =>
  configs.filter(isStatListedInPopup).sort((a, b) => a.order - b.order)

/**
 * 表示リスト上で統計を1つ上/下に移動した新しい設定配列を返す。
 * 移動できない場合（未知のID・すでに端）はnullを返す。
 *
 * 基準は必ず「表示リスト」であって、statDisplayConfigsの生の配列インデックス
 * ではない。生配列の隣接要素とorderを交換する実装では、表示上は隣り合って
 * いない`playerName`と入れ替わるケース（VPIPの↑1回目、HANDの↓1回目）で
 * 表示順が全く変化しないデッドクリックになる。
 *
 * 非表示項目は元のスロット位置に据え置き、表示項目だけを入れ替えたうえで
 * order全体を0..n-1に振り直す。order値の交換ではなく振り直しにしているのは、
 * order重複があっても1クリック=1段の移動を保証するため（mergeStatDisplayConfigs
 * は新規統計にデフォルトorderを、既存統計にユーザー保存orderを与えるので、
 * 両者が衝突した設定が実在しうる）。
 *
 * 要素は必ずコピーしてから書き換える: 呼び出し側のconfigsは
 * `defaultStatDisplayConfigs`の要素をそのまま参照しうる（Popupの初期state、
 * および`mergeStatDisplayConfigs`の新規統計パス）ため、その場でorderを
 * 書き換えるとモジュールレベルのデフォルト構成を汚染する。
 */
export const moveStatInDisplayOrder = (
  configs: StatDisplayConfig[],
  statId: string,
  direction: 'up' | 'down'
): StatDisplayConfig[] | null => {
  // 表示リストと同じ順序で全項目を並べる（Array.prototype.sortは安定ソート）
  const sortedConfigs = [...configs].sort((a, b) => a.order - b.order)

  // 表示項目が入っているスロット位置（非表示項目のスロットは含まない）
  const listedSlots = sortedConfigs.reduce<number[]>((slots, config, slot) => {
    if (isStatListedInPopup(config)) slots.push(slot)
    return slots
  }, [])

  const listedIndex = listedSlots.findIndex(slot => sortedConfigs[slot]!.id === statId)
  if (listedIndex === -1) return null

  const targetIndex = direction === 'up' ? listedIndex - 1 : listedIndex + 1
  if (targetIndex < 0 || targetIndex >= listedSlots.length) return null

  // 表示リスト上で隣接する2項目を入れ替える（非表示項目のスロットは据え置き）
  const fromSlot = listedSlots[listedIndex]!
  const toSlot = listedSlots[targetIndex]!
  const reordered = [...sortedConfigs]
  reordered[fromSlot] = sortedConfigs[toSlot]!
  reordered[toSlot] = sortedConfigs[fromSlot]!

  return reordered.map((config, order) => ({ ...config, order }))
}
