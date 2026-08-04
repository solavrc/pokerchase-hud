/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
import { EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY } from '../replay/protocol'

let enabled = false
let initialized = false

/**
 * 開発者フラグが有効な環境だけで、リプレイと取り込みキューの時系列を出す。
 * payload・HandId・playerIdはログへ載せない（MUST NOT）。
 */
export const initializeReplayDiagnostics = (): void => {
  if (initialized) return
  initialized = true

  chrome.storage.sync.get(EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY)
    .then(stored => {
      enabled = stored[EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY] === true
    })
    .catch(() => undefined)

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return
    const change = changes[EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY]
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
