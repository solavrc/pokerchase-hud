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
import type { PokerChaseDB } from '../db/poker-chase-db'
import {
  REPLAY_LEDGER_MAX_ENTRIES,
  REPLAY_PORT_LEDGER,
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
  /** 台帳にあってローカルに無いHandId（＝キャプチャ欠損の疑い）。 */
  missingHandIds: number[]
  /** ローカルにあるが会計が未確定で照合できなかったハンド数。 */
  unverifiableHands: number
  chipDiffMismatches: ReplayLedgerChipDiffMismatch[]
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
  const entries = ledger.hands.slice(0, REPLAY_LEDGER_MAX_ENTRIES)
  const localHands = await db.hands.bulkGet(entries.map(entry => entry.handId))

  const missingHandIds: number[] = []
  const chipDiffMismatches: ReplayLedgerChipDiffMismatch[] = []
  let unverifiableHands = 0

  entries.forEach((entry, index) => {
    const hand = localHands[index]
    if (!hand) {
      missingHandIds.push(entry.handId)
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
    missingHandIds,
    unverifiableHands,
    chipDiffMismatches
  }

  await db.meta.put({
    id: REPLAY_LEDGER_AUDIT_META_ID,
    value: result,
    updatedAt: now
  })

  if (missingHandIds.length > 0 || chipDiffMismatches.length > 0) {
    console.warn(
      `[replay-ledger] BattleType=${ledger.battleType}: ` +
      `台帳${entries.length}件中、ローカル欠損${missingHandIds.length}件 / ` +
      `チップ不一致${chipDiffMismatches.length}件`,
      { missingHandIds, chipDiffMismatches }
    )
  }

  return result
}

/**
 * ポートに届いたメッセージが台帳なら処理して`true`を返す。
 *
 * 取り込みキューには載せない。`apiEvents`へ書かないので耐久性バリアの対象に
 * なる副作用が無く、載せるとライブイベントの処理を待たせるだけになる
 * （`event-ingestion.ts`冒頭の直列化の趣旨を参照）。
 */
export const handleReplayLedgerPortMessage = (
  message: unknown,
  db: PokerChaseDB,
  playerId: number | undefined,
  now: number
): boolean => {
  if (typeof message !== 'object' || message === null) return false
  if ((message as { type?: unknown }).type !== REPLAY_PORT_LEDGER) return false

  const ledger = message as Partial<ReplayLedgerMessage>
  // 形が違っても`true`（このモジュール宛）を返す。イベント処理へ落として
  // 不正なAPIイベントとして扱われるほうが紛らわしい。
  if (!Array.isArray(ledger.hands)) return true
  if (ledger.hands.length > REPLAY_LEDGER_MAX_ENTRIES) return true

  auditReplayLedger(db, playerId, {
    battleType: typeof ledger.battleType === 'number' ? ledger.battleType : -1,
    cardOpenEndDate: typeof ledger.cardOpenEndDate === 'number' ? ledger.cardOpenEndDate : 0,
    isExpiredCardOpen: ledger.isExpiredCardOpen === true,
    hands: ledger.hands
  }, now).catch(error => {
    console.error('[replay-ledger] 台帳の突き合わせに失敗しました:', error)
  })
  return true
}
