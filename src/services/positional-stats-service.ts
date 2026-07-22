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
 * - フィルター（battleTypeFilter/tableSizeFilter/handLimitFilter）の適用順序・
 *   意味論はcalcStatsと完全に一致させる。これらが食い違うと、通常のHUD統計と
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
import { matchesTableSizeFilter } from '../utils/table-size'
import { compareHandsNewestFirst } from '../utils/hand-order'

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

// 監査finding 11フォローアップ・pass-3（P2、codexレビュー指摘）: 「進行中フェッチが
// 完了後キャッシュへ古い結果を書き込んでしまう」レース対応。
//
// 上のsubscribeToHandCompletion()によるcache.clear()だけでは不十分だった:
// (1) 進行中のgetPositionalStats()呼び出しがDB読み取り中（awaitで中断中）、
// (2) その最中に生きたハンドが1件完了してこのリスナーが発火しcache.clear()、
// (3) しかし(1)の呼び出しはキャンセルされずそのまま続行し、完了前のDB状態を基に
//     計算した結果でcache.set()を実行してしまう。
// これにより、直後（bumpされたhandEpochによる）オープンパネルの再フェッチが
// この「完了直後に書き込まれた古い結果」にヒットし、30秒間ずっと新しいハンドを
// 反映しないまま古いデータを表示し続けてしまう。
//
// 対応: 各フェッチをその開始時点のcacheGeneration値でスタンプし（下の
// getPositionalStats()冒頭参照）、書き込み時に現在値と比較する -- フェッチ中に
// ハンドが完了して世代が進んでいれば、計算結果は呼び出し元にはそのまま返す
// （呼び出された時点では最新の正しい答え）が、キャッシュへの書き込みはスキップ
// する（未来の呼び出しを汚染させない）。
let cacheGeneration = 0

// 監査指摘11（P2）「開いたドリルダウンパネルが無期限に古くなる」対応:
// RecentHandsPanel/PositionalStatsPanelのフェッチeffectはApp.tsxから渡される
// 「hand epoch」propをdepsに含めるようになり、生きたハンドが1件完了するたびに
// 再フェッチする(App.tsx参照)。しかしそれだけでは、この再フェッチが引き続き
// 「直前と同じcacheKey」に対してこの30秒キャッシュへヒットしてしまい、古い
// 結果を返し続ける(cacheKeyはplayerId+フィルターのみで、「どのハンドまでの
// 結果か」を持たない)。
//
// 対応方針（プロンプト指定の2案のうち「配線の少ない方」）: メッセージに
// epochを積んでcacheKeyを回転させる案は、その配線がmessage-router.ts
// （別ワークストリームが所有）を経由する必要があり本タスクのスコープ外。
// 代わりに、この関数が既に受け取っている`service`引数（PokerChaseService）
// が公開する`writeEntityStream`に直接購読する。これでbackground.ts/
// ports.ts/content_script.ts/message-router.tsのいずれにも触れずに完結する。
//
// `statsOutputStream`ではなく`writeEntityStream`である理由（audit finding 11の
// フォローアップ、P2、codexレビュー指摘）: 当初`statsOutputStream`の'data'に
// 購読していたが、このイベントはハンド完了時だけでなく、(1)新しいハンド開始時
// （EVT_DEAL）にDBへ既存ハンドがあれば毎回発火する「ウォームアップ」ブロード
// キャスト（aggregate-events-stream.ts）、(2)フィルター変更・インポート/
// リビルド・auto-sync復元時の明示的な再計算（message-router.ts、
// import-export.ts、poker-chase-service.tsのrecalculateStats/
// recalculateAllStats、auto-sync-service.ts。いずれも`statsOutputStream.write()`
// を直接呼ぶ）でも発火する。これらは「ハンドが1件完了した」わけではないため、
// このタイミングでキャッシュを無効化すると、開いたパネルの再フェッチが
// 起きていないのに無駄にキャッシュだけ消える（逆に、フィルター変更直後の
// 再フェッチではまだ古いキャッシュを消してほしいのに、handEpoch自体は
// 変わらないため再フェッチ自体が起きない、というズレも生む）。
// `writeEntityStream`の'data'は`write-entity-stream.ts`の
// `this.push(hand.seatUserIds)`からのみ発火し、これは生きたポート経由の
// イベント取り込み（event-ingestion.ts→handAggregateStream）だけがたどる
// パイプラインで、かつハンドが実際にDBへ書き込まれた後にのみ届く
// （キメラハンドはpushされずreturnする）。ports.tsのhandCompletionEpochと
// 全く同じ完了限定シグナルであり、frontend側のhandEpoch（App.tsx/
// Hud.tsx経由でこのパネルのフェッチeffectのdepsに入る値）が実際に変化する
// タイミングとキャッシュ無効化のタイミングを揃えられる。
//
// 購読はサービスインスタンスごとに一度だけ（WeakSetで冪等化、テストごとに
// 新しいPokerChaseServiceインスタンスが作られるため明示的な解除は不要 --
// 古いインスタンスがGCされればリスナーごと消える）。
// 全クリアである理由: 1つのハンドは同卓の複数プレイヤーのハンド履歴/
// ポジションを同時に更新しうる（そのハンドに参加した全員分）。個別
// エントリ単位の的確な無効化よりも全クリアの方が単純で、頻度も低い
// （ハンド完了ごとに高々1回）ためコストは無視できる。
const subscribedServices = new WeakSet<PokerChaseService>()

function subscribeToHandCompletion(service: PokerChaseService): void {
  if (subscribedServices.has(service)) return
  subscribedServices.add(service)
  service.writeEntityStream.on('data', () => {
    cacheGeneration++
    clearPositionalStatsCache()
  })
}

/** Exported for direct unit testing (see positional-stats-service.test.ts) -- caching itself
 * is disabled under NODE_ENV=test (see `useCache` below), so key-differs-when-filter-differs
 * can't be observed behaviorally in tests and is instead pinned down against this function directly. */
export const buildCacheKey = (playerId: number, service: PokerChaseService): string =>
  `${playerId}_${service.battleTypeFilter?.join(',') ?? 'all'}_${service.tableSizeFilter?.join(',') ?? 'all'}_${service.handLimitFilter ?? 'all'}`

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
 * @param service battleTypeFilter/tableSizeFilter/handLimitFilterを保持するサービスインスタンス
 * @param playerId 対象プレイヤーID
 */
export async function getPositionalStats(
  db: PokerChaseDB,
  service: PokerChaseService,
  playerId: number
): Promise<PositionalStatsResult> {
  subscribeToHandCompletion(service)
  // このフェッチ開始時点のgeneration -- 下の2箇所のcache.set()で、フェッチ中に
  // ハンド完了(cacheGeneration++)が割り込んでいないか照合する（上のコメント参照）。
  const fetchGeneration = cacheGeneration

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
  //   3. tableSizeFilterを適用（C案）
  //   4. handLimitFilterを適用（新しいハンドから優先）
  let allPlayerHands = await db.hands
    .where('seatUserIds').equals(playerId)
    .toArray()

  if (service.battleTypeFilter) {
    allPlayerHands = allPlayerHands.filter((hand: Hand) =>
      service.battleTypeFilter!.includes(hand.session.battleType!)
    )
  }

  if (service.tableSizeFilter) {
    allPlayerHands = allPlayerHands.filter((hand: Hand) =>
      matchesTableSizeFilter(hand, service.tableSizeFilter)
    )
  }

  if (service.handLimitFilter !== undefined && service.handLimitFilter > 0) {
    allPlayerHands = [...allPlayerHands]
      .sort(compareHandsNewestFirst)
      .slice(0, service.handLimitFilter)
  }

  // battleType/tableSize/handLimitフィルターの結果、対象ハンドが0件なら
  // actionsクエリ自体が不要（新規プレイヤーの0ハンド表示と、フィルターで
  // 全滅した場合の両方が同じ「全バケットhandsN=0」の結果になるため、
  // 区別なく早期returnできる）
  if (allPlayerHands.length === 0) {
    const result = buildEmptyResult()
    // フェッチ中にハンドが完了していれば(cacheGenerationが進んでいれば)書き込まない
    // -- 上のコメント参照。呼び出し元にはそのまま最新の結果を返す。
    if (cacheGeneration === fetchGeneration) {
      cache.set(cacheKey, { result, timestamp: now })
    }
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

  // フェッチ中にハンドが完了していれば(cacheGenerationが進んでいれば)書き込まない
  // -- ファイル冒頭のコメント参照。呼び出し元にはそのまま最新の結果を返す。
  if (cacheGeneration === fetchGeneration) {
    cache.set(cacheKey, { result, timestamp: now })
    if (cache.size > MAX_CACHE_SIZE) {
      for (const [key, entry] of cache.entries()) {
        if (now - entry.timestamp > CACHE_DURATION_MS) {
          cache.delete(key)
        }
      }
    }
  }

  return result
}

/** Test/debug helper: clears the module-level cache so tests don't leak state across cases. */
export function clearPositionalStatsCache(): void {
  cache.clear()
}
