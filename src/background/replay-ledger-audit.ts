/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
/**
 * 受動取得した台帳（`/replay/list`）とローカルの`hands`の突き合わせ。
 *
 * この層は**リクエストを1本も出さない**。ユーザーがゲーム内でリプレイ画面を
 * 開いたときにゲーム自身が出した通信を、ページ側フックが読んで渡してくる
 * だけなので、拡張が発生させる通信は増えない。
 *
 * 台帳はサーバ自身が持つ「ヒーローが打ったハンド」の記録なので、
 * WebSocketキャプチャに対する**独立した観測チャネル**になる（AGENTS.mdの
 * Incident Diagnosis Practicesが求める「別の観測チャネルによる反証」）。
 * 分かるのは2つ:
 *
 * 1. **キャプチャ欠損** — 台帳にあってローカルに無いHandIdは、サーバが送った
 *    のにクライアントが取り逃したハンド。docs/api-events.mdに「原因未特定」
 *    として残っている欠損が、サーバー省略なのか取りこぼしなのかを決着させる
 * 2. **チップ会計の検証** — `ChipDiff`はヒーローのそのハンドの純増減。
 *    ローカルの`playerChipAccounting[hero].netChips`と一致するはず
 *
 * 結果は`meta`テーブルへ書く。専用ストアを作らないのは、この監査が
 * 診断用の最新スナップショットで足り、Dexieのバージョンを消費する理由が
 * 無いため（既存の`meta`は`id`主キーの汎用テーブル）。
 *
 * 台帳は「当日−3日 00:00 JST以降・カテゴリごと最新100件」しか含まないので
 * （docs/replay-api.md）、これは遡及監査ではなく**前向きの監視**である。
 * 過去に記録済みの欠損を後から検証することはできない。
 */
import Dexie from 'dexie'
import type { PokerChaseDB } from '../db/poker-chase-db'
import { ApiType } from '../types/api'
import {
  REPLAY_LEDGER_MAX_ENTRIES,
  REPLAY_PORT_LEDGER,
  isPositiveHandId,
  type ReplayLedger,
  type ReplayLedgerMessage
} from '../replay/protocol'

export const REPLAY_LEDGER_AUDIT_META_ID = 'replayLedgerAudit'

export interface ReplayLedgerChipDiffMismatch {
  handId: number
  /** サーバの台帳が言う純増減。 */
  ledgerChipDiff: number
  /** ローカルの`playerChipAccounting`が言う純増減。 */
  localNetChips: number
}

export interface ReplayLedgerAuditResult {
  checkedAt: number
  battleType: number
  /** 手札公開パスの期限（Unix秒）。`0`は未購入。 */
  cardOpenEndDate: number
  isExpiredCardOpen: boolean
  /** 台帳に載っていたハンド数。 */
  listedHands: number
  /**
   * 台帳にあり、`hands`にも`apiEvents`にも無いHandId。
   * **これだけが本物のキャプチャ欠損**（サーバは送ったがクライアントに
   * 届いていない、または保存に失敗した）。
   */
  notCapturedHandIds: number[]
  /**
   * `apiEvents`にはあるが`hands`が無いHandId。イベントは受信・保存できて
   * いて、派生側で落ちたもの。既知の正常系を含む:
   * キメラハンドの意図的な棄却（`write-entity-stream.ts`のRejected chimera
   * hand）、現行スキーマで検証に通らないpayload、そして**直前のハンドの
   * 派生がまだ書き終わっていない場合**（raw書き込みが先、派生が後という
   * 順序のため、この監査は取り込みキューを迂回しても欠損とは誤判定しない）。
   */
  derivationMissingHandIds: number[]
  /** ローカルにあるが会計が未確定で照合できなかったハンド数。 */
  unverifiableHands: number
  /**
   * ローカルが観測を始める前のハンド数。判定対象から外したもの。
   *
   * 新規インストール直後・実験フラグを初めて有効にした直後・全データ削除後に
   * 一覧を開くと、台帳には過去3日分が載る一方でローカルにそれが無いのは
   * **正常**。これを欠損に数えると初回だけで最大100件の偽陽性を永続化する。
   *
   * 観測開始の下限はローカル最古のハンドの時刻を使う。観測期間の**途中**に
   * 空白がある場合（拡張を一時的に切っていた等）は依然として欠損として
   * 報告される ―― そこは本当に区別が付かないため。
   */
  outOfObservationWindowHands: number
  chipDiffMismatches: ReplayLedgerChipDiffMismatch[]
}

/**
 * 台帳の`StartTime`（Unix秒、サーバ時刻）から`apiEvents`（クライアント受信
 * 時刻ms）を引くときの前後余裕。
 *
 * 前方向はサーバ時刻とクライアント時刻のズレ、後方向は「ハンド開始から
 * `EVT_HAND_RESULTS` が届くまで」の最大想定。
 */
const HAND_RESULTS_LOOKUP_LEAD_MS = 5 * 60_000
const HAND_RESULTS_LOOKUP_TAIL_MS = 30 * 60_000

/**
 * 時間範囲で見つからなかったHandIdを、範囲を捨てて全走査で確かめる。
 *
 * `StartTime` はサーバ時刻、`apiEvents.timestamp` はクライアントの `Date.now()`
 * なので、端末時計がずれていたり1ハンドが想定より長引いたりすると、生行が
 * 実在しても上の時間範囲から外れる。**限定的な時間検索の空振りを
 * 「イベントが届かなかった証拠」として扱ってはいけない。**
 *
 * 走査するのは、時間範囲で見つからず「未キャプチャ」と断定しかけた
 * HandIdだけ。健全なら候補は空で、この関数は1行も読まない。
 */
const confirmCapturesByFullScan = async (
  db: PokerChaseDB,
  candidates: number[]
): Promise<Set<number>> => {
  const found = new Set<number>()
  if (candidates.length === 0) return found
  const wanted = new Set(candidates)
  await db.apiEvents
    .where('[ApiTypeId+timestamp]')
    .between(
      [ApiType.EVT_HAND_RESULTS, Dexie.minKey],
      [ApiType.EVT_HAND_RESULTS, Dexie.maxKey],
      true,
      true
    )
    .until(() => wanted.size === 0, true)
    .each(row => {
      const handId = (row as { HandId?: unknown }).HandId
      if (isPositiveHandId(handId) && wanted.delete(handId)) found.add(handId)
    })
  return found
}

/**
 * 台帳の時間範囲に入る`EVT_HAND_RESULTS`のHandIdを、Raw Event Lakeから集める。
 *
 * 生行をそのまま読むがZod検証はしない。ここで見たいのは「そのHandIdの
 * イベントが届いて保存されたか」だけで、値を派生パイプラインへ渡さないため
 * （`EntityConverter`/`HandLogProcessor`へ生行を流してはならない、という
 * 制約の対象外）。
 */
const collectCapturedHandIds = async (
  db: PokerChaseDB,
  startTimesSec: number[]
): Promise<Set<number>> => {
  const captured = new Set<number>()
  if (startTimesSec.length === 0) return captured

  const startsMs = startTimesSec.map(seconds => seconds * 1000)
  const from = Math.min(...startsMs) - HAND_RESULTS_LOOKUP_LEAD_MS
  const to = Math.max(...startsMs) + HAND_RESULTS_LOOKUP_TAIL_MS

  const rows = await db.apiEvents
    .where('[ApiTypeId+timestamp]')
    .between([ApiType.EVT_HAND_RESULTS, from], [ApiType.EVT_HAND_RESULTS, to], true, true)
    .toArray()
  for (const row of rows) {
    const handId = (row as { HandId?: unknown }).HandId
    if (isPositiveHandId(handId)) captured.add(handId)
  }
  return captured
}

/**
 * 台帳とローカルを突き合わせる。
 *
 * `playerChipAccounting`が`null`のハンドは不一致に数えない。`null`は
 * 「会計を確定できなかった」という印であって誤った値ではないので、
 * 取りこぼしとして報告すると本物の不一致が埋もれる。件数だけ別に数える。
 */
export const auditReplayLedger = async (
  db: PokerChaseDB,
  playerId: number | undefined,
  ledger: ReplayLedger,
  now: number
): Promise<ReplayLedgerAuditResult> => {
  const all = ledger.hands.slice(0, REPLAY_LEDGER_MAX_ENTRIES)

  // 観測開始前のハンドは判定しない（新規インストール・再有効化・全データ削除後）
  const oldestLocal = await db.hands.orderBy('approxTimestamp').first()
  const observationFloorMs = oldestLocal?.approxTimestamp
  const entries = observationFloorMs === undefined
    ? []
    : all.filter(entry => entry.startTime * 1000 >= observationFloorMs)
  const outOfObservationWindowHands = all.length - entries.length

  const localHands = await db.hands.bulkGet(entries.map(entry => entry.handId))
  const capturedHandIds = await collectCapturedHandIds(db, entries.map(entry => entry.startTime))

  const notCapturedHandIds: number[] = []
  const derivationMissingHandIds: number[] = []
  const chipDiffMismatches: ReplayLedgerChipDiffMismatch[] = []
  let unverifiableHands = 0

  entries.forEach((entry, index) => {
    const hand = localHands[index]
    if (!hand) {
      // 派生テーブルの不在だけでキャプチャ欠損と断定しない。Raw Event Lake
      // に生行があれば、イベントは届いていて派生側で落ちただけ。
      if (capturedHandIds.has(entry.handId)) derivationMissingHandIds.push(entry.handId)
      else notCapturedHandIds.push(entry.handId)
      return
    }
    if (playerId === undefined) {
      unverifiableHands += 1
      return
    }
    const accounting = hand.playerChipAccounting?.[String(playerId)]
    if (!accounting) {
      unverifiableHands += 1
      return
    }
    if (accounting.netChips !== entry.chipDiff) {
      chipDiffMismatches.push({
        handId: entry.handId,
        ledgerChipDiff: entry.chipDiff,
        localNetChips: accounting.netChips
      })
    }
  })

  // 時間範囲の空振りを欠損と断定しない。クライアント時計のずれで生行が
  // 範囲外に落ちうるので、断定しかけたものだけ全走査で確かめる。
  const lateFound = await confirmCapturesByFullScan(db, notCapturedHandIds)
  if (lateFound.size > 0) {
    for (let i = notCapturedHandIds.length - 1; i >= 0; i--) {
      const handId = notCapturedHandIds[i]!
      if (!lateFound.has(handId)) continue
      notCapturedHandIds.splice(i, 1)
      derivationMissingHandIds.push(handId)
    }
    derivationMissingHandIds.sort((a, b) => a - b)
  }

  const result: ReplayLedgerAuditResult = {
    checkedAt: now,
    battleType: ledger.battleType,
    cardOpenEndDate: ledger.cardOpenEndDate,
    isExpiredCardOpen: ledger.isExpiredCardOpen,
    listedHands: entries.length,
    outOfObservationWindowHands,
    notCapturedHandIds,
    derivationMissingHandIds,
    unverifiableHands,
    chipDiffMismatches
  }

  await db.meta.put({
    id: REPLAY_LEDGER_AUDIT_META_ID,
    value: result,
    updatedAt: now
  })

  if (notCapturedHandIds.length > 0 || derivationMissingHandIds.length > 0 ||
    chipDiffMismatches.length > 0) {
    console.warn(
      `[replay-ledger] BattleType=${ledger.battleType}: ` +
      `台帳${entries.length}件中、未キャプチャ${notCapturedHandIds.length}件 / ` +
      `派生欠落${derivationMissingHandIds.length}件 / ` +
      `チップ不一致${chipDiffMismatches.length}件`,
      { notCapturedHandIds, derivationMissingHandIds, chipDiffMismatches }
    )
  }

  return result
}

/**
 * 監査の実行に必要な依存。値ではなく取得関数で受けるのは、**待ってから読む**
 * 必要があるため（下記 `handleReplayLedgerPortMessage` の説明を参照）。
 */
export interface ReplayLedgerAuditDeps {
  db: PokerChaseDB
  /**
   * 監査を始める前に待つもの。取り込みキューの決着（直前の
   * `EVT_HAND_RESULTS` のDB書き込み）と、Service Worker起動時の状態復元。
   */
  waitUntilConsistent: () => Promise<void>
  getPlayerId: () => number | undefined
  now: () => number
}

/**
 * ポートに届いたメッセージが台帳なら処理して`true`を返す。
 *
 * 取り込みキューには**載せない**。`apiEvents`へ書かないので耐久性バリアの
 * 対象になる副作用が無く、載せるとライブイベントの処理を待たせるだけになる
 * （`event-ingestion.ts`冒頭の直列化の趣旨）。
 *
 * ただし**待つ**必要はある。同じポートから直前に届いた`EVT_HAND_RESULTS`の
 * ハンドラーは書き込みをキューに積むだけなので、待たずに照会すると、
 * 受信済みのハンドを「未キャプチャ」に分類しうる。キューを迂回することと
 * キューの決着を待つことは両立する（読み手側で解決する）。
 *
 * `playerId`も待ってから読む。コールドスタート直後は`restoreState()`が
 * 終わっておらず`undefined`のことがあり、その値で固定するとローカルの全ハンドが
 * 照合不能に落ちてチップ不一致の検出が丸ごと失われる。
 */
export const handleReplayLedgerPortMessage = (
  message: unknown,
  deps: ReplayLedgerAuditDeps
): boolean => {
  if (typeof message !== 'object' || message === null) return false
  if ((message as { type?: unknown }).type !== REPLAY_PORT_LEDGER) return false

  const ledger = message as Partial<ReplayLedgerMessage>
  // 形が違っても`true`（このモジュール宛）を返す。イベント処理へ落として
  // 不正なAPIイベントとして扱われるほうが紛らわしい。
  if (!Array.isArray(ledger.hands)) return true
  if (ledger.hands.length > REPLAY_LEDGER_MAX_ENTRIES) return true

  const snapshot: ReplayLedger = {
    battleType: typeof ledger.battleType === 'number' ? ledger.battleType : -1,
    cardOpenEndDate: typeof ledger.cardOpenEndDate === 'number' ? ledger.cardOpenEndDate : 0,
    isExpiredCardOpen: ledger.isExpiredCardOpen === true,
    hands: ledger.hands
  }
  void (async () => {
    await deps.waitUntilConsistent()
    await auditReplayLedger(deps.db, deps.getPlayerId(), snapshot, deps.now())
  })().catch(error => {
    console.error('[replay-ledger] 台帳の突き合わせに失敗しました:', error)
  })
  return true
}
