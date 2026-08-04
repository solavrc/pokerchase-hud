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
    // 変更監視は初期読込のawaitより前に登録する（MUST）。読込中に届いた変更は
    // onChanged未登録だと失われ、旧値がSWの残りの生存期間ずっと確定してしまう
    // （#361レビュー指摘）。リスナーは常にenabledを更新し、初期読込の結果は
    // 「読込中に変更が届かなかった場合」にだけ適用することで、後着の変更を
    // 初期値で上書きしない。
    let sawChange = false
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync') return
      const change = changes[SW_INGESTION_DIAGNOSTICS_STORAGE_KEY]
      if (!change) return
      sawChange = true
      enabled = change.newValue === true
    })

    let initial = false
    try {
      const stored = await chrome.storage.sync.get(SW_INGESTION_DIAGNOSTICS_STORAGE_KEY)
      initial = stored[SW_INGESTION_DIAGNOSTICS_STORAGE_KEY] === true
    } catch {
      initial = false
    }
    if (!sawChange) enabled = initial
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
