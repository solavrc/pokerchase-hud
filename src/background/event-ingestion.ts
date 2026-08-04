/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
import PokerChaseService, {
  ApiType,
  type ApiEvent,
  ApiMessage,
  validateMessage,
  validateApiEvent,
  parseApiEvent,
  getValidationError,
  isApplicationApiEvent,
  isApiEventType
} from '../app'
import { autoSyncService } from '../services/auto-sync-service'
import {
  claimActivePortForGameEvent,
  clearActiveRealtimeForSessionEnd,
  connectedPorts,
  notifySessionStart,
  recordActiveDealContext,
  registerActivePortForService,
  releaseActivePortForService,
  startPortPing,
} from './ports'
import { setEventGeneration } from '../streams/stats-output-context'
import {
  INVALID_API_TYPE_ID_BUCKET,
  recordUndecodedEvent
} from './undecoded-event-tracker'
import { awaitIngestionDrain, markSessionActive, markSessionInactive, recheckPendingUpdate, setIngestionDrainProvider } from './update-manager'
import { mergeApiEvents, type RawApiEvent } from '../utils/api-event-key'
import { getOperationGeneration, getOperationState, onOperationBecameIdle } from './operation-state'
import {
  cancelReplayRequestsForSessionStart,
  handleReplayPortMessage,
  releaseReplayRequestsForPort
} from './replay-fetch-bridge'
import { handleReplayLedgerPortMessage, type ReplayLedgerAuditDeps } from './replay-ledger-audit'
import {
  findActivePortForPlayer,
  isActivePortOutsideSession,
  markActivePortPlayerId,
  markActivePortSessionActive,
  markActivePortSessionInactive,
  readActivePortPlayerId,
  resolveGeneration
} from './active-port'
import { REPLAY_PORT_AUTH_READY } from '../replay/protocol'
import {
  drainReplayImportQueue,
  enqueueReplayHandId,
  readReplayImportEnabled,
  type ReplayImportDeps
} from './replay-import'
import {
  captureHandledException,
  captureSchemaValidationFailure
} from '../observability/sentry'
import { buildSchemaDiagnostic } from '../observability/schema-diagnostic'
import { getEventFields, getEventSchema } from '../types/api'
import {
  initializeReplayDiagnostics,
  logReplayDiagnostic
} from './replay-diagnostics'

/**
 * 参加取消申込（ApiTypeId 203）。`ApiType` enum（アプリケーションで使用する
 * イベント種別、`isApplicationApiEvent`の判定基準）には意図的に含めない
 * ——enumに加えると`isApplicationApiEvent`がtrueを返すようになり、
 * ストリーム（handLogStream等）に本来対象外のイベントが投入されてしまう
 * ため。ここではセッション状態追跡専用の生ApiTypeId定数として扱う
 * （201/303/308/309と同じraw-firstパターン）。
 *
 * 参加申込(201)後、着席（303/308）に至る前にユーザーが参加をキャンセル
 * すると、ハンドが一度も始まらないため309も届かない
 * （P2, codexレビュー指摘 2026-07-21, pass-3）。この203を観測したら309と
 * 同様にsessionActivityをINACTIVEへ戻す（詳細は`applySessionActivity()`
 * コメント参照）。content_script.tsのkeepalive解除条件も同じ判定を
 * ミラーする。
 */
const EVT_ENTRY_CANCELLED_API_TYPE_ID = 203

type StatsLedgerPrefetchTrigger = 'seat-assigned' | 'player-join' | 'deal'

/**
 * 着席情報から、その場でHUDに必要になりうるプレイヤーの永続統計台帳を
 * 先読みする。313はSNGでも欠落しうるため、301の途中参加と303の実ライン
 * ナップも同じ先読み経路へ入れる。303の通常読み取りは引き続き
 * `readPlayerSnapshot()`のlazy baselineを正本とするので、先読みが失敗しても
 * 統計の正しさには影響しない。
 *
 * この関数は取り込み順序やRaw Event Lakeの耐久性バリアを延ばしてはならない。
 * 返すPromiseは完了観測用であり、呼び出し側はstream投入前には待たず、
 * `ensurePlayerBaseline()`の同一player in-flight重複排除に委ねること（MUST）。
 * 診断にはplayer ID・生payload・例外messageを含めてはならない（MUST NOT）。
 */
export const prefetchStatsLedgerBaselines = (
  service: PokerChaseService,
  event: ApiEvent
): Promise<void> | undefined => {
  let playerIds: readonly number[]
  let trigger: StatsLedgerPrefetchTrigger

  switch (event.ApiTypeId) {
    case ApiType.EVT_PLAYER_SEAT_ASSIGNED:
      playerIds = event.SeatUserIds
      trigger = 'seat-assigned'
      break
    case ApiType.EVT_PLAYER_JOIN:
      playerIds = [event.JoinUser.UserId]
      trigger = 'player-join'
      break
    case ApiType.EVT_DEAL:
      playerIds = event.SeatUserIds
      trigger = 'deal'
      break
    default:
      return
  }

  const uniquePlayerIds = new Set(
    playerIds.filter(playerId => Number.isSafeInteger(playerId) && playerId > 0)
  )
  return service.statsLedger.ensurePlayerBaselines([...uniquePlayerIds]).catch(() => {
    // player ID・payload・例外messageはログへ出さない（MUST NOT）。
    console.warn(`[StatsLedger] Baseline prefetch failed (${trigger})`)
  })
}

interface EventProcessingCompletion {
  /**
   * Raw取り込みキューへは含めないが、このイベントから起動した非同期処理を
   * テスト・明示的な呼び出し元が破棄前に待てるようにする完了ハンドル。
   */
  backgroundTasks: readonly Promise<void>[]
}

/**
 * Raw Event Lakeの耐久性バリア（release-blocker監査 finding A）を実現する
 * ための直列化キュー。モジュールスコープに置くのは、update-manager.tsの
 * `awaitIngestionDrain()`（キュー・ドレイン・バリア、2026-07-21 pass-3）
 * から`setIngestionDrainProvider()`経由で参照させるため
 * （`registerEventIngestion()`のコメント参照）。
 */
let ingestionQueue: Promise<void> = Promise.resolve()
let ingestionQueueDepth = 0

/**
 * 台帳突き合わせの依存。ポート受信時と、Service Worker起動時の再開
 * （`resumePendingReplayLedgerAudits`）が**同じ待機条件**で走る必要があるので
 * 一箇所にまとめる。
 */
export const createReplayLedgerAuditDeps = (service: PokerChaseService): ReplayLedgerAuditDeps => ({
  db: service.db,
  // 取り込みキューには載せないが、決着は待つ。直前のEVT_HAND_RESULTSの書き込みが
  // 済む前に照会すると、受信済みのハンドを未キャプチャに分類しうる。
  // 起動直後は状態復元も待つ（playerIdがundefinedのままだと全ハンドが
  // 照合不能に落ちる）。
  waitUntilConsistent: async () => {
    await service.ready
    // 取り込みキューの決着だけでは足りない。`processEvent` は
    // `handAggregateStream.write()` で下流を起動するだけで、
    // `WriteEntityStream` が `hands` を書き終えるまでは待たない。
    // rawだけが在る瞬間に照会すると、正常に生成中のハンドを
    // 「派生欠落」として永続化する。`whenIdle()` は下流へ連鎖する。
    await awaitIngestionDrain()
    await service.handAggregateStream.whenIdle()
  },
  // インポート/再構築/エクスポートの最中は監査しない。インポートは生行を
  // 先にコミットして派生を後から作るので、その途中で照会すると正常に
  // 処理中のハンドが「派生欠落」として永続化される。ライブ取り込みの
  // ドレインではインポート側を待てない。診断なので延期ではなく見送りで
  // 足りる（次にリプレイ一覧を開けば走る）。
  isBusy: () => getOperationState().type !== 'idle',
  // 読み始めと書き戻しの間に長時間操作が走り切った場合を検出するための世代。
  // 渡し忘れると比較が常に`undefined`同士になり、この保護が無効化される。
  getOperationGeneration,
  getPlayerId: () => service.playerId,
  now: () => Date.now()
})

/**
 * リプレイ取り込み層の依存。積む側（`EVT_HAND_RESULTS`）と流す側
 * （セッション終了・ポート接続）が同じ判定条件で動くよう一箇所にまとめる。
 */
export const createReplayImportDeps = (service: PokerChaseService): ReplayImportDeps => ({
  db: service.db,
  isEnabled: readReplayImportEnabled,
  now: () => Date.now(),
  // インポート/再構築/エクスポートの最中は取得しない。診断ではなく保存を
  // 伴うので、長時間操作と同じ`apiEvents`へ書き込むのを避ける。
  isBusy: () => getOperationState().type !== 'idle',
  getPlayerId: readActivePortPlayerId,
  isFetchAllowed: isActivePortOutsideSession,
  resolvePort: findActivePortForPlayer
})

/**
 * `chrome.runtime.onConnect`のハンドラーを登録する。
 * content_scriptからのポート接続を受け取り、APIイベントの検証・DB保存・
 * 各ストリームへの書き込み・自動同期トリガーを行う。
 */
export const registerEventIngestion = (service: PokerChaseService): void => {
  initializeReplayDiagnostics()
  // 長時間操作（インポート/再構築/エクスポート/全削除）が終わったら、その間に
  // 中断・見送りになったリプレイ取得を再開する。これが無いと、再開の契機が
  // 次の309/203かポート再接続だけになり、ページを開いたまま次の対局をしない
  // ユーザーのキューが3日の取得期限を越えて捨てられる。
  // `drainReplayImportQueue` 側の不変条件がセッション状態を見るので、
  // ここでは無条件に呼んでよい（セッション中なら何も起きない）。
  onOperationBecameIdle(() => {
    drainReplayImportQueue(createReplayImportDeps(service), 'operation-idle')
      .catch(err => console.error('[background] Replay import drain after operation failed:', err))
  })

  // Raw Event Lakeの耐久性バリア（release-blocker監査 finding A）:
  // `db.apiEvents.add()`を待たずにストリーム書き込みやセッションフックの副作用
  // （自動同期トリガー、`chrome.runtime.reload()`を呼びうる保留アップデート
  // 再チェック）を進めると、
  //   (1) quota超過等でadd()が失敗した場合に「派生統計だけ存在してraw行が
  //       無い」というRaw Event Lakeの不変条件違反（CLAUDE.md「Raw Event
  //       Lake」/ "Storage happens *before* the validation gate" 参照）が
  //       起こりうる
  //   (2) reconnect再送（同一payloadが既に保存済み）の場合、そのイベントは
  //       初回処理時に既にストリーム/セッションフックを一度通過済みのはず
  //       なのに、ここでも投入してしまうと二重処理になる
  //   (3) raw mergeのトランザクションが確定する前にreloadでService Workerが
  //       巻き込まれ、書き込みが失われる恐れがある
  // という3つの安全性違反を起こしうる。
  //
  // 対策として、各イベントの処理を「このイベントのadd()が決着（成功、または
  // 処理済みの失敗）してから次のイベントの処理を始める」キューで直列化する
  // （`processEvent`内で全副作用がadd()のawait後に実行されるため、この
  // キューはあわせて「バーストで来たイベントの観測順序がストリーム側で
  // 入れ替わらないこと」も保証する——add()を待つ以上、後続イベントのadd()が
  // 先に決着してしまうと素朴な実装では順序が壊れうるため）。
  //
  // セッション状態追跡（markSessionActive/markSessionInactive）もこの
  // キューの内側、耐久性バリア・重複排除判定の後で行う（2026-07-21
  // pass-3で統一。経緯: 過去2ラウンドはACTIVE化だけを同期的に前倒しする
  // 「楽観的arm」設計を採ったが、到着順序ゲーティング・重複判明時の
  // ロールバックといった対症療法を重ねるほど設計が自分自身と衝突する
  // ようになった——詳細はupdate-manager.tsの`markSessionActive`コメント
  // 参照）。この統一により(a)重複イベントがそもそもACTIVE/INACTIVE判定に
  // 到達しない（判定より先にreturnする）、(b)キュー自体が到着順序を
  // 保証するため順序反転が起こりえない、という2点が構造的に保証される。
  // 残る懸念（rawの書き込みが詰まっている間、reload判定が古い
  // sessionActivityを読んでしまう）は書く側でなく読む側で解決する——
  // update-manager.tsの`awaitIngestionDrain()`参照。
  //
  // 同期トリガー（`autoSyncService.onGameSessionEnd()`/`onNewSessionStart()`）
  // は、このキューを塞がない（P2, codexレビュー指摘 2026-07-21, pass-4,
  // "Don't block raw ingestion on cloud uploads"）。認証済みユーザーで
  // 未同期行数が閾値を超えていれば`onGameSessionEnd()`は実際の
  // Firestoreアップロードを走らせうる非同期処理で、これをここでawaitして
  // キューを塞ぐと、次のハンドの生イベントが`apiEvents.add()`にすら到達
  // できずメモリ上で滞留し、アップロード完了までライブHUDが凍結し、SW
  // サスペンド/リロード・タブクローズが起きればそれらのイベントは失われる。
  // `chrome.runtime.reload()`を呼びうる`recheckPendingUpdate()`だけは
  // 引き続き同期トリガーの決着後にチェーンするが、`processEvent`からawait
  // せずfire-and-forgetにする。再チェック側はpending state等のawaitを
  // 終えた後、全reload経路共通のcommit pointで最新のingestion tailを
  // 安定するまでdrainし、tail同一性とsessionActivityをreload直前に同期
  // 確認する（update-manager.tsの`commitReloadIfStillSafe()`参照）。
  // このため呼び出し元固有のactivity generation plumbingは不要であり、
  // operation completion/SW startupと同じ安全性機構へ統一されている。
  ingestionQueue = Promise.resolve()
  ingestionQueueDepth = 0
  setIngestionDrainProvider(() => ingestionQueue)

  chrome.runtime.onConnect.addListener(port => {
    if (port.name === PokerChaseService.POKER_CHASE_SERVICE_EVENT) {
      connectedPorts.add(port)
      registerActivePortForService(service, port)
      // 持ち越し分の再開点。セッション終了時に認証エンベロープを捕獲できて
      // いないと取得は繰り延べられる（キューには残る）。エンベロープは
      // ページ再読み込み後のホーム到達で捕まるので、そのページが繋いできた
      // この瞬間が次の機会になる。**セッション外であること**の判定は
      // `drainReplayImportQueue` 側の不変条件が担うので、ここでは
      // 呼ぶだけでよい（セッション中なら何も起きない）。
      drainReplayImportQueue(createReplayImportDeps(service), 'port-connect')
        .catch(err => console.error('[background] Replay import drain on connect failed:', err))
      port.onMessage.addListener((message: ApiMessage | { type: string }) => {
        // キープアライブメッセージの処理（キュー直列化の対象外 -- 何も
        // 保存・処理しないため、耐久性バリアの対象になる副作用が無い）
        if (typeof message === 'object' && 'type' in message && message.type === 'keepalive') {
          return
        }

        // Local deletion owns the database through runtime.reload(). Events
        // arriving after that synchronous claim must not enter the queue:
        // Dexie would otherwise auto-open and recreate the just-deleted DB in
        // the narrow window before reload. Tasks queued before the claim are
        // drained by deleteAllData() and then removed with the database.
        if (getOperationState().type === 'delete') {
          console.warn('[background] Dropping event while local data deletion is committing:', message)
          return Promise.resolve()
        }

        // 認証エンベロープの捕獲通知。繰り延べていた取得を再開する。
        // 何も保存しないので取り込みキューには載せない。
        if (typeof message === 'object' && message !== null &&
          (message as { type?: unknown }).type === REPLAY_PORT_AUTH_READY) {
          // 取り込みキューの決着を待ってから流す（MUST）。同じポートから直前に
          // 届いた201/303/308がまだRaw Lakeの書き込み待ちだと、この通知が先に
          // 決着してセッション状態を古い `inactive` のまま読む。
          drainReplayImportQueue(createReplayImportDeps(service), 'auth-ready')
            .catch(err => console.error('[background] Replay import drain on auth capture failed:', err))
          return Promise.resolve()
        }

        // 受動取得した台帳（`/replay/list`）の突き合わせ。`apiEvents`へは
        // 書かないので、同じ理由で取り込みキューには載せない。
        if (handleReplayLedgerPortMessage(message, createReplayLedgerAuditDeps(service))) {
          return Promise.resolve()
        }

        // このイベントの処理を、直前のイベントの処理（add()の決着含む）の
        // 後ろに連結する。`processEvent`は内部で全エラーを捕捉して素通し
        // させない設計だが、想定外のバグでqueueが壊れて以降のイベントが
        // 永久に詰まることのないよう、キューの継続用チェーンは別途catchする。
        const deliveredAt = Date.now()
        const diagnosticApiTypeId = (message as { ApiTypeId?: unknown }).ApiTypeId
        ingestionQueueDepth += 1
        logReplayDiagnostic('port-event-received', {
          apiTypeId: typeof diagnosticApiTypeId === 'number' ? diagnosticApiTypeId : undefined,
          queueDepth: ingestionQueueDepth
        })
        const task = ingestionQueue
          .then(() => {
            // replay RESULTは自身では保存しないが、待っている取り込み処理を
            // 90001保存へ再開させる。生イベントと同じキューへ通すことで、
            // 先行する201/303/308のactivity更新後にwrite-time gateを読ませる。
            if (handleReplayPortMessage(message, port)) return
            return processEvent(service, message, port, deliveredAt)
          })
          .finally(() => {
            ingestionQueueDepth = Math.max(0, ingestionQueueDepth - 1)
            logReplayDiagnostic('port-event-processed', {
              apiTypeId: typeof diagnosticApiTypeId === 'number' ? diagnosticApiTypeId : undefined,
              elapsedMs: Date.now() - deliveredAt,
              queueDepth: ingestionQueueDepth
            })
          })
        ingestionQueue = task.then(() => undefined).catch(err => {
          console.error('[background] Unhandled ingestion queue error (fail-safe, queue continues):', err)
          captureHandledException(err, {
            operation: 'event_ingestion.queue'
          })
        })
        // ChromeのPort listenerは返したPromiseを待たない。Raw取り込みの直列化は
        // 上の`ingestionQueue`だけで完了させ、baseline prefetchでは止めない
        // （MUST NOT）。一方、直接listenerを呼ぶテスト等にはbackground taskを
        // 含む完了Promiseを返し、DB破棄後まで処理・ログが残らないようにする。
        return task.then(async completion => {
          await Promise.all(completion?.backgroundTasks ?? [])
        })
      })
      const stopPing = startPortPing(port)

      // Clean up when port disconnects
      port.onDisconnect.addListener(() => {
        // Keep lastKnownStats for page reloads - only clear interval
        stopPing()
        connectedPorts.delete(port)
        releaseActivePortForService(service, port)
        // 応答が返らないまま切れた依頼を解放する（待ち続けさせない）
        releaseReplayRequestsForPort(port)
      })
    }
  })
}

/**
 * 201は参加成功/失敗でApiTypeIdを共有する。明示的な非0 Codeだけを
 * 失敗として除外し、Code自体が欠落した未知payloadは従来通りfail-closedで
 * ACTIVE扱いする（schema変更時にゲーム中reloadを許さないため）。
 */
const isExplicitEntryFailure = (message: ApiMessage | { type: string }): boolean => {
  const code = (message as { Code?: unknown }).Code
  return typeof code === 'number' && code !== 0
}

const isSessionStartSignal = (
  rawApiTypeId: unknown,
  message: ApiMessage | { type: string }
): boolean =>
  (rawApiTypeId === ApiType.EVT_ENTRY_QUEUED && !isExplicitEntryFailure(message)) ||
  rawApiTypeId === ApiType.EVT_SESSION_DETAILS ||
  (rawApiTypeId === ApiType.EVT_DEAL && (message as { Player?: unknown }).Player != null)

/**
 * 生メッセージの数値ApiTypeIdだけを見て、セッションのACTIVE/INACTIVE状態を
 * 判定し、該当すれば`markSessionActive()`/`markSessionInactive()`を呼ぶ。
 *
 * 呼び出しは`processEvent`内、Raw Event Lakeの耐久性バリア（add()の決着）
 * および重複判定の**後**でのみ行う（真の重複はここに到達する前に
 * `processEvent`がreturn済み——重複イベントがACTIVE/INACTIVEを動かす
 * ことは無い。詳細は`processEvent`のコメント参照）。
 *
 * ACTIVE化のトリガーは308(EVT_SESSION_DETAILS)単独に頼らない
 * （release-blocker監査 finding B）: docs/api-events.md:99が明記する
 * 通り、308の欠落は正常系のバリアント（観測ギャップ）であり、
 * 「308が来ない試合開始」は普通に起こる。以下のいずれかを観測したら
 * 即active化する:
 *   - EVT_ENTRY_QUEUED(201): 着席（新セッション/新テーブルの入口）。
 *     ただしCodeが明示的に非0の参加失敗応答は除外
 *   - EVT_DEAL(303, Player在席時のみ): ハンド進行中の最も強いシグナル
 *     （観戦モード=Playerフィールド自体が無い場合は除外——P2, codex
 *     レビュー指摘。docs/api-events.md「EVT_DEAL: Playerフィールドの
 *     欠落」参照）
 *   - EVT_SESSION_DETAILS(308): 従来からのシグナル（来れば最速）
 *
 * INACTIVEへ戻すトリガーはEVT_SESSION_RESULTS(309)と
 * EVT_ENTRY_CANCELLED(203, 本ファイル冒頭の定数コメント参照)の2つ
 * （tri-stateのunknown=unsafeデフォルトは変更しない）。
 *
 * 同じトリガー集合をcontent_script.tsのkeepalive起動/解除条件にも
 * ミラーする必要がある（背景・コンテンツスクリプト間でimport不可のため
 * 手動同期。変更時は両ファイルを揃えること）。
 *
 * `activeOnly`（P2, codexレビュー指摘 2026-07-21, pass-4, "Fail closed
 * on dropped ACTIVE writes"）: `true`の場合、INACTIVE化（309/203）を
 * 一切行わない。raw書き込み自体が失敗した（quota超過等、真の重複でも
 * 衝突でもない）イベントに対する`processEvent`のfail-closed処理から
 * 呼ばれる場合に使う。理由: 309/203の永続化に失敗したという事実は
 * 「本当にセッションが終わった/キャンセルされた」ことの確証にならない
 * ため、INACTIVE化（＝reload許可という「危険側」の遷移）は生書き込みの
 * 成功を要求する。一方ACTIVE化（＝reload禁止という「安全側」の遷移）は
 * 生メッセージから読み取れる限り、書き込みが失敗していても即座に反映
 * してよい——「不明ならunsafe」という保守的デフォルトの単純な延長。
 * これを怠ると、直前が309でinactiveのまま、実際には新しいハンドが
 * 始まっているのに（201/303/308の生書き込みがたまたま失敗しただけで）
 * reloadが「安全」と誤判定されうる。
 */
const applySessionActivity = (
  rawApiTypeId: unknown,
  message: ApiMessage | { type: string },
  activeOnly = false,
  generation?: number
): void => {
  // forced update用の全体値と、現在tokenを持つACTIVEポートの値を進める。
  // 前者の意味は変えず、後者はリプレイ取得の判定点だけが読む。
  if (!activeOnly && (rawApiTypeId === ApiType.EVT_SESSION_RESULTS || rawApiTypeId === EVT_ENTRY_CANCELLED_API_TYPE_ID)) {
    markSessionInactive()
    if (generation !== undefined) markActivePortSessionInactive(generation)
    return
  }
  if (isSessionStartSignal(rawApiTypeId, message)) {
    markSessionActive()
    if (generation !== undefined) markActivePortSessionActive(generation)
    const rawPlayer = (message as { Player?: unknown }).Player
    if (rawApiTypeId === ApiType.EVT_DEAL && rawPlayer != null && generation !== undefined) {
      // このタブのヒーローが誰かを控える。キューに積んだアカウントと
      // 一致するポートへだけ取得を依頼するために使う。
      const seatIndex = (rawPlayer as { SeatIndex?: unknown }).SeatIndex
      const seatUserIds = (message as { SeatUserIds?: unknown }).SeatUserIds
      if (typeof seatIndex === 'number' && Array.isArray(seatUserIds)) {
        const playerId = seatUserIds[seatIndex]
        if (typeof playerId === 'number' && playerId > 0) markActivePortPlayerId(generation, playerId)
      }
    }
    return
  }
}

/**
 * セッション開始時の補助CANCELを一箇所へ集約する。保存成功時はdedupで新規と
 * 確定した後、保存失敗時はfail-closed分岐からだけ呼ぶ。
 */
const cancelReplayForSessionStart = (
  rawApiTypeId: unknown,
  message: ApiMessage | { type: string }
): void => {
  if (!isSessionStartSignal(rawApiTypeId, message)) return
  const cancelled = cancelReplayRequestsForSessionStart()
  if (cancelled > 0) {
    logReplayDiagnostic('drain-aborted-by-session-start', {
      apiTypeId: typeof rawApiTypeId === 'number' ? rawApiTypeId : undefined,
      cancelledRequests: cancelled
    })
  }
}

/**
 * 1件のAPIイベントを処理する: Raw Event Lakeへの保存・重複排除 → ACTIVE token/
 * 世代/activity更新 → リアルタイムパイプライン投入 → UI配信。
 *
 */
const processEvent = async (
  service: PokerChaseService,
  message: ApiMessage | { type: string },
  port?: chrome.runtime.Port,
  deliveredAt: number = Date.now()
): Promise<EventProcessingCompletion | undefined> => {
  const rawApiTypeId = (message as { ApiTypeId?: unknown }).ApiTypeId
  const rawTimestamp = (message as { timestamp?: unknown }).timestamp
  const hasUsableRawKey = validateMessage(message).success

  let portGeneration: number | undefined
  let storedRawEvent: RawApiEvent | undefined

  // Ensure service is ready before processing messages
  try {
    await service.ready
  } catch (err) {
    console.error('[background] Service not ready:', err)
    return
  }

  // Raw Event Lake（docs/architecture.md参照）: timestamp/ApiTypeIdが数値である
  // 限り、Zodパースの成否・アプリケーションイベントか否かに関わらず生のまま
  // 保存する。バリデーションは後続のリアルタイム処理パイプライン（ストリーム）
  // への投入可否のみを左右し、保存の可否は左右しない。これにより将来
  // PokerChase側のペイロード変更でスキーマ検証が壊れても、修正後のデータ
  // 再構築で復旧可能になる（2026年シーズン3のEVT_SESSION_RESULTS破壊的変更で
  // 実際にデータが失われた反省による）。
  if (hasUsableRawKey) {
    // Content-based dedup runs before sequence allocation. This retains the
    // reconnect-resend contract without making `(timestamp, ApiTypeId)`
    // unique: a genuinely different same-ms/same-type burst row receives the
    // next sequence and is durably stored instead of being mistaken for a
    // duplicate. The indexed lookup + add are one transaction, while the
    // outer ingestionQueue preserves WebSocket arrival order.
    try {
      const rawHandId = (message as { HandId?: unknown }).HandId
      const pendingDerivationOptions = rawApiTypeId === ApiType.EVT_HAND_RESULTS &&
        Number.isSafeInteger(rawHandId) &&
        ((rawHandId as number) >= 0)
          ? {
              // valid 306のraw commitと派生保留の間にMV3 workerが止まっても
              // 次回起動で復旧できるよう、sequence割当後のexact raw keyを
              // 同じtransactionで控える（MUST）。306以外のraw writeはmeta storeを
              // ロックしない。
              atomicMetaRecordsForAdded: (added: readonly RawApiEvent[]) =>
                service.statsLedger.createPendingHandDerivationFenceRecords(added),
            }
          : undefined
      const merge = await mergeApiEvents(
        service.db,
        [message as unknown as RawApiEvent],
        pendingDerivationOptions
      )
      if (merge.duplicates === 1) {
        console.warn('[background] Duplicate event (identical payload already in Raw Event Lake), skipping re-processing:', message)
        return
      }
      storedRawEvent = merge.added[0]
    } catch (err) {
      // quota/transaction failure = this event is absent from the Lake.
      // Preserve the invariant by dropping it from streams/sync hooks while
      // still applying only fail-closed ACTIVE transitions.
      console.error('[background] Raw Event Lake write failed -- dropping from pipeline to preserve the Lake invariant (derived stats require a raw row):', err, message)
      captureHandledException(err, {
        operation: 'raw_event_lake.write'
      })
      if (typeof rawApiTypeId === 'number') {
        const eventTimestamp = typeof rawTimestamp === 'number' ? rawTimestamp : Date.now()
        recordUndecodedEvent(service.db, rawApiTypeId, eventTimestamp).catch(recordErr =>
          console.error('[background] Failed to record dropped-event stats:', recordErr)
        )
      }
      // forced-update用の全体activityをfail-closedでACTIVE化する。raw mergeを
      // 通過していないためtoken/世代は移譲しないが、現在世代の取得判定だけは
      // ACTIVEへ倒す。
      // tokenのhandoverはraw成功後に限るが、現在tokenのinactiveは再取得を許すため、
      // START失敗時だけは既存世代もACTIVEへ倒して再発火を防ぐ。
      applySessionActivity(rawApiTypeId, message, true, resolveGeneration())
      // Raw Lakeの故障中でも、開始シグナルを実際に受けた以上は旧pageの取得を
      // fail-closedで止める（MUST）。これはstorage判定ではなく補助CANCELであり、
      // raw書き込み後にだけ動かすACTIVE-port tokenの規則は変更しない。
      cancelReplayForSessionStart(rawApiTypeId, message)
      return
    }
  } else {
    // timestamp/ApiTypeIdが数値でない = キーとして使えないため保存不可。
    // add()自体を呼んでいないので耐久性バリアの対象外（待つべきI/Oが無い）。
    // 直後のparseApiEvent()もほぼ確実にnullを返し自然に早期returnする。
    console.warn('[background] Event missing numeric timestamp/ApiTypeId, cannot store:', message)
  }

  // valid 306はraw行とexact sequenceの派生保留フェンスを同じtransactionで
  // commit済み。ここからAggregateEventsStreamへ正常にhandoffするまでの例外は、
  // 同一SW内でも起動時復旧の対象になるようfailed化する（MUST）。handoff後は
  // WriteEntityStreamがフェンスの成否を所有するため、他streamの例外で
  // 誤ってfailedへ戻してはならない（MUST NOT）。
  let pendingHandDerivationHandedOff = false
  try {

  // token・世代・activityを動かすのは、raw mergeの重複判定を通過した
  // 数値game eventだけ（MUST）。重複再送がrelicから来てもhandover/resetを
  // 起こさず、保存不能なイベントもACTIVE-port状態へ混ぜない。
  if (hasUsableRawKey && port) {
    portGeneration = claimActivePortForGameEvent(service, port, deliveredAt)
  }

  // ここから先はraw書き込み・重複排除・token世代確定が完了済み。

  // 309の現在ハンド状態はZod検証より先に破棄する（MUST）。集計lineupは
  // 保持したまま、後続のfilter再計算が終了済みハンドのSPR/ポットオッズを
  // 再配信できないようにする。真の重複は上でreturn済みなので新ハンドを
  // 過去のreconnect resendで消すこともない。
  if (rawApiTypeId === ApiType.EVT_SESSION_RESULTS && portGeneration !== undefined) {
    clearActiveRealtimeForSessionEnd(service, portGeneration)
  }

  // Forced-update安全性述語（update-manager.ts）のセッション状態追跡。
  // 意図的にパース成功後のdata.ApiTypeIdではなく、生メッセージの数値
  // ApiTypeIdだけを見て判定する: PokerChase側のペイロード破壊的変更で
  // parseApiEvent()がnullを返すようになっても、セッション状態が永久に
  // 誤った値のまま詰まらないようにするため（codexレビュー指摘）。
  // 詳細は`applySessionActivity`のコメント参照。
  applySessionActivity(rawApiTypeId, message, false, portGeneration)
  cancelReplayForSessionStart(rawApiTypeId, message)

  const successfulSessionStartTimestamp =
    rawApiTypeId === ApiType.EVT_ENTRY_QUEUED &&
    !isExplicitEntryFailure(message) &&
    portGeneration !== undefined
      ? (typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp)
          ? rawTimestamp
          : Date.now())
      : undefined

  // リプレイ取り込み層（既定OFF）。**セッション中は取得しない**（MUST）ので、
  // ここでやるのは HandId をキューへ積むことだけ。取得はセッション終了の
  // トリガーから走る（`replay-import.ts`）。
  //
  // 生メッセージの数値ApiTypeIdと生の`Player`だけを見る（上のセッション状態
  // 追跡と同じraw-firstパターン）。`Player`の有無がヒーローの配札有無で、
  // 観戦モードでは undefined になる（docs/api-events.md）。Zod検証の成否に
  // 依存させない ―― 検証はパイプライン投入の可否だけを決める。
  if (rawApiTypeId === ApiType.EVT_HAND_RESULTS &&
    (message as { Player?: unknown }).Player !== undefined) {
    // アカウントは、この結果でtokenを持つACTIVEポートが過去のdealで観測した
    // playerIdだけを使う（MUST）。キュー行へ焼き付けた後はhandoverしても変えない。
    enqueueReplayHandId(
      {
        ...createReplayImportDeps(service),
        getPlayerId: readActivePortPlayerId
      },
      (message as { HandId?: unknown }).HandId,
      Date.now()
    ).catch(err => console.error('[background] Replay import enqueue failed:', err))
  }

  // Auto-sync起動・保留中アップデートの安全性再チェックも、上のセッション状態
  // 追跡と同じ理由で生メッセージの数値ApiTypeIdだけを見て判定する（codexレビュー
  // 指摘, P2）。autoSyncService.onGameSessionEnd()/onNewSessionStart()は
  // 生のapiEvents Lake（上で既に保存済み）の件数だけを見るヘルパーで、
  // パース済みdataには一切依存しない。以前はこのトリガーが後段の
  // `if (data.ApiTypeId === ...)`（パース成功時のみ到達するブロック）に
  // ぶら下がっていたため、PokerChase側の309ペイロード破壊的変更で
  // parseApiEvent()がnullを返すケースでは、下のearly returnによって
  // recheckPendingUpdate()が一切呼ばれず、保留中アップデートは次の
  // セッション終了までずっと詰まったままになっていた（309の生データは
  // 上のRaw Event Lake保存で既に確保済みなので、この再チェック自体を
  // パース成否に依存させる理由はそもそも無い）。
  if (rawApiTypeId === ApiType.EVT_SESSION_RESULTS) {
    // セッション終了は保留中アップデートの安全性再チェック地点の1つ
    // （src/background/update-manager.ts参照）。onGameSessionEnd()の
    // Promiseが完了(成功/失敗いずれか)してから必ずチェーンして
    // recheckPendingUpdate()を呼ぶ -- 両方を並列で撃つと、performSync()が
    // `_isSyncing`を立てる前の非同期区間（min-versionゲートのawait等）を
    // recheckPendingUpdate()がすり抜けて安全と誤判定し、直近セッションの
    // クラウドバックアップがまだ始まってもいないうちに
    // chrome.runtime.reload()でService Workerを巻き込んでしまう恐れが
    // あるため（codexレビュー指摘, P1）。
    //
    // このチェーン全体はfire-and-forgetで、`processEvent`からawaitしない
    // （P2, codexレビュー指摘 2026-07-21, pass-4, "Don't block raw
    // ingestion on cloud uploads"）: `onGameSessionEnd()`は認証済み
    // ユーザーで未同期行数が閾値を超えていれば実際のFirestoreアップロード
    // を走らせうる非同期処理で、これを`ingestionQueue`内でawaitすると、
    // 次のハンドの生イベントが`apiEvents.add()`にすら到達できずメモリ上に
    // 滞留し、アップロード完了までライブHUDが凍結し、SWサスペンド/
    // リロード・タブクローズが起きればそれらのイベントは失われる
    // （前回の暫定対策——チェーン全体をawaitしてreloadとの競合を防ぐ——は
    // このスループット問題を引き起こしていた）。
    //
    // reload競合の防止は、同期処理をブロックする世代カウンタではなく、
    // `recheckPendingUpdate()`内の共有reload commit pointが担う。sync完了後
    // またはstorage await中に次の201/303/308が積まれても、その時点の最新
    // tailまでdrainしてACTIVEを適用してから安全性を最終判定する。202/205等
    // のノイズが同時に積まれた場合も単に処理完了まで待つだけで、再チェックを
    // 永続的に捨てない。
    autoSyncService.onGameSessionEnd()
      .catch(err => console.error('[background] Auto sync on game end failed:', err))
      .finally(() => {
        recheckPendingUpdate().catch(err =>
          console.error('[background] Pending update recheck on session end failed:', err)
        )
      })
    // リプレイ取り込み（既定OFF）。**ここが取得の起点**であり、セッション中に
    // 積んだHandIdをここで初めて取りに行く。`applySessionActivity()`が既に
    // INACTIVEへ倒した後なので、`drainReplayImportQueue`の不変条件判定を
    // 通過する。auto-syncと同じくfire-and-forget（取り込みキューを塞がない）。
    drainReplayImportQueue(createReplayImportDeps(service), 'session-end')
      .catch(err => console.error('[background] Replay import drain failed:', err))
  } else if (rawApiTypeId === EVT_ENTRY_CANCELLED_API_TYPE_ID) {
    // 参加取消申込(203)も保留中アップデートの安全性再チェック地点の1つに
    // 加える（P2, codexレビュー指摘 2026-07-21, pass-4, "Recheck updates
    // after entry cancellation"）: `applySessionActivity()`は203を309と
    // 同様にINACTIVE化トリガーとして扱う（本ファイル冒頭の定数コメント
    // 参照）が、この再チェック地点が309専用のままだと、参加キャンセルで
    // ちょうど安全になったケースでも別の契機（次のセッション終了・操作
    // 完了・SW起動）が来るまで保留され続けてしまう。203はauto-syncの
    // トリガー対象ではない（バックアップすべきセッションデータが無い）
    // ため`onGameSessionEnd()`は呼ばず、共有commit pointを持つ
    // `recheckPendingUpdate()`だけを呼ぶ。
    recheckPendingUpdate().catch(err =>
      console.error('[background] Pending update recheck on entry cancellation failed:', err)
    )
    // 203もINACTIVE化トリガーなので、持ち越し分があればここでも流す。
    drainReplayImportQueue(createReplayImportDeps(service), 'entry-cancelled')
      .catch(err => console.error('[background] Replay import drain failed:', err))
  } else if (
    (rawApiTypeId === ApiType.EVT_ENTRY_QUEUED && !isExplicitEntryFailure(message)) ||
    rawApiTypeId === ApiType.EVT_SESSION_DETAILS
  ) {
    // フォールバックトリガー（docs/postmortems/2026-07-session-results-drop.md
    // 再発防止#3): 309単一トリガーのSPOF対策。新セッション開始時点は
    // 進行中ハンドが存在しない安全なタイミングなので、ここでも同じ閾値判定
    // でuploadを起動する（309が正常なら直前で既にバックログが閾値未満に
    // なっているため二重発火しない）
    autoSyncService.onNewSessionStart().catch(err =>
      console.error('[background] Auto sync on new session start failed:', err)
    )
  }

  // 通常のAPIメッセージ処理
  // Zodスキーマでパース（passthrough: 未知プロパティは保持）
  // raw writerが割り当てたsequenceをパイプラインへ引き継ぐ。
  // WriteEntityStreamはこのexact raw keyのフェンスだけをcanonical commitと
  // 同時に消すため、元のsequence無しmessageを再度parseしてはならない
  // （MUST NOT）。
  const data = parseApiEvent((storedRawEvent ?? message) as ApiMessage)

  if (!data) {
    // パース失敗 = 必須プロパティ欠損など破壊的変更の可能性。保存キーが
    // 有効なら生ログは上で保存済みなので、リアルタイムパイプラインへの
    // 投入のみ諦める。キー自体が不正ならraw保存不能だが、下の診断と
    // 永続カウンタには残す。
    const validationResult = validateApiEvent(message as ApiMessage)
    const errorDetails = validationResult.error ? getValidationError(validationResult.error) : null
    const rawStatus = hasUsableRawKey
      ? 'stored raw, pipeline skipped'
      : 'raw not stored: invalid storage key, pipeline skipped'
    console.warn(`[background] Schema validation failed (${rawStatus}):\n  Errors: ${JSON.stringify(errorDetails, null, 2)}\n  Event: ${JSON.stringify(message, null, 2)}`)

    // drop可視化（docs/postmortems/2026-07-session-results-drop.md 再発防止#2）:
    // 検証失敗イベントの件数をApiTypeIdごとに集計してmetaテーブルへ永続化し、
    // Popupから可視化できるようにする。309インシデントは半年間これが
    // console.warnの中にしか無かったために気づけなかった
    // ApiTypeId itself may be the field whose schema changed. Keep those
    // failures visible under one bounded sentinel instead of silently losing
    // both Sentry telemetry and the persistent Popup counter. The raw row
    // remains unstorable when its timestamp/ApiTypeId key is invalid.
    const diagnosticApiTypeId =
      typeof rawApiTypeId === 'number' &&
      Number.isSafeInteger(rawApiTypeId)
        ? rawApiTypeId
        : INVALID_API_TYPE_ID_BUCKET
    captureSchemaValidationFailure(
      diagnosticApiTypeId,
      () => buildSchemaDiagnostic(
        message,
        validationResult.error?.issues ?? [],
        {
          redactUnknownRootKeys: true,
          knownRootKeys: getEventSchema(diagnosticApiTypeId)
            ? getEventFields(diagnosticApiTypeId)
            : undefined
        }
      )
    )
    const eventTimestamp =
      typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp)
        ? rawTimestamp
        : Date.now()
    recordUndecodedEvent(
      service.db,
      diagnosticApiTypeId,
      eventTimestamp
    ).catch(err =>
      console.error('[background] Failed to record undecoded event stats:', err)
    )
    if (storedRawEvent?.ApiTypeId === ApiType.EVT_HAND_RESULTS) {
      // 現行スキーマではパイプライン対象にできない終端判定。
      // rawはLakeに残るため、後日のスキーマ修正+再構築は失われない。
      await service.statsLedger.acknowledgePendingHandDerivation(storedRawEvent)
    }
    if (successfulSessionStartTimestamp !== undefined) {
      notifySessionStart(portGeneration!, successfulSessionStartTimestamp)
    }
    return
  }

  // アプリケーション用のイベントかチェック
  if (!isApplicationApiEvent(data)) {
    // アプリケーションで使用しないApiTypeIdのイベントはパイプラインに投入しないが
    // 内容は記録（生ログとしては上で既に保存済み）
    console.info(`[background] Non-application event (${data.ApiTypeId}): ${JSON.stringify(data)}`)
    if (successfulSessionStartTimestamp !== undefined) {
      notifySessionStart(portGeneration!, successfulSessionStartTimestamp)
    }
    return
  }

  // 313が来る正常系では着席時点からbaseline構築を先行させ、313欠落・途中参加
  // は301/303で補う。取り込みキューと既存stream順序を止めないためMUST NOT await。
  const statsLedgerPrefetch = prefetchStatsLedgerBaselines(service, data)

  if (portGeneration !== undefined) setEventGeneration(data, portGeneration)

  // ここでdataはApiEvent型（isApplicationApiEventで保証済み）
  service.eventLogger(data, 'info')

  if (portGeneration !== undefined && isApiEventType(data, ApiType.EVT_DEAL)) {
    recordActiveDealContext(portGeneration)
  }

  // ストリーム処理（DB保存は上で完了済み・耐久性確定済み）
  service.handLogStream.write(data)
  service.handAggregateStream.write(data)
  if (storedRawEvent?.ApiTypeId === ApiType.EVT_HAND_RESULTS) {
    pendingHandDerivationHandedOff = true
  }
  service.realTimeStatsStream.write(data)
  if (successfulSessionStartTimestamp !== undefined) {
    notifySessionStart(portGeneration!, successfulSessionStartTimestamp)
  }
  // Auto-sync起動・pending update再チェック（309/201/308）は上のRaw
  // Event Lake保存直後に生ApiTypeIdベースで既にトリガー済み（本ブロックの
  // パース成功はストリーム投入のみが目的）
  return {
    backgroundTasks: statsLedgerPrefetch ? [statsLedgerPrefetch] : []
  }
  } catch (err) {
    if (
      storedRawEvent?.ApiTypeId === ApiType.EVT_HAND_RESULTS &&
      !pendingHandDerivationHandedOff
    ) {
      try {
        await service.statsLedger.markPendingHandDerivationFailed(storedRawEvent)
      } catch (markerErr) {
        console.error('[background] Failed to mark pending hand derivation after pre-handoff error:', markerErr)
        captureHandledException(markerErr, {
          operation: 'stats_ledger.mark_pending_hand_derivation_failed'
        })
      }
    }
    throw err
  }
}
