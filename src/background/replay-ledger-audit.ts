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
 * **確定できることの範囲を明示する**（AGENTS.mdの「Declare observability」）:
 *
 * 1. 台帳が証明するのは「**このアカウントのハンドとしてサーバに記録がある**」
 *    ことだけで、該当のWebSocketイベントをサーバがこの接続へ送ったかどうかは
 *    観測していない
 * 2. したがって、ローカルに派生エンティティも生イベントも無い場合に確定するのは
 *    「**このクライアントに残っていない**」ことだけ。別デバイス／別セッションでの
 *    プレイ、拡張が動いていなかった、フックの取りこぼし、保存失敗、サーバが
 *    この接続へ送らなかった ―― これらは**区別できない**
 * 3. 一方 `ChipDiff` との突き合わせは因果の推定を含まない直接比較なので、
 *    ローカルの`playerChipAccounting[hero].netChips`が正しいことの外部検証
 *    として成立する
 *
 * 結果は`meta`テーブルへ書く。専用ストアを作らないのは、この監査が
 * 診断用の最新スナップショットで足り、Dexieのバージョンを消費する理由が
 * 無いため（既存の`meta`は`id`主キーの汎用テーブル）。
 *
 * 台帳は「当日−3日 00:00 JST以降・カテゴリごと最新100件」しか含まないので
 * （docs/replay-api.md）、これは遡及監査ではなく**前向きの監視**である。
 * 過去に記録済みの欠損を後から検証することはできない。
 */
import type { PokerChaseDB } from '../db/poker-chase-db'
import { processInChunks } from '../utils/database-utils'
import { ApiType } from '../types/api'
import {
  REPLAY_LEDGER_MAX_ENTRIES,
  REPLAY_PORT_LEDGER,
  isPositiveHandId,
  type ReplayLedger,
  type ReplayLedgerEntry,
  type ReplayLedgerMessage
} from '../replay/protocol'

export const REPLAY_LEDGER_AUDIT_META_ID = 'replayLedgerAudit'

/**
 * 実行待ち・実行中の台帳の控え。
 *
 * この監査は全走査を含みうるので、Service Workerの非アクティブ期限をまたぐ
 * ことがある。ポートのハンドラは既に同期的に返っており、キューと走査の進捗は
 * モジュールスコープにしか無いため、MV3がいずれかのawaitでworkerを終了すると
 * 受け取った台帳ごと消え、次回起動でも再開できない（欠損検出が無通知で
 * 終わる）。台帳そのものを`meta`へ控えて、起動時に再開する。
 *
 * 走査カーソルは控えない。この監査は読み取りと`meta`への上書きだけで副作用が
 * 無く冪等なので、途中経過を持ち越すより最初からやり直すほうが単純で、
 * 「取りこぼさない」という目的には十分足りる。
 */
export const REPLAY_LEDGER_AUDIT_PENDING_META_ID = 'replayLedgerAuditPending'

/**
 * 再開の上限。毎回worker停止で終わる台帳（Lakeが極端に大きい等）を、起動の
 * たびに走らせ続けないため。上限に達したら破棄する ―― 診断なので、次に
 * リプレイ一覧を開けばまた積まれる。
 */
export const REPLAY_LEDGER_AUDIT_MAX_ATTEMPTS = 3

/** 監査の直列化キュー（受信順を保つ）。 */
let auditQueue: Promise<void> = Promise.resolve()

/**
 * 保留リストのread-modify-writeの直列化キュー。受信（キュー投入前）と完了
 * （キューの中）は別々の時点で走るので、リスト操作自体を直列化しないと
 * 片方の書き込みがもう片方を巻き戻す。
 */
let pendingMetaQueue: Promise<void> = Promise.resolve()

export interface PendingReplayLedgerAudit {
  ledger: ReplayLedger
  /** 台帳を受信した時点の`playerId`。再開後もアカウント変更ガードを効かせる。 */
  playerIdAtReceipt?: number
  receivedAt: number
  /** 実行を開始した回数。`REPLAY_LEDGER_AUDIT_MAX_ATTEMPTS`で打ち切る。 */
  attempts: number
}

const isPendingEntry = (value: unknown): value is PendingReplayLedgerAudit => {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const ledger = record.ledger
  if (typeof ledger !== 'object' || ledger === null) return false
  if (!Array.isArray((ledger as { hands?: unknown }).hands)) return false
  return typeof record.receivedAt === 'number' && typeof record.attempts === 'number'
}

const readPendingAudits = async (db: PokerChaseDB): Promise<PendingReplayLedgerAudit[]> => {
  const record = await db.meta.get(REPLAY_LEDGER_AUDIT_PENDING_META_ID)
  const list = (record?.value as { pending?: unknown } | undefined)?.pending
  if (!Array.isArray(list)) return []
  return list.filter(isPendingEntry)
}

/** 保留リストを直列化して書き換える。 */
const updatePendingAudits = (
  db: PokerChaseDB,
  now: number,
  update: (current: PendingReplayLedgerAudit[]) => PendingReplayLedgerAudit[]
): Promise<void> => {
  const next = pendingMetaQueue.then(async () => {
    const current = await readPendingAudits(db)
    const updated = update(current)
    if (updated.length === 0) {
      await db.meta.delete(REPLAY_LEDGER_AUDIT_PENDING_META_ID)
      return
    }
    await db.meta.put({
      id: REPLAY_LEDGER_AUDIT_PENDING_META_ID,
      value: { pending: updated },
      updatedAt: now
    })
  })
  pendingMetaQueue = next.catch(() => undefined)
  return next
}

const isSamePending = (a: PendingReplayLedgerAudit, b: PendingReplayLedgerAudit): boolean =>
  a.receivedAt === b.receivedAt && a.ledger.battleType === b.ledger.battleType

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
  /** サーバが返す期限値（Unix秒）。 */
  cardOpenEndDate: number
  isExpiredCardOpen: boolean
  /** 台帳に載っていたハンド数。 */
  listedHands: number
  /**
   * 台帳にあり、`hands`にも`apiEvents`にも無いHandId。
   *
   * 確定するのは「このクライアントに残っていない」ことだけで、**原因は
   * 特定できない**（別デバイス／別セッションでのプレイ、拡張が動いて
   * いなかった、フックの取りこぼし、保存失敗、サーバがこの接続へ
   * 送らなかった）。ここを「サーバは送ったのに取り逃した」と読むと
   * 原因調査を誤る。
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
/** 全走査のページ幅。都度トランザクションを解放するための単位。 */
const FULL_SCAN_CHUNK_SIZE = 2000

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
): Promise<Map<number, number>> => {
  const found = new Map<number, number>()
  if (candidates.length === 0) return found
  const wanted = new Set(candidates)
  // **1トランザクションで走査しない。** IndexedDBでは同じ`apiEvents`ストアへの
  // 後続readwriteが走査の完了まで待たされるため、大きいLakeでは監査中に届いた
  // ライブイベントのraw保存がその後ろへ滞留し、その間にService Workerが
  // 停止すれば未保存のまま失われる。診断が取り込みの耐久性バリアを塞ぐのは
  // src/background/AGENTS.md が禁じている形。
  //
  // ページごとに独立したクエリを出して都度トランザクションを解放する。
  // カーソルは主キーの3要素を全て保持する（`processInChunks`と同じ理由 ――
  // 一部を落とすと同一ミリ秒の行を飛ばす/重複させる）。候補が全て見つかれば
  // 途中で打ち切る。
  for await (const chunk of processInChunks(db.apiEvents, FULL_SCAN_CHUNK_SIZE)) {
    for (const row of chunk) {
      if (row.ApiTypeId !== ApiType.EVT_HAND_RESULTS) continue
      const handId = (row as { HandId?: unknown }).HandId
      const ts = (row as { timestamp?: unknown }).timestamp
      if (isPositiveHandId(handId) && typeof ts === 'number' && wanted.delete(handId)) {
        found.set(handId, ts)
      }
    }
    if (wanted.size === 0) break
  }
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
): Promise<Map<number, number>> => {
  const captured = new Map<number, number>()
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
    const ts = (row as { timestamp?: unknown }).timestamp
    if (isPositiveHandId(handId) && typeof ts === 'number') captured.set(handId, ts)
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
  now: number,
  isBusy?: () => boolean
): Promise<ReplayLedgerAuditResult> => {
  const all = ledger.hands.slice(0, REPLAY_LEDGER_MAX_ENTRIES)

  // --- 1. まず生イベントの有無を全エントリについて確定させる ---
  //
  // 生行が在ることは「このクライアントが観測した」ことの**直接証拠**なので、
  // 後段の観測窓ヒューリスティックより優先する。順序を逆にすると、派生が
  // 全面停止した状況（スキーマ破損など）で `hands` が1件も一致せず、
  // 補正不能→全件を対象外、という経路に落ちて、**監査が最も叫ぶべき場面で
  // 沈黙する**。
  //
  // 読み取りは**1つのreadonlyトランザクション**に閉じる。個別の照会に分けると、
  // 監査の最中に到着したイベントが照会の合間に保存され、「生行はあるが
  // `hands` がまだ」という途中状態を読んで、正常に処理中のハンドを
  // 派生欠落や不在として保存しうる。同一トランザクションなら一貫した
  // スナップショットになる。
  const snapshot = await db.transaction('r', db.hands, db.apiEvents, async () => ({
    rawByWindow: await collectCapturedHandIds(db, all.map(entry => entry.startTime)),
    localHands: await db.hands.bulkGet(all.map(entry => entry.handId)),
    oldestOwnHand: playerId === undefined
      ? undefined
      : await db.hands.where('seatUserIds').equals(playerId).first()
  }))
  const { rawByWindow, localHands, oldestOwnHand } = snapshot
  // 全走査だけはスナップショットの外。ページごとにトランザクションを解放
  // しないとライブ取り込みを塞ぐ（`confirmCapturesByFullScan`のコメント参照）。
  // 走査中に届いた行が見えるのは構わない ―― 「生行が在る」方向にしか動かず、
  // 欠損の誤報を増やさない。
  const rawByScan = await confirmCapturesByFullScan(
    db,
    all.filter(entry => !rawByWindow.has(entry.handId)).map(entry => entry.handId)
  )
  const rawTimestamps = new Map([...rawByWindow, ...rawByScan])

  // --- 2. 時計差を測る ---
  //
  // `startTime` はサーバ時刻、ローカルの時刻はクライアントの `Date.now()`。
  // 素朴に比べると、端末時計が進んでいれば観測済みのハンドまで対象外になり、
  // 遅れていればインストール前のハンドを欠損候補に入れてしまう。
  // 中央値なのは、1件の外れ値（長考で受信が遅れたハンド等）に引きずられないため。
  const handOffsets: number[] = []
  const rawOffsets: number[] = []
  all.forEach((entry, index) => {
    const startMs = entry.startTime * 1000
    const approx = localHands[index]?.approxTimestamp
    if (approx !== undefined) handOffsets.push(approx - startMs)
    const rawTs = rawTimestamps.get(entry.handId)
    if (rawTs !== undefined) rawOffsets.push(rawTs - startMs)
  })
  const median = (xs: number[]): number | undefined =>
    xs.length === 0 ? undefined : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  // `hands` 由来を優先する。生行は `EVT_HAND_RESULTS`＝ハンド**終了**時刻なので
  // ハンド長のぶん偏るが、派生が全面停止していると `hands` からは測れないため
  // フォールバックとして使う（偏りは分単位で、観測開始の下限判定には十分）。
  const clockOffsetMs = median(handOffsets) ?? median(rawOffsets)

  // 観測開始の下限。**現在のアカウントに限定する**。
  //
  // 同じプロファイルを複数アカウントで使うと、DBには前のアカウントの履歴が
  // 残る。全体の最古ハンドを下限にすると、アカウントを切り替えた直後に
  // 「このアカウントを観測する前のハンド」まで判定対象になり、台帳の全件が
  // 偽のローカル不在として保存される。待機中のplayerId変更チェックは
  // 既存履歴の混在を防げない（切り替えは監査の開始より前に済んでいる）。
  //
  // HandIdは時系列で単調増加するので、multiEntryインデックスの`first()`
  // （＝最小の主キー）がそのアカウントの最古ハンドになる。
  // 派生が全面停止していて`hands`に1件も無い場合のフォールバック。台帳は
  // 定義上このアカウントのハンドなので、その生行の最古を下限に使えば
  // アカウント帰属を崩さない（全体の最古生行を使うと上と同じ混在が起きる）。
  const observationFloorMs = oldestOwnHand?.approxTimestamp
    ?? (rawTimestamps.size > 0 ? Math.min(...rawTimestamps.values()) : undefined)

  // --- 3. 判定対象を決める ---
  //
  // 生行が在るエントリは無条件に対象。観測窓の判定は「痕跡が一切無い」
  // エントリにだけ適用する ―― そこだけが「観測前だったのか、失ったのか」を
  // 区別できない領域だから。
  const inScope = (entry: ReplayLedgerEntry): boolean => {
    if (rawTimestamps.has(entry.handId)) return true
    if (clockOffsetMs !== undefined && observationFloorMs !== undefined) {
      return entry.startTime * 1000 + clockOffsetMs >= observationFloorMs
    }
    // 時計差が測れないのは、台帳のどのハンドも `hands` にも生行にも無いとき。
    // それはまさに「最近の全面的な非到着」であり、監査が最も報告すべき状態
    // なのに、ここで全件を観測窓外にすると0件として隠れてしまう。
    // HandIdは時系列で単調増加する（このファイルが `oldestOwnHand` の選択で
    // 既に前提にしている）ので、時計を使わずに前後関係を決められる。
    if (oldestOwnHand !== undefined) return entry.handId >= oldestOwnHand.id
    return false
  }
  const entries = all.filter(inScope)
  const outOfObservationWindowHands = all.length - entries.length
  const scopedLocalHands = all
    .map((entry, index) => ({ entry, hand: localHands[index] }))
    .filter(({ entry }) => inScope(entry))

  const notCapturedHandIds: number[] = []
  const derivationMissingHandIds: number[] = []
  const chipDiffMismatches: ReplayLedgerChipDiffMismatch[] = []
  let unverifiableHands = 0

  scopedLocalHands.forEach(({ entry, hand }) => {
    if (!hand) {
      // 派生テーブルの不在だけで断定しない。生行があれば、イベントは届いて
      // いて派生側で落ちただけ。
      if (rawTimestamps.has(entry.handId)) derivationMissingHandIds.push(entry.handId)
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

  // 保存の直前にもう一度確かめる。開始時のチェックと照会の間にインポートが
  // 始まると、rawコミット済み・派生未生成の途中経過を読んでしまう。
  //
  // 監査の間ずっと操作スロットを保持する案は採らない ―― ユーザーが押した
  // 再構築やインポートを、バックグラウンドの診断が待たせることになり、
  // 一時的に不正確な診断より悪い。読んだ結果を捨てるだけで足りる。
  if (isBusy?.()) {
    console.info('[replay-ledger] 実行中に長時間操作が始まったため結果を破棄しました')
    return result
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
      `台帳${entries.length}件中、ローカル不在${notCapturedHandIds.length}件（原因未特定）/ ` +
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
  /** インポート等の長時間操作の最中かどうか。真なら監査を見送る。 */
  isBusy?: () => boolean
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
  // 受信順に直列化する。カテゴリを素早く切り替えると複数の応答が重なり、
  // 全走査を伴う重い監査が後発の軽い監査より遅く終わりうる。同じキーへ書くので、
  // その場合は古い結果が新しい結果を上書きして「最新スナップショット」が
  // 受信順と逆になる。
  // 台帳を受信した時点のアカウントを控える。ここは**キュー投入前の同期部分**で
  // なければならない ―― `.then()` の中で読むと、先行監査の最中にアカウントが
  // 変わった場合、2件目は「受信時」ではなく「自分の番が来た時」の値を控えて
  // しまい、変更ガードを素通りする。
  // 受信時が undefined なのはコールドスタートで復元前のときなので、その場合
  // だけは復元後の値を採用する（getter にしてある理由）。
  const playerIdAtReceipt = deps.getPlayerId()
  enqueueReplayLedgerAudit(deps, {
    ledger: snapshot,
    playerIdAtReceipt,
    receivedAt: deps.now(),
    attempts: 1
  }, true)
  return true
}

/**
 * 1件の台帳を保留リストへ控えたうえで、直列化キューへ積む。
 *
 * 控えるのは**キュー投入前**（先行監査の最中にworkerが死んでも残るように）。
 * 控えの書き込みに失敗しても監査自体は続ける ―― 再開できなくなるだけで、
 * 今この場で走らせないほうが悪い。
 */
const enqueueReplayLedgerAudit = (
  deps: ReplayLedgerAuditDeps,
  entry: PendingReplayLedgerAudit,
  persist: boolean
): void => {
  const persisted = persist
    ? updatePendingAudits(deps.db, entry.receivedAt, current => [
      // 同じカテゴリの古い控えは新しい受信で置き換える。結果は同じ`meta`キーへ
      // 上書きされるので、古いほうを再開する意味が無い。
      ...current.filter(item => item.ledger.battleType !== entry.ledger.battleType),
      entry
    ]).catch(error => {
      console.warn('[replay-ledger] 保留中の台帳を控えられませんでした:', error)
    })
    : Promise.resolve()

  auditQueue = auditQueue
    .then(async () => {
      await persisted
      try {
        await deps.waitUntilConsistent()
        if (deps.isBusy?.()) {
          console.info('[replay-ledger] 長時間操作の実行中のため突き合わせを見送りました')
          return
        }
        const playerId = deps.getPlayerId()
        if (entry.playerIdAtReceipt !== undefined && entry.playerIdAtReceipt !== playerId) {
          console.info('[replay-ledger] 待機中にアカウントが変わったため突き合わせを見送りました')
          return
        }
        await auditReplayLedger(deps.db, playerId, entry.ledger, deps.now(), deps.isBusy)
      } finally {
        // 見送り・失敗も含めて控えを外す。ここまで到達した＝workerは生きていた
        // ので、次回起動で再開すべき仕事は残っていない。
        await updatePendingAudits(deps.db, deps.now(), current =>
          current.filter(item => !isSamePending(item, entry))
        ).catch(() => undefined)
      }
    })
    .catch(error => {
      console.error('[replay-ledger] 台帳の突き合わせに失敗しました:', error)
    })
}

/**
 * Service Worker起動時に、前回のworkerが終わらせられなかった突き合わせを
 * 再開する。保留が無ければ1行もDBを読まない（`meta`の1件取得のみ）。
 */
export const resumePendingReplayLedgerAudits = async (
  deps: ReplayLedgerAuditDeps
): Promise<void> => {
  let pending: PendingReplayLedgerAudit[]
  try {
    pending = await readPendingAudits(deps.db)
  } catch (error) {
    console.warn('[replay-ledger] 保留中の台帳を読めませんでした:', error)
    return
  }
  for (const entry of pending) {
    const attempts = entry.attempts + 1
    if (attempts > REPLAY_LEDGER_AUDIT_MAX_ATTEMPTS) {
      console.warn(
        `[replay-ledger] BattleType=${entry.ledger.battleType}: ` +
        '再開の上限に達したため保留中の突き合わせを破棄しました'
      )
      await updatePendingAudits(deps.db, deps.now(), current =>
        current.filter(item => !isSamePending(item, entry))
      ).catch(() => undefined)
      continue
    }
    enqueueReplayLedgerAudit(deps, { ...entry, attempts }, true)
  }
}

/** テスト用。直列化キューを初期化する。 */
export const __resetReplayLedgerQueueForTests = (): void => {
  auditQueue = Promise.resolve()
  pendingMetaQueue = Promise.resolve()
}
