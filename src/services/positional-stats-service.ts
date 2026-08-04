/**
 * Positional Stats Service
 *
 * 永続StatsLedgerが選択済みplayer-hand寄与をポジション別に集計した結果を、
 * ドリルダウン表示の公開形式へ射影する。
 *
 * フィルターの意味論は通常HUDと共通で、台帳側が次の順序で適用する:
 * battleType -> tableSize -> 全position横断の最新N件 -> position集計。
 */
import { Position } from '../types/game'
import type {
  PositionalStatId,
  PositionalStatsBucket,
  PositionalStatsBucketId,
  PositionalStatsResult,
} from '../types/stats'
import type { PokerChaseDB } from '../db/poker-chase-db'
import type PokerChaseService from './poker-chase-service'
import { getStatCounter } from '../stats/hand-contribution'

/** Bucket display order: standard late→early preflop order, blinds, then unknown. */
const POSITION_BUCKETS: PositionalStatsBucketId[] = [
  Position.BTN,
  Position.CO,
  Position.HJ,
  Position.UTG,
  Position.SB,
  Position.BB,
  'unknown',
]

/** The 6 stats this drill-down surfaces per position. */
const POSITIONAL_STAT_IDS: PositionalStatId[] = [
  'vpip',
  'pfr',
  '3bet',
  'steal',
  'foldToSteal',
  'cbet',
]

const emptyStats = (): Record<PositionalStatId, [number, number]> => ({
  vpip: [0, 0],
  pfr: [0, 0],
  '3bet': [0, 0],
  steal: [0, 0],
  foldToSteal: [0, 0],
  cbet: [0, 0],
})

/**
 * 旧キャッシュ利用者との互換API。
 *
 * StatsLedgerはフィルターを読取り条件として受け取り、完成ハンドの書込みと同じ
 * transactionで更新されるため、このキーを使うプロセスメモリcacheは持たない。
 */
export const buildCacheKey = (playerId: number, service: PokerChaseService): string =>
  `${playerId}_${service.battleTypeFilter?.join(',') ?? 'all'}_${service.tableSizeFilter?.join(',') ?? 'all'}_${service.handLimitFilter ?? 'all'}`

function buildBucketStats(
  counters: readonly number[]
): Record<PositionalStatId, [number, number]> {
  const stats = emptyStats()
  for (const statId of POSITIONAL_STAT_IDS) {
    const [numerator, denominator] = getStatCounter(counters, statId)
    stats[statId] = [numerator, denominator]
  }
  return stats
}

/**
 * プレイヤーのポジション別スタッツを永続台帳から取得する。
 *
 * @param _db 既存呼出し元との互換用。読取りはservice所有のStatsLedgerを使う。
 * @param service フィルターとStatsLedgerを保持するサービスインスタンス
 * @param playerId 対象プレイヤーID
 */
export async function getPositionalStats(
  _db: PokerChaseDB,
  service: PokerChaseService,
  playerId: number
): Promise<PositionalStatsResult> {
  const battleTypes = service.battleTypeFilter
    ? [...service.battleTypeFilter]
    : undefined
  const tableSizeLayers = service.tableSizeFilter
    ? [...service.tableSizeFilter]
    : undefined
  const latestHands = service.handLimitFilter !== undefined && service.handLimitFilter > 0
    ? service.handLimitFilter
    : undefined

  const snapshot = await service.statsLedger.readPlayerSnapshot(playerId, {
    battleTypes,
    tableSizeLayers,
    latestHands,
  })
  const bucketsByPosition = new Map(
    snapshot.positions.map(bucket => [bucket.position, bucket] as const)
  )

  const positions: PositionalStatsBucket[] = POSITION_BUCKETS.map(position => {
    const bucket = bucketsByPosition.get(position)
    return bucket
      ? {
          position,
          handsN: bucket.handsN,
          stats: buildBucketStats(bucket.counters),
        }
      : { position, handsN: 0, stats: emptyStats() }
  })

  return { positions, computedAt: Date.now() }
}

/**
 * 旧テスト/debug呼出しとの互換API。永続台帳移行後は消去対象のメモリcacheが無い。
 */
export function clearPositionalStatsCache(): void {}
