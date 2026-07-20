/**
 * 更新情報（What's New）。バージョンごとの変更点をポップアップに表示するための
 * キュレーション済みコンテンツと、それを選択するためのユーティリティ。
 *
 * `src/constants/update.ts`と同じ理由（codex review, PR #150参照）で、
 * サイドエフェクトフリーな独立モジュールとして切り出している:
 * popupが`src/background/whats-new-badge.ts`（`chrome.action`/`chrome.storage`
 * への副作用を持つ）を直接importせずに済むようにするため。
 *
 * `WHATS_NEW_ENTRIES`は新しい順（配列の先頭が最新バージョン）で保持する。
 * 各エントリの`points`は「一行の変更点 + 任意の一行『why』（意図・効能）」
 * という最小フォーマット。日本語コピーはsolaレビュー対象。
 *
 * **リリース手順の一部**: リリースする度（release-pleaseがバージョンを
 * バンプする度）に、このファイルへ新バージョンのエントリを追記すること。
 * 追記を忘れると`selectWhatsNewEntry()`が直近の（古い）エントリへ
 * フォールバックし、ユーザーに「更新情報が無い」ように見えてしまう。
 */
import { compareVersions } from '../utils/version-compare'

export interface WhatsNewPoint {
  /** 一行で読める変更点の説明 */
  text: string
  /** 任意: なぜその変更をしたか（意図・効能）を一行で補足 */
  why?: string
}

export interface WhatsNewEntry {
  /** `chrome.runtime.getManifest().version`と比較する、numeric-dottedのバージョン文字列 */
  version: string
  /** リリース日（YYYY-MM-DD、CHANGELOG.md/release-please PRの日付と一致させる） */
  date: string
  /** エントリの見出し */
  title: string
  points: WhatsNewPoint[]
}

/** 新しい順（先頭が最新）。リリースの度にここへ追記する（このファイル冒頭のコメント参照） */
export const WHATS_NEW_ENTRIES: WhatsNewEntry[] = [
  {
    version: '5.2.0',
    date: '2026-07-20',
    title: 'HUD表示刷新・自動アップデート・安定性強化',
    points: [
      { text: 'コンパクトHUD表示 + カラーコーディング', why: '0.5秒で読める対局中表示へ' }, // #143
      { text: 'ポジション別スタッツのドリルダウン', why: 'ポジションごとの傾向を掘り下げて確認できます' }, // #128
      { text: '各プレイヤーの直近ハンド履歴パネル', why: 'ショーダウンで見えたホールカードとアクションラインを一覧表示' }, // #160
      { text: 'VPIP・Fの卓人数別集計 / テーブル人数フィルタ', why: 'SNG終盤など人数が減った局面の統計の歪みを分離' }, // #130, #131
      { text: 'プレイヤータイプ分類アイコン 🦈💣🪨🐟🐳', why: '相手のタイプを一目で判別' }, // #146
      { text: '対戦開始前にヒーロー統計を先出し表示', why: '着席直後の最初のハンドから確認できます' }, // #158
      { text: 'Popupをダーク/ライトテーマで刷新、起動を高速化', why: '白フラッシュを解消し体感速度を改善' }, // #145, #149, #151, #152
      { text: '安全な瞬間を選んで自動アップデート', why: '対局中は適用を待機し、サポート終了バージョンは警告表示' }, // #150
      { text: '同期・インポート・ポート再接続まわりの安定性を強化', why: 'クラウド同期の切断復帰、インポートの排他制御と失敗時の可視化を改善' }, // #153, #155, #156, #157, #159
    ],
  },
  {
    version: '5.1.0',
    date: '2026-07-18',
    title: 'クラウド同期の安定化',
    points: [
      { text: 'クラウド同期の403エラーを恒久修正', why: 'Firestoreへの書き込み方式を:commit APIに切り替え' }, // #124, #126
      { text: 'Popupの応答性を改善', why: 'Service Workerへの問い合わせにタイムアウトを追加' }, // #127
    ],
  },
  {
    version: '5.0.0',
    date: '2026-07-09',
    title: '統計ロジックの精度向上',
    points: [
      { text: '統計ロジックをPT4準拠に再監査', why: 'AF/AFq/VPIP/PFR/WTSD/WWSFの定義を統一し、WTSDa/WWSFaを追加' }, // #115
    ],
  },
]

export const GITHUB_RELEASES_URL = 'https://github.com/solavrc/pokerchase-hud/releases'

/** `chrome.storage.local`のキー: 未読の更新情報が対応するバージョン（未設定なら未読なし） */
export const WHATS_NEW_STORAGE_KEY = 'whatsNewUnseenVersion'

/**
 * `currentVersion`に一致するエントリを`entries`（新しい順を前提）から選ぶ。
 * 完全一致が無ければ、`currentVersion`以下で最も新しいエントリにフォールバック
 * する（例: リリース直後にまだこのファイルへ追記されていない、または将来
 * ホットフィックスでpatchバージョンだけ上がった場合）。比較不能
 * （`compareVersions`が`null`を返す非数値セグメント）なエントリは無視する。
 *
 * 該当なし（`entries`が空、または`currentVersion`より新しいエントリしか
 * 無い）の場合は`undefined`を返す -- 呼び出し側はセクションを描画しない。
 */
export const selectWhatsNewEntry = (
  currentVersion: string,
  entries: WhatsNewEntry[] = WHATS_NEW_ENTRIES
): WhatsNewEntry | undefined => {
  const exact = entries.find(entry => entry.version === currentVersion)
  if (exact) return exact

  // entriesは新しい順を前提とするため、最初に見つかった「currentVersion以下」の
  // エントリが自動的に「currentVersion以下で最も新しい」エントリになる。
  return entries.find(entry => {
    const cmp = compareVersions(entry.version, currentVersion)
    return cmp !== null && cmp <= 0
  })
}
