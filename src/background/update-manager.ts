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
 *   - アクティブなゲームセッションが無い（EVT_ENTRY_QUEUED(201)/EVT_DEAL(303)/
 *     EVT_SESSION_DETAILS(308)のいずれかからEVT_SESSION_RESULTS(309)までの
 *     間はunsafe。content_script.tsのkeepaliveゲート[`isGameActive`]と同じ
 *     境界イベントを、Service Worker側で`markSessionActive()`/
 *     `markSessionInactive()`により独立に追跡する。308単独をACTIVEの
 *     トリガーにしないのは、docs/api-events.md:99が明記する通り308の欠落
 *     （観測ギャップ）が正常系のバリアントとして起こりうるため——309で
 *     inactiveにした直後、308無しで次の試合が201/303から始まるケースを
 *     inactiveのまま固めてしまうと、この安全性述語がゲーム中に「安全」と
 *     誤判定してService Workerをreloadしてしまう（release-blocker監査
 *     finding B）。ACTIVE化のトリガーを201/303/308の3つに広げても、
 *     INACTIVEへ戻すトリガーは引き続き309のみ。ACTIVE化とINACTIVE化は
 *     呼ばれるタイミングが非対称（前者は同期、後者はRaw Event Lakeの
 *     耐久性バリアの後ろ）なため、生の到着順序を保つための`arrivalSeq`
 *     ゲーティングと、真の重複判明時のロールバックが必要——詳細は
 *     `markSessionActive`/`markSessionInactive`/
 *     `revertSessionActivityIfStillApplied`のコメント参照）
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

/**
 * 到着シーケンス番号ゲーティング（P1, codexレビュー 2026-07-21指摘）:
 *
 * ACTIVE化（event-ingestion.tsのport.onMessage受信直後、完全に同期的）と
 * INACTIVE化（同ファイルのRaw Event Lake耐久性バリアの後ろ、`ingestionQueue`
 * 経由で非同期に決着）は、意図的に異なるタイミングで呼ばれる（理由は
 * event-ingestion.tsの`markSessionActiveFromRawMessage()`コメント参照）。
 * しかし生の到着順序が[309, 201]（セッション終了の直後に次のセッションが
 * 始まる、docs/api-events.md:99が明記する正常系のバリアント）だった場合、
 * 309は耐久性バリアの後ろでキューに積まれ決着が遅れる一方、201は同期的に
 * 即座にACTIVE化する。何もしなければ、後から決着する（が到着順序としては
 * 古い）309のINACTIVE化が、より新しいはずの201のACTIVE化を上書きしてしまい、
 * 「新しいハンドが進行中なのにinactiveのまま」という状態反転が起こる。
 *
 * 対策として、各呼び出し元（event-ingestion.ts）に、その生メッセージの
 * *到着*順序を表す単調増加の`arrivalSeq`を明示的に渡させ、
 * `lastAppliedSeq`より新しい`arrivalSeq`の遷移だけを適用する。これにより
 * 「後から決着したが、実際は先に到着していた」遷移が「先に決着したが、
 * 実際は後から到着していた」遷移を上書きすることを防ぐ——真の到着順序
 * だけが最終状態を決める。
 *
 * `arrivalSeq`を省略した呼び出し（既存のテスト等、レガシー用途）は
 * `internalAutoSeq`による自動採番にフォールバックする。呼び出しごとに
 * 単調増加する値が振られるため、「直近の呼び出しが常に勝つ」という
 * 従来通りの単純な挙動が保たれる。
 */
let lastAppliedSeq = 0
let previousSessionActivity: SessionActivity = 'unknown'
let previousAppliedSeq = 0
let internalAutoSeq = 0

/**
 * `next`への遷移を、`seq`（省略時は内部自動採番）が現在適用済みの
 * `lastAppliedSeq`より新しい場合にのみ適用する。適用時は直前の状態を
 * 1段階分だけ`previousSessionActivity`/`previousAppliedSeq`に退避する
 * （`revertSessionActivityIfStillApplied()`によるロールバック用）。
 * 実際に適用したかに関わらず、使用した`effectiveSeq`を返す。
 */
const applyActivityTransition = (next: SessionActivity, seq?: number): number => {
  const effectiveSeq = seq ?? ++internalAutoSeq
  if (effectiveSeq <= lastAppliedSeq) {
    // 到着順序としてより新しい遷移が既に適用済み -- 古い遷移は無視する
    return effectiveSeq
  }
  previousSessionActivity = sessionActivity
  previousAppliedSeq = lastAppliedSeq
  sessionActivity = next
  lastAppliedSeq = effectiveSeq
  return effectiveSeq
}

/**
 * `event-ingestion.ts`のEVT_ENTRY_QUEUED(201)/EVT_DEAL(303, Player在席時)/
 * EVT_SESSION_DETAILS(308)いずれかの受信時に呼ぶ（308単独に頼らない理由は
 * 本ファイル冒頭のコメント参照）。`arrivalSeq`は呼び出し元での生メッセージ
 * 到着順序（上のコメント参照）。
 */
export const markSessionActive = (arrivalSeq?: number): void => {
  applyActivityTransition('active', arrivalSeq)
}

/**
 * `event-ingestion.ts`のEVT_SESSION_RESULTS(309)受信時に呼ぶ。`arrivalSeq`は
 * 呼び出し元での生メッセージ到着順序（上のコメント参照）。
 */
export const markSessionInactive = (arrivalSeq?: number): void => {
  applyActivityTransition('inactive', arrivalSeq)
}

/**
 * 重複検知の取り消し（P2, codexレビュー 2026-07-21指摘）: `arrivalSeq`が
 * まだ現在適用中の遷移（`lastAppliedSeq === arrivalSeq`）であれば、その
 * 遷移を取り消して直前の状態へ1段階ロールバックする。
 *
 * 想定用途: event-ingestion.tsは201/303[Player在席]/308の受信直後に
 * `markSessionActive()`を同期的に（raw書き込みの耐久性バリアより前に）
 * 呼ぶ「楽観的」な設計になっている（P2#3, 2026-07-21の前回修正）。これは
 * 再チェックとの競合を防ぐために必要な一方、この生メッセージが実は
 * reconnect resend等による**真の重複**（同一(timestamp, ApiTypeId)・
 * 同一ペイロードが既にRaw Event Lakeに存在する）だと後から判明した場合、
 * その楽観的なACTIVE化は本来起こるべきではなかった遷移である。
 * このケースを放置すると、309で正しくinactive化された後にstaleな
 * resendが届いただけでsessionActivityがactiveに戻ってしまい、
 * 新しいハンドが無いのに保留中アップデートが無期限にブロックされ続ける
 * （このバグはtri-stateを`'unknown'`に一律フォールバックさせるのではなく、
 * 遷移前の状態へ正しくロールバックすることで、「本当は309で終わっていた」
 * という正しい状態を復元する——1段階の巻き戻しで十分なのは、この関数は
 * 「まだ現在の状態として有効な遷移」だけを対象にするため。既に別の新しい
 * 遷移で上書きされていれば`lastAppliedSeq !== arrivalSeq`となり、
 * 何もしない[その新しい遷移の方が正しいため]）。
 */
export const revertSessionActivityIfStillApplied = (arrivalSeq: number): void => {
  if (lastAppliedSeq === arrivalSeq) {
    sessionActivity = previousSessionActivity
    lastAppliedSeq = previousAppliedSeq
  }
}

/** テスト専用: モジュールスコープの状態をリセットする */
export const __resetUpdateManagerStateForTests = (): void => {
  sessionActivity = 'unknown'
  lastAppliedSeq = 0
  previousSessionActivity = 'unknown'
  previousAppliedSeq = 0
  internalAutoSeq = 0
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

/**
 * 更新チェックalarmをセットアップする。
 *
 * `initUpdateManager()`経由でService Worker起動のたびに呼ばれるが、
 * alarm自体はSW再起動をまたいで既にChrome側に生き続けている。
 * `chrome.alarms.create()`は「同名のalarmが既にあればキャンセルして
 * 置き換える」仕様（https://developer.chrome.com/docs/extensions/reference/api/alarms）
 * のため、無条件に呼び直すと`periodInMinutes`のカウントダウンがその
 * 都度リセットされる。SWが6時間より頻繁に再起動する環境（アクティブに
 * 使われている場合はよくある）では、この定期チェックが実質永遠に
 * 発火しなくなり、`requestUpdateCheck()`はSW起動時1回のスロットリング
 * された呼び出しにしか頼れなくなる（codexレビュー指摘, PR #150監査#3）。
 * `chrome.alarms.get()`で既存のalarmを確認し、無い場合（初回インストール時
 * や何らかの理由でalarmがクリアされていた場合）のみ`create()`する。
 */
const setupUpdateCheckAlarm = async (): Promise<void> => {
  if (!chrome.alarms) return
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === UPDATE_CHECK_ALARM_NAME) {
      chrome.runtime.requestUpdateCheck?.().catch((error: unknown) => {
        console.warn('[update-manager] requestUpdateCheck (alarm) failed:', error)
      })
    }
  })

  const existingAlarm = await chrome.alarms.get(UPDATE_CHECK_ALARM_NAME)
  if (existingAlarm) {
    console.log(`[update-manager] Update-check alarm already scheduled (next: ${new Date(existingAlarm.scheduledTime).toISOString()}) -- not recreating`)
    return
  }
  chrome.alarms.create(UPDATE_CHECK_ALARM_NAME, { periodInMinutes: UPDATE_CHECK_PERIOD_MINUTES })
}

/**
 * `background.ts`から一度だけ呼び出す初期化関数。
 * - onUpdateAvailableリスナー登録
 * - operation completion時の再チェック購読
 * - 加速チェック（SW起動時1回 + 6時間おきのalarm）
 * - SW起動時の保留中アップデート再チェック
 *
 * 戻り値はSW起動時の`recheckPendingUpdate()`呼び出しのpromise（常にresolve
 * する -- 内部でcatch済み）。呼び出し側（background.ts）はこれを使って
 * 「pendingUpdateのSW起動時クリーンアップが終わってから」whats-newバッジの
 * 再評価を行うよう順序付けできる（codex review, PR #172:
 * `reassertWhatsNewBadgeOnStartup()`がこのクリーンアップの完了前に
 * `pendingUpdate`の中間状態を読んでしまうレースの防止）。この関数自体は
 * 呼び出しをブロックしない（他のセットアップは同期的に完了する）ので、
 * SW起動を止めたくない呼び出し側はそのままfire-and-forgetしてよい。
 */
export const initUpdateManager = (): Promise<void> => {
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
  setupUpdateCheckAlarm().catch(error => {
    console.error('[update-manager] setupUpdateCheckAlarm failed:', error)
  })

  return recheckPendingUpdate().catch(error => {
    console.error('[update-manager] recheckPendingUpdate (SW startup) failed:', error)
  })
}
