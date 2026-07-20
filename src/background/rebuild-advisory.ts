/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
/**
 * データ再構築アドバイザリ。
 *
 * `REBUILD_ADVISORY_VERSION`（`src/constants/database.ts`）がバンプされた状態で
 * 拡張機能が更新されたとき、既存データを持つユーザーに対して一度だけ
 * 「データ再構築」の実行を促す。状態は`chrome.storage.local`の`rebuildAdvisory`
 * キーに永続化し、拡張機能アイコンのバッジと通知、およびPopup内バナーで
 * ユーザーに知らせる。
 *
 * バッジ優先順位（3-way, rebuild-advisory > update-manager > whats-new）:
 * このファイルは最上位固定で、他モジュールの存在を知らず常に無条件で
 * バッジを制御する（「勝ち」側）。update-manager.ts/whats-new-badge.tsは
 * このファイルの状態（`getRebuildAdvisoryState().pendingVersion`）を
 * 確認してからno-opする側。詳細はupdate-manager.ts冒頭のコメント・
 * whats-new-badge.ts冒頭のコメント・CLAUDE.mdを参照。
 */
import type { PokerChaseDB } from '../db/poker-chase-db'
import { REBUILD_ADVISORY_VERSION } from '../constants/database'

export const REBUILD_ADVISORY_STORAGE_KEY = 'rebuildAdvisory'

export interface RebuildAdvisoryState {
  /** ユーザーへの提示待ちのバージョン。未設定ならアドバイザリなし */
  pendingVersion?: number
  /** ユーザーが最後に解消（rebuild実行 or 閉じる）したバージョン */
  acknowledgedVersion?: number
}

const BADGE_TEXT = '!'
const BADGE_BACKGROUND_COLOR = '#d70022'

/** `chrome.storage.local`から現在のアドバイザリ状態を取得する */
export const getRebuildAdvisoryState = async (): Promise<RebuildAdvisoryState> => {
  const result = await chrome.storage.local.get(REBUILD_ADVISORY_STORAGE_KEY)
  return (result?.[REBUILD_ADVISORY_STORAGE_KEY] as RebuildAdvisoryState | undefined) ?? {}
}

const setRebuildAdvisoryState = async (state: RebuildAdvisoryState): Promise<void> => {
  await chrome.storage.local.set({ [REBUILD_ADVISORY_STORAGE_KEY]: state })
}

/** バッジ表示（API未対応環境ではno-op） */
const setBadge = (): void => {
  if (!chrome.action?.setBadgeText) return
  try {
    chrome.action.setBadgeText({ text: BADGE_TEXT })
    chrome.action.setBadgeBackgroundColor?.({ color: BADGE_BACKGROUND_COLOR })
  } catch (error) {
    console.warn('[rebuild-advisory] Failed to set badge:', error)
  }
}

/** バッジ解除（API未対応環境ではno-op） */
const clearBadge = (): void => {
  if (!chrome.action?.setBadgeText) return
  try {
    chrome.action.setBadgeText({ text: '' })
  } catch (error) {
    console.warn('[rebuild-advisory] Failed to clear badge:', error)
  }
}

/** ユーザーへの通知（API未対応環境ではno-op） */
const notifyUser = (): void => {
  if (!chrome.notifications?.create) return
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon_128px.png'),
      title: '統計ロジックが更新されました',
      message: '拡張機能の更新により統計ロジックが改善されました。ポップアップから「データ再構築」を実行して、既存データに正しい統計を反映してください。'
    })
  } catch (error) {
    console.warn('[rebuild-advisory] Failed to create notification:', error)
  }
}

/**
 * `chrome.runtime.onInstalled`（`details.reason === 'update'`）から呼び出す。
 *
 * `REBUILD_ADVISORY_VERSION`が既に確認済みバージョンより新しく、かつ既存の
 * `apiEvents`が存在する場合、アドバイザリを保留状態にしてバッジ・通知を出す。
 * データが存在しない場合は再構築の必要がないため、確認済みとして静かに記録する。
 */
export const checkOnUpdate = async (db: PokerChaseDB): Promise<void> => {
  const state = await getRebuildAdvisoryState()
  const acknowledgedVersion = state.acknowledgedVersion ?? 0

  if (REBUILD_ADVISORY_VERSION <= acknowledgedVersion) {
    // 既にこのバージョンまで確認済み（二重通知の防止）
    return
  }

  if (state.pendingVersion === REBUILD_ADVISORY_VERSION) {
    // 既に本バージョンのアドバイザリを提示済み（ユーザーがリビルド/解消せずに
    // 再度拡張機能を更新した状態）。通知を再送すると更新の度に通知が積み重なって
    // しまうため、バッジ（ブラウザ再起動後も見えるように再アサートしておく）だけ
    // 更新し、通知の再送と冗長なストレージ書き込みはスキップする。
    setBadge()
    return
  }

  const eventCount = await db.apiEvents.count()

  if (eventCount === 0) {
    // 再構築対象のデータが存在しない場合は通知不要
    await setRebuildAdvisoryState({ ...state, acknowledgedVersion: REBUILD_ADVISORY_VERSION, pendingVersion: undefined })
    return
  }

  await setRebuildAdvisoryState({ ...state, pendingVersion: REBUILD_ADVISORY_VERSION })
  setBadge()
  notifyUser()
}

/**
 * アドバイザリを解消する。
 *
 * 呼び出し元:
 * - `rebuildAllData`成功時（再構築が完了したので不要になった）
 * - `deleteAllData`（全データ削除で再構築対象が無くなった。`chrome.runtime.reload()`
 *   より前に呼ぶこと）
 * - Popupでのバナー「閉じる」（`acknowledgeRebuildAdvisory`メッセージ経由）
 */
export const resolveAdvisory = async (): Promise<void> => {
  await setRebuildAdvisoryState({ acknowledgedVersion: REBUILD_ADVISORY_VERSION, pendingVersion: undefined })
  clearBadge()
}
