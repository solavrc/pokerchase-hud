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

export function enqueuePendingStorageWrite<T>(write: () => Promise<T>): Promise<T> {
  const result = pendingStorageWriteTail.then(write, write)
  pendingStorageWriteTail = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

/** reload commitが安定性と完了を確認するための現在のtail。 */
export const getPendingStorageWriteTail = (): Promise<void> => pendingStorageWriteTail

/** テスト専用: モジュールスコープのtailを初期状態へ戻す。 */
export const __resetPendingStorageWritesForTests = (): void => {
  pendingStorageWriteTail = Promise.resolve()
}
