/**
 * Positional Stats Service
 *
 * プレイヤーの各ポジション（BTN/CO/HJ/UTG/SB/BB/unknown）ごとに、主要な統計
 * （VPIP/PFR/3bet/steal/foldToSteal/cbet）を集計するドリルダウン機能。
 *
 * 設計方針:
 * - 統計の計算式は一切再実装しない。src/stats/core/* に定義された本物の
 *   StatDefinition.calculate() を、ポジション別に絞り込んだ
 *   StatCalculationContext で呼び出すことで正確性を担保する
 *   （read-entity-stream.tsのcalcStatsと同じ考え方）。
 * - フィルター（battleTypeFilter/handLimitFilter）の適用順序・意味論は
 *   calcStatsと完全に一致させる。この2つが食い違うと、通常のHUD統計と
 *   ドリルダウンの数字が一致しなくなり信頼性を損なうため。
 * - DBアクセスはテーブルごとに1回のインデックス付きクエリに抑える
 *   （hands: 'seatUserIds'、actions: 'playerId'）。どちらもプレイヤー単位で
 *   絞り込まれるため、DB全体のサイズ（例: 40万アクション）に対してではなく
 *   プレイヤーが関与したハンド数に対してスケールする。
 */
import { PhaseType, Position } from '../types/game'
import type { Hand, Action } from '../types/entities'
import type {
  StatCalculationContext,
  PositionalStatId,
  PositionalStatsBucket,
  PositionalStatsBucketId,
  PositionalStatsResult
} from '../types/stats'
import type { PokerChaseDB } from '../db/poker-chase-db'
import type PokerChaseService from './poker-chase-service'
import { defaultRegistry } from '../stats'

/** Bucket display order: standard late→early preflop order, blinds, then unknown. */
const POSITION_BUCKETS: PositionalStatsBucketId[] = [
  Position.BTN,
  Position.CO,
  Position.HJ,
  Position.UTG,
  Position.SB,
  Position.BB,
  'unknown'
]

/** The 6 stats this drill-down surfaces per position, reused as-is from the registry. */
const POSITIONAL_STAT_IDS: PositionalStatId[] = ['vpip', 'pfr', '3bet', 'steal', 'foldToSteal', 'cbet']

/** `Position`列挙体の値域（-2..3の連続整数）に収まるかを判定する。legacy sentinel `-3` はfalseになる。 */
const isValidPosition = (position: number): position is Position =>
  position >= Position.BB && position <= Position.UTG

// 30秒キャッシュ（ReadEntityStreamの統計キャッシュと同じパターン、#read-entity-stream.ts）
const CACHE_DURATION_MS = 30_000
const MAX_CACHE_SIZE = 50
const cache: Map<string, { result: PositionalStatsResult, timestamp: number }> = new Map()

const buildCacheKey = (playerId: number, service: PokerChaseService): string =>
  `${playerId}_${service.battleTypeFilter?.join(',') ?? 'all'}_${service.handLimitFilter ?? 'all'}`

const emptyStats = (): Record<PositionalStatId, [number, number]> => ({
  vpip: [0, 0],
  pfr: [0, 0],
  '3bet': [0, 0],
  steal: [0, 0],
  foldToSteal: [0, 0],
  cbet: [0, 0]
})

const buildEmptyResult = (): PositionalStatsResult => ({
  positions: POSITION_BUCKETS.map(position => ({ position, handsN: 0, stats: emptyStats() })),
  computedAt: Date.now()
})

/**
 * ハンドごとにプレイヤーのポジションを決定する。
 *
 * 優先順位:
 * 1. そのハンドでのプレイヤー自身のPREFLOPアクション行が持つ`position`
 *    （同一ハンド内のPREFLOPアクションは全て同じpositionを持つ前提、#write-entity-stream.ts）
 * 2. PREFLOPアクションが一切ない場合（ウォーク/BBアクションスキップ）は
 *    `hand.bigBlindUserId === playerId` でBBバケットへ
 * 3. どちらでも決定できない場合（legacy `position === -3`、または
 *    PREFLOPアクションなしかつbigBlindUserId不一致/欠落）は'unknown'
 */
function resolveHandBucket(
  hand: Hand,
  playerId: number,
  positionByHandId: Map<number, Position>
): PositionalStatsBucketId {
  const position = positionByHandId.get(hand.id)
  if (position !== undefined) {
    return isValidPosition(position) ? position : 'unknown'
  }
  return hand.bigBlindUserId === playerId ? Position.BB : 'unknown'
}

/**
 * プレイヤーのポジション別スタッツを計算する。
 *
 * @param db プレイヤーのハンド/アクションを取得するDexie DB
 * @param service battleTypeFilter/handLimitFilterを保持するサービスインスタンス
 * @param playerId 対象プレイヤーID
 */
export async function getPositionalStats(
  db: PokerChaseDB,
  service: PokerChaseService,
  playerId: number
): Promise<PositionalStatsResult> {
  const cacheKey = buildCacheKey(playerId, service)
  const useCache = process.env.NODE_ENV !== 'test' && !process.env.DEBUG_NO_CACHE
  const now = Date.now()

  if (useCache) {
    const cached = cache.get(cacheKey)
    if (cached && (now - cached.timestamp) < CACHE_DURATION_MS) {
      return cached.result
    }
  }

  // hands: 'seatUserIds' はマルチエントリインデックス（poker-chase-db.ts）。
  // calcStats（read-entity-stream.ts）と全く同じ取得・フィルター順序を踏む:
  //   1. プレイヤーの全ハンドを取得
  //   2. battleTypeFilterを適用
  //   3. handLimitFilterを適用（新しいハンドから優先）
  let allPlayerHands = await db.hands
    .where('seatUserIds').equals(playerId)
    .toArray()

  if (service.battleTypeFilter) {
    allPlayerHands = allPlayerHands.filter((hand: Hand) =>
      service.battleTypeFilter!.includes(hand.session.battleType!)
    )
  }

  if (service.handLimitFilter !== undefined && service.handLimitFilter > 0) {
    allPlayerHands = [...allPlayerHands]
      .sort((a, b) => b.id - a.id)
      .slice(0, service.handLimitFilter)
  }

  // battleType/handLimitフィルターの結果、対象ハンドが0件ならactionsクエリ自体が
  // 不要（新規プレイヤーの0ハンド表示と、フィルターで全滅した場合の両方が
  // 同じ「全バケットhandsN=0」の結果になるため、区別なく早期returnできる）
  if (allPlayerHands.length === 0) {
    const result = buildEmptyResult()
    cache.set(cacheKey, { result, timestamp: now })
    return result
  }

  // actions: 'playerId' 単一フィールドインデックス。プレイヤーが関与した
  // 全フェーズのアクションを1クエリで取得する（cbetはFLOPフェーズを、
  // vpip/pfr/3bet/steal/foldToStealはPREFLOPフェーズのactionDetailsを見るため、
  // 全フェーズが必要）
  const allPlayerActions = await db.actions
    .where({ playerId })
    .toArray()

  const filteredHandIdSet = new Set(allPlayerHands.map((h: Hand) => h.id))
  const relevantActions = allPlayerActions.filter((a: Action) =>
    a.handId !== undefined && filteredHandIdSet.has(a.handId)
  )

  // ハンドごとのポジションを、プレイヤー自身のPREFLOPアクション行から決定する。
  // 同一ハンド内のPREFLOPアクションは全て同じpositionを持つ想定のため、
  // 最初に見つかったものを採用すれば十分。
  const positionByHandId = new Map<number, Position>()
  for (const action of relevantActions) {
    if (action.phase !== PhaseType.PREFLOP || action.handId === undefined) continue
    if (!positionByHandId.has(action.handId)) {
      positionByHandId.set(action.handId, action.position)
    }
  }

  // ハンドをポジションバケットに分類
  const handIdsByBucket = new Map<PositionalStatsBucketId, Set<number>>(
    POSITION_BUCKETS.map(bucket => [bucket, new Set<number>()])
  )
  for (const hand of allPlayerHands) {
    const bucket = resolveHandBucket(hand, playerId, positionByHandId)
    handIdsByBucket.get(bucket)!.add(hand.id)
  }

  // バケットごとに、本物のStatDefinition.calculate()を絞り込んだ
  // サブコンテキストで呼び出す（統計式そのものは再実装しない）
  const positions: PositionalStatsBucket[] = []
  for (const bucket of POSITION_BUCKETS) {
    const bucketHandIds = handIdsByBucket.get(bucket)!
    const bucketHands = allPlayerHands.filter((h: Hand) => bucketHandIds.has(h.id))
    const bucketActions = relevantActions.filter((a: Action) => a.handId !== undefined && bucketHandIds.has(a.handId))

    const context: StatCalculationContext = {
      playerId,
      actions: bucketActions,
      phases: [],
      hands: bucketHands,
      allPlayerActions: [],
      allPlayerPhases: [],
      winningHandIds: new Set(),
      session: service.session
    }

    const stats = emptyStats()
    for (const statId of POSITIONAL_STAT_IDS) {
      const statDef = defaultRegistry.get(statId)
      if (!statDef) continue
      const value = await statDef.calculate(context)
      if (Array.isArray(value) && value.length === 2) {
        stats[statId] = [value[0], value[1]]
      }
    }

    positions.push({ position: bucket, handsN: bucketHands.length, stats })
  }

  const result: PositionalStatsResult = { positions, computedAt: now }

  cache.set(cacheKey, { result, timestamp: now })
  if (cache.size > MAX_CACHE_SIZE) {
    for (const [key, entry] of cache.entries()) {
      if (now - entry.timestamp > CACHE_DURATION_MS) {
        cache.delete(key)
      }
    }
  }

  return result
}

/** Test/debug helper: clears the module-level cache so tests don't leak state across cases. */
export function clearPositionalStatsCache(): void {
  cache.clear()
}
