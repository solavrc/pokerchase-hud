/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */

/**
 * Service Worker のアイドル停止を防止するキープアライブを開始する。
 * Chrome MV3 では 30 秒のアイドル後に Worker が停止されるため、
 * 長時間のバッチ処理中は30秒未満の間隔でExtension APIを呼び出す。
 * Chrome 110以降はExtension API呼び出しがService Workerのアイドル
 * タイマーをリセットする。manifestのminimum_chrome_versionは120。
 * @returns クリーンアップ関数
 */
export const startKeepAlive = async (): Promise<() => void> => {
  const ping = () => {
    chrome.runtime.getPlatformInfo().catch(() => {})
  }
  // Scheduling an interval does not reset Chrome's idle timer. The caller may
  // arrive here after a slow network/IDB step with little of the original
  // 30-second budget left, so reset it before waiting for the first tick.
  ping()
  const id = setInterval(ping, 25000)
  return () => clearInterval(id)
}
