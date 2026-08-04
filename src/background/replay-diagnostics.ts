/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */

export const SW_INGESTION_DIAGNOSTICS_STORAGE_KEY = 'swIngestionDiagnosticsEnabled'

let enabled = false
let initialized = false

/**
 * SW取り込み診断フラグが有効な環境だけで、ポート受信とリプレイキューの時系列を出す。
 * リプレイ取得フラグとは独立して切り替えられなければならない（MUST）。
 * payload・HandId・playerIdはログへ載せない（MUST NOT）。
 */
export const initializeReplayDiagnostics = (): void => {
  if (initialized) return
  initialized = true

  chrome.storage.sync.get(SW_INGESTION_DIAGNOSTICS_STORAGE_KEY)
    .then(stored => {
      enabled = stored[SW_INGESTION_DIAGNOSTICS_STORAGE_KEY] === true
    })
    .catch(() => undefined)

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return
    const change = changes[SW_INGESTION_DIAGNOSTICS_STORAGE_KEY]
    if (change) enabled = change.newValue === true
  })
}

export const logReplayDiagnostic = (
  event: string,
  fields: Record<string, string | number | boolean | undefined>
): void => {
  if (!enabled) return
  console.debug(`[replay-dev] ${event}`, fields)
}

export const __setReplayDiagnosticsEnabledForTests = (next: boolean): void => {
  enabled = next
}
