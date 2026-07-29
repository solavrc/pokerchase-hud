/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
import PokerChaseService, {
  ApiType,
  BattleType,
  ApiMessage,
  validateMessage,
  validateApiEvent,
  parseApiEvent,
  getValidationError,
  isApplicationApiEvent
} from '../app'
import { autoSyncService } from '../services/auto-sync-service'
import {
  broadcastMessage,
  connectedPorts,
  startPortPing,
  setLastKnownStats,
} from './ports'
import { recordUndecodedEvent } from './undecoded-event-tracker'
import { markSessionActive, markSessionInactive, recheckPendingUpdate, setIngestionDrainProvider } from './update-manager'
import { mergeApiEvents, type RawApiEvent } from '../utils/api-event-key'
import { getOperationState } from './operation-state'
import { POKER_CHASE_SESSION_END_SETTLED_MESSAGE } from '../constants/runtime'

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

/**
 * Raw Event Lakeの耐久性バリア（release-blocker監査 finding A）を実現する
 * ための直列化キュー。モジュールスコープに置くのは、update-manager.tsの
 * `awaitIngestionDrain()`（キュー・ドレイン・バリア、2026-07-21 pass-3）
 * から`setIngestionDrainProvider()`経由で参照させるため
 * （`registerEventIngestion()`のコメント参照）。
 */
let ingestionQueue: Promise<void> = Promise.resolve()
let applicationForwardingQueue: Promise<void> = Promise.resolve()
let ingestionDrainQueue: Promise<void> = Promise.resolve()

type DurableProcessingResult = {
  forwarding?: Promise<void>
}

type SessionBoundaryState = {
  rawSessionSourceTabId?: number
  sourceRestore: Promise<void>
}

type RawEntryRecovery = {
  id?: string
  battleType?: BattleType
}

const SESSION_SOURCE_TAB_STORAGE_KEY = 'pokerChaseActiveSessionSourceTabId'

const KNOWN_BATTLE_TYPES = new Set<number>([
  BattleType.SIT_AND_GO,
  BattleType.TOURNAMENT,
  BattleType.FRIEND_SIT_AND_GO,
  BattleType.RING_GAME,
  BattleType.FRIEND_RING_GAME,
  BattleType.CLUB_MATCH,
])

const applySessionContext = (
  service: PokerChaseService,
  context?: RawEntryRecovery
): void => {
  const previousAutoFilter = service.getEffectiveBattleTypeFilter()?.join(',')
  service.resetSession()
  if (context?.id !== undefined && context.battleType !== undefined) {
    service.session.setId(context.id)
    service.session.setBattleType(context.battleType)
  }
  if (
    service.autoBattleTypeFilter &&
    previousAutoFilter !== service.getEffectiveBattleTypeFilter()?.join(',')
  ) {
    service.autoBattleTypeFilterRevision++
  }
}

const clearEndedSession = async (
  service: PokerChaseService
): Promise<void> => {
  applySessionContext(service)
  // resetSession() normally persists on a 500 ms debounce. A pending update
  // may reload the worker as soon as ingestion drains, so make the cleared
  // snapshot part of that drain barrier.
  try {
    await service.flushStatePersistence()
  } catch (error) {
    // The in-memory session is clear, but a worker restart could restore the
    // stale persisted one. Keep forced updates fail-closed until a later
    // successful lifecycle write proves that reload is safe.
    markSessionActive()
    throw error
  }
}

const isSessionEndSignal = (rawApiTypeId: unknown): boolean =>
  rawApiTypeId === ApiType.EVT_SESSION_RESULTS ||
  rawApiTypeId === EVT_ENTRY_CANCELLED_API_TYPE_ID

const enqueueApplicationForwarding = (
  service: PokerChaseService,
  rawApiTypeId: unknown,
  foreignSessionEnd: boolean,
  resetReboundSession: boolean,
  data?: ReturnType<typeof parseApiEvent>,
  rawEntryRecovery?: RawEntryRecovery
): Promise<void> => {
  const forwarding = applicationForwardingQueue.then(async () => {
    // Local deletion must not wait for a startup filter gate merely to discard
    // work whose raw rows are being deleted. Recheck after the gate too, since
    // deletion can claim ownership while this task is waiting.
    if (getOperationState().type === 'delete') return
    await Promise.all([service.ready, service.filtersRestored])

    // Raw保存後にlocal deletionがcommit slotを取得した場合、待機していた
    // application転送を再開するとDexieが削除済みDBを再作成し得る。deleteが
    // ownershipを持つ間は派生streamを破棄する（raw行も削除対象なので再送不要）。
    if (getOperationState().type === 'delete') return

    if (rawApiTypeId === ApiType.EVT_ENTRY_QUEUED && rawEntryRecovery) {
      applySessionContext(service, rawEntryRecovery)
    }
    if (resetReboundSession) {
      // A new source began play without a captured 201, so its game type is
      // unknowable. Repeat the raw fail-closed reset in application order,
      // after older source events, durably persist it, then publish an empty
      // HUD state before forwarding any event from the new source.
      await clearEndedSession(service)
      setLastKnownStats([])
      await service.statsOutputStream.clearStats()
    }

    // A different tab/source is direct evidence that this boundary does not
    // end the session installed by the current source. Keep it in the Raw
    // Lake, but do not let it clear or enter the live application streams.
    if (foreignSessionEnd) return

    // The raw queue can advance while older application transforms are still
    // calculating. Drain those transforms before publishing the terminal
    // clear so no pre-end result can repopulate lastKnownStats/the HUD after
    // the content script observes this boundary.
    if (isSessionEndSignal(rawApiTypeId)) {
      await Promise.all([
        service.handLogStream.whenIdle(),
        service.handAggregateStream.whenIdle(),
        service.realTimeStatsStream.whenIdle(),
      ])
      await service.writeEntityStream.whenIdle()
      await service.statsOutputStream.whenIdle()
      if (rawApiTypeId === ApiType.EVT_SESSION_RESULTS) {
        setLastKnownStats([])
      }
      await clearEndedSession(service)
      if (rawApiTypeId === ApiType.EVT_SESSION_RESULTS) {
        broadcastMessage(POKER_CHASE_SESSION_END_SETTLED_MESSAGE)
      }
    }

    if (!data || !isApplicationApiEvent(data)) return

    service.eventLogger(data, 'info')
    service.handLogStream.write(data)
    service.handAggregateStream.write(data)
    service.realTimeStatsStream.write(data)
  })
  applicationForwardingQueue = forwarding.catch(err => {
    console.error('[background] Unhandled application forwarding error (fail-safe, queue continues):', err)
  })
  // application queue自体はwrite()後すぐ次イベントへ進めてライブ処理を詰まらせない。
  // 一方、reload drain/callerへ返すPromiseは、このイベントまでに各streamへ積まれた
  // 非同期変換と下流DB派生まで待つ。特にEVT_HAND_RESULTSはAggregate→WriteEntity
  // →ReadEntityの順にqueueが追加されるため、上流から順にidleを確認する。
  return forwarding.then(async () => {
    await Promise.all([
      service.handLogStream.whenIdle(),
      service.handAggregateStream.whenIdle(),
      service.realTimeStatsStream.whenIdle(),
    ])
    await service.writeEntityStream.whenIdle()
    await service.statsOutputStream.whenIdle()
  })
}

/**
 * `chrome.runtime.onConnect`のハンドラーを登録する。
 * content_scriptからのポート接続を受け取り、APIイベントの検証・DB保存・
 * 各ストリームへの書き込み・自動同期トリガーを行う。
 */
export const registerEventIngestion = (service: PokerChaseService): void => {
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
  applicationForwardingQueue = Promise.resolve()
  ingestionDrainQueue = Promise.resolve()
  const sessionBoundaryState = {
    rawSessionSourceTabId: undefined,
  } as SessionBoundaryState
  sessionBoundaryState.sourceRestore = chrome.storage.session
    .get(SESSION_SOURCE_TAB_STORAGE_KEY)
    .then(result => {
      const restored = result[SESSION_SOURCE_TAB_STORAGE_KEY]
      if (typeof restored === 'number') {
        sessionBoundaryState.rawSessionSourceTabId = restored
      }
    })
    .catch(error => {
      console.error('[background] Failed to restore active session source:', error)
    })
  setIngestionDrainProvider(() => ingestionDrainQueue)

  chrome.runtime.onConnect.addListener(port => {
    if (port.name === PokerChaseService.POKER_CHASE_SERVICE_EVENT) {
      connectedPorts.add(port)
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

        // Raw Event Lakeへの保存とraw-first副作用だけを直列化する。フィルター
        // 復元待ちを含むアプリケーションstream転送はprocessEvent()が別キューへ
        // 積むため、cold start中でも後続イベントは各自のraw mergeまで進める。
        const sourceTabId = port.sender?.tab?.id
        const durableTask = ingestionQueue.then(() =>
          processEvent(service, message, sessionBoundaryState, sourceTabId)
        )
        ingestionQueue = durableTask.then(() => undefined).catch(err => {
          console.error('[background] Unhandled ingestion queue error (fail-safe, queue continues):', err)
        })
        // 呼び出し元には従来通り、このイベント固有のstream転送完了まで待てる
        // Promiseを返す。ただしそれをraw ingestionQueueのtailにはしない。
        const completion = durableTask.then(result => result?.forwarding)
        // reloadだけはrawとapplicationの両方が決着するまで待つ。前のdrain tailも
        // 明示的につなぐことで、後続のnon-application eventが古いforwardingを
        // providerから脱落させない。
        ingestionDrainQueue = Promise.all([ingestionDrainQueue, completion])
          .then(() => undefined)
          .catch(err => {
            console.error('[background] Unhandled ingestion drain error (fail-safe, drain continues):', err)
          })
        return completion
      })
      const stopPing = startPortPing(port)

      // Clean up when port disconnects
      port.onDisconnect.addListener(() => {
        // Keep lastKnownStats for page reloads - only clear interval
        stopPing()
        connectedPorts.delete(port)
      })
    }
  })
}

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
 *   - EVT_ENTRY_QUEUED(201): 着席（新セッション/新テーブルの入口）
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
  preserveActiveSession = false,
  isEntryBoundary = rawApiTypeId === ApiType.EVT_ENTRY_QUEUED
): void => {
  if (
    !activeOnly &&
    !preserveActiveSession &&
    (rawApiTypeId === ApiType.EVT_SESSION_RESULTS || rawApiTypeId === EVT_ENTRY_CANCELLED_API_TYPE_ID)
  ) {
    markSessionInactive()
    return
  }
  if (isEntryBoundary || rawApiTypeId === ApiType.EVT_SESSION_DETAILS) {
    markSessionActive()
    return
  }
  if (rawApiTypeId === ApiType.EVT_DEAL) {
    const rawPlayer = (message as { Player?: unknown }).Player
    if (rawPlayer != null) {
      markSessionActive()
    }
  }
}

/**
 * 1件のAPIイベントを処理する: Raw Event Lakeへの保存（耐久性バリア）→
 * セッション状態追跡・自動同期トリガー（raw書き込み決着後のみ）→
 * リアルタイムパイプラインへの投入。
 *
 */
const processEvent = async (
  service: PokerChaseService,
  message: ApiMessage | { type: string },
  boundaryState: SessionBoundaryState,
  sourceTabId: number | undefined
): Promise<DurableProcessingResult | undefined> => {
  // Ensure service is ready before processing messages
  try {
    await Promise.all([service.ready, boundaryState.sourceRestore])
  } catch (err) {
    console.error('[background] Service not ready:', err)
    return
  }

  const rawApiTypeId = (message as { ApiTypeId?: unknown }).ApiTypeId
  const rawTimestamp = (message as { timestamp?: unknown }).timestamp
  const rawEntryCode = (message as { Code?: unknown }).Code
  const isExplicitEntryFailure =
    rawApiTypeId === ApiType.EVT_ENTRY_QUEUED &&
    typeof rawEntryCode === 'number' &&
    rawEntryCode !== 0
  const isEntryBoundary =
    rawApiTypeId === ApiType.EVT_ENTRY_QUEUED &&
    !isExplicitEntryFailure

  // Raw Event Lake（docs/architecture.md参照）: timestamp/ApiTypeIdが数値である
  // 限り、Zodパースの成否・アプリケーションイベントか否かに関わらず生のまま
  // 保存する。バリデーションは後続のリアルタイム処理パイプライン（ストリーム）
  // への投入可否のみを左右し、保存の可否は左右しない。これにより将来
  // PokerChase側のペイロード変更でスキーマ検証が壊れても、修正後のデータ
  // 再構築で復旧可能になる（2026年シーズン3のEVT_SESSION_RESULTS破壊的変更で
  // 実際にデータが失われた反省による）。
  if (validateMessage(message).success) {
    // Content-based dedup runs before sequence allocation. This retains the
    // reconnect-resend contract without making `(timestamp, ApiTypeId)`
    // unique: a genuinely different same-ms/same-type burst row receives the
    // next sequence and is durably stored instead of being mistaken for a
    // duplicate. The indexed lookup + add are one transaction, while the
    // outer ingestionQueue preserves WebSocket arrival order.
    try {
      const merge = await mergeApiEvents(service.db, [message as unknown as RawApiEvent])
      if (merge.duplicates === 1) {
        console.warn('[background] Duplicate event (identical payload already in Raw Event Lake), skipping re-processing:', message)
        return
      }
    } catch (err) {
      // quota/transaction failure = this event is absent from the Lake.
      // Preserve the invariant by dropping it from streams/sync hooks while
      // still applying only fail-closed ACTIVE transitions.
      console.error('[background] Raw Event Lake write failed -- dropping from pipeline to preserve the Lake invariant (derived stats require a raw row):', err, message)
      if (typeof rawApiTypeId === 'number') {
        const eventTimestamp = typeof rawTimestamp === 'number' ? rawTimestamp : Date.now()
        recordUndecodedEvent(service.db, rawApiTypeId, eventTimestamp).catch(recordErr =>
          console.error('[background] Failed to record dropped-event stats:', recordErr)
        )
      }
      applySessionActivity(rawApiTypeId, message, true, false, isEntryBoundary)
      return
    }
  } else {
    // timestamp/ApiTypeIdが数値でない = キーとして使えないため保存不可。
    // add()自体を呼んでいないので耐久性バリアの対象外（待つべきI/Oが無い）。
    // 直後のparseApiEvent()もほぼ確実にnullを返し自然に早期returnする。
    console.warn('[background] Event missing numeric timestamp/ApiTypeId, cannot store:', message)
  }

  // ここから先はraw書き込みが成功したか、保存不可能で待つべきI/Oが
  // 無かった場合のみ到達する。真の重複と書き込み失敗は上でreturn済み。

  // Forced-update安全性述語（update-manager.ts）のセッション状態追跡。
  // 意図的にパース成功後のdata.ApiTypeIdではなく、生メッセージの数値
  // ApiTypeIdだけを見て判定する: PokerChase側のペイロード破壊的変更で
  // parseApiEvent()がnullを返すようになっても、セッション状態が永久に
  // 誤った値のまま詰まらないようにするため（codexレビュー指摘）。
  // 詳細は`applySessionActivity`のコメント参照。
  const isSeatedDeal =
    rawApiTypeId === ApiType.EVT_DEAL &&
    (message as { Player?: unknown }).Player != null
  const isSessionSourceSignal =
    isEntryBoundary ||
    rawApiTypeId === ApiType.EVT_SESSION_DETAILS ||
    isSeatedDeal
  const previousSessionSourceTabId =
    boundaryState.rawSessionSourceTabId
  const sourceReboundWithoutEntry =
    !isEntryBoundary &&
    isSessionSourceSignal &&
    previousSessionSourceTabId !== undefined &&
    sourceTabId !== undefined &&
    previousSessionSourceTabId !== sourceTabId
  if (
    isSessionSourceSignal &&
    boundaryState.rawSessionSourceTabId !== sourceTabId
  ) {
    // 201 can be absent in valid captures. A seated 303 or session-details
    // 308 from a new tab is direct evidence that the only active login moved,
    // so rebind ownership before classifying that tab's eventual 309.
    boundaryState.rawSessionSourceTabId = sourceTabId
    try {
      if (sourceTabId === undefined) {
        await chrome.storage.session.remove(SESSION_SOURCE_TAB_STORAGE_KEY)
      } else {
        await chrome.storage.session.set({
          [SESSION_SOURCE_TAB_STORAGE_KEY]: sourceTabId,
        })
      }
    } catch (error) {
      console.error('[background] Failed to persist active session source:', error)
    }
  }
  if (sourceReboundWithoutEntry) {
    applySessionContext(service)
    service.invalidateStatsOutputContext()
  }
  const foreignSessionEnd =
    isSessionEndSignal(rawApiTypeId) &&
    boundaryState.rawSessionSourceTabId !== undefined &&
    sourceTabId !== undefined &&
    boundaryState.rawSessionSourceTabId !== sourceTabId
  applySessionActivity(
    rawApiTypeId,
    message,
    false,
    foreignSessionEnd,
    isEntryBoundary
  )

  if (rawApiTypeId === ApiType.EVT_SESSION_RESULTS && !foreignSessionEnd) {
    // Invalidate before the independently advancing application queue waits:
    // any older stats transform that has not pushed yet must not repopulate
    // the HUD after the raw session-end clear.
    service.invalidateStatsOutputContext()
  }
  if (isSessionEndSignal(rawApiTypeId) && !foreignSessionEnd) {
    boundaryState.rawSessionSourceTabId = undefined
    try {
      await chrome.storage.session.remove(SESSION_SOURCE_TAB_STORAGE_KEY)
    } catch (error) {
      console.error('[background] Failed to clear active session source:', error)
    }
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
  } else if (isEntryBoundary || rawApiTypeId === ApiType.EVT_SESSION_DETAILS) {
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
  const data = parseApiEvent(message as ApiMessage)

  // An explicit failed entry response is durable diagnostic data, not a
  // session boundary. It must not replace the current owner/category or
  // enter application streams even if a future schema accepts its shape.
  if (isExplicitEntryFailure) return

  if (!data) {
    // パース失敗 = 必須プロパティ欠損など破壊的変更の可能性。生ログは上で
    // 既に保存済みなので、ここではリアルタイムパイプラインへの投入のみ諦める
    const validationResult = validateApiEvent(message as ApiMessage)
    const errorDetails = validationResult.error ? getValidationError(validationResult.error) : null
    console.warn(`[background] Schema validation failed (stored raw, pipeline skipped):\n  Errors: ${JSON.stringify(errorDetails, null, 2)}\n  Event: ${JSON.stringify(message, null, 2)}`)

    // drop可視化（docs/postmortems/2026-07-session-results-drop.md 再発防止#2）:
    // 検証失敗イベントの件数をApiTypeIdごとに集計してmetaテーブルへ永続化し、
    // Popupから可視化できるようにする。309インシデントは半年間これが
    // console.warnの中にしか無かったために気づけなかった
    if (typeof rawApiTypeId === 'number') {
      const eventTimestamp = typeof rawTimestamp === 'number' ? rawTimestamp : Date.now()
      recordUndecodedEvent(service.db, rawApiTypeId, eventTimestamp).catch(err =>
        console.error('[background] Failed to record undecoded event stats:', err)
      )
    }
    if (isSessionEndSignal(rawApiTypeId)) {
      return {
        forwarding: enqueueApplicationForwarding(
          service,
          rawApiTypeId,
          foreignSessionEnd,
          false
        )
      }
    }
    if (isEntryBoundary) {
      const raw = message as { Id?: unknown, BattleType?: unknown, Code?: unknown }
      const rawEntryRecovery: RawEntryRecovery = {
        id: raw.Code === 0 && typeof raw.Id === 'string'
          ? raw.Id
          : undefined,
        battleType: raw.Code === 0 &&
          typeof raw.BattleType === 'number' &&
          KNOWN_BATTLE_TYPES.has(raw.BattleType)
          ? raw.BattleType as BattleType
          : undefined,
      }
      return {
        forwarding: enqueueApplicationForwarding(
          service,
          rawApiTypeId,
          false,
          false,
          undefined,
          rawEntryRecovery
        )
      }
    }
    if (sourceReboundWithoutEntry) {
      return {
        forwarding: enqueueApplicationForwarding(
          service,
          rawApiTypeId,
          false,
          true
        )
      }
    }
    return
  }

  // アプリケーション用のイベントかチェック
  if (!isApplicationApiEvent(data)) {
    // アプリケーションで使用しないApiTypeIdのイベントはパイプラインに投入しないが
    // 内容は記録（生ログとしては上で既に保存済み）
    console.info(`[background] Non-application event (${data.ApiTypeId}): ${JSON.stringify(data)}`)
    if (isSessionEndSignal(rawApiTypeId)) {
      return {
        forwarding: enqueueApplicationForwarding(
          service,
          rawApiTypeId,
          foreignSessionEnd,
          false
        )
      }
    }
    return
  }

  // フィルター依存のstream転送だけを別の直列キューへ積む。復元待ちが長引いても
  // raw ingestionQueueを保持しないため、後続イベントは先にRaw Lakeへ永続化できる。
  // applicationForwardingQueueはraw側での到着順に積まれるので、復元後のstream順序は
  // これまで通り保たれる。
  return {
    forwarding: enqueueApplicationForwarding(
      service,
      rawApiTypeId,
      foreignSessionEnd,
      sourceReboundWithoutEntry,
      data
    )
  }
}
