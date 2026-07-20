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
 *     読んでしまう」——は書く側ではなく読む側で解決する:
 *     `awaitIngestionDrain()`を参照。
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
export const setIngestionDrainProvider = (provider: IngestionDrainProvider): void => {
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
 * `event-ingestion.ts`の`processEvent`が309/203自身の処理の中から直接
 * 呼ぶ`recheckPendingUpdate()`はこのバリアを使わない（使うと自己参照で
 * デッドロックする——`ingestionQueue`はその309/203自身の処理が完了する
 * まで解決しないため）。その経路は別の機構（`event-ingestion.ts`の
 * `queueGeneration`比較）で同種の安全性を確保している——詳細は
 * event-ingestion.tsの309/203ブロックのコメント参照。
 */
export const awaitIngestionDrain = async (): Promise<void> => {
  if (!ingestionDrainProvider) return

  let previous: Promise<void> | undefined
  let current = ingestionDrainProvider()
  let iterations = 0
  while (current !== previous && iterations < MAX_DRAIN_ITERATIONS) {
    previous = current
    await current
    current = ingestionDrainProvider()
    iterations++
  }
  if (iterations >= MAX_DRAIN_ITERATIONS) {
    console.warn('[update-manager] awaitIngestionDrain: hit the iteration safety cap -- the ingestion queue may be receiving new work faster than it can settle')
  }
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
  // キュー・ドレイン・バリア（本ファイル冒頭のSAFE定義コメント参照）:
  // `onUpdateAvailable`はevent-ingestion.tsのキューとは無関係な任意の
  // タイミングで発火しうるため、判定前に必ず待つ。
  await awaitIngestionDrain()

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
 *
 * キュー・ドレイン・バリアはこの関数自身の中には置かない（意図的）:
 * event-ingestion.tsの309自身の`processEvent`内から直接呼ぶ経路が
 * あり、そこで`awaitIngestionDrain()`を呼ぶとその309自身を含む
 * `ingestionQueue`の決着を待つことになり自己参照でデッドロックする。
 * 呼び出し元（operation-complete契機・SW起動時契機）側で個別に
 * `awaitIngestionDrain()`してから呼ぶ（`initUpdateManager()`参照）。
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
  // キュー・ドレイン・バリア（本ファイル冒頭のSAFE定義コメント参照）:
  // ユーザー操作起点でevent-ingestion.tsのキューとは無関係なタイミングで
  // 呼ばれるため、判定前に必ず待つ。
  await awaitIngestionDrain()

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
/**
 * `recheckPendingUpdate()`をキュー・ドレイン・バリアの後ろで呼ぶラッパー。
 * event-ingestion.tsの309自身の処理からは呼ばない（そちらは
 * `recheckPendingUpdate()`自身のコメント参照）——operation-complete契機・
 * SW起動時契機はどちらもingestionQueueとは無関係なタイミングで発火しうる
 * ため、両方ともこのラッパー経由で呼ぶ。
 */
const recheckPendingUpdateAfterDrain = async (): Promise<void> => {
  await awaitIngestionDrain()
  await recheckPendingUpdate()
}

export const initUpdateManager = (): Promise<void> => {
  chrome.runtime.onUpdateAvailable.addListener((details) => {
    handleUpdateAvailable(details).catch(error => {
      console.error('[update-manager] handleUpdateAvailable failed:', error)
    })
  })

  onOperationBecameIdle(() => {
    recheckPendingUpdateAfterDrain().catch(error => {
      console.error('[update-manager] recheckPendingUpdate (operation completion) failed:', error)
    })
  })

  chrome.runtime.requestUpdateCheck?.().catch((error: unknown) => {
    console.warn('[update-manager] requestUpdateCheck (startup) failed:', error)
  })
  setupUpdateCheckAlarm().catch(error => {
    console.error('[update-manager] setupUpdateCheckAlarm failed:', error)
  })

  return recheckPendingUpdateAfterDrain().catch(error => {
    console.error('[update-manager] recheckPendingUpdate (SW startup) failed:', error)
  })
}
