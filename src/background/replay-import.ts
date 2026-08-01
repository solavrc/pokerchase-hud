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
 * セッション状態は `update-manager.ts` の三値（unknown/active/inactive）を使い、
 * **`unknown` は取得不可**として扱う ―― Service Worker はいつでも落ちうるので、
 * 再起動直後は「セッション中かどうか分からない」が正しい状態であり、そこで
 * 撃つと不変条件を破りうる。分からない間は積んだまま待ち、次のセッション終了で
 * 取得する。
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
import { getSessionActivity } from './update-manager'

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

/** 取得の直列化。並行に走らせると間隔制御が壊れる。 */
let drainInFlight: Promise<void> | undefined

export interface ReplayImportDeps {
  db: PokerChaseDB
  /** 実験フラグ。既定OFF。 */
  isEnabled: () => Promise<boolean>
  now: () => number
  /** インポート/再構築/エクスポート等の長時間操作の最中かどうか。 */
  isBusy?: () => boolean
  /** 取得の実行体。既定はページ側ブリッジ（テストで差し替える）。 */
  fetchDetails?: (handIds: number[]) => Promise<ReplayFetchItemResult[]>
  /** Service Workerを起こしておく仕組み（テストで差し替える）。 */
  startKeepAlive?: () => Promise<() => void>
  /** 逐次取得の間隔（ms）。既定は `REPLAY_FETCH_INTERVAL_MS`。テストで0にする。 */
  intervalMs?: number
  /** 現在のヒーローのUserId。積んだアカウントとの一致判定に使う。 */
  getPlayerId?: () => number | undefined
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
  if (!await deps.isEnabled()) return false
  const playerId = deps.getPlayerId?.()
  await updateQueue(deps.db, now, current => {
    if (current.some(entry => entry.handId === handId)) return current
    const appended = [
      ...current,
      { handId, enqueuedAt: now, ...playerId !== undefined ? { playerId } : {} }
    ]
    // 溢れたら古い方から落とす（暦日の窓から先に失効するのも古い方）。
    return appended.length > REPLAY_IMPORT_QUEUE_LIMIT
      ? appended.slice(appended.length - REPLAY_IMPORT_QUEUE_LIMIT)
      : appended
  })
  return true
}

/**
 * **この不変条件の唯一の判定点**（MUST）。セッションが有効でないと確定して
 * いる場合にだけ取得を許す。`unknown`（Service Worker再起動直後）は不可。
 */
const canFetchNow = (): boolean => getSessionActivity() === 'inactive'

/** 合成イベント1件を Lake と `replayDetails` へ入れる。 */
const storeReplayDetail = async (
  db: PokerChaseDB,
  handId: number,
  detail: unknown,
  now: number
): Promise<boolean> => {
  const record = detail as { param?: unknown, appVer?: unknown, dataVer?: unknown, masterVer?: unknown } | null
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
export const drainReplayImportQueue = async (deps: ReplayImportDeps): Promise<void> => {
  if (drainInFlight) return drainInFlight
  const run = withKeepAlive(deps, () => drainOnce(deps))
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
  run: () => Promise<void>
): Promise<void> => {
  // フラグOFFのユーザーでは keepalive すら起こさない。
  if (!await deps.isEnabled()) return
  const stop = deps.startKeepAlive
    ? await deps.startKeepAlive()
    : await startKeepAlive()
  try {
    await run()
  } finally {
    stop()
  }
}

const drainOnce = async (deps: ReplayImportDeps): Promise<void> => {
  if (!await deps.isEnabled()) return
  // 不変条件の判定点。ここを通らない限り1本も飛ばない。
  if (!canFetchNow()) return
  if (deps.isBusy?.()) return

  // 積む側（`EVT_HAND_RESULTS`）の書き込みは取り込みキューから切り離された
  // fire-and-forget なので、同じイベント列の直後に来る309でここへ入ると、
  // まだ書かれていないHandIdを読み落とす。**キューの書き込みが決着してから
  // 読む**（MUST）―― 読み落とすと、そのハンドは次のセッション終了まで、
  // 遊ばなければ暦日の窓を過ぎるまで取得されない。
  await queueMutation.catch(() => undefined)

  const now = deps.now()
  const queued = await readQueue(deps.db)
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
  const currentPlayerId = deps.getPlayerId?.()
  const targets: ReplayQueueEntry[] = []
  alive.forEach((entry, index) => {
    if (stored[index]) {
      settled.add(entry.handId)
      return
    }
    // 積んだアカウントと今のアカウントが違うなら撃たない。撃つと `2302` が
    // 返り、再試行不能として永久に捨ててしまう（元のアカウントへ戻れば
    // 取得できるので、持ち越すのが正しい）。
    if (entry.playerId !== undefined && currentPlayerId !== undefined &&
      entry.playerId !== currentPlayerId) return
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
  for (const [index, entry] of targets.entries()) {
    // 直前の判定と同じ3つを、**毎回**確認する（MUST）。
    if (!canFetchNow() || deps.isBusy?.() || !await deps.isEnabled()) {
      aborted = true
      break
    }
    // 先頭は待たない。1件だけの取得は即座に走る。
    if (index > 0) {
      await delay(deps.intervalMs ?? REPLAY_FETCH_INTERVAL_MS)
      // 待っている間に状況が変わることがある。待機の後にも確認する（MUST）。
      if (!canFetchNow() || deps.isBusy?.() || !await deps.isEnabled()) {
        aborted = true
        break
      }
    }

    const [result] = await (deps.fetchDetails ?? defaultFetchDetails)([entry.handId])
    // 応答が返らなかった（ポート切断・期限切れなど）ものは持ち越す。
    if (!result || result.handId !== entry.handId) continue
    if (result.ok) {
      if (await storeReplayDetail(deps.db, entry.handId, result.detail, deps.now())) storedCount += 1
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

  const deferred = queued.filter(entry => !settled.has(entry.handId)).length
  await updateQueue(deps.db, deps.now(), current =>
    current.filter(entry => !settled.has(entry.handId))
  )
  await updateStatus(deps.db, deps.now(), current => ({
    ...current,
    lastRunAt: deps.now(),
    stored: current.stored + storedCount,
    expired: current.expired + expired,
    notFound: current.notFound + notFound,
    droppedBeforeRequest: current.droppedBeforeRequest + droppedBeforeRequest,
    deferred,
    ...lastError ? { lastError } : {}
  }))

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

const defaultFetchDetails = async (handIds: number[]): Promise<ReplayFetchItemResult[]> => {
  const outcome = await requestReplayDetails(handIds)
  return outcome.success ? outcome.results : []
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
}
