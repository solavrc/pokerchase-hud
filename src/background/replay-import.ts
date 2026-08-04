/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
/**
 * リプレイ詳細の取り込み層（既定OFF）。
 *
 * ## 不変条件: セッション中は1本も撃たない（MUST）
 *
 * セッションの進行中に過去ハンドの詳細を取れてしまうと、まだ伏せられている
 * 情報がセッション内で参照可能になる。ゲーム性・公平性に直結するため、
 * **セッションが有効な間は `/replay/detail` を一切発行しない**。セッション中に
 * できるのは HandId をキューへ積むことだけで、取得はセッション終了後に走る。
 *
 * この不変条件はこのファイルの1箇所（`canFetchNow`）に集約し、テストで固定する。
 * 判定するのはACTIVEポートの三値（unknown/active/inactive）だけで、
 * **`unknown` は取得不可**として扱う。Service Worker再起動直後のtoken未生成も
 * unknownであり、dedup済みゲームイベントがactivityを確立するまで取得しない。
 *
 * ## キューの永続化
 *
 * MV3のService Workerは数十秒で落ちるので、キューはメモリに置けない。
 * `meta` テーブルの1行（`replayImportQueue`）に持つ。専用ストアを作らないのは、
 * 高々100件規模の待ち行列にDexieのバージョンを消費する理由が無いため。
 *
 * ## 保存形式
 *
 * 取得結果は Raw Event Lake（`apiEvents`）へ**合成イベント**（ApiTypeId 90001、
 * `ApiType.REPLAY_HAND_DETAIL`）として保存し、同じトランザクションで
 * `replayDetails`（HandId主キー）へ射影する。Lakeに載せることで、NDJSONの
 * エクスポート／インポート、Firestoreの増分同期、その先のBQ取り込みが
 * **無改修で**この行を運ぶ。
 *
 * `session`（回転する資格情報）は保存も輸出もしない（MUST NOT）。ページ側の
 * `sanitizeReplayDetail` が境界で落としており、ここでも `payload` として
 * 受け取るのは応答の `param` だけに限定する。
 */
import type { PokerChaseDB } from '../db/poker-chase-db'
import { ApiType } from '../types/api'
import { mergeApiEvents, type RawApiEvent } from '../utils/api-event-key'
import {
  EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY,
  REPLAY_FETCH_INTERVAL_MS,
  REPLAY_STATUS_EXPIRED,
  REPLAY_STATUS_NOT_FOUND,
  isPositiveHandId,
  parseReplayErrorStatus,
  type ReplayFetchItemResult
} from '../replay/protocol'
import { isWithinReplayWindow } from '../replay/window'
import { sanitizeReplayDetail } from '../replay/protocol'
import { requestReplayDetails } from './replay-fetch-bridge'
import { startKeepAlive } from './service-worker-keepalive'
import { enqueuePendingStorageWrite } from './pending-storage-writes'
import { awaitIngestionDrain } from './update-manager'
import {
  findActivePortForPlayer,
  isActivePortOutsideSession
} from './active-port'
import { logReplayDiagnostic } from './replay-diagnostics'

export const REPLAY_IMPORT_QUEUE_META_ID = 'replayImportQueue'
export const REPLAY_IMPORT_STATUS_META_ID = 'replayImportStatus'

/**
 * キューの上限。取得が滞ってもメタ行が無制限に膨らまないための頭打ち。
 * 1セッションのハンド数（実測で100件超）に対して十分な余裕を取る。
 * 溢れたときに落とすのは**古い方**（暦日の窓から先に失効するのも古い方）。
 */
export const REPLAY_IMPORT_QUEUE_LIMIT = 1000

export interface ReplayQueueEntry {
  handId: number
  /** そのハンドを観測した時刻（Unix Milliseconds）。暦日の窓判定に使う。 */
  enqueuedAt: number
  /**
   * 積んだ時点のヒーローのUserId。
   *
   * 取得はページ側の認証エンベロープで行われるので、繰り延べ中に別アカウントへ
   * ログインすると、旧アカウントのHandIdが新しい資格情報で `2302`（データ無し）
   * になり、**再試行不能として永久に捨てられる**。積んだアカウントと一致する
   * ときだけ撃つ（一致しなければ持ち越す）。
   */
  playerId?: number
}

export interface ReplayImportStatus {
  /** 直近の取得を終えた時刻。 */
  lastRunAt: number
  /** 保存できた件数（累計）。 */
  stored: number
  /** 閲覧期限切れ（サーバの2301）で落ちた件数（累計）。再試行しない。 */
  expired: number
  /** データ無し（サーバの2302）で落ちた件数（累計）。再試行しない。 */
  notFound: number
  /** 暦日の窓を過ぎたためリクエストせず落とした件数（累計）。 */
  droppedBeforeRequest: number
  /** 認証エンベロープ不在などで持ち越した件数（直近の実行時点）。 */
  deferred: number
  /** 直近の実行で最後に観測したエラー（診断用。資格情報は含まない）。 */
  lastError?: string
}

const EMPTY_STATUS: ReplayImportStatus = {
  lastRunAt: 0,
  stored: 0,
  expired: 0,
  notFound: 0,
  droppedBeforeRequest: 0,
  deferred: 0
}

/** キュー操作の直列化（read-modify-writeが互いを巻き戻さないように）。 */
let queueMutation: Promise<void> = Promise.resolve()

/**
 * DBへの書き込みを、reload前のドレイン対象（共通FIFO）に載せたうえで、
 * **書き込みの直前に**長時間操作の有無を同期的に確かめてから実行する。
 *
 * 二重の理由がある:
 * - `deleteAllData()` はこのドレインを待たずに `db.delete()` する。判定と
 *   書き込みの間にawaitがあると、その隙に削除が完了して、続く書き込みが
 *   消えたDBを作り直す。await境界ごとに点検を足すのではなく、**書き込みの
 *   直前**という1点に寄せる
 * - forced update の reload commit point はこのFIFOを待つので、書き込みの
 *   途中で `chrome.runtime.reload()` されない
 */
const guardedWrite = <T>(
  deps: ReplayImportDeps,
  write: () => Promise<T>
): Promise<T | undefined> =>
  enqueuePendingStorageWrite(async () => {
    if (deps.isBusy?.()) return undefined
    return write()
  })

/** 取得の直列化。並行に走らせると間隔制御が壊れる。 */
let drainInFlight: Promise<void> | undefined

/** 実行中のドレインの後ろに1周だけ予約されているか。 */
let drainRerunRequested = false

export interface ReplayImportDeps {
  db: PokerChaseDB
  /** 実験フラグ。既定OFF。 */
  isEnabled: () => Promise<boolean>
  now: () => number
  /** インポート/再構築/エクスポート等の長時間操作の最中かどうか。 */
  isBusy?: () => boolean
  /** 取得の実行体。既定はページ側ブリッジ（テストで差し替える）。 */
  fetchDetails?: (handIds: number[], port?: chrome.runtime.Port) => Promise<ReplayFetchItemResult[]>
  /** Service Workerを起こしておく仕組み（テストで差し替える）。 */
  startKeepAlive?: () => Promise<() => void>
  /** 逐次取得の間隔（ms）。既定は `REPLAY_FETCH_INTERVAL_MS`。テストで0にする。 */
  intervalMs?: number
  /** 現在のヒーローのUserId。積んだアカウントとの一致判定に使う。 */
  getPlayerId?: () => number | undefined
  /** ACTIVEポートがセッション外か（テストで差し替える）。 */
  isFetchAllowed?: () => boolean
  /** 取り込みキューの決着待ち（テストで差し替える）。 */
  waitForIngestion?: () => Promise<void>
  /** そのアカウントのハンドを依頼してよいポートの解決（テストで差し替える）。 */
  resolvePort?: (playerId: number | undefined) => chrome.runtime.Port | undefined
}

const readQueue = async (db: PokerChaseDB): Promise<ReplayQueueEntry[]> => {
  const record = await db.meta.get(REPLAY_IMPORT_QUEUE_META_ID)
  const pending = (record?.value as { pending?: unknown } | undefined)?.pending
  if (!Array.isArray(pending)) return []
  return pending.filter((entry): entry is ReplayQueueEntry =>
    typeof entry === 'object' && entry !== null &&
    isPositiveHandId((entry as ReplayQueueEntry).handId) &&
    typeof (entry as ReplayQueueEntry).enqueuedAt === 'number')
}

const writeQueue = async (
  db: PokerChaseDB,
  pending: ReplayQueueEntry[],
  now: number
): Promise<void> => {
  if (pending.length === 0) {
    await db.meta.delete(REPLAY_IMPORT_QUEUE_META_ID)
    return
  }
  await db.meta.put({
    id: REPLAY_IMPORT_QUEUE_META_ID,
    value: { pending },
    updatedAt: now
  })
}

/** キューを直列化して書き換える。 */
const updateQueue = (
  db: PokerChaseDB,
  now: number,
  update: (current: ReplayQueueEntry[]) => ReplayQueueEntry[]
): Promise<void> => {
  const next = queueMutation.then(async () => {
    await writeQueue(db, update(await readQueue(db)), now)
  })
  queueMutation = next.catch(() => undefined)
  return next
}

export const readReplayImportQueue = (db: PokerChaseDB): Promise<ReplayQueueEntry[]> =>
  readQueue(db)

export const readReplayImportStatus = async (
  db: PokerChaseDB
): Promise<ReplayImportStatus> => {
  const record = await db.meta.get(REPLAY_IMPORT_STATUS_META_ID)
  const value = record?.value as Partial<ReplayImportStatus> | undefined
  return { ...EMPTY_STATUS, ...value }
}

const updateStatus = async (
  db: PokerChaseDB,
  now: number,
  patch: (current: ReplayImportStatus) => ReplayImportStatus
): Promise<void> => {
  const next = patch(await readReplayImportStatus(db))
  await db.meta.put({ id: REPLAY_IMPORT_STATUS_META_ID, value: next, updatedAt: now })
}

/**
 * 自分が参加したハンドの HandId をキューへ積む（**取得はしない**）。
 *
 * 呼び出し元は `event-ingestion.ts` の `EVT_HAND_RESULTS`。ヒーローが配札を
 * 受けたかどうかは生イベントの `Player` の有無で決まる（観戦モードでは
 * undefined。docs/api-events.md「EVT_DEAL: Player フィールドの欠落」と
 * 同じ規約が結果イベントにもある）。Zod検証の成否には依存させない ――
 * Raw Event Lake と同じで、検証はパイプライン投入の可否だけを決める。
 */
export const enqueueReplayHandId = async (
  deps: ReplayImportDeps,
  handId: unknown,
  now: number
): Promise<boolean> => {
  if (!isPositiveHandId(handId)) return false
  const playerId = deps.getPlayerId?.()
  // **フラグの読み取りごと共有tailへ載せる**（MUST）。読み取りは非同期なので、
  // これを待ってから `queueMutation` に繋ぐと、直後に来た309のdrainが
  // 「決着済みの古いtail」を待って空のキューを読み、その後でHandIdだけが
  // 書き込まれる。終了トリガーは消費済みなので、そのハンドは次の対局まで
  // 取得されない。
  const mutation = queueMutation.then(async () => {
    if (!await deps.isEnabled()) return false
    await writeQueue(deps.db, appendToQueue(await readQueue(deps.db), handId, now, playerId), now)
    return true
  })
  queueMutation = mutation.then(() => undefined, () => undefined)
  return mutation
}

/** キューへの追加（重複排除と上限の適用）。 */
const appendToQueue = (
  current: ReplayQueueEntry[],
  handId: number,
  now: number,
  playerId: number | undefined
): ReplayQueueEntry[] => {
  if (current.some(entry => entry.handId === handId)) return current
  const appended = [
    ...current,
    { handId, enqueuedAt: now, ...playerId !== undefined ? { playerId } : {} }
  ]
  // 溢れたら古い方から落とす（暦日の窓から先に失効するのも古い方）。
  return appended.length > REPLAY_IMPORT_QUEUE_LIMIT
    ? appended.slice(appended.length - REPLAY_IMPORT_QUEUE_LIMIT)
    : appended
}

/**
 * **この不変条件の唯一の判定点**（MUST）。セッションが有効でないと確定して
 * いる場合にだけ取得を許す。`unknown`（Service Worker再起動直後）は不可。
 */
const canFetchNow = (deps: ReplayImportDeps): boolean => {
  // 唯一のACTIVEポートだけを判定する（MUST）。unknownとtoken未生成は対局中
  // 扱いにし、実際の送信先もACTIVE accountへ限定する。
  return (deps.isFetchAllowed ?? isActivePortOutsideSession)()
}

export type ReplayDrainReason =
  | 'session-end'
  | 'entry-cancelled'
  | 'port-connect'
  | 'auth-ready'
  | 'operation-idle'
  | 'direct'

/** 合成イベント1件を Lake と `replayDetails` へ入れる。 */
const storeReplayDetail = async (
  db: PokerChaseDB,
  handId: number,
  detail: unknown,
  now: number
): Promise<boolean> => {
  // **保存の直前にもサニタイズする**（MUST）。`REPLAY_BRIDGE_RESULT` は
  // 同一オリジンのページから偽装でき、進行中の `requestId` もページから
  // 観測できる。ページ側ブリッジの `sanitizeReplayDetail` だけに頼ると、
  // 偽の成功応答にネストされた `session` / `requestKey` がそのまま Lake と
  // 索引へ永続化され、エクスポートとクラウド同期にも流れる。
  const record = sanitizeReplayDetail(detail) as
    { param?: unknown, appVer?: unknown, dataVer?: unknown, masterVer?: unknown } | null
  const param = record && typeof record === 'object' ? record.param : undefined
  if (typeof param !== 'object' || param === null || Array.isArray(param)) return false

  // 先勝ち。payloadはサーバ側で不変なので、既に在るなら取り直す意味が無い。
  if (await db.replayDetails.get(handId)) return false

  const clientMeta = {
    ...typeof record?.appVer === 'string' ? { appVer: record.appVer } : {},
    ...typeof record?.dataVer === 'string' ? { dataVer: record.dataVer } : {},
    ...typeof record?.masterVer === 'string' ? { masterVer: record.masterVer } : {}
  }
  const payload = param as Record<string, unknown>

  const syntheticEvent: RawApiEvent = {
    timestamp: now,
    ApiTypeId: ApiType.REPLAY_HAND_DETAIL,
    HandId: handId,
    payload,
    fetchedAt: now,
    ...Object.keys(clientMeta).length > 0 ? { clientMeta } : {}
  }

  // **Lakeの行と索引を1つのトランザクションで確定させる**（MUST）。別々に
  // コミットすると、間でquota超過やSW停止が起きたときにLakeだけが残り、索引と
  // キューは未完了のままになる。次回は索引が無いので同じHandIdを取り直し、
  // 取得時刻の違う別の90001をLakeへ足してしまう ―― 障害時ほど重複が増える。
  // `mergeApiEvents` は自身のトランザクションを開くが、Dexieは同じテーブルを
  // 含む外側のトランザクションがあればそこに参加する。
  await db.transaction('rw', db.apiEvents, db.meta, db.replayDetails, async () => {
    await mergeApiEvents(db, [syntheticEvent])
    await db.replayDetails.put({
      handId,
      payload,
      fetchedAt: now,
      ...Object.keys(clientMeta).length > 0 ? { clientMeta } : {}
    })
  })
  return true
}

/**
 * 取り込んだ生行のうち 90001 の `payload` から資格情報を落とす（その場で書き換える）。
 *
 * NDJSONインポートは数値キーを持つ行を検証前にそのままLakeへ保存するので、
 * インポートファイルに `payload.session` やネストした `requestKey` が残って
 * いると、Lake・エクスポート・Firestore同期へそのまま流れてしまう。
 * ライブ取得の境界（ページ側の `sanitizeReplayDetail`）だけでは塞げない経路。
 */
export const sanitizeReplayDetailEvents = (events: Array<Record<string, unknown>>): void => {
  for (const event of events) {
    if (event.ApiTypeId !== ApiType.REPLAY_HAND_DETAIL) continue
    if (typeof event.payload === 'object' && event.payload !== null) {
      event.payload = sanitizeReplayDetail(event.payload)
    }
    if (typeof event.clientMeta === 'object' && event.clientMeta !== null) {
      event.clientMeta = sanitizeReplayDetail(event.clientMeta)
    }
    delete event.session
    delete event.requestKey
  }
}

/**
 * Lake上の合成イベント（90001）を `replayDetails` へ射影する。
 *
 * NDJSONインポートや再構築で Lake に 90001 が入ったとき、索引側を追従させる
 * ための入口。Lakeは生ログなので同じHandIdの行を複数持ちうるが、この射影は
 * **先勝ち**で1件に畳む。
 */
export const projectReplayDetailEvents = async (
  db: PokerChaseDB,
  events: Array<Record<string, unknown>>
): Promise<number> => {
  const byHandId = new Map<number, { payload: Record<string, unknown>, fetchedAt: number, clientMeta?: Record<string, unknown> }>()
  for (const event of events) {
    if (event.ApiTypeId !== ApiType.REPLAY_HAND_DETAIL) continue
    const handId = event.HandId
    const payload = event.payload
    if (!isPositiveHandId(handId)) continue
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) continue
    if (byHandId.has(handId)) continue
    byHandId.set(handId, {
      // インポート由来の行には資格情報が残っていることがある（NDJSONは検証前に
      // そのままLakeへ入る）。索引へ写す前にも落とす（MUST NOT: 資格情報の永続化）。
      payload: sanitizeReplayDetail(payload) as Record<string, unknown>,
      fetchedAt: typeof event.fetchedAt === 'number' ? event.fetchedAt : (event.timestamp as number ?? 0),
      ...typeof event.clientMeta === 'object' && event.clientMeta !== null
        ? { clientMeta: event.clientMeta as Record<string, unknown> }
        : {}
    })
  }
  if (byHandId.size === 0) return 0

  const handIds = [...byHandId.keys()]
  const existing = await db.replayDetails.bulkGet(handIds)
  const inserts = handIds
    .map((handId, index) => ({ handId, existing: existing[index] }))
    .filter(({ existing: found }) => !found)
    .map(({ handId }) => ({ handId, ...byHandId.get(handId)! }))
  if (inserts.length === 0) return 0
  await db.replayDetails.bulkPut(inserts)
  return inserts.length
}

/**
 * キューを流す。セッション終了トリガーから呼ぶ。
 *
 * 取得の間隔（1.5秒）と逐次性はページ側（`replay_bridge.ts`）が持つので、
 * ここは1バッチを渡して待つだけ。取得できなかったものは**理由で振り分ける**:
 *
 * - 2301（閲覧期限切れ）/ 2302（データ無し）: 再試行しない。数えて落とす
 * - 認証エンベロープ不在などの再試行可能: キューへ残し、次の機会に回す
 */
export const drainReplayImportQueue = async (
  deps: ReplayImportDeps,
  reason: ReplayDrainReason = 'direct'
): Promise<void> => {
  logReplayDiagnostic('drain-trigger', { reason })
  // 実行中のドレインに**相乗りさせない**（MUST）。相乗りさせると、既に
  // 中断へ向かっているドレインをそのまま返すだけになり、その契機
  // （操作の終了・ポート接続・セッション終了）が消費されて再開しない。
  // 代わりに「もう1周だけ」を予約する。予約は多重化しない ―― 何周も
  // 積む必要は無く、最後の1周が最新のキューを見る。
  if (drainInFlight) {
    if (!drainRerunRequested) {
      drainRerunRequested = true
      drainInFlight = drainInFlight
        .catch(() => undefined)
        .then(() => {
          drainRerunRequested = false
          return withKeepAlive(deps, reason)
        })
        .finally(() => { drainInFlight = undefined })
    }
    return drainInFlight
  }
  const run = withKeepAlive(deps, reason)
    .finally(() => { drainInFlight = undefined })
  drainInFlight = run
  return run
}

/**
 * 取得の間、Service Workerを起こしておく。
 *
 * 取得の起点はセッション終了（309）で、そこは**keepaliveが解除される瞬間**
 * でもある（`event-ingestion.ts` のセッション状態追跡）。1件1.5秒間隔で
 * 逐次取得するので、100件なら数分かかり、素のままではMV3の30秒アイドルで
 * 途中でworkerが落ちる。落ちても結果が失われるだけでキューは残る（次の
 * セッション終了で再開する）が、毎回そうなると取得が一向に進まない。
 *
 * 起こすのは取得の実行中だけで、`isEnabled` が偽・セッション中・キューが
 * 空の場合は `drainOnce` が即座に返るので実質的な影響は無い。
 */
const withKeepAlive = async (
  deps: ReplayImportDeps,
  reason: ReplayDrainReason
): Promise<void> => {
  // フラグOFFのユーザーでは keepalive すら起こさない。
  if (!await deps.isEnabled()) return
  // セッション開始イベントがRaw Lakeの書き込み待ちでも、古いinactiveを読んで
  // keepaliveやHTTPを始めないよう、実処理の前に取り込みtailを待つ（MUST）。
  await (deps.waitForIngestion ?? awaitIngestionDrain)().catch(() => undefined)
  if (!canFetchNow(deps)) {
    logReplayDiagnostic('drain-blocked', { reason, gate: 'session-unknown-or-active' })
    return
  }
  if (deps.isBusy?.()) {
    logReplayDiagnostic('drain-blocked', { reason, gate: 'operation-busy' })
    return
  }
  const stop = deps.startKeepAlive
    ? await deps.startKeepAlive()
    : await startKeepAlive()
  try {
    await drainOnce(deps, reason)
  } finally {
    stop()
  }
}

const drainOnce = async (
  deps: ReplayImportDeps,
  reason: ReplayDrainReason
): Promise<void> => {
  if (!await deps.isEnabled()) return
  // `isEnabled`のawait中にも201/303が処理されうるため、HTTP前に再確認する。
  if (!canFetchNow(deps)) {
    logReplayDiagnostic('drain-blocked', { reason, gate: 'session-unknown-or-active' })
    return
  }
  if (deps.isBusy?.()) {
    logReplayDiagnostic('drain-blocked', { reason, gate: 'operation-busy' })
    return
  }

  // 積む側（`EVT_HAND_RESULTS`）の書き込みは取り込みキューから切り離された
  // fire-and-forget なので、同じイベント列の直後に来る309でここへ入ると、
  // まだ書かれていないHandIdを読み落とす。**キューの書き込みが決着してから
  // 読む**（MUST）―― 読み落とすと、そのハンドは次のセッション終了まで、
  // 遊ばなければ暦日の窓を過ぎるまで取得されない。
  await queueMutation.catch(() => undefined)

  const now = deps.now()
  const queued = await readQueue(deps.db)
  logReplayDiagnostic('drain-ready', { reason, pendingHands: queued.length })
  if (queued.length === 0) return

  /**
   * 決着した HandId。キューから外すのはここに入ったものだけで、それ以外は
   * すべて持ち越す。「残す集合」ではなく「外す集合」を作るのは、取得の最中に
   * 積まれた新しい HandId を巻き添えで消さないため（キューの書き換えは
   * 実行後の最新の内容に対して差分で当てる）。
   */
  const settled = new Set<number>()

  // 暦日の窓を過ぎたものは、リクエストする前に落とす。撃っても2301が返る
  // だけで、1本無駄にするため。
  const alive: ReplayQueueEntry[] = []
  for (const entry of queued) {
    if (isWithinReplayWindow(entry.enqueuedAt, now)) alive.push(entry)
    else settled.add(entry.handId)
  }
  const droppedBeforeRequest = settled.size
  if (droppedBeforeRequest > 0) {
    console.info(`[replay-import] 暦日の窓を過ぎた${droppedBeforeRequest}件を取得せず破棄しました`)
  }

  // 既に取得済みのHandIdは撃たない（先勝ち）。
  const stored = await deps.db.replayDetails.bulkGet(alive.map(entry => entry.handId))
  const targets: ReplayQueueEntry[] = []
  alive.forEach((entry, index) => {
    if (stored[index]) {
      settled.add(entry.handId)
      return
    }
    // アカウントの一致は**依頼の直前にACTIVE token単位で**確かめる（下記）。
    targets.push(entry)
  })

  let storedCount = 0
  let expired = 0
  let notFound = 0
  let lastError: string | undefined
  let aborted = false

  /**
   * **1件ずつ**依頼する（バッチでまとめて渡さない）。
   *
   * 100件を1バッチで渡すと、ページ側が1.5秒間隔で撃ち切るまで数分かかり、
   * その間に次の対局が始まっても残りが撃たれ続ける ―― 本機能の中心的な
   * 不変条件（セッション中は1本も撃たない）を破る。1件ずつなら、**次の1本の
   * 直前に**セッション状態・実験フラグ・長時間操作の有無を再確認できる。
   *
   * 間隔（1.5秒）もこちら側で空ける。ページ側の間隔はバッチ内でしか効かない
   * ため、1件ずつ渡すと間隔が消えてしまう。
   */
  // 間隔は**実際に撃った後**にだけ空ける。撃たずに飛ばすエントリ（依頼先の
  // タブが無い等）でも待つと、先頭に未接続アカウントの999件が並んでいるだけで
  // 最後の1件まで25分待たされ、その間に次の対局が始まって中断される。
  let issuedAny = false
  for (const entry of targets) {
    // 直前の判定と同じ3つを、**毎回**確認する（MUST）。フラグの読み取りは
    // 非同期（`chrome.storage.sync.get`）なので、**その待機の後にもう一度**
    // セッション状態を見る ―― 待っている間に次の対局の201/303/308が
    // 取り込みキューで処理されていても、待機前に評価した古い `inactive` の
    // ままリクエストへ進んでしまう。
    if (!canFetchNow(deps) || deps.isBusy?.() || !await deps.isEnabled() || !canFetchNow(deps)) {
      aborted = true
      break
    }
    // accountが今のACTIVEポートと合わないentryでは間隔待ちもしない。未接続
    // accountが先頭に大量に在っても、取得可能なentryを遅らせないため。
    let port = (deps.resolvePort ?? findActivePortForPlayer)(entry.playerId)
    if (!port) continue

    // 先頭は待たない。1件だけの取得は即座に走る。
    if (issuedAny) {
      await delay(deps.intervalMs ?? REPLAY_FETCH_INTERVAL_MS)
      // 待っている間に状況が変わることがある。待機の後にも確認する（MUST）。
      if (!canFetchNow(deps) || deps.isBusy?.() || !await deps.isEnabled() || !canFetchNow(deps)) {
        aborted = true
        break
      }
      // 待機中のhandoverを反映し、旧ACTIVEポートへは送らない（MUST NOT）。
      port = (deps.resolvePort ?? findActivePortForPlayer)(entry.playerId)
      if (!port) continue
    }

    issuedAny = true
    const [result] = await (deps.fetchDetails ?? defaultFetchDetails)([entry.handId], port)
    // 201/303/308はbackgroundからページのAbortControllerへも中断を伝えるが、
    // 応答とイベント処理が同時に完了しても保存境界で必ず止める（MUST）。
    if (!canFetchNow(deps) || !await deps.isEnabled() || !canFetchNow(deps)) {
      aborted = true
      break
    }
    // 応答待ちの間に全データ削除やインポートが操作スロットを取ることがある。
    // `deleteAllData()` はこの取得を待たずDBを消すので、遅れて返った応答を
    // 素通しで保存すると、消えたDBを開き直して書きに行く。**保存の直前にも
    // 確認する**（MUST）。
    if (deps.isBusy?.()) {
      aborted = true
      break
    }
    // 応答が返らなかった（ポート切断・期限切れなど）ものは持ち越す。
    if (!result || result.handId !== entry.handId) continue
    if (result.ok) {
      const wrote = await guardedWrite(deps, () =>
        storeReplayDetail(deps.db, entry.handId, result.detail, deps.now()))
      if (wrote === undefined) {
        // 書き込みの直前に長時間操作が始まった。保存も決着もせず持ち越す。
        aborted = true
        break
      }
      if (wrote) storedCount += 1
      settled.add(entry.handId)
      continue
    }
    lastError = result.error
    const status = parseReplayErrorStatus(result.error)
    if (status === REPLAY_STATUS_EXPIRED) {
      // 閲覧期限切れ。データはサーバに在るが暦日の窓から外れた。再取得の
      // 見込みが無いので、数えて落とす。
      expired += 1
      settled.add(entry.handId)
      continue
    }
    if (status === REPLAY_STATUS_NOT_FOUND) {
      // データ無し（参加していないハンド等）。同上。
      notFound += 1
      settled.add(entry.handId)
      continue
    }
    // 再試行不能な未知のエラーも落とす。同じエンベロープで撃ち直しても
    // 状況が変わる根拠が無く、残すとキューが永久に詰まる。
    if (!result.retryable) settled.add(entry.handId)
  }

  // **長時間操作で中断したときは `meta` にも書かない**（MUST）。`break` が
  // 抜けるのは `for` だけなので、そのまま進むと削除の最中に `updateQueue()` /
  // `updateStatus()` が書き込みへ行く。`deleteAllData()` はこのドレインを
  // 待たないため、`db.delete()` と競合してDexieがDBを作り直しうる。
  // 中断時に落とすのは「この周回で分かったこと」だけで、キューの内容は
  // 触っていないので次の機会にそのまま再開できる。
  if (aborted && deps.isBusy?.()) {
    console.info('[replay-import] 長時間操作の開始により中断しました（キューはそのまま）')
    return
  }

  const deferred = queued.filter(entry => !settled.has(entry.handId)).length
  await guardedWrite(deps, () => updateQueue(deps.db, deps.now(), current =>
    current.filter(entry => !settled.has(entry.handId))
  ))
  await guardedWrite(deps, () => updateStatus(deps.db, deps.now(), current => ({
    ...current,
    lastRunAt: deps.now(),
    stored: current.stored + storedCount,
    expired: current.expired + expired,
    notFound: current.notFound + notFound,
    droppedBeforeRequest: current.droppedBeforeRequest + droppedBeforeRequest,
    deferred,
    ...lastError ? { lastError } : {}
  })))

  if (storedCount > 0 || expired > 0 || notFound > 0 || aborted) {
    console.info(
      `[replay-import] 保存${storedCount}件 / 期限切れ${expired}件 / ` +
      `データ無し${notFound}件 / 持ち越し${deferred}件` +
      (aborted ? '（セッション開始・無効化・長時間操作のため中断）' : '')
    )
  }
}

/** 逐次取得の間隔。ページ側の間隔はバッチ内でしか効かないので、こちらで空ける。 */
const delay = (ms: number): Promise<void> =>
  new Promise(resolve => { setTimeout(resolve, ms) })

const defaultFetchDetails = async (
  handIds: number[],
  port?: chrome.runtime.Port
): Promise<ReplayFetchItemResult[]> => {
  const outcome = await requestReplayDetails(handIds, port)
  return outcome.success ? outcome.results : []
}

export const REPLAY_DETAILS_BACKFILL_META_ID = 'replayDetailsBackfilled'

/**
 * Lakeに既に在る 90001 を `replayDetails` へ一度だけ流し込む。
 *
 * v7 より前の版でも、別端末が同期した 90001 は Raw Event Lake の方針どおり
 * `apiEvents` に保存されている。v7 へ上げても、バージョン移行が作るのは空の
 * ストアだけなので、手動同期か再構築をするまで索引が空のままになる。
 *
 * 移行（`version().upgrade()`）の中ではやらない ―― Dexieのアップグレード
 * トランザクションは壊れやすく、失敗するとDBが開かなくなる。起動時に
 * `meta` の目印を見て一度だけ走る掃き出しなら、失敗しても次回に再試行できる。
 *
 * 走査は `[ApiTypeId+timestamp]` インデックスで 90001 だけに絞るので、
 * Lakeの大きさに関わらず読むのは対象行だけ。健全なら0行。
 */
export const backfillReplayDetailsFromLake = async (db: PokerChaseDB): Promise<number> => {
  try {
    if (await db.meta.get(REPLAY_DETAILS_BACKFILL_META_ID)) return 0
    const rows = await db.apiEvents
      .where('[ApiTypeId+timestamp]')
      .between(
        [ApiType.REPLAY_HAND_DETAIL, Number.MIN_SAFE_INTEGER],
        [ApiType.REPLAY_HAND_DETAIL, Number.MAX_SAFE_INTEGER],
        true,
        true
      )
      .toArray() as unknown as Array<Record<string, unknown>>
    const projected = await projectReplayDetailEvents(db, rows)
    await db.meta.put({
      id: REPLAY_DETAILS_BACKFILL_META_ID,
      value: { at: Date.now(), scanned: rows.length, projected },
      updatedAt: Date.now()
    })
    if (projected > 0) {
      console.info(`[replay-import] Lakeの既存90001から${projected}件を索引へ流し込みました`)
    }
    return projected
  } catch (error) {
    // 目印を残さないので次回起動で再試行する。
    console.warn('[replay-import] 既存90001の索引化に失敗しました:', error)
    return 0
  }
}

/** 実験フラグの読み取り。既定OFF（読めないときもOFF）。 */
export const readReplayImportEnabled = async (): Promise<boolean> => {
  try {
    const stored = await chrome.storage.sync.get(EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY)
    return stored[EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY] === true
  } catch {
    return false
  }
}

/** テスト用。モジュールスコープの直列化状態を初期化する。 */
export const __resetReplayImportForTests = (): void => {
  queueMutation = Promise.resolve()
  drainInFlight = undefined
  drainRerunRequested = false
}
