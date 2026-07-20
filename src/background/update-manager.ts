/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
/**
 * 拡張機能の自動更新適用（Forced Update, sola承認）。
 *
 * `chrome.runtime.onUpdateAvailable`でダウンロード済みの更新を検知したら、
 * 「安全な瞬間」であれば即座に`chrome.runtime.reload()`で適用する。安全で
 * なければ`chrome.storage.local`に保留状態を記録し、バッジ・Popupバナーで
 * ユーザーに知らせつつ、以下のタイミングで安全性を再チェックする:
 *   1. ゲームセッション終了（EVT_SESSION_RESULTS/309, event-ingestion.tsの
 *      `AutoSyncService.onGameSessionEnd()`呼び出し箇所と同じ場所）
 *   2. 長時間操作（export/import/rebuild）の完了（operation-state.tsの
 *      `onOperationBecameIdle`経由）
 *   3. Service Worker起動時（`initUpdateManager()`呼び出し時）
 *
 * SAFE（安全）の定義（`isSafeToUpdate()`）:
 *   - アクティブなゲームセッションが無い（EVT_SESSION_DETAILS〜
 *     EVT_SESSION_RESULTSの間はunsafe。content_script.tsのkeepaliveゲート
 *     [`isGameActive`]と同じ境界イベントを、Service Worker側で
 *     `markSessionActive()`/`markSessionInactive()`により独立に追跡する）
 *   - `AutoSyncService.isSyncing`がfalse（同期中でない）
 *   - `currentOperationState.type === 'idle'`（export/import/rebuild中でない）
 * 上記いずれかが「unknown」（SW再起動直後などでセッション状態を未観測）の
 * 場合もunsafeとして扱う（保守的なデフォルト）。
 *
 * バッジ優先順位（3-way, rebuild-advisory > update-manager > whats-new）:
 * rebuild-advisory（データ再構築の提要）が既にバッジを表示している間は、
 * update-managerのバッジは表示・消去のどちらも行わない
 * （`getRebuildAdvisoryState().pendingVersion`をチェックしてno-op）。
 * rebuild-advisoryは既存の実装のまま変更せず、常に無条件でバッジを
 * 制御する「勝ち」側。whats-new-badge.ts（更新情報バッジ）はこのファイルより
 * さらに下位で、rebuild-advisoryとこのファイルの**両方**を確認してから
 * 自分のバッジを出す/消す（このファイル自身はwhats-newの存在を知らない）。
 * 詳細はwhats-new-badge.ts冒頭のコメント・CLAUDE.md参照。
 */
import { getRebuildAdvisoryState } from './rebuild-advisory'
import { isOperationIdle, onOperationBecameIdle } from './operation-state'
import { autoSyncService } from '../services/auto-sync-service'
import { PENDING_UPDATE_STORAGE_KEY, type PendingUpdateState } from '../constants/update'

// popup等の非backgroundコンシューマー向けに再エクスポート（codex#3612092812:
// 実体は../constants/update.ts。popupはそちらから直接importし、この
// バックグラウンド専用モジュール[autoSyncServiceのDB/Firestore依存を持つ]を
// importしないこと）
export { PENDING_UPDATE_STORAGE_KEY, type PendingUpdateState }

export interface ApplyUpdateResult {
  applied: boolean
  reason?: string
}

const BADGE_TEXT = 'UPD'
const BADGE_BACKGROUND_COLOR = '#1565c0'

const UPDATE_CHECK_ALARM_NAME = 'pokerchase-hud-update-check'
// 6時間ごと。Chromeは通常でも数時間おきに自動チェックするが、明示的な
// requestUpdateCheck()呼び出しで加速する（spec: accelerated update checks）。
const UPDATE_CHECK_PERIOD_MINUTES = 6 * 60

type SessionActivity = 'unknown' | 'active' | 'inactive'

/** SW再起動のたびに`'unknown'`にリセットされる（保守的なデフォルト = unsafe扱い） */
let sessionActivity: SessionActivity = 'unknown'

/** `event-ingestion.ts`のEVT_SESSION_DETAILS(308)受信時に呼ぶ */
export const markSessionActive = (): void => {
  sessionActivity = 'active'
}

/** `event-ingestion.ts`のEVT_SESSION_RESULTS(309)受信時に呼ぶ */
export const markSessionInactive = (): void => {
  sessionActivity = 'inactive'
}

/** テスト専用: モジュールスコープの状態をリセットする */
export const __resetUpdateManagerStateForTests = (): void => {
  sessionActivity = 'unknown'
}

/** 保留中アップデートを適用できない理由を日本語で説明する（Popup表示用） */
const describeUnsafeReason = (): string => {
  if (sessionActivity !== 'inactive') return 'ゲームセッション中のため適用できません'
  if (autoSyncService.isSyncing) return 'クラウド同期中のため適用できません'
  if (!isOperationIdle()) return '他の処理が実行中のため適用できません'
  return '安全な状態ではないため適用できません'
}

/**
 * SAFE = アクティブセッション無し AND 同期中でない AND 操作アイドル。
 * いずれか不明/該当時はunsafe（保守的）。
 */
export const isSafeToUpdate = (): boolean =>
  sessionActivity === 'inactive' && !autoSyncService.isSyncing && isOperationIdle()

export const getPendingUpdateState = async (): Promise<PendingUpdateState> => {
  const result = await chrome.storage.local.get(PENDING_UPDATE_STORAGE_KEY)
  return (result?.[PENDING_UPDATE_STORAGE_KEY] as PendingUpdateState | undefined) ?? { pending: false }
}

const setPendingUpdateState = async (state: PendingUpdateState): Promise<void> => {
  await chrome.storage.local.set({ [PENDING_UPDATE_STORAGE_KEY]: state })
}

const clearPendingUpdateState = async (): Promise<void> => {
  await setPendingUpdateState({ pending: false })
}

/** バッジ表示。rebuild-advisoryが既にバッジを使用中ならno-op（優先順位: rebuild-advisory勝ち） */
const setBadge = async (): Promise<void> => {
  if (!chrome.action?.setBadgeText) return
  const advisory = await getRebuildAdvisoryState()
  if (advisory.pendingVersion) return
  try {
    chrome.action.setBadgeText({ text: BADGE_TEXT })
    chrome.action.setBadgeBackgroundColor?.({ color: BADGE_BACKGROUND_COLOR })
  } catch (error) {
    console.warn('[update-manager] Failed to set badge:', error)
  }
}

/** バッジ解除。rebuild-advisoryが表示中のバッジを誤って消さないよう同じチェックを行う */
const clearBadge = async (): Promise<void> => {
  if (!chrome.action?.setBadgeText) return
  const advisory = await getRebuildAdvisoryState()
  if (advisory.pendingVersion) return
  try {
    chrome.action.setBadgeText({ text: '' })
  } catch (error) {
    console.warn('[update-manager] Failed to clear badge:', error)
  }
}

/**
 * `chrome.runtime.onUpdateAvailable`のハンドラー本体。
 * SAFEなら即座に適用、そうでなければ保留状態を記録してバッジを出す。
 */
export const handleUpdateAvailable = async (details: { version: string }): Promise<void> => {
  if (isSafeToUpdate()) {
    console.log(`[update-manager] Update ${details.version} available and safe -- applying immediately`)
    await clearPendingUpdateState()
    await clearBadge()
    chrome.runtime.reload()
    return
  }

  console.log(`[update-manager] Update ${details.version} available but unsafe (${describeUnsafeReason()}) -- pending`)
  await setPendingUpdateState({ pending: true, version: details.version, detectedAt: Date.now() })
  await setBadge()
}

/**
 * 保留中アップデートの安全性を再チェックし、SAFEになっていれば適用する。
 * session end / operation completion / SW startup の3箇所から呼ばれる。
 */
export const recheckPendingUpdate = async (): Promise<void> => {
  const state = await getPendingUpdateState()
  if (!state.pending) return

  // Chromeはこのマネージャーの関与なしにダウンロード済みの更新をブラウザ再起動時に
  // 自分で適用することがある（chrome.runtime.reload()はこのマネージャーが更新を
  // 適用する手段の1つに過ぎない）。保留中として記録していたバージョンと現在
  // 実行中の拡張機能バージョンが一致していれば、それは既に適用済みという
  // ことなので、二度と来ない「安全な瞬間でのreload」を待たずに古いフラグ・
  // バッジをここで片付ける（codex#3612092805）
  if (state.version && state.version === chrome.runtime.getManifest().version) {
    console.log(`[update-manager] Pending update ${state.version} is already running (installed outside this manager, e.g. Chrome restart) -- clearing stale pending state`)
    await clearPendingUpdateState()
    await clearBadge()
    return
  }

  if (isSafeToUpdate()) {
    console.log('[update-manager] Pending update is now safe to apply -- applying')
    await clearPendingUpdateState()
    await clearBadge()
    chrome.runtime.reload()
    return
  }

  // まだunsafe: バッジを再アサート（rebuild-advisoryが解消済みなら表示に切り替わる）
  await setBadge()
}

/**
 * Popupの「今すぐ適用」ボタンから呼ばれる。安全性を再チェックし、
 * SAFEなら適用、そうでなければ理由を返す（Popupに表示させる）。
 */
export const applyUpdateNow = async (): Promise<ApplyUpdateResult> => {
  if (!isSafeToUpdate()) {
    const reason = describeUnsafeReason()
    const current = await getPendingUpdateState()
    await setPendingUpdateState({ ...current, pending: true, lastBlockedReason: reason })
    return { applied: false, reason }
  }

  await clearPendingUpdateState()
  chrome.runtime.reload()
  return { applied: true }
}

const setupUpdateCheckAlarm = (): void => {
  if (!chrome.alarms) return
  chrome.alarms.create(UPDATE_CHECK_ALARM_NAME, { periodInMinutes: UPDATE_CHECK_PERIOD_MINUTES })
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === UPDATE_CHECK_ALARM_NAME) {
      chrome.runtime.requestUpdateCheck?.().catch((error: unknown) => {
        console.warn('[update-manager] requestUpdateCheck (alarm) failed:', error)
      })
    }
  })
}

/**
 * `background.ts`から一度だけ呼び出す初期化関数。
 * - onUpdateAvailableリスナー登録
 * - operation completion時の再チェック購読
 * - 加速チェック（SW起動時1回 + 6時間おきのalarm）
 * - SW起動時の保留中アップデート再チェック
 */
export const initUpdateManager = (): void => {
  chrome.runtime.onUpdateAvailable.addListener((details) => {
    handleUpdateAvailable(details).catch(error => {
      console.error('[update-manager] handleUpdateAvailable failed:', error)
    })
  })

  onOperationBecameIdle(() => {
    recheckPendingUpdate().catch(error => {
      console.error('[update-manager] recheckPendingUpdate (operation completion) failed:', error)
    })
  })

  chrome.runtime.requestUpdateCheck?.().catch((error: unknown) => {
    console.warn('[update-manager] requestUpdateCheck (startup) failed:', error)
  })
  setupUpdateCheckAlarm()

  recheckPendingUpdate().catch(error => {
    console.error('[update-manager] recheckPendingUpdate (SW startup) failed:', error)
  })
}
