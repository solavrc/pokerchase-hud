/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */

/**
 * Service Workerのreload前に完了させる必要があるstorage書き込みの共通FIFO。
 *
 * 書き込み要求を受けた時点でtailを差し替えるため、先行書き込みの完了待ちで
 * まだChrome Storage APIへ渡されていない後続要求も、reloadドレインから
 * 観測できる。各writeの失敗は呼び出し元へ返す一方、FIFO自体は失敗後も
 * 次のwriteを実行する。
 */
let pendingStorageWriteTail: Promise<void> = Promise.resolve()
let pendingStorageWriteCount = 0

export function enqueuePendingStorageWrite<T>(write: () => Promise<T>): Promise<T> {
  pendingStorageWriteCount += 1
  const result = pendingStorageWriteTail.then(write, write)
  pendingStorageWriteTail = result.then(
    () => {
      pendingStorageWriteCount -= 1
    },
    () => {
      pendingStorageWriteCount -= 1
    }
  )
  return result
}

/** reload commitが安定性と完了を確認するための現在のtail。 */
export const getPendingStorageWriteTail = (): Promise<void> => pendingStorageWriteTail

/** 読み取り側が未開始を含む先行writeの有無を判定する。 */
export const hasPendingStorageWrites = (): boolean => pendingStorageWriteCount > 0

/** テスト専用: モジュールスコープのtailを初期状態へ戻す。 */
export const __resetPendingStorageWritesForTests = (): void => {
  pendingStorageWriteTail = Promise.resolve()
  pendingStorageWriteCount = 0
}
