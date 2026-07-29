/**
 * manifest.jsonの実行バージョンへ対応する正式リリース日。
 * release-pleaseがCHANGELOG.mdへ追加した日付と同時に更新する。
 */
export const RELEASE_DATES_BY_VERSION: Readonly<Record<string, string>> = {
  '5.3.1': '2026-07-23',
  '5.3.0': '2026-07-22',
  '5.2.0': '2026-07-21',
  '5.1.0': '2026-07-18',
  '5.0.0': '2026-07-09',
}
