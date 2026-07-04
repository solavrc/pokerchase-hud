import { mergeStatDisplayConfigs } from './index'
import type { StatDisplayConfig } from '../types/filters'

/**
 * mergeStatDisplayConfigsのユニットテスト
 *
 * 背景: このヘルパーはPopup.tsx（ポップアップUI）とbackground.ts
 * （service-worker起動時のオプション復元、setBattleTypeFilter経由の
 * フィルター更新）の両方から呼ばれる。保存済みの統計表示設定に
 * リリース後追加された新しい統計（例: #86のSTL/FTS）が欠けていても、
 * デフォルト設定とマージすることでHUDから新統計が漏れないようにする。
 */
describe('mergeStatDisplayConfigs', () => {
  const defaults: StatDisplayConfig[] = [
    { id: 'hands', enabled: true, order: 0 },
    { id: 'vpip', enabled: true, order: 1 },
    { id: 'pfr', enabled: true, order: 2 },
    { id: 'steal', enabled: true, order: 3 },      // 新規追加された統計を想定
    { id: 'foldToSteal', enabled: true, order: 4 } // 新規追加された統計を想定
  ]

  it('保存済み設定に存在しない新しいIDはデフォルト設定のまま末尾側に追加される', () => {
    // 保存済み設定はsteal/foldToStealが追加される前のバージョン
    const saved: StatDisplayConfig[] = [
      { id: 'hands', enabled: true, order: 0 },
      { id: 'vpip', enabled: false, order: 2 }, // ユーザーが無効化＆並び替え済み
      { id: 'pfr', enabled: true, order: 1 }
    ]

    const merged = mergeStatDisplayConfigs(saved, defaults)

    // 新規統計（steal, foldToSteal）がデフォルト設定のまま含まれる
    const steal = merged.find(c => c.id === 'steal')
    const foldToSteal = merged.find(c => c.id === 'foldToSteal')
    expect(steal).toEqual({ id: 'steal', enabled: true, order: 3 })
    expect(foldToSteal).toEqual({ id: 'foldToSteal', enabled: true, order: 4 })

    // 既存統計はユーザー設定（enabled/order）を維持する
    expect(merged.find(c => c.id === 'vpip')).toEqual({ id: 'vpip', enabled: false, order: 2 })
    expect(merged.find(c => c.id === 'pfr')).toEqual({ id: 'pfr', enabled: true, order: 1 })

    // 全項目が含まれ、廃止された項目は存在しない
    expect(merged.map(c => c.id).sort()).toEqual(defaults.map(c => c.id).sort())

    // orderでソートされている
    expect(merged.map(c => c.order)).toEqual([...merged.map(c => c.order)].sort((a, b) => a - b))
  })

  it('保存済み設定が空配列の場合はデフォルト設定がそのまま返る', () => {
    const merged = mergeStatDisplayConfigs([], defaults)
    expect(merged).toEqual(defaults.slice().sort((a, b) => a.order - b.order))
  })

  it('保存済み設定がundefinedの場合はデフォルト設定がそのまま返る（service-worker起動時の初回など）', () => {
    const merged = mergeStatDisplayConfigs(undefined, defaults)
    expect(merged).toEqual(defaults.slice().sort((a, b) => a.order - b.order))
  })

  it('デフォルトに存在しない廃止済みの統計IDは結果から除外される', () => {
    const saved: StatDisplayConfig[] = [
      { id: 'hands', enabled: true, order: 0 },
      { id: 'vpip', enabled: true, order: 1 },
      { id: 'pfr', enabled: true, order: 2 },
      { id: 'steal', enabled: true, order: 3 },
      { id: 'foldToSteal', enabled: true, order: 4 },
      { id: 'obsoleteStat', enabled: true, order: 5 } // もう存在しない統計
    ]

    const merged = mergeStatDisplayConfigs(saved, defaults)

    expect(merged.find(c => c.id === 'obsoleteStat')).toBeUndefined()
    expect(merged).toHaveLength(defaults.length)
  })

  it('全項目が保存済みの場合はenabled/orderがそのまま保持される（冪等性）', () => {
    const saved: StatDisplayConfig[] = defaults.map(c => ({ ...c, enabled: false }))
    const merged = mergeStatDisplayConfigs(saved, defaults)
    expect(merged.every(c => c.enabled === false)).toBe(true)
    expect(merged).toHaveLength(defaults.length)
  })
})
