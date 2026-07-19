/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
/**
 * 未解釈イベント（drop）追跡。
 *
 * ポストモーテム（docs/postmortems/2026-07-session-results-drop.md）の教訓:
 * Zod検証に失敗したイベントは Raw Event Lake には保存されるが、リアルタイム
 * パイプラインには投入されない（`event-ingestion.ts`）。この drop の痕跡は
 * これまで console.warn のみで、通常運用では半年間気づかれなかった。
 * 本モジュールはその件数を`meta`テーブル（既存テーブル、スキーマ変更不要）に
 * 集計し、Popupから可視化できるようにする。
 *
 * 分類（呼び出し元 = event-ingestion.ts の `parseApiEvent` 失敗時のみが対象）:
 * - `appTypeParseFailed`: `ApiTypeId` が `ApiType` enum（アプリケーション種別）に
 *   含まれるのに検証に失敗した。309インシデントと同じ危険クラス
 * - `unknownApiType`: `ApiTypeId` が `ApiType` enum に含まれない（新種イベントの
 *   可能性、または既知の非アプリケーションスキーマ自体が変化した稀なケース）
 *
 * 202/205等の「検証は通るが非アプリケーション」イベント（`isApplicationApiEvent`
 * が false を返すが `parseApiEvent` 自体は成功する）は仕様通りの挙動であり、
 * このモジュールの対象外（呼び出し元でそもそもこの関数を呼ばない）。
 */
import type { PokerChaseDB } from '../db/poker-chase-db'
import { ApiTypeValues, type ApiType } from '../types'

export const UNDECODED_EVENT_STATS_KEY = 'undecodedEventStats'

export type UndecodedEventClass = 'appTypeParseFailed' | 'unknownApiType'

export interface UndecodedEventTypeStat {
  count: number
  lastSeen: number
}

export interface UndecodedEventStats {
  total: number
  perApiTypeId: Record<number, UndecodedEventTypeStat>
}

const EMPTY_STATS: UndecodedEventStats = { total: 0, perApiTypeId: {} }

const cloneStats = (stats: UndecodedEventStats): UndecodedEventStats => ({
  total: stats.total,
  perApiTypeId: { ...stats.perApiTypeId }
})

/** `ApiTypeId`からdropクラスを判定する（(c)非アプリケーションは呼び出し元でフィルタ済みの前提） */
export const classifyUndecodedApiTypeId = (apiTypeId: number): UndecodedEventClass =>
  ApiTypeValues.includes(apiTypeId as ApiType) ? 'appTypeParseFailed' : 'unknownApiType'

// モジュールスコープの状態。Service Workerのライフタイム内でのみ有効
// （SW再起動時はmetaテーブルから再読込される）。
let statsPromise: Promise<UndecodedEventStats> | null = null
let flushTimer: ReturnType<typeof setTimeout> | undefined

const FLUSH_DEBOUNCE_MS = 500

const loadStats = async (db: PokerChaseDB): Promise<UndecodedEventStats> => {
  try {
    const record = await db.meta.get(UNDECODED_EVENT_STATS_KEY)
    const value = record?.value as UndecodedEventStats | undefined
    return value ? cloneStats(value) : cloneStats(EMPTY_STATS)
  } catch (error) {
    console.error('[undecoded-event-tracker] Failed to load stats:', error)
    return cloneStats(EMPTY_STATS)
  }
}

/**
 * 同一Promiseをキャッシュすることで、`recordUndecodedEvent`が短時間に連続で
 * 呼ばれても同じ`UndecodedEventStats`オブジェクト参照を返し、DB読み込み完了前の
 * 複数呼び出し間で更新を取りこぼさないようにする（JSのマイクロタスクは
 * 実行完了まで割り込まれないため、参照共有だけで直列化される）。
 */
const ensureLoaded = (db: PokerChaseDB): Promise<UndecodedEventStats> => {
  if (!statsPromise) {
    statsPromise = loadStats(db)
  }
  return statsPromise
}

const scheduleFlush = (db: PokerChaseDB, stats: UndecodedEventStats): void => {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = undefined
    db.meta.put({
      id: UNDECODED_EVENT_STATS_KEY,
      value: cloneStats(stats),
      updatedAt: Date.now()
    }).catch(err => console.error('[undecoded-event-tracker] Failed to persist stats:', err))
  }, FLUSH_DEBOUNCE_MS)
}

/**
 * 未解釈イベントを記録する。呼び出し側は既に(c)（既知の非アプリケーション
 * イベント）を除外していること。書き込みは500msデバウンスされる
 * （Service Worker Compatibility: グローバル`setTimeout`を使用）。
 */
export const recordUndecodedEvent = async (
  db: PokerChaseDB,
  apiTypeId: number,
  timestamp: number
): Promise<void> => {
  const stats = await ensureLoaded(db)
  const existing = stats.perApiTypeId[apiTypeId]
  stats.perApiTypeId[apiTypeId] = {
    count: (existing?.count ?? 0) + 1,
    lastSeen: Math.max(existing?.lastSeen ?? 0, timestamp)
  }
  stats.total += 1
  scheduleFlush(db, stats)
}

/** Popup向け: 現在の集計値を取得する（デバウンス中の未flush分も含む） */
export const getUndecodedEventStats = async (db: PokerChaseDB): Promise<UndecodedEventStats> => {
  const stats = await ensureLoaded(db)
  return cloneStats(stats)
}

/** Popupの「確認済みにする」操作: カウンタをリセットする */
export const resetUndecodedEventStats = async (db: PokerChaseDB): Promise<void> => {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = undefined
  }
  const fresh = cloneStats(EMPTY_STATS)
  statsPromise = Promise.resolve(fresh)
  await db.meta.put({
    id: UNDECODED_EVENT_STATS_KEY,
    value: cloneStats(fresh),
    updatedAt: Date.now()
  })
}
