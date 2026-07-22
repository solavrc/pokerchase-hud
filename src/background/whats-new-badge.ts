/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
/**
 * 更新情報（What's New）バッジ。
 *
 * `chrome.runtime.onInstalled`（`details.reason === 'update'`）で拡張機能が
 * バージョンアップし、かつ`WHATS_NEW_ENTRIES`（`src/constants/whats-new.ts`）
 * にそのバージョンのキュレーション済みエントリが存在するとき、一度だけ
 * 「バッジ + Popup内の更新情報セクション」でユーザーに知らせる。新規
 * インストール（`reason === 'install'`）ではバッジを出さない（バッジ churn
 * 防止 -- 初回インストール時点では「更新」ではなく「その版が最初から
 * 入っている」だけなので、通知する意味がない。呼び出し側の`background.ts`が
 * `reason === 'update'`のときだけ`markWhatsNewOnUpdate()`を呼ぶことで保証する）。
 *
 * 状態は`chrome.storage.local`の`whatsNewUnseenVersion`キー
 * （`WHATS_NEW_STORAGE_KEY`、`src/constants/whats-new.ts`）に文字列
 * （未読の更新情報が対応するバージョン）として保持する。Popupが
 * `WhatsNewSection`をマウントした時点で`acknowledgeWhatsNew`メッセージ
 * （`message-router.ts`）を送り、これを解消する。
 *
 * **バッジ優先順位（3-way）**: rebuild-advisory > update-manager > whats-new。
 * - `rebuild-advisory.ts`（データ再構築の提要）は無条件・一方的にバッジを
 *   制御する（他モジュールの存在を知らない、常に「勝ち」側）。
 * - `update-manager.ts`は`rebuild-advisory`のみを確認してno-opする
 *   （whats-newの存在を知らない）。
 * - このファイルは`rebuild-advisory`と`update-manager`の**両方**を確認して
 *   から自分のバッジを出す/消す（`resolveActiveBadge()`が3状態の優先順位を
 *   一箇所に集約している。CLAUDE.mdの「Badge Precedence」節も参照）。
 *
 * 他の2つと違い、whats-newバッジには「解消をトリガーに再チェックする」
 * 専用フックが無い（rebuild-advisoryの`resolveAdvisory()`やupdate-managerの
 * `recheckPendingUpdate()`のような、session end/operation完了に相乗りする
 * 仕組みはあえて追加していない -- 情報バッジのために既存の再チェック経路を
 * 増やすほどの緊急性は無い）。代わりに`reassertWhatsNewBadgeOnStartup()`を
 * Service Worker起動時（`background.ts`）に一度だけ呼び、未読が残っていれば
 * その時点の優先順位で再評価する（update-managerもSW起動を3つの再チェック
 * ポイントの1つとして使っているのと同じ発想）。
 */
import { getRebuildAdvisoryState } from './rebuild-advisory'
import { getPendingUpdateState } from './update-manager'
import { runBestEffortChromeUi } from './best-effort-chrome-api'
import { WHATS_NEW_STORAGE_KEY, WHATS_NEW_ENTRIES } from '../constants/whats-new'

const BADGE_TEXT = 'N'
const BADGE_BACKGROUND_COLOR = '#2e7d32'

export type ActiveBadge = 'rebuild' | 'update' | 'whats-new' | null

/**
 * 3種類のバッジ（rebuild-advisory / update-manager / whats-new）のうち、
 * どれが実際に表示されるべきかを判定する純粋関数（優先順位:
 * rebuild > update > whats-new）。`syncBadge()`が実際のバッジ制御に使う
 * ほか、`whats-new-badge.test.ts`が8状態すべてを網羅するテーブルテストで
 * 直接検証する対象でもある。
 */
export const resolveActiveBadge = (state: {
  rebuildPending: boolean
  updatePending: boolean
  whatsNewUnseen: boolean
}): ActiveBadge => {
  if (state.rebuildPending) return 'rebuild'
  if (state.updatePending) return 'update'
  if (state.whatsNewUnseen) return 'whats-new'
  return null
}

/** `chrome.storage.local`から未読バージョンを取得する（未読なしなら`undefined`） */
export const getUnseenWhatsNewVersion = async (): Promise<string | undefined> => {
  const result = await chrome.storage.local.get(WHATS_NEW_STORAGE_KEY)
  return (result?.[WHATS_NEW_STORAGE_KEY] as string | undefined) ?? undefined
}

const setUnseenWhatsNewVersion = async (version: string | undefined): Promise<void> => {
  if (version === undefined) {
    await chrome.storage.local.remove(WHATS_NEW_STORAGE_KEY)
  } else {
    await chrome.storage.local.set({ [WHATS_NEW_STORAGE_KEY]: version })
  }
}

/**
 * 現在のstorage状態（rebuild-advisory / update-manager / whats-new未読）を
 * 読み直し、優先順位に従ってバッジを同期する。
 * - `resolveActiveBadge()`が`'whats-new'`を返す場合のみバッジテキストを立てる。
 * - `null`（何も表示すべきものが無い）の場合のみ空文字にクリアする。
 * - `'rebuild'`/`'update'`の場合は何もしない（それらのモジュールの管轄の
 *   バッジ表示を誤って消さないため）。
 */
const syncBadge = async (): Promise<void> => {
  if (!chrome.action?.setBadgeText) return

  const [advisory, pendingUpdate, unseen] = await Promise.all([
    getRebuildAdvisoryState(),
    getPendingUpdateState(),
    getUnseenWhatsNewVersion(),
  ])

  const active = resolveActiveBadge({
    rebuildPending: !!advisory.pendingVersion,
    updatePending: !!pendingUpdate.pending,
    whatsNewUnseen: !!unseen,
  })

  if (active === 'whats-new') {
    runBestEffortChromeUi('whats-new-badge/setBadgeText', () =>
      chrome.action.setBadgeText({ text: BADGE_TEXT }))
    if (chrome.action.setBadgeBackgroundColor) {
      runBestEffortChromeUi('whats-new-badge/setBadgeBackgroundColor', () =>
        chrome.action.setBadgeBackgroundColor({ color: BADGE_BACKGROUND_COLOR }))
    }
  } else if (active === null) {
    runBestEffortChromeUi('whats-new-badge/clearBadgeText', () =>
      chrome.action.setBadgeText({ text: '' }))
  }
  // active === 'rebuild' | 'update': 他モジュールの管轄なので何もしない
}

/**
 * `chrome.runtime.onInstalled`（`details.reason === 'update'`）から呼ぶ。
 * `currentVersion`（`chrome.runtime.getManifest().version`）に一致する
 * キュレーション済みエントリが`WHATS_NEW_ENTRIES`に存在する場合のみ、
 * それを未読として記録しバッジを同期する（優先順位が上のバッジが
 * 使用中ならバッジ自体はno-op、ただし未読の記録は残るので、Popupを
 * 開けば更新情報セクションには表示される）。
 */
export const markWhatsNewOnUpdate = async (currentVersion: string): Promise<void> => {
  const hasEntry = WHATS_NEW_ENTRIES.some(entry => entry.version === currentVersion)
  if (!hasEntry) return

  await setUnseenWhatsNewVersion(currentVersion)
  await syncBadge()
}

/**
 * Popupの更新情報セクション（`WhatsNewSection`）がマウントされた時点で呼ぶ
 * （`acknowledgeWhatsNew`メッセージ経由、`message-router.ts`参照）。
 * 未読が無い状態で呼んでも安全（冪等）。
 */
export const acknowledgeWhatsNew = async (): Promise<void> => {
  await setUnseenWhatsNewVersion(undefined)
  await syncBadge()
}

/**
 * Service Worker起動時に一度だけ呼ぶ（`background.ts`）。未読バージョンが
 * 残っている状態でSWが再起動した場合、その時点の最新の優先順位で
 * バッジを再評価する（例: 前回の起動時点ではrebuild-advisoryのバッジが
 * 表示中でwhats-newバッジが抑制されていたが、その後ユーザーがリビルドを
 * 実行してrebuild-advisoryが解消済み -- このタイミングでwhats-newバッジに
 * 「昇格」できる）。未読が無ければ何もしない。
 */
export const reassertWhatsNewBadgeOnStartup = async (): Promise<void> => {
  const unseen = await getUnseenWhatsNewVersion()
  if (!unseen) return
  await syncBadge()
}
