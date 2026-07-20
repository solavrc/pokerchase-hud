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
    title: 'HUDが見やすく、賢くなりました',
    points: [
      { text: '対戦中のHUDがすっきり読みやすくなりました', why: '主要な数値だけを大きく表示し、数値の高低を色で判別。クリックで従来の詳細表示に切り替わります' }, // #143
      { text: '相手のプレイスタイルがアイコンでわかるようになりました', why: '🦈タイトで強気 💣手広く強気 🪨堅実 🐟ルース 🐳超ルース。十分なハンド数が貯まると表示されます' }, // #146
      { text: '相手のポジションごとの傾向を確認できるようになりました', why: 'パネルの ▸ を押すと、ボタンやブラインドなど位置別の成績が開きます' }, // #128
      { text: '相手の過去のハンドを振り返れるようになりました', why: 'パネルの ≡ から、ショーダウンで見えたカードとプレイの流れを一覧できます' }, // #160
      { text: '対戦が始まる前から自分の成績が表示されるようになりました' }, // #158
      { text: '少人数テーブルで数値が高く出る歪みに対応しました', why: '満席時だけの成績表示(VPIP·F)と、テーブル人数での絞り込みを追加' }, // #130, #131
      { text: '設定画面を一新しました', why: 'ダーク/ライトテーマに対応し、開いた瞬間に表示されるようになりました' }, // #145, #149, #151, #152
      { text: 'アップデートが自動で適用されるようになりました', why: '対戦中は避けて、切りの良いタイミングで適用します' }, // #150
      { text: 'クラウド保存やデータ取り込みの安定性を改善しました' }, // #153, #155, #156, #157, #159
    ],
  },
  {
    version: '5.1.0',
    date: '2026-07-18',
    title: 'クラウドバックアップの復旧',
    points: [
      { text: 'クラウドバックアップが失敗し続ける問題を修正しました', why: '対戦データが再び自動で保存されるようになりました' }, // #124, #126
      { text: '設定画面が固まる・開かない問題を修正しました' }, // #127
    ],
  },
  {
    version: '5.0.0',
    date: '2026-07-09',
    title: '成績数値の精度向上',
    points: [
      { text: '各種成績の計算を主要ポーカーツールの標準に合わせました', why: '他のツールと数値をそのまま比べられます' }, // #115
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
