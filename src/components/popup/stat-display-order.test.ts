import type { StatDisplayConfig } from '../../types/filters'
import { defaultStatDisplayConfigs } from '../../stats'
import { getStatConfigsInDisplayOrder, moveStatInDisplayOrder } from './stat-display-order'

/**
 * ポップアップの統計並べ替えロジックのユニットテスト。
 *
 * 中核の不変条件: 1クリック = 表示リスト上で1段移動。
 * 表示されない`playerName`のスロットを跨ぐ移動でも「見た目が変わらない
 * デッドクリック」を発生させない。
 */
describe('getStatConfigsInDisplayOrder', () => {
  it('playerNameを除外しorderの昇順で返す', () => {
    const configs: StatDisplayConfig[] = [
      { id: 'vpip', enabled: true, order: 2 },
      { id: 'playerName', enabled: true, order: 1 },
      { id: 'hands', enabled: true, order: 0 },
    ]

    expect(getStatConfigsInDisplayOrder(configs).map(config => config.id)).toEqual(['hands', 'vpip'])
  })

  it('入力配列を破壊しない（sortのin-place副作用を漏らさない）', () => {
    const configs: StatDisplayConfig[] = [
      { id: 'vpip', enabled: true, order: 2 },
      { id: 'playerName', enabled: true, order: 1 },
      { id: 'hands', enabled: true, order: 0 },
    ]

    getStatConfigsInDisplayOrder(configs)

    expect(configs.map(config => config.id)).toEqual(['vpip', 'playerName', 'hands'])
  })
})

describe('moveStatInDisplayOrder', () => {
  const displayOrderOf = (configs: StatDisplayConfig[]) =>
    getStatConfigsInDisplayOrder(configs).map(config => config.id)

  // 表示されないplayerNameがhandsとvpipの間（order 1）に挟まる既定構成。
  // 生配列インデックスで隣接要素とorderを交換する実装は、ここでデッドクリック
  // （↑を押しても表示順が変わらない）になっていた。
  const configs: StatDisplayConfig[] = [
    { id: 'hands', enabled: true, order: 0 },
    { id: 'playerName', enabled: true, order: 1 },
    { id: 'vpip', enabled: true, order: 2 },
    { id: 'vpipF', enabled: false, order: 3 },
  ]

  it('1回の↑で表示リスト上を必ず1段だけ移動する（playerNameを跨ぐケース）', () => {
    const moved = moveStatInDisplayOrder(configs, 'vpip', 'up')

    expect(displayOrderOf(moved!)).toEqual(['vpip', 'hands', 'vpipF'])
  })

  it('1回の↓で表示リスト上を必ず1段だけ移動する（playerNameを跨ぐケース）', () => {
    const moved = moveStatInDisplayOrder(configs, 'hands', 'down')

    expect(displayOrderOf(moved!)).toEqual(['vpip', 'hands', 'vpipF'])
  })

  it('非表示のplayerNameは表示リストの並べ替えに巻き込まれない（自身のスロットに据え置き）', () => {
    const moved = moveStatInDisplayOrder(configs, 'vpip', 'up')!

    // playerNameは元のスロット（前後1件ずつの間）に残ったまま、
    // 全体のorderが0..n-1に振り直される
    expect(moved.map(config => ({ id: config.id, order: config.order }))).toEqual([
      { id: 'vpip', order: 0 },
      { id: 'playerName', order: 1 },
      { id: 'hands', order: 2 },
      { id: 'vpipF', order: 3 },
    ])
  })

  it('表示リストの端を越える移動はnullを返す（未適用フラグを立てさせない）', () => {
    expect(moveStatInDisplayOrder(configs, 'hands', 'up')).toBeNull()
    expect(moveStatInDisplayOrder(configs, 'vpipF', 'down')).toBeNull()
  })

  it('未知のIDはnullを返す', () => {
    expect(moveStatInDisplayOrder(configs, 'unknownStat', 'up')).toBeNull()
  })

  it('order重複があっても1クリックで1段だけ動く（order交換ではなく振り直し）', () => {
    // mergeStatDisplayConfigsは新規統計にデフォルトorderを、既存統計には
    // ユーザー保存orderを与えるため、両者が衝突した設定が実在しうる。
    // order値の交換だと衝突時に見た目が変わらないデッドクリックになる。
    const duplicated: StatDisplayConfig[] = [
      { id: 'hands', enabled: true, order: 0 },
      { id: 'vpip', enabled: true, order: 1 },
      { id: 'pfr', enabled: true, order: 1 },
    ]

    const moved = moveStatInDisplayOrder(duplicated, 'pfr', 'up')!

    expect(displayOrderOf(moved)).toEqual(['hands', 'pfr', 'vpip'])
    expect(moved.map(config => config.order)).toEqual([0, 1, 2])
  })

  it('enabledなど他のフィールドを保持する', () => {
    const moved = moveStatInDisplayOrder(configs, 'vpipF', 'up')!

    expect(moved.find(config => config.id === 'vpipF')).toEqual({ id: 'vpipF', enabled: false, order: 2 })
  })

  it('入力の要素をコピーして返す（defaultStatDisplayConfigsを汚染しない）', () => {
    const before = defaultStatDisplayConfigs.map(config => ({ ...config }))

    // Popupの初期stateはdefaultStatDisplayConfigsそのもの。
    // 要素をその場で書き換える実装だとモジュールレベルの既定構成が壊れる。
    const moved = moveStatInDisplayOrder(defaultStatDisplayConfigs, 'vpip', 'up')!

    expect(defaultStatDisplayConfigs).toEqual(before)
    moved.forEach(config => {
      expect(defaultStatDisplayConfigs).not.toContain(config)
    })
  })
})
