/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
/**
 * HUD統計表示設定（statDisplayConfigs）の起動時永続化。
 *
 * 背景（#100レビュー）: service worker起動時、保存済みのstatDisplayConfigsは
 * デフォルトとマージしてから`service.statDisplayConfigs`（インメモリ）に設定される
 * （新しい統計がリリースで追加されてもHUDに表示されるようにするため）。
 * しかしHUD自体（`src/components/App.tsx`）はservice workerの状態を経由せず、
 * `chrome.storage.sync`の`options.filterOptions.statDisplayConfigs`を直接読む。
 * そのため、ユーザーがPopupを一度も開かずにマージが必要な状態（新統計追加後の
 * 最初の起動など）だと、HUDはstorageに保存された古い設定のまま表示され続ける。
 *
 * 対処として、起動時にマージ済みの設定をstorageへ書き戻す。ただし毎起動で書き込むと
 * 無駄なstorageイベントやsync競合を招くため、実際に差分がある場合のみ書き込む
 * （`needsConfigPersist`で判定）。
 */
import type { StatDisplayConfig } from '../types/filters'

/**
 * 保存済みのstatDisplayConfigsとマージ後の内容を比較し、storageへの書き戻しが
 * 必要かどうかを判定する（安価な比較: 件数とid集合のみを見る）。
 *
 * - 保存済みが存在しない/空の場合は、初回保存として書き戻しが必要と判定する。
 * - 件数が異なる場合（新規統計の追加・廃止統計の除去）は書き戻しが必要。
 * - 件数が同じでもid集合が異なる場合（入れ替わり）は書き戻しが必要。
 * - それ以外（同一のid集合）は、enabled/orderがユーザー操作で変わっているだけなので
 *   書き戻し不要（ユーザー設定を勝手に上書きしない）。
 */
export const needsConfigPersist = (
  saved: StatDisplayConfig[] | undefined,
  merged: StatDisplayConfig[]
): boolean => {
  if (!saved || saved.length === 0) {
    return merged.length > 0
  }

  if (saved.length !== merged.length) {
    return true
  }

  const savedIds = new Set(saved.map(config => config.id))
  const mergedIds = new Set(merged.map(config => config.id))

  if (savedIds.size !== mergedIds.size) {
    return true
  }

  for (const id of mergedIds) {
    if (!savedIds.has(id)) {
      return true
    }
  }

  return false
}
