/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */

export const SW_INGESTION_DIAGNOSTICS_STORAGE_KEY = 'swIngestionDiagnosticsEnabled'

let enabled = false
let initialization: Promise<void> | undefined
let ready = false
const pendingLogs: Array<{
  event: string
  fields: Record<string, string | number | boolean | undefined>
}> = []

const emitReplayDiagnostic = (
  event: string,
  fields: Record<string, string | number | boolean | undefined>
): void => {
  if (!enabled) return
  console.debug(`[replay-dev] ${event}`, fields)
}

/**
 * SW取り込み診断フラグが有効な環境だけで、ポート受信とリプレイキューの時系列を出す。
 * リプレイ取得フラグとは独立して切り替えられなければならない（MUST）。
 * payload・HandId・playerIdはログへ載せない（MUST NOT）。
 */
export const initializeReplayDiagnostics = (): Promise<void> => {
  if (initialization) return initialization

  initialization = (async () => {
    try {
      const stored = await chrome.storage.sync.get(SW_INGESTION_DIAGNOSTICS_STORAGE_KEY)
      enabled = stored[SW_INGESTION_DIAGNOSTICS_STORAGE_KEY] === true
    } catch {
      enabled = false
    }

    // 初期値の読込が決着してから変更監視を登録する（MUST）。診断ONの保存値を
    // 読む前に起動イベントをOFFとして確定させない。
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync') return
      const change = changes[SW_INGESTION_DIAGNOSTICS_STORAGE_KEY]
      if (change) enabled = change.newValue === true
    })
    for (const pending of pendingLogs.splice(0)) {
      emitReplayDiagnostic(pending.event, pending.fields)
    }
    ready = true
  })()
  return initialization
}

export const logReplayDiagnostic = (
  event: string,
  fields: Record<string, string | number | boolean | undefined>
): void => {
  if (ready) {
    emitReplayDiagnostic(event, fields)
    return
  }
  // `runtime.onConnect`の登録はMV3の起動イベントを逃さないよう同期のまま保ち、
  // 初期化中に届いた診断だけを保存値の読込後へ到着順のまま繰り延べる。
  pendingLogs.push({ event, fields })
  void initializeReplayDiagnostics()
}

export const __setReplayDiagnosticsEnabledForTests = (next: boolean): void => {
  enabled = next
}
