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
 *     EVT_SESSION_DETAILS(308)のいずれかからEVT_SESSION_RESULTS(309)/
 *     EVT_ENTRY_CANCELLED(203)までの間はunsafe。content_script.tsの
 *     keepaliveゲート[`isGameActive`]と同じ境界イベントを、Service Worker
 *     側で`markSessionActive()`/`markSessionInactive()`により独立に
 *     追跡する。308単独をACTIVEのトリガーにしないのは、
 *     docs/api-events.md:99が明記する通り308の欠落（観測ギャップ）が
 *     正常系のバリアントとして起こりうるため——309でinactiveにした直後、
 *     308無しで次の試合が201/303から始まるケースをinactiveのまま
 *     固めてしまうと、この安全性述語がゲーム中に「安全」と誤判定して
 *     Service Workerをreloadしてしまう（release-blocker監査finding B）。
 *     203(参加取消申込)もINACTIVEトリガーに加えているのは、参加後・
 *     着席前にキャンセルするとハンドが一度も始まらず309も届かない
 *     ケースがあり（2026-07-21 pass-3 codexレビュー指摘）、それを
 *     放置するとsessionActivityがactiveのまま固まるため。
 *
 *     ACTIVE化・INACTIVE化はいずれも`event-ingestion.ts`の
 *     `ingestionQueue`（Raw Event Lakeの耐久性バリア・重複排除の内側）
 *     で直列に決着する——キュー自体が真の到着順序を保証するため、
 *     どちらの遷移も「決着が遅れて古い遷移が新しい遷移を上書きする」
 *     心配が構造的に無い（2026-07-21 pass-3: 以前は同期的な楽観的ACTIVE
 *     化+到着シーケンス番号ゲーティング+ロールバックという設計だったが、
 *     reconnectが複数の重複をまとめて再送するケースでロールバックの
 *     退避スロットが上書きされる等、対症療法が自分自身と衝突し始めた
 *     ため、根本的にシンプル化した）。
 *
 *     この直列化の裏で残る唯一の懸念——「rawの書き込みがキューに詰まって
 *     いる間、reload判定がまだ反映されていない古いsessionActivityを
 *     読んでしまう」——は書く側ではなく、全reload経路が通る
 *     `commitReloadIfStillSafe()`で解決する。同関数はキューを安定するまで
 *     drainしたうえで、drain後にtailが差し替わっていないことと
 *     `isSafeToUpdate()`を、reloadとの間にawaitを挟まず最終確認する。
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
import { runBestEffortChromeUi } from './best-effort-chrome-api'
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

/** 1つのSWインスタンスからreloadを二重commitしないための同期ガード。 */
let reloadCommitted = false

/**
 * `event-ingestion.ts`のEVT_ENTRY_QUEUED(201)/EVT_DEAL(303, Player在席時)/
 * EVT_SESSION_DETAILS(308)いずれかの受信時に呼ぶ（308単独に頼らない理由は
 * 本ファイル冒頭のコメント参照）。`event-ingestion.ts`の`ingestionQueue`
 * （Raw Event Lakeの耐久性バリア・重複排除判定の後ろ）から直列に呼ばれる
 * ため、単純に最新の呼び出しを適用するだけでよい（到着順序はキュー自体が
 * 保証する）。
 */
export const markSessionActive = (): void => {
  sessionActivity = 'active'
}

/**
 * `event-ingestion.ts`のEVT_SESSION_RESULTS(309)/EVT_ENTRY_CANCELLED(203)
 * 受信時に呼ぶ。`markSessionActive()`と同じく`ingestionQueue`から直列に
 * 呼ばれる。
 */
export const markSessionInactive = (): void => {
  sessionActivity = 'inactive'
}

/**
 * `event-ingestion.ts`の`registerEventIngestion()`が登録する、
 * 「現時点までにキューへ積まれた取り込み処理が全て決着するまで待つ」
 * プロバイダ。未登録（`registerEventIngestion()`が一度も呼ばれていない
 * ごく初期のSW起動時など）ならno-op。
 */
type IngestionDrainProvider = () => Promise<void>

let ingestionDrainProvider: IngestionDrainProvider | undefined

/**
 * `event-ingestion.ts`専用: このモジュールの外からsessionActivityの
 * 「書き込みタイミング」を変えることなく、reload判定地点だけが安全に
 * 待てるようにするための登録フック（circular importを避けるための
 * 依存性逆転——update-manager.tsはevent-ingestion.tsを一切importしない）。
 */
export const setIngestionDrainProvider = (provider: IngestionDrainProvider | undefined): void => {
  ingestionDrainProvider = provider
}

/** `awaitIngestionDrain()`のループ安全上限。通常は数イテレーションで
 * 安定するが、プロバイダ実装のバグ等で新しいタスクが積まれ続ける異常系
 * でも呼び出し元を無期限にブロックしないための保険（P1, codexレビュー
 * 指摘 2026-07-21, pass-4, "Wait for tasks appended while draining"）。 */
const MAX_DRAIN_ITERATIONS = 1000

/**
 * reload判定（`isSafeToUpdate()`を使う各エントリーポイント）の直前で待つ
 * 「キュー・ドレイン・バリア」（2026-07-21 pass-3 codexレビュー3件の帰結、
 * 詳細は本ファイル冒頭のSAFE定義コメント参照）。
 *
 * ACTIVE化・INACTIVE化は`event-ingestion.ts`の`ingestionQueue`内で決着する
 * ため、そのキューにまだ何か積まれている（rawの書き込みが進行中、または
 * 重複判定待ち）間は、`sessionActivity`が最新の生イベントを反映していない
 * 可能性がある。この関数は「呼び出し時点までに到着したイベントの処理が
 * 全て終わるまで」待つことで、reload判定が古い/遷移途中の状態を読んで
 * しまうことを防ぐ（呼び出し後に新たに到着したイベントは、因果的に
 * この判定より後なので待つ必要が無い）。
 *
 * ループする理由（P1, codexレビュー指摘 2026-07-21, pass-4, "Wait for
 * tasks appended while draining"）: `ingestionDrainProvider()`は呼んだ
 * 瞬間のキュー末尾のスナップショットを返すだけなので、そのPromiseの
 * 決着を待っている間に新しいイベントが到着して`ingestionQueue`が
 * 再代入されると、待っていたスナップショットは「古い末尾」のまま
 * 決着してしまい、新しく積まれた分の決着を待たずに戻ってしまう
 * （ドレインバリアを使っている呼び出し元でも、その僅かな隙間で
 * mid-hand reloadが起こりうる）。決着後にもう一度プロバイダを呼び直し、
 * 参照が変わっていれば（＝待っている間に何か新しく積まれた）そちらも
 * 待つ、を「2回連続で同じ参照が返る」まで繰り返すことで、呼び出し
 * 時点までに到着した全てのイベントの決着を確実に待つ。
 *
 * この公開関数は既存のテスト・診断用に「待つ」だけのAPIを保つ。reload
 * commitでは、安定確認済みtailを返す内部版を使い、async関数から呼び出し元へ
 * 戻るmicrotask境界で新しいtailが積まれた場合も最終同期チェックで検出する。
 */
interface IngestionDrainCheckpoint {
  stable: boolean
  tail: Promise<void> | undefined
}

const awaitStableIngestionCheckpoint = async (): Promise<IngestionDrainCheckpoint> => {
  let previous: Promise<void> | undefined
  let current = ingestionDrainProvider?.()
  let iterations = 0
  while (current !== previous && iterations < MAX_DRAIN_ITERATIONS) {
    previous = current
    await current
    current = ingestionDrainProvider?.()
    iterations++
  }

  const stable = current === previous
  if (!stable) {
    console.warn('[update-manager] awaitIngestionDrain: hit the iteration safety cap -- the ingestion queue may be receiving new work faster than it can settle')
  }
  return { stable, tail: current }
}

export const awaitIngestionDrain = async (): Promise<void> => {
  await awaitStableIngestionCheckpoint()
}

/** テスト専用: モジュールスコープの状態をリセットする */
export const __resetUpdateManagerStateForTests = (): void => {
  sessionActivity = 'unknown'
  reloadCommitted = false
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
  runBestEffortChromeUi('update-manager/setBadgeText', () =>
    chrome.action.setBadgeText({ text: BADGE_TEXT }))
  if (chrome.action.setBadgeBackgroundColor) {
    runBestEffortChromeUi('update-manager/setBadgeBackgroundColor', () =>
      chrome.action.setBadgeBackgroundColor({ color: BADGE_BACKGROUND_COLOR }))
  }
}

/** バッジ解除。rebuild-advisoryが表示中のバッジを誤って消さないよう同じチェックを行う */
const clearBadge = async (): Promise<void> => {
  if (!chrome.action?.setBadgeText) return
  const advisory = await getRebuildAdvisoryState()
  if (advisory.pendingVersion) return
  runBestEffortChromeUi('update-manager/clearBadgeText', () =>
    chrome.action.setBadgeText({ text: '' }))
}

/**
 * 全ての`chrome.runtime.reload()`が通る唯一のcommit point。
 *
 * 1. 現在のingestion tailを「同じ参照が2回続く」までdrainする。
 * 2. async関数の復帰microtaskより先に新しいmessageがenqueueされてtailが
 *    差し替わった場合は、同期比較で検出して1へ戻る。
 * 3. 安定したtailの同一性・sessionActivity/同期/operationの安全性・
 *    二重commitガードを、`chrome.runtime.reload()`との間にawaitを挟まず
 *    確認する。
 *
 * これにより、storage/badge await中だけでなく、drain自体が返した直後の
 * microtask境界で201/303/308等が積まれた場合も、未処理のACTIVE遷移を
 * 古いINACTIVE状態で追い越してreloadすることはない。drainの安全上限に
 * 達した場合も「安全」とはみなさず、保留したまま次の再チェックへ委ねる。
 */
type ReloadCommitResult = 'committed' | 'already-committed' | 'unsafe'

const commitReloadIfStillSafe = async (commitLog?: string): Promise<ReloadCommitResult> => {
  for (let attempt = 0; attempt < MAX_DRAIN_ITERATIONS; attempt++) {
    const checkpoint = await awaitStableIngestionCheckpoint()
    if (!checkpoint.stable) return 'unsafe'

    // `awaitStableIngestionCheckpoint()`のreturnからこの継続へ移る間にも
    // microtaskが走りうる。現在tailを同期的に取り直し、変わっていれば
    // その新tailもdrainする。ここからreloadまではawaitを一切挟まない。
    if (ingestionDrainProvider?.() !== checkpoint.tail) continue
    if (reloadCommitted) return 'already-committed'
    if (!isSafeToUpdate()) return 'unsafe'

    reloadCommitted = true
    if (commitLog) console.log(commitLog)
    chrome.runtime.reload()
    // reload後のクリアはfire-and-forget。SWが即終了して未完了でも、次回
    // startupのバージョン一致分岐がstale stateを確実に片付ける。
    clearPendingUpdateState().catch(err => console.error('[update-manager] Failed to clear pending update state after reload:', err))
    clearBadge().catch(err => console.error('[update-manager] Failed to clear badge after reload:', err))
    return 'committed'
  }

  console.warn('[update-manager] Reload commit aborted -- ingestion tail never stayed stable at the commit point')
  return 'unsafe'
}

/**
 * `chrome.runtime.onUpdateAvailable`のハンドラー本体。
 * SAFEなら即座に適用、そうでなければ保留状態を記録してバッジを出す。
 */
export const handleUpdateAvailable = async (details: { version: string }): Promise<void> => {
  // まず保留状態を永続化してからドレインする（P2, codexレビュー指摘
  // 2026-07-21, pass-5, "Persist pending updates before draining
  // ingestion"）: この関数は`chrome.runtime.onUpdateAvailable`リスナー
  // からfire-and-forgetで呼ばれる（`initUpdateManager()`参照）。下の
  // `awaitIngestionDrain()`はキューが詰まっていれば長時間かかりうるが、
  // その待機中にService Workerがサスペンド/強制終了されると、この関数
  // 自体のPromiseチェーンごと消え去り、どこにも保留記録が残らない
  // （SW再起動時契機の`recheckPendingUpdate()`は`pendingUpdate`が
  // 無ければ何もすることが無く、ダウンロード済みの更新が事実上失われる）。
  // 先に「保留中」として記録しておけば、途中でSWが落ちてもSW再起動時に
  // 必ず拾われる。安全であることが分かった場合のクリアは末尾で行う。
  await setPendingUpdateState({ pending: true, version: details.version, detectedAt: Date.now() })
  await setBadge()

  const result = await commitReloadIfStillSafe(
    `[update-manager] Update ${details.version} available and safe -- applying immediately`
  )
  if (result === 'unsafe') {
    console.log(`[update-manager] Update ${details.version} available but unsafe (${describeUnsafeReason()}) -- pending`)
  }
}

/**
 * 保留中アップデートの安全性を再チェックし、SAFEになっていれば適用する。
 * session end / entry cancellation / operation completion / SW startup の
 * 4箇所から呼ばれる。
 *
 * pending stateやstale-version cleanupに必要なawaitを全て終えた後、共有の
 * `commitReloadIfStillSafe()`が改めてdrainと最終tail比較を行う。309/203の
 * ingestion内呼び出しでも、最初の`getPendingUpdateState()` awaitで現在の
 * `processEvent`が先にreturnできるため、自己参照デッドロックは起こらない。
 * 呼び出し元ごとのgeneration callbackは不要で、operation completion・
 * SW startupを含む全経路が同じcommit保証を得る。
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

  const result = await commitReloadIfStillSafe(
    '[update-manager] Pending update is now safe to apply -- applying'
  )
  if (result === 'unsafe') {
    // まだunsafe、またはdrainが上限内で安定しなかった: バッジを再アサート
    // （rebuild-advisory解消後なら表示）。別経路がreloadをcommit済みなら
    // 先行経路のclearBadgeと競合するため何もしない。
    await setBadge()
  }
}

/**
 * Popupの「今すぐ適用」ボタンから呼ばれる。安全性を再チェックし、
 * SAFEなら適用、そうでなければ理由を返す（Popupに表示させる）。
 */
export const applyUpdateNow = async (): Promise<ApplyUpdateResult> => {
  const result = await commitReloadIfStillSafe()
  if (result === 'unsafe') {
    const reason = describeUnsafeReason()
    const current = await getPendingUpdateState()
    await setPendingUpdateState({ ...current, pending: true, lastBlockedReason: reason })
    return { applied: false, reason }
  }
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
