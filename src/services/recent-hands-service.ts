/**
 * Recent Hands Service
 *
 * プレイヤーの「直近Nハンド」を新しい順に一覧化するドリルダウン機能
 * （HM3/PT4の"Last Hands"、Hand2Noteの"recent showdown hole cards"相当）。
 *
 * 設計方針:
 * - ホールカードはapiEventsを再取得しない。EVT_HAND_RESULTS.Resultsは
 *   entity-converter.ts/write-entity-stream.ts双方で`hand.results`に
 *   そのまま保存されており（`handState.hand.results = event.Results`）、
 *   サーバー自身が「実際に公開されたカードのみ有効値を送る」仕様のため、
 *   永続化済みのHand entityだけで可視性判定が完結する（#128のポジション別
 *   ドリルダウンが統計式を再実装しないのと同じ思想で、ここでは
 *   「公開ルールの再実装」をしない -- サーバー送信値をそのまま信頼する）。
 * - DBアクセスはテーブルごとに1回のインデックス付きクエリに抑える
 *   （hands: 'seatUserIds'、actions/phases: 'handId'のanyOf、対象ハンドID
 *   集合に対してのみ）。デフォルトlimit=10件なので、actions/phasesの
 *   バッチクエリも小さい。
 * - フィルター（battleTypeFilter/tableSizeFilter）の意味論はcalcStats/
 *   positional-stats-serviceと一致させる。ただしhandLimitFilterは対象外
 *   （アプリ全体の集計範囲とは独立した「直近N件」機能のため、仕様通り）。
 * - 30秒キャッシュ（#128と同じパターン）、キーにplayerId+フィルター+limitを含める。
 */
import { ActionType, PhaseType, Position, isShowdownParticipant } from '../types/game'
import type { Hand, Action, Phase, Result } from '../types/entities'
import type { RecentHandEntry, RecentHandsResult, PreflopLine } from '../types/stats'
import type { PokerChaseDB } from '../db/poker-chase-db'
import type PokerChaseService from './poker-chase-service'
import { matchesTableSizeFilter } from '../utils/table-size'
import { formatCardsArray } from '../utils/card-utils'

/** デフォルトの取得件数（「直近10ハンド」）。 */
export const DEFAULT_RECENT_HANDS_LIMIT = 10

/** `Position`列挙体の値域（-2..3の連続整数）に収まるかを判定する。legacy sentinel `-3` はfalseになる。 */
const isValidPosition = (position: number): position is Position =>
  position >= Position.BB && position <= Position.UTG

// 30秒キャッシュ（positional-stats-service.tsと同じパターン）
const CACHE_DURATION_MS = 30_000
const MAX_CACHE_SIZE = 50
const cache: Map<string, { result: RecentHandsResult, timestamp: number }> = new Map()

/** Exported for direct unit testing -- caching itself is disabled under NODE_ENV=test
 * (see `useCache` below), so key-differs-when-filter-or-limit-differs can't be observed
 * behaviorally in tests and is instead pinned down against this function directly. */
export const buildRecentHandsCacheKey = (playerId: number, service: PokerChaseService, limit: number): string =>
  `${playerId}_${service.battleTypeFilter?.join(',') ?? 'all'}_${service.tableSizeFilter?.join(',') ?? 'all'}_${limit}`

/**
 * あるアクションの`phasePrevBetCount`をローカルに再計算する。
 * write-entity-stream.ts:193と全く同じ式（同一フェーズ内でこのアクション
 * より前のBET/RAISEアクション数 + PREFLOPなら1）。`actionsByHandId`は
 * 対象ハンド集合の全プレイヤー分のアクションを含む必要がある（自分の
 * アクションだけでは「何ベット目に直面したか」は分からないため）。
 */
function computePhasePrevBetCount(action: Action, actionsByHandId: Map<number, Action[]>): number {
  if (action.handId === undefined) return action.phase === PhaseType.PREFLOP ? 1 : 0
  const phaseActions = (actionsByHandId.get(action.handId) ?? []).filter(a => a.phase === action.phase)
  const priorBetRaiseCount = phaseActions.filter(a =>
    a.index < action.index && (a.actionType === ActionType.BET || a.actionType === ActionType.RAISE)
  ).length
  return priorBetRaiseCount + (action.phase === PhaseType.PREFLOP ? 1 : 0)
}

/** RAISE/BETの`phasePrevBetCount`からベットラベルを決める。1='Open'、2='3Bet'、3+='NBet'。 */
function betLabel(phasePrevBetCount: number): string {
  if (phasePrevBetCount <= 1) return 'Open'
  if (phasePrevBetCount === 2) return '3Bet'
  return `${phasePrevBetCount + 1}Bet`
}

/**
 * プリフロップ・ラインの簡易分類。タクソノミーの詳細は
 * `src/types/stats.ts`の`PreflopLine`ドキュメントコメント参照。
 */
export function derivePreflopLine(
  hand: Hand,
  playerId: number,
  actionsByHandId: Map<number, Action[]>
): PreflopLine | null {
  const handActions = actionsByHandId.get(hand.id) ?? []
  const preflopActions = handActions
    .filter(a => a.playerId === playerId && a.phase === PhaseType.PREFLOP)
    .sort((a, b) => a.index - b.index)

  if (preflopActions.length === 0) {
    // プリフロップ・アクションが一切ない: ウォーク（BBが不戦勝、サーバーが
    // BBのアクションすら送らない）か、そもそもこのハンドのプレイヤーデータが
    // 欠落している（切断等）かのいずれか。
    return hand.bigBlindUserId === playerId ? 'Walk' : null
  }

  let label: string | null = null
  for (const action of preflopActions) {
    if (action.actionType === ActionType.FOLD) {
      return label ? `${label}-F` : 'Fold'
    }
    if (action.actionType === ActionType.CHECK) {
      label = 'Check'
      continue
    }
    if (action.actionType === ActionType.CALL) {
      const phasePrevBetCount = computePhasePrevBetCount(action, actionsByHandId)
      label = phasePrevBetCount <= 1 ? 'Limp' : (label === null ? 'ColdCall' : 'Call')
      continue
    }
    if (action.actionType === ActionType.RAISE || action.actionType === ActionType.BET) {
      label = betLabel(computePhasePrevBetCount(action, actionsByHandId))
      continue
    }
  }
  return label
}

/**
 * ハンドにおけるプレイヤーのポジションを決定する。positional-stats-service.ts
 * の`resolveHandBucket`と同一ロジックだが、'unknown'バケットの代わりに
 * `null`を返す（このパネルはバケット化しない、素の値をそのまま表示するため）。
 */
function resolvePosition(hand: Hand, playerId: number, actionsByHandId: Map<number, Action[]>): Position | null {
  const handActions = actionsByHandId.get(hand.id) ?? []
  const ownPreflop = handActions.find(a => a.playerId === playerId && a.phase === PhaseType.PREFLOP)
  if (ownPreflop) {
    return isValidPosition(ownPreflop.position) ? ownPreflop.position : null
  }
  return hand.bigBlindUserId === playerId ? Position.BB : null
}

/**
 * ホールカードの可視性判定。`isShowdownParticipant`（RankTypeがNO_CALL/
 * FOLD_OPEN以外）とHoleCardsの実値の両方を要求する。SHOWDOWN_MUCKは
 * ショーダウン参加者ではあるがマックしていれば通常HoleCardsは空/[-1,-1]の
 * ため自然にnullへ倒れる。FOLD_OPEN（フォールド後の自発公開）はRankType
 * ゲートで最初から除外する -- サーバーは実際のカード値を送ってくることが
 * あるが、この機能は「ショーダウンで実際に見せた/比較した」ハンドの
 * ホールカードのみを表示する。詳細はdocs/api-events.mdのRankType表参照。
 */
function deriveHoleCards(result: Result | undefined): string[] | null {
  if (!result || !isShowdownParticipant(result)) return null
  const cards = result.HoleCards
  if (!cards || cards.length === 0 || cards[0] === -1) return null
  const formatted = formatCardsArray(cards)
  return formatted.length > 0 ? formatted : null
}

function deriveWonAndNetChips(result: Result | undefined): { won: boolean, netChips: number | null } {
  if (!result) return { won: false, netChips: null }
  const won = result.RewardChip > 0
  return { won, netChips: won ? result.RewardChip : null }
}

/**
 * フロップを見たかどうか。基本はphasesテーブルのFLOPフェーズエントリ
 * （BET_ABLE/ALL_INのプレイヤーのみseatUserIdsに含まれる、write-entity-stream.ts
 * 参照）を見るが、プリフロップ・オールインで残りストリートのEVT_DEAL_ROUNDが
 * 一切送信されないケース（docs/api-events.md「コミュニティカード
 * （オールイン）」参照）ではFLOPのphaseエントリ自体が存在しないことがある。
 * この場合でもショーダウンに到達していれば必ずフロップ（というよりリバー
 * までの全ボード）を見ている（ショーダウンはボードが揃わなければ発生し
 * 得ない）ため、フォールバックとして採用する。
 */
function deriveSawFlop(
  handId: number,
  playerId: number,
  phasesByHandId: Map<number, Phase[]>,
  wentToShowdown: boolean
): boolean {
  const phasesForHand = phasesByHandId.get(handId) ?? []
  const flopPhase = phasesForHand.find(p => p.phase === PhaseType.FLOP)
  if (flopPhase && flopPhase.seatUserIds.includes(playerId)) return true
  return wentToShowdown
}

/**
 * プレイヤーの直近Nハンドを新しい順に取得する。
 *
 * @param db ハンド/アクション/フェーズを取得するDexie DB
 * @param service battleTypeFilter/tableSizeFilterを保持するサービスインスタンス
 * @param playerId 対象プレイヤーID
 * @param limit 取得件数（デフォルト10、handLimitFilterとは無関係）
 */
export async function getRecentHands(
  db: PokerChaseDB,
  service: PokerChaseService,
  playerId: number,
  limit: number = DEFAULT_RECENT_HANDS_LIMIT
): Promise<RecentHandsResult> {
  const effectiveLimit = limit > 0 ? limit : DEFAULT_RECENT_HANDS_LIMIT
  const cacheKey = buildRecentHandsCacheKey(playerId, service, effectiveLimit)
  const useCache = process.env.NODE_ENV !== 'test' && !process.env.DEBUG_NO_CACHE
  const now = Date.now()

  if (useCache) {
    const cached = cache.get(cacheKey)
    if (cached && (now - cached.timestamp) < CACHE_DURATION_MS) {
      return cached.result
    }
  }

  // hands: 'seatUserIds' はマルチエントリインデックス（poker-chase-db.ts）。
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

  // handLimitFilterは意図的に適用しない（このパネル自体の「直近N件」が
  // 独立したlimitのため、仕様通り）。新しいハンドから優先して上位limit件を選ぶ。
  const recentHands = [...allPlayerHands]
    .sort((a, b) => b.id - a.id)
    .slice(0, effectiveLimit)

  if (recentHands.length === 0) {
    const result: RecentHandsResult = { hands: [], computedAt: now }
    cache.set(cacheKey, { result, timestamp: now })
    return result
  }

  const handIds = recentHands.map(h => h.id)

  // actions/phases: 'handId' 単一フィールドインデックス。対象ハンド集合
  // （高々limit件）に対する1回のバッチクエリで、全プレイヤー分を取得する
  // （phasePrevBetCountの再計算・sawFlop判定に他プレイヤーの行が必要なため、
  // playerId絞り込みはしない。N+1は発生しない）。
  const [allActions, allPhases] = await Promise.all([
    db.actions.where('handId').anyOf(handIds).toArray(),
    db.phases.where('handId').anyOf(handIds).toArray(),
  ])

  const actionsByHandId = new Map<number, Action[]>()
  for (const action of allActions) {
    if (action.handId === undefined) continue
    const list = actionsByHandId.get(action.handId)
    if (list) list.push(action)
    else actionsByHandId.set(action.handId, [action])
  }

  const phasesByHandId = new Map<number, Phase[]>()
  for (const phase of allPhases) {
    if (phase.handId === undefined) continue
    const list = phasesByHandId.get(phase.handId)
    if (list) list.push(phase)
    else phasesByHandId.set(phase.handId, [phase])
  }

  const hands: RecentHandEntry[] = recentHands.map(hand => {
    const result = hand.results.find((r: Result) => r.UserId === playerId)
    const wentToShowdown = result ? isShowdownParticipant(result) : false
    const { won, netChips } = deriveWonAndNetChips(result)

    return {
      handId: hand.id,
      approxTimestamp: hand.approxTimestamp ?? null,
      position: resolvePosition(hand, playerId, actionsByHandId),
      holeCards: deriveHoleCards(result),
      preflopLine: derivePreflopLine(hand, playerId, actionsByHandId),
      sawFlop: deriveSawFlop(hand.id, playerId, phasesByHandId, wentToShowdown),
      wentToShowdown,
      won,
      netChips,
    }
  })

  const result: RecentHandsResult = { hands, computedAt: now }

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
export function clearRecentHandsCache(): void {
  cache.clear()
}
