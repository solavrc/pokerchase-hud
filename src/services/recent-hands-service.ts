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
 *   集合に対してのみ）。対象ハンドは高々`MAX_RECENT_HANDS_LIMIT`件なので、
 *   actions/phasesのバッチクエリも小さい。
 * - フィルター（battleTypeFilter/tableSizeFilter）の意味論はcalcStats/
 *   positional-stats-serviceと一致させる。ただしhandLimitFilterは対象外
 *   （アプリ全体の集計範囲とは独立した「直近N件」機能のため、仕様通り）。
 * - 30秒キャッシュ（#128と同じパターン）。キーはplayerId+フィルターのみで、
 *   件数（limit）は含めない（#341）。UIの件数スイッチャー（10/25/50/100）は
 *   同じ母集合の先頭を切り出すだけなので、常に最大件数まで組み立てて
 *   キャッシュし、返却時にsliceする。件数ごとにキーを分けると、切り替えの
 *   たびにDB読み取りが1往復増え、キャッシュも同じ内容で4重化する。
 * - 対象プレイヤーが配られていないハンド（バースト後の観戦ハンド等）は
 *   除外する（#341）。`isDealtIn`参照。
 */
import { ActionType, PhaseType, Position, ActionDetail, isShowdownParticipant } from '../types/game'
import type { Hand, Action, Phase, Result } from '../types/entities'
import type { RecentHandEntry, RecentHandsResult, PreflopLine, PostflopLines } from '../types/stats'
import type { PokerChaseDB } from '../db/poker-chase-db'
import type PokerChaseService from './poker-chase-service'
import { matchesTableSizeFilter } from '../utils/table-size'
import { formatCardsArray } from '../utils/card-utils'
import { readReplayHoleCards } from '../replay/hole-cards'
import { readReplayImportEnabled } from '../background/replay-import'
import { EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY } from '../replay/protocol'
import { compareHandsNewestFirst } from '../utils/hand-order'
// 件数の選択肢・既定値・上限はrecent-hands-config.tsが持つ（UI側からも
// 参照するため。同ファイル冒頭のコメント参照）。ここから再エクスポートして、
// 既存の`import { DEFAULT_RECENT_HANDS_LIMIT } from './recent-hands-service'`
// を壊さない。
import {
  DEFAULT_RECENT_HANDS_LIMIT,
  MAX_RECENT_HANDS_LIMIT,
  RECENT_HANDS_LIMIT_OPTIONS,
} from '../utils/recent-hands-config'

export { DEFAULT_RECENT_HANDS_LIMIT, MAX_RECENT_HANDS_LIMIT, RECENT_HANDS_LIMIT_OPTIONS }

/** `Position`列挙体の値域（-2..3の連続整数）に収まるかを判定する。legacy sentinel `-3` はfalseになる。 */
const isValidPosition = (position: number): position is Position =>
  position >= Position.BB && position <= Position.UTG

// 30秒キャッシュ（positional-stats-service.tsと同じパターン）
const CACHE_DURATION_MS = 30_000
const MAX_CACHE_SIZE = 50
const cache: Map<string, { result: RecentHandsResult, timestamp: number }> = new Map()

// 監査finding 11フォローアップ・pass-3（P2、codexレビュー指摘）: 「進行中フェッチが
// 完了後キャッシュへ古い結果を書き込んでしまう」レース対応。
// positional-stats-service.tsの同名の仕組みと全く同じ理由・同じ実装パターン
// （そちらのコメント参照）: 進行中のgetRecentHands()呼び出しがDB読み取り中に
// ハンドが完了してcache.clear()が走っても、その呼び出し自体は完了前のDB状態を
// 基にした結果でcache.set()を実行してしまう。各フェッチをその開始時点の
// cacheGeneration値でスタンプし、書き込み時に現在値と比較する -- フェッチ中に
// 世代が進んでいれば呼び出し元へはそのまま結果を返すが、キャッシュへの書き込みは
// スキップする。
let cacheGeneration = 0

// 監査指摘11（P2）「開いたドリルダウンパネルが無期限に古くなる」対応。
// positional-stats-service.tsの同名の仕組みと全く同じ理由・同じ実装パターン
// （そちらのコメント参照）: `service.writeEntityStream`の'data'（生きたポート
// 経由の取り込みだけがたどるパイプラインで、ハンドが実際にDBへ書き込まれた
// 後にのみ発火する、ports.tsの`handCompletionEpoch`と同一の完了限定シグナル）
// に購読して、この30秒キャッシュをbackground.ts/ports.ts/content_script.ts/
// message-router.tsを一切経由せずに無効化する。`service.statsOutputStream`の
// 'data'はハンド完了以外（ハンド開始時のウォームアップ、フィルター変更/
// インポート/auto-sync復元の再計算）でも発火するため使わない（audit finding 11
// フォローアップ、P2、codexレビュー指摘 -- positional-stats-service.tsの
// 詳細なコメント参照）。
const subscribedServices = new WeakSet<PokerChaseService>()

function subscribeToHandCompletion(service: PokerChaseService): void {
  if (subscribedServices.has(service)) return
  subscribedServices.add(service)
  service.writeEntityStream.on('data', () => {
    cacheGeneration++
    clearRecentHandsCache()
  })
}

/**
 * Exported for direct unit testing -- caching itself is disabled under NODE_ENV=test
 * (see `useCache` below), so key-differs-when-filter-differs can't be observed
 * behaviorally in tests and is instead pinned down against this function directly.
 *
 * 件数は意図的にキーへ含めない（#341）: エントリは常に
 * `MAX_RECENT_HANDS_LIMIT`件まで組み立ててキャッシュし、呼び出し側の
 * `limit`はその先頭からのsliceで満たす。件数スイッチャーの切り替えが
 * DB読み取りを増やさず、同じ内容のキャッシュが件数分だけ重複しない。
 */
export const buildRecentHandsCacheKey = (playerId: number, service: PokerChaseService): string =>
  `${playerId}_${service.battleTypeFilter?.join(',') ?? 'all'}_${service.tableSizeFilter?.join(',') ?? 'all'}`

/**
 * リプレイ取り込みのオプトインが切り替わったらキャッシュを捨てる。
 *
 * キャッシュキーにフラグを含めない代わりの措置。含めると、キーを組む前に
 * 非同期のstorage読み取りが要る（キャッシュヒットの経路が遅くなる）。
 * 切り替えは稀なので、変更通知で丸ごと捨てるほうが素直。
 *
 * これが無いと、ONの結果をキャッシュした直後にOFFへ切り替えても最大30秒は
 * リプレイ由来のカードが返り続け、逆にONへ切り替えても古いnullが残る。
 */
chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName !== 'sync') return
  if (!(EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY in changes)) return
  // 世代も進める（MUST）。捨てるだけだと、切り替え前に始まった読み取りが
  // 後から完了したときに世代比較を通過して**古い結果を書き戻す**ため、
  // OFFにしてもリプレイ由来のカードが最大30秒返り続ける。
  cacheGeneration++
  clearRecentHandsCache()
})

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
 * そのハンドで対象プレイヤーが実際に配られていたか（#341「参加しなかった
 * ハンドの除外」）。
 *
 * 判定は配札時のラインナップ`hand.seatUserIds`（=`EVT_DEAL.SeatUserIds`）
 * のみを根拠にする。docs/battle-type-coverage-audit.md「Ringバスト →
 * 観戦 → 買い直し」が結論づけているとおり、そのハンドを配られたかどうかの
 * 権威は結果スナップショットではなく配札イベントであり、バースト後の観戦
 * ハンドではその席が`-1`センチネル（空席）になる。
 *
 * `playerId === -1`を弾くのが実質的な防御になる: `-1`は「空席」を表す
 * センチネルであってプレイヤーIDではないため、そのまま
 * `where('seatUserIds').equals(-1)`に流すと**空席を1つでも含む全ハンド**が
 * ヒットする。SNG終盤やバースト直後のテーブルは空席だらけ（同audit
 * 「SNG終盤の空席は`SeatUserIds`の-1 sentinelで表現される」）なので、
 * これはまさに観戦ハンドの混入経路になる。
 *
 * MUST: 呼び出し側でDexieのマルチエントリインデックス検索を通していても、
 * この述語は省略しない ―― インデックスの副作用に暗黙に依存するのではなく、
 * 「配られたハンドだけを出す」という仕様をこの1関数に明示しておく。
 */
export function isDealtIn(hand: Hand, playerId: number): boolean {
  if (playerId === -1) return false
  // 過去に書かれた行が欠損フィールドを持っていても落ちない（読み取り経路）。
  return Array.isArray(hand.seatUserIds) && hand.seatUserIds.includes(playerId)
}

/**
 * `ActionType`→1文字表記。`PostflopLines`のドキュメントコメント参照。
 * `Partial`にしてあるのは`ActionType.ALL_IN`を意図的に持たないため
 * （actionSchemaがALL_INのactionType自体を禁じている）。万一その値が
 * 残っている古い行を読んでも、未定義として空文字に落ちる。
 */
const ACTION_LETTER: Partial<Record<ActionType, string>> = {
  [ActionType.CHECK]: 'X',
  [ActionType.BET]: 'B',
  [ActionType.FOLD]: 'F',
  [ActionType.CALL]: 'C',
  [ActionType.RAISE]: 'R',
}

const POSTFLOP_PHASES = [PhaseType.FLOP, PhaseType.TURN, PhaseType.RIVER] as const

/**
 * ポストフロップ各ストリートでの、対象プレイヤー自身のアクション列を
 * 省略記法へ畳む（#341）。表記の定義は`PostflopLines`参照。
 *
 * ストリートの帰属は`action.phase`をそのまま使う ―― #340/#346で、これは
 * アクションイベント自身が運ぶ権威的な`Progress.Phase`になっている
 * （EVT_DEAL_ROUNDのローカルなカウンタではない）ので、オールイン・ランナウト
 * のようにEVT_DEAL_ROUNDが省略される形でも正しいストリートに載る。
 *
 * パイプラインは生の`ActionType.ALL_IN`をBET/RAISE/CALLへ正規化し、事実は
 * `actionDetails`の`ALL_IN`に残す（entitiesのactionSchemaがALL_INのactionType
 * 自体を禁じている）ので、`!`サフィックスで復元する。
 */
export function derivePostflopLines(
  handId: number,
  playerId: number,
  actionsByHandId: Map<number, Action[]>
): PostflopLines {
  const ownActions = (actionsByHandId.get(handId) ?? []).filter(a => a.playerId === playerId)
  const [flop, turn, river] = POSTFLOP_PHASES.map(phase => {
    const notation = ownActions
      .filter(a => a.phase === phase)
      .sort((a, b) => a.index - b.index)
      .map(a => {
        const letter = ACTION_LETTER[a.actionType]
        if (!letter) return ''
        return a.actionDetails.includes(ActionDetail.ALL_IN) ? `${letter}!` : letter
      })
      .join('')
    return notation.length > 0 ? notation : null
  })
  return { flop: flop ?? null, turn: turn ?? null, river: river ?? null }
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

function deriveWonAndNetChips(hand: Hand, playerId: number): { won: boolean, netChips: number | null } {
  const accounting = hand.playerChipAccounting?.[String(playerId)]
  if (!accounting) return { won: false, netChips: null }
  return { won: accounting.netChips > 0, netChips: accounting.netChips }
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
 * @param limit 取得件数（デフォルト`DEFAULT_RECENT_HANDS_LIMIT`、上限
 *   `MAX_RECENT_HANDS_LIMIT`、handLimitFilterとは無関係）
 */
export async function getRecentHands(
  db: PokerChaseDB,
  service: PokerChaseService,
  playerId: number,
  limit: number = DEFAULT_RECENT_HANDS_LIMIT
): Promise<RecentHandsResult> {
  subscribeToHandCompletion(service)
  // このフェッチ開始時点のgeneration -- 下の2箇所のcache.set()で、フェッチ中に
  // ハンド完了(cacheGeneration++)が割り込んでいないか照合する（上のコメント参照）。
  const fetchGeneration = cacheGeneration

  const effectiveLimit = limit > 0 ? Math.min(limit, MAX_RECENT_HANDS_LIMIT) : DEFAULT_RECENT_HANDS_LIMIT
  const cacheKey = buildRecentHandsCacheKey(playerId, service)
  const useCache = process.env.NODE_ENV !== 'test' && !process.env.DEBUG_NO_CACHE
  const now = Date.now()

  if (useCache) {
    const cached = cache.get(cacheKey)
    if (cached && (now - cached.timestamp) < CACHE_DURATION_MS) {
      return sliceToLimit(cached.result, effectiveLimit)
    }
  }

  // hands: 'seatUserIds' はマルチエントリインデックス（poker-chase-db.ts）。
  // インデックス検索の結果に対しても`isDealtIn`を明示的に適用する（#341、
  // 同関数のコメント参照）。
  let allPlayerHands = (await db.hands
    .where('seatUserIds').equals(playerId)
    .toArray())
    .filter((hand: Hand) => isDealtIn(hand, playerId))

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
  // 独立したlimitのため、仕様通り）。新しいハンドから優先して上位
  // `MAX_RECENT_HANDS_LIMIT`件を組み立て、呼び出し側のlimitへは返却時に
  // sliceして合わせる（キャッシュ粒度、#341 -- 上のcacheKeyのコメント参照）。
  const recentHands = [...allPlayerHands]
    .sort(compareHandsNewestFirst)
    .slice(0, MAX_RECENT_HANDS_LIMIT)

  if (recentHands.length === 0) {
    const result: RecentHandsResult = { hands: [], computedAt: now }
    // フェッチ中にハンドが完了していれば(cacheGenerationが進んでいれば)書き込まない
    // -- 上のコメント参照。呼び出し元にはそのまま最新の結果を返す。
    if (cacheGeneration === fetchGeneration) {
      cache.set(cacheKey, { result, timestamp: now })
    }
    return result
  }

  const handIds = recentHands.map(h => h.id)

  // actions/phases: 'handId' 単一フィールドインデックス。対象ハンド集合
  // （高々MAX_RECENT_HANDS_LIMIT件）に対する1回のバッチクエリで、全プレイヤー分を取得する
  // （phasePrevBetCountの再計算・sawFlop判定に他プレイヤーの行が必要なため、
  // playerId絞り込みはしない。N+1は発生しない）。
  const [allActions, allPhases, replayDetails] = await Promise.all([
    db.actions.where('handId').anyOf(handIds).toArray(),
    db.phases.where('handId').anyOf(handIds).toArray(),
    // マック行の穴埋め用（オプトイン時のみ）。主キー1回のbulkGetで、
    // 対象ハンド分だけを引く（N+1は発生しない）。
    readReplayImportEnabled()
      .then(enabled => enabled ? db.replayDetails.bulkGet(handIds) : [])
      .catch(() => []),
  ])

  const replayPayloadByHandId = new Map<number, Record<string, unknown>>()
  replayDetails.forEach(record => {
    if (record) replayPayloadByHandId.set(record.handId, record.payload)
  })

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
    const { won, netChips } = deriveWonAndNetChips(hand, playerId)

    const holeCardsFromResults = deriveHoleCards(result)
    // マックしたショーダウン行（RankType 11、HoleCardsが空）だけを埋める。
    // フォールドした相手の手札は対象外 ―― サーバがリプレイで開示するのは
    // ショーダウンに到達した手であり、ここで表示するのもそれだけ。
    const holeCardsFromReplay = holeCardsFromResults === null && wentToShowdown
      ? readReplayHoleCards(replayPayloadByHandId.get(hand.id), playerId)
      : null

    return {
      handId: hand.id,
      approxTimestamp: hand.approxTimestamp ?? null,
      position: resolvePosition(hand, playerId, actionsByHandId),
      holeCards: holeCardsFromResults ?? holeCardsFromReplay,
      holeCardsSource: holeCardsFromResults !== null
        ? 'results'
        : holeCardsFromReplay !== null ? 'replay' : null,
      preflopLine: derivePreflopLine(hand, playerId, actionsByHandId),
      postflopLines: derivePostflopLines(hand.id, playerId, actionsByHandId),
      sawFlop: deriveSawFlop(hand.id, playerId, phasesByHandId, wentToShowdown),
      wentToShowdown,
      won,
      netChips,
    }
  })

  const result: RecentHandsResult = { hands, computedAt: now }

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

  return sliceToLimit(result, effectiveLimit)
}

/**
 * キャッシュ済みの「最大件数ぶん」の結果を、呼び出し側が要求した件数へ
 * 切り出す（#341）。`computedAt`は算出時刻なのでsliceでは変えない。
 * 件数が足りている場合は同一オブジェクトを返す（不要なコピーを避ける）。
 */
function sliceToLimit(result: RecentHandsResult, limit: number): RecentHandsResult {
  if (result.hands.length <= limit) return result
  return { hands: result.hands.slice(0, limit), computedAt: result.computedAt }
}

/** Test/debug helper: clears the module-level cache so tests don't leak state across cases. */
export function clearRecentHandsCache(): void {
  cache.clear()
}
