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
 * - 「参加のみ」（既定ON、#353）は自発的にチップを入れたハンドだけへ絞る。
 *   キャッシュは常に無フィルターで持ち、返却時に絞ってからlimitを適用する
 *   （`sliceToLimit` / `isVoluntaryParticipation`参照）。
 * - ヒーロー自身の配札ホールカードだけは、Hand entityに無いためRaw Event
 *   Lakeの`EVT_DEAL`から読み取り時に補う（#353、`readHeroDealtHoleCardsByHandId`）。
 */
import { ActionType, PhaseType, Position, ActionDetail, isShowdownParticipant } from '../types/game'
import { ApiType } from '../types/api'
import type { Hand, Action, Phase, Result } from '../types/entities'
import type { RecentHandEntry, RecentHandsResult, PreflopLine, PostflopLines, StreetAction } from '../types/stats'
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
  RECENT_HANDS_ASSEMBLY_LIMIT,
  RECENT_HANDS_LIMIT_OPTIONS,
} from '../utils/recent-hands-config'

export {
  DEFAULT_RECENT_HANDS_LIMIT,
  MAX_RECENT_HANDS_LIMIT,
  RECENT_HANDS_ASSEMBLY_LIMIT,
  RECENT_HANDS_LIMIT_OPTIONS,
}

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
 * 件数と「参加のみ」は意図的にキーへ含めない（#341/#353）: エントリは常に
 * `MAX_RECENT_HANDS_LIMIT`件・無フィルターで組み立ててキャッシュし、
 * 呼び出し側の条件は`sliceToLimit`で満たす。切り替えがDB読み取りを増やさず、
 * 同じ内容のキャッシュが条件の数だけ重複しない。
 *
 * 一方「ヒーロー自身のパネルか」はキーへ含める（MUST、#353）。この値は
 * 組み立て結果そのものを変える（配札ホールカードを埋めるかどうか）ため。
 * サービスワーカー再起動直後などヒーローID復元前にパネルを開くと、
 * 含めない実装では「カードなし」の結果が最大30秒残り続ける。
 */
export const buildRecentHandsCacheKey = (
  playerId: number,
  service: PokerChaseService,
  heroPanel: boolean = isHeroPanel(service, playerId)
): string =>
  `${playerId}_${service.battleTypeFilter?.join(',') ?? 'all'}_${service.tableSizeFilter?.join(',') ?? 'all'}_${heroPanel ? 'hero' : 'other'}`

/**
 * そのパネルが観測者本人（ヒーロー）のものか。`EVT_DEAL.Player`は観測クライアント
 * 自身の席の情報なので、配札ホールカードの補完はこの判定が真のときだけ行う。
 *
 * MUST: 呼び出し側はこの値をフェッチ開始時に**一度だけ**取り、キー作成とLake
 * 読み取りの両方で同じスナップショットを使う。`service.playerId`はDB awaitの
 * 最中に新しいDEALやアカウント／タブ切替で変わり得るため、都度読み直すと
 * 「`other`キーの下に配札カード入りの結果」あるいはその逆を書き込み、
 * 最大30秒のあいだ誤った可視性の結果を再利用してしまう。
 */
export const isHeroPanel = (service: PokerChaseService, playerId: number): boolean =>
  service.playerId !== undefined && service.playerId === playerId

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
 * 基本形はwrite-entity-stream.ts:193の式（同一フェーズ内でこのアクション
 * より前のBET/RAISEアクション数 + PREFLOPなら1）。`actionsByHandId`は
 * 対象ハンド集合の全プレイヤー分のアクションを含む必要がある（自分の
 * アクションだけでは「何ベット目に直面したか」は分からないため）。
 *
 * ただし先行アクションは**実質種別**（`resolveEffectiveActionType`）で数える
 * （MUST）。保存パイプラインは相手のベットをカバーできないショートオールイン
 * （＝実質はコール）も`RAISE`として保存するため、生の種別で数えると
 * `オープン → ショートオールイン → コール`の最後のコールが「3ベットに直面」
 * と誤判定され、`CC`が`3CC`に、後続レイズの`3B`が`4B`になる。
 * `bigBlindFallback`はプリフロップの実質種別判定に使う下駄（ブラインドは
 * `EVT_ACTION`として来ないため。`facingBetBefore`参照）。
 */
function computePhasePrevBetCount(
  action: Action,
  actionsByHandId: Map<number, Action[]>,
  bigBlindFallback: number = 0
): number {
  if (action.handId === undefined) return action.phase === PhaseType.PREFLOP ? 1 : 0
  const phaseActions = (actionsByHandId.get(action.handId) ?? []).filter(a => a.phase === action.phase)
  const fallback = action.phase === PhaseType.PREFLOP ? bigBlindFallback : 0
  const priorBetRaiseCount = phaseActions.filter(a =>
    a.index < action.index && isAggressiveAction(resolveEffectiveActionType(a, phaseActions, fallback))
  ).length
  return priorBetRaiseCount + (action.phase === PhaseType.PREFLOP ? 1 : 0)
}

/**
 * RAISE/BETの`phasePrevBetCount`からベットラベルを決める。
 * 1=`'OR'`（オープンレイズ）、2=`'3B'`、3+=`'NB'`。
 * 表記はHUD/トラッカー系の一般的な短縮形に合わせてある（#356）。
 */
function betLabel(phasePrevBetCount: number): string {
  if (phasePrevBetCount <= 1) return 'OR'
  if (phasePrevBetCount === 2) return '3B'
  return `${phasePrevBetCount + 1}B`
}

/**
 * コールドコール（自分は未参加のままレイズにコール）のラベルを、
 * **何に対して**コールしたかで分ける（#356）。オープンへのコールと3betへの
 * コールは全く意味合いが異なるため、まとめて1ラベルにしない。
 *
 * `phasePrevBetCount`は「このアクションが直面していたベット数」（プリフロップは
 * 強制投稿ぶんの+1を含む）なので、レイズ側の`betLabel`と違って+1しない:
 *  - 2 = オープンに直面 → `'CC'`
 *  - 3 = 3betに直面 → `'3CC'`
 *  - 4以上 = 4bet以降に直面 → `'4CC'`, `'5CC'`, …
 */
function coldCallLabel(phasePrevBetCount: number): string {
  if (phasePrevBetCount <= 2) return 'CC'
  return `${phasePrevBetCount}CC`
}

/**
 * ラベルと「そのラベルを決めたアクション」の組（#356）。
 *
 * 金額のインライン表示（#355）は「ラベル↔数字は同じアクションのもの」という
 * 不変条件の上に成り立っているので、ラベルを組み立てるループの中で、それを
 * 決めたアクション自身を一緒に持ち出す。分類ロジックを2箇所へ写経すると
 * この不変条件が静かに崩れる。
 */
interface PreflopLabeling {
  line: PreflopLine | null
  /** ラベルを決めたアクション。金額はこのアクションの額から出す。 */
  labelingAction: Action | null
  /** そのラベルが金額を伴うか（レイズto額／コールドコールのコールto額）。 */
  showsAmount: boolean
}

function derivePreflopLabeling(
  hand: Hand,
  playerId: number,
  actionsByHandId: Map<number, Action[]>
): PreflopLabeling {
  const handActions = actionsByHandId.get(hand.id) ?? []
  const preflopActions = handActions
    .filter(a => a.playerId === playerId && a.phase === PhaseType.PREFLOP)
    .sort((a, b) => a.index - b.index)

  if (preflopActions.length === 0) {
    // プリフロップ・アクションが一切ない: ウォーク（BBが不戦勝、サーバーが
    // BBのアクションすら送らない）か、そもそもこのハンドのプレイヤーデータが
    // 欠落している（切断等）かのいずれか。
    return {
      line: hand.bigBlindUserId === playerId ? 'W' : null,
      labelingAction: null,
      showsAmount: false,
    }
  }

  // 実質種別判定（ショートオールインの実質コール除外）の下駄。
  // ブラインドは`EVT_ACTION`として来ないため、プリフロップの対峙額はBBから始まる。
  const bigBlindFallback = isUsableNumber(hand.bigBlind) && hand.bigBlind > 0 ? hand.bigBlind : 0

  let label: string | null = null
  let labelingAction: Action | null = null
  let showsAmount = false
  for (const action of preflopActions) {
    if (action.actionType === ActionType.FOLD) {
      // フォールドはラベルを作らない ―― 直前のラベル（とそれを決めた
      // アクション）へ`-F`を付けるだけ。数字は`-F`の前へ入る（`CC2.2-F`）。
      return { line: label ? `${label}-F` : 'F', labelingAction, showsAmount }
    }
    if (action.actionType === ActionType.CHECK) {
      label = 'X'
      labelingAction = action
      showsAmount = false
      continue
    }
    if (action.actionType === ActionType.CALL) {
      const phasePrevBetCount = computePhasePrevBetCount(action, actionsByHandId, bigBlindFallback)
      const isColdCall: boolean = phasePrevBetCount > 1 && label === null
      label = phasePrevBetCount <= 1 ? 'L' : (isColdCall ? coldCallLabel(phasePrevBetCount) : 'C')
      labelingAction = action
      // 金額を出すのはコールドコールだけ。`Limp`はBB1枚と分かりきっており、
      // `Call`（既にラインがある状態からのコール）は「いくらまでコールしたか」
      // より「何をした後のコールか」のほうが情報量が大きい。
      showsAmount = isColdCall
      continue
    }
    if (action.actionType === ActionType.RAISE || action.actionType === ActionType.BET) {
      label = betLabel(computePhasePrevBetCount(action, actionsByHandId, bigBlindFallback))
      labelingAction = action
      showsAmount = true
      continue
    }
  }
  return { line: label, labelingAction, showsAmount }
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
  return derivePreflopLabeling(hand, playerId, actionsByHandId).line
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
 * `ActionType`→1文字表記。`StreetAction.letter`のドキュメントコメント参照。
 * `Partial`にしてあるのは`ActionType.ALL_IN`を意図的に持たないため
 * （actionSchemaがALL_INのactionType自体を禁じている）。万一その値が
 * 残っている古い行を読んでも、未定義として弾かれる。
 */
const ACTION_LETTER: Partial<Record<ActionType, string>> = {
  [ActionType.CHECK]: 'X',
  [ActionType.BET]: 'B',
  [ActionType.FOLD]: 'F',
  [ActionType.CALL]: 'C',
  [ActionType.RAISE]: 'R',
}

/** ポット比を出す意味があるアクション（自分から仕掛けて出した額があるもの）。 */
const isAggressiveAction = (actionType: ActionType): boolean =>
  actionType === ActionType.BET || actionType === ActionType.RAISE

/**
 * そのアクションが対峙していたベット額（同ストリートで、**他プレイヤー**が
 * それまでに積み上げた累計betの最大値）。
 *
 * `fallbackFacingBet`は先行アクションが1件も無いときの下駄。プリフロップは
 * ブラインドが`EVT_ACTION`として飛んで来ないため、最初の自発アクションが
 * 対峙しているのはBBであり、ここへ`hand.bigBlind`を渡す。ポストフロップは
 * ストリート開始時に誰も出していないので0。
 * （`hand-log-processor.ts`の`getPreviousBet()`と同じ規約 ―― あちらも
 * ポストフロップは0、プリフロップは`posts big blind`の額へ落ちる。）
 */
function facingBetBefore(
  action: Action,
  sameStreetActions: Action[],
  fallbackFacingBet: number
): number {
  const maxPrior = sameStreetActions
    .filter(a => a.index < action.index && a.playerId !== action.playerId)
    .reduce((max, a) => (isUsableNumber(a.bet) && a.bet > max ? a.bet : max), 0)
  return maxPrior > 0 ? maxPrior : Math.max(0, fallbackFacingBet)
}

/**
 * 表示上のアクション種別（#354のcodexレビュー指摘）。
 *
 * 保存パイプラインは生の`ActionType.ALL_IN`を`Progress.NextActionTypes`だけを
 * 見て正規化する（write-entity-stream.ts / entity-converter.ts）:
 * `CALL`が選択肢にあれば **額を見ずに** `RAISE` へ倒す。したがって、相手の
 * ベットをカバーできないショートオールイン（＝実質はオールインコール）まで
 * `RAISE`として保存される。そのまま出すと、本来`C!`の行に`Rxx!`とポット比が
 * 付き、プリフロップでは存在しないレイズのツールチップが出る。
 *
 * ここでは`ActionDetail.ALL_IN`が付いた行に限り、同ストリートで対峙していた
 * ベット額と自分の累計betを比べ直し、**上回ったときだけ**BET/RAISEとして扱う。
 * 同額（ちょうどカバー）も下回りもコール ―― `hand-log-processor.ts`の
 * `ALL_IN`分岐（`BetChip > prevBet`のみ"raises ... and is all-in"、
 * `BetChip === prevBet`と`BetChip < prevBet`はどちらも"calls ... and is
 * all-in"）と同じ境界に揃える。
 *
 * MUST: `ActionDetail.ALL_IN`が無い行には触らない。そちらはサーバーが
 * `RAISE`/`BET`を明示的に送っており、再解釈する理由が無い。
 */
export function resolveEffectiveActionType(
  action: Action,
  sameStreetActions: Action[],
  fallbackFacingBet: number = 0
): ActionType {
  if (!action.actionDetails.includes(ActionDetail.ALL_IN)) return action.actionType
  if (!isAggressiveAction(action.actionType)) return action.actionType
  if (!isUsableNumber(action.bet)) return action.actionType
  const facing = facingBetBefore(action, sameStreetActions, fallbackFacingBet)
  // 対峙するベットが無ければ、そのオールインは正真正銘のベット。
  if (facing <= 0) return action.actionType
  return action.bet > facing ? action.actionType : ActionType.CALL
}

const POSTFLOP_PHASES = [PhaseType.FLOP, PhaseType.TURN, PhaseType.RIVER] as const

const isUsableNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/**
 * そのアクションで**新たに**出したチップ額（#354）。`StreetAction.increment`参照。
 *
 * `Action.bet`（=`EVT_ACTION.BetChip`）はストリート内累計なので、同じ
 * プレイヤーの直前のbetとの差が増分になる。ポストフロップはストリート開始時に
 * 0へ戻る（プリフロップのブラインドのような「アクション前の拠出」が無い）ため、
 * 先行アクションが無ければ累計＝増分。
 */
function computeIncrement(action: Action, sameStreetActions: Action[]): number | null {
  if (!isUsableNumber(action.bet)) return null
  const prior = sameStreetActions
    .filter(a => a.playerId === action.playerId && a.index < action.index)
    .reduce((max, a) => (isUsableNumber(a.bet) && a.bet > max ? a.bet : max), 0)
  const increment = action.bet - prior
  return increment >= 0 ? increment : null
}

/**
 * そのアクション直前のポット総額（メイン＋全サイドポット）（#354）。
 * 検証内容は`StreetAction.potBefore`のドキュメントコメント参照。
 *
 * サイドポットを足し込むのは必須（MUST）: オールインでポットがティア分割
 * されるとチップは`Pot`と`SidePot[]`の間を移動するため、`Pot`単独では
 * 「場に出ている額」にならない。
 */
function computePotBefore(action: Action, increment: number | null): number | null {
  if (increment === null || !isUsableNumber(action.pot)) return null
  const sidePot = Array.isArray(action.sidePot)
    ? action.sidePot.reduce((sum: number, value) => sum + (isUsableNumber(value) ? value : 0), 0)
    : 0
  const potBefore = action.pot + sidePot - increment
  return potBefore > 0 ? potBefore : null
}

/**
 * ポストフロップ各ストリートでの、対象プレイヤー自身のアクション列（#341）と
 * そのサイジング（#354）。
 *
 * ストリートの帰属は`action.phase`をそのまま使う ―― #340/#346で、これは
 * アクションイベント自身が運ぶ権威的な`Progress.Phase`になっている
 * （EVT_DEAL_ROUNDのローカルなカウンタではない）ので、オールイン・ランナウト
 * のようにEVT_DEAL_ROUNDが省略される形でも正しいストリートに載る。
 *
 * パイプラインは生の`ActionType.ALL_IN`をBET/RAISE/CALLへ正規化し、事実は
 * `actionDetails`の`ALL_IN`に残す（entitiesのactionSchemaがALL_INのactionType
 * 自体を禁じている）ので、`allIn`フラグとして復元する。
 *
 * 比率の分子に累計betではなく**増分**を使うのは、レイズで「これまでに出した
 * 総額」を分子にすると、相手のベットへ被せた分まで自分の投入として二重に
 * 数えてしまうため。
 */
export function derivePostflopLines(
  handId: number,
  playerId: number,
  actionsByHandId: Map<number, Action[]>
): PostflopLines {
  const handActions = actionsByHandId.get(handId) ?? []
  const [flop, turn, river] = POSTFLOP_PHASES.map(phase => {
    // 増分の算出には**同じストリートの自分の先行アクション**が要るので、
    // フェーズ単位で切り出してからプレイヤーで絞る。
    const streetActions = handActions.filter(a => a.phase === phase)
    return streetActions
      .filter(a => a.playerId === playerId)
      .sort((a, b) => a.index - b.index)
      .flatMap<StreetAction>(action => {
        // ショートオールインは保存上RAISEでも実質コール（`resolveEffectiveActionType`
        // 参照）。ポストフロップはストリート開始時点で対峙するベットが無いので
        // 下駄は0でよい。
        const effectiveActionType = resolveEffectiveActionType(action, streetActions)
        const letter = ACTION_LETTER[effectiveActionType]
        if (!letter) return []
        const increment = computeIncrement(action, streetActions)
        const potBefore = computePotBefore(action, increment)
        return [{
          letter,
          allIn: action.actionDetails.includes(ActionDetail.ALL_IN),
          increment,
          potBefore,
          potPercent: isAggressiveAction(effectiveActionType) && increment !== null && increment > 0 && potBefore !== null
            ? Math.round((increment / potBefore) * 100)
            : null,
        }]
      })
  })
  return { flop: flop ?? [], turn: turn ?? [], river: river ?? [] }
}

/**
 * ラベルに添える金額（#354のレイズto額を#356でコールドコールへ拡張）。
 *
 * プリフロップの`Action.bet`はストリート内累計なので、レイズなら「いくらまで
 * 上げたか」、コールなら「いくらまでコールしたか」がそのまま入っている
 * （ブラインドは既にその内側）。
 *
 * MUST: 額は必ず**ラベルを決めたアクション**（`derivePreflopLabeling`の
 * `labelingAction`）から採る。数字はラベルの直後へインライン表示されるので、
 * 別のアクションの額を返すと「あるアクションの数字が別のアクションのラベルに
 * 付く」ことになる（#355で確立した不変条件）。
 */
export function derivePreflopLineAmount(
  hand: Hand,
  playerId: number,
  actionsByHandId: Map<number, Action[]>
): { chips: number | null, bb: number | null } {
  const { labelingAction, showsAmount } = derivePreflopLabeling(hand, playerId, actionsByHandId)
  if (!labelingAction || !showsAmount) return { chips: null, bb: null }

  // ショートオールイン（実質コール）をレイズとして拾わない ――
  // `resolveEffectiveActionType`参照。プリフロップはブラインドが
  // `EVT_ACTION`として来ないため、対峙額の下駄にBBを渡す。
  // コールドコールのコールto額はこのゲートの対象外（コールはコール）。
  if (isAggressiveAction(labelingAction.actionType)) {
    const preflopActions = (actionsByHandId.get(hand.id) ?? []).filter(a => a.phase === PhaseType.PREFLOP)
    const bigBlindFallback = isUsableNumber(hand.bigBlind) && hand.bigBlind > 0 ? hand.bigBlind : 0
    if (!isAggressiveAction(resolveEffectiveActionType(labelingAction, preflopActions, bigBlindFallback))) {
      return { chips: null, bb: null }
    }
  }

  if (!isUsableNumber(labelingAction.bet) || labelingAction.bet <= 0) return { chips: null, bb: null }
  const bb = isUsableNumber(hand.bigBlind) && hand.bigBlind > 0 ? labelingAction.bet / hand.bigBlind : null
  return { chips: labelingAction.bet, bb }
}

/**
 * そのハンドでプレイヤーが**自発的に**チップを入れたか（#353「参加のみ」）。
 *
 * 判定はプリフロップ・ラインのラベルに寄せる（VPIPをアクションから再導出
 * しない）。`derivePreflopLine`が返す`'Fold'`と`'Walk'`だけが「強制投稿
 * （SB/BB/アンテ）以外に1チップも入れていない」を意味するため:
 *  - `'Walk'`: BBがアクションを一切していない（不戦勝）。
 *  - `'Fold'`: プレイヤーの**最初の**プリフロップアクションがフォールド。
 *    直前にラインが付いていた場合は`'Open-F'`のようにサフィックス付きに
 *    なるので、素の`'Fold'`は自発投資ゼロと同義。
 *
 * `'Check'`（BBがリンプされてオプションをチェック）は**除外しない**。
 * VPIP的には自発投資ゼロだが、そのハンドはフロップへ進み、ポストフロップで
 * 実際にプレイしている可能性がある ―― 落とすと本当に打ったハンドが消える。
 * ここで狙って消したいのは「ブラインドを取られただけで終わった行」だけ。
 *
 * `preflopLine`が`null`（このハンドのプレイヤーデータが欠落＝切断等）は
 * 判定できないので残す（推測して消さない）。
 *
 * MUST: ラベルだけで切らず、「そのプレイヤーにとってハンドがそこで終わった」
 * ことも確かめる。`'Walk'`は「BBのプリフロップ`EVT_ACTION`が無い」ことしか
 * 意味しておらず、サーバーはBBのcheckを省略することがある（docs/api-events.md
 * の既知の形: 実ハンドの31.9%でBBの`EVT_ACTION`が無い）ほか、BBが強制投稿で
 * オールインした場合もアクションを送らない。どちらもボードを見ており、
 * ラベルだけで消すと**実際にプレイしたハンドが既定ONのフィルターで消える**。
 * `sawFlop`／`wentToShowdown`のどちらかが立っていれば残す ――
 * `hand-log-processor.ts`の`getMissingBBCheck`が真の不戦勝（RankType
 * NO_CALL）と省略checkを分けているのと同じ区別を、このパネルが既に
 * 導出済みのフィールドで行う。`'Fold'`側はフォールド済みなので両方falseに
 * なり、この追加条件は実質的にWalkのための救済として働く。
 */
export function isVoluntaryParticipation(entry: RecentHandEntry): boolean {
  const noVoluntaryChips = entry.preflopLine === 'F' || entry.preflopLine === 'W'
  if (!noVoluntaryChips) return true
  return entry.sawFlop || entry.wentToShowdown
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
 * ヒーロー自身が配られたホールカードを、Raw Event Lakeの`EVT_DEAL`から読む
 * （#353）。
 *
 * なぜ必要か: `hand.results[].HoleCards`はサーバーが**公開した**カードしか
 * 持たない（ショーダウン到達分のみ）。ヒーロー自身の配札カードは
 * `EVT_DEAL.Player.HoleCards`にしか無く、Hand entityには保存されていない。
 * そのためコールドコールしてフォールドしたようなハンドでは、自分の手札なのに
 * カード欄が空になっていた。
 *
 * なぜ読み取り時か: Hand entityに`heroHoleCards`を足す案は導出変更になり、
 * `REBUILD_ADVISORY_VERSION`のbumpと全履歴のリビルドが要る。Lakeを直接読めば
 * 既存の全ハンドに遡って効き、導出は一切変わらない（AGENTS.md「Raw Event
 * Lake」＝復旧・再解釈の一次資料、という位置づけそのもの）。
 *
 * 相関のとり方: `hand.approxTimestamp`はEVT_DEALの`timestamp`そのもの
 * （entity-converter.ts / write-entity-stream.ts双方が配札時に代入する）。
 * `[ApiTypeId+timestamp]`複合インデックスへ(303, ts)の組を`anyOf`で流す1回の
 * バッチクエリで引く（N+1なし）。同一msに別テーブルの配札が同居し得るため、
 * `SeatUserIds`が当該ハンドのラインナップと完全一致する行だけを採用する。
 *
 * MUST: `heroPlayerId`が一致する呼び出しでのみ使う。`EVT_DEAL.Player`は
 * 観測者自身の情報なので、他プレイヤーのパネルへ流用してはならない。
 *
 * MUST: ここでイベント全体のZod検証（`isApiEventType`）を条件にしない。
 * これは表示のための読み取りであってパイプライン投入ではなく、AGENTS.md
 * 「Raw Event Lake」の原則どおり検証はパイプライン入口だけの関門である。
 * EVT_DEALのどこか無関係な部分がサーバー仕様変更でスキーマから外れた途端に
 * 自分の手札が全部消える、という壊れ方をしてはならない。必要な
 * `SeatUserIds`と`Player.HoleCards`だけを構造的に見て、形が合わない行は
 * 個別に捨てる。
 */
function readDealHoleCardsShape(
  event: unknown
): { seatUserIds: number[], holeCards: number[], observerUserId: number } | null {
  if (typeof event !== 'object' || event === null) return null
  const record = event as { SeatUserIds?: unknown, Player?: unknown }
  if (!Array.isArray(record.SeatUserIds)) return null
  if (!record.SeatUserIds.every((userId): userId is number => typeof userId === 'number')) return null
  if (typeof record.Player !== 'object' || record.Player === null) return null
  const player = record.Player as { HoleCards?: unknown, SeatIndex?: unknown }
  const holeCards = player.HoleCards
  // テーブル移動直後は`HoleCards: []`（docs/api-events.md「EVT_DEAL: Player
  // フィールドの欠落」）。観戦ハンドはPlayerごと無い。どちらも配札なしとして扱う。
  if (!Array.isArray(holeCards) || holeCards.length !== 2) return null
  if (!holeCards.every((card): card is number => typeof card === 'number' && card >= 0 && card <= 51)) return null
  // そのイベントを受け取った観測者自身のUserId。`service.playerId`ではなく
  // **イベント側**から解決する（MUST、下の突き合わせで使う）。
  if (typeof player.SeatIndex !== 'number') return null
  const observerUserId = record.SeatUserIds[player.SeatIndex]
  if (typeof observerUserId !== 'number' || observerUserId === -1) return null
  return { seatUserIds: record.SeatUserIds, holeCards, observerUserId }
}

async function readHeroDealtHoleCardsByHandId(
  db: PokerChaseDB,
  hands: Hand[],
  playerId: number
): Promise<Map<number, string[]>> {
  const byTimestamp = new Map<number, Hand[]>()
  for (const hand of hands) {
    const timestamp = hand.approxTimestamp
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) continue
    const list = byTimestamp.get(timestamp)
    if (list) list.push(hand)
    else byTimestamp.set(timestamp, [hand])
  }
  if (byTimestamp.size === 0) return new Map()

  const dealEvents = await db.apiEvents
    .where('[ApiTypeId+timestamp]')
    .anyOf([...byTimestamp.keys()].map(timestamp => [ApiType.EVT_DEAL, timestamp]))
    .toArray()

  const cardsByHandId = new Map<number, string[]>()
  for (const event of dealEvents) {
    const shape = readDealHoleCardsShape(event)
    if (!shape) continue
    // MUST: そのイベントを実際に受け取った観測者が、いま表示しようとしている
    // プレイヤー本人であることをイベント自身から確かめる。`service.playerId`が
    // 一致していることだけでは足りない ―― アカウント切替後や、別アカウントの
    // Lakeをインポートした環境では、同じラインナップのハンドを**以前は別の
    // アカウントで観測していた**ことがあり、その場合ここは前の観測者の手札を
    // 現在のヒーローの手札として表示してしまう。
    if (shape.observerUserId !== playerId) continue
    const candidates = byTimestamp.get(event.timestamp!) ?? []
    // 同一msに複数テーブルの配札が並び得るので、席の並びが完全一致した
    // ハンドにだけ結び付ける（推測しない）。
    const hand = candidates.find(candidate =>
      candidate.seatUserIds.length === shape.seatUserIds.length &&
      candidate.seatUserIds.every((userId, index) => userId === shape.seatUserIds[index])
    )
    if (!hand) continue
    const formatted = formatCardsArray(shape.holeCards)
    if (formatted.length === 2) cardsByHandId.set(hand.id, formatted)
  }
  return cardsByHandId
}

/**
 * そのハンドのボード（コミュニティカード）を、既に取得済みのphases行から拾う
 * （#356）。追加クエリは投げない ―― `phases`はサービスが既にhandId単位で
 * バッチ取得している。
 *
 * `phase.communityCards`はストリートごとの**累積**（entity-converter.ts /
 * write-entity-stream.tsが前ストリートの配列へ足していく）なので、最長の
 * 配列がそのハンドの最終ボードになる。EVT_DEAL_ROUNDが省略される
 * オールイン・ランナウトでも、合成されたFLOPフェーズとSHOWDOWNフェーズに
 * ボードが入るため、この「最長を採る」方式なら同じように拾える
 * （docs/api-events.md「コミュニティカード（オールイン）」参照）。
 */
export function deriveBoard(handId: number, phasesByHandId: Map<number, Phase[]>): string[] {
  const longest = (phasesByHandId.get(handId) ?? []).reduce<number[]>((best, phase) => {
    const cards = phase.communityCards
    return Array.isArray(cards) && cards.length > best.length ? cards : best
  }, [])
  return longest.length > 0 ? formatCardsArray(longest) : []
}

/**
 * プレイヤーの直近Nハンドを新しい順に取得する。
 *
 * @param db ハンド/アクション/フェーズを取得するDexie DB
 * @param service battleTypeFilter/tableSizeFilterを保持するサービスインスタンス
 * @param playerId 対象プレイヤーID
 * @param limit 取得件数（デフォルト`DEFAULT_RECENT_HANDS_LIMIT`、上限
 *   `MAX_RECENT_HANDS_LIMIT`、handLimitFilterとは無関係）
 * @param participationOnly 自発的にチップを入れたハンドだけへ絞る（#353）。
 *   キャッシュは常に無フィルターで組み立て、返却時に絞ってからlimitを適用
 *   するので、切り替えてもDB読み取りは増えない。
 */
export async function getRecentHands(
  db: PokerChaseDB,
  service: PokerChaseService,
  playerId: number,
  limit: number = DEFAULT_RECENT_HANDS_LIMIT,
  participationOnly: boolean = false
): Promise<RecentHandsResult> {
  subscribeToHandCompletion(service)
  // このフェッチ開始時点のgeneration -- 下の2箇所のcache.set()で、フェッチ中に
  // ハンド完了(cacheGeneration++)が割り込んでいないか照合する（上のコメント参照）。
  const fetchGeneration = cacheGeneration

  const effectiveLimit = limit > 0 ? Math.min(limit, MAX_RECENT_HANDS_LIMIT) : DEFAULT_RECENT_HANDS_LIMIT
  // ヒーロー判定はここで1回だけ確定させる（MUST、`isHeroPanel`のコメント参照）。
  // 以降のDB awaitの最中に`service.playerId`が変わっても、キーと読み取りが
  // 食い違わないようにする。
  const heroPanel = isHeroPanel(service, playerId)
  const cacheKey = buildRecentHandsCacheKey(playerId, service, heroPanel)
  const useCache = process.env.NODE_ENV !== 'test' && !process.env.DEBUG_NO_CACHE
  const now = Date.now()

  if (useCache) {
    const cached = cache.get(cacheKey)
    if (cached && (now - cached.timestamp) < CACHE_DURATION_MS) {
      return sliceToLimit(cached.result, effectiveLimit, participationOnly)
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
  // `RECENT_HANDS_ASSEMBLY_LIMIT`件を組み立て、呼び出し側の条件（件数・
  // 「参加のみ」）へは返却時に絞ってから合わせる（キャッシュ粒度、#341/#353
  // -- 上のcacheKeyのコメントと`RECENT_HANDS_ASSEMBLY_LIMIT`の定義参照）。
  // 表示上限より広く組むのは、絞り込みで表示件数に届かなくなるのを防ぐため。
  const recentHands = [...allPlayerHands]
    .sort(compareHandsNewestFirst)
    .slice(0, RECENT_HANDS_ASSEMBLY_LIMIT)

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
  // （高々RECENT_HANDS_ASSEMBLY_LIMIT件）に対する1回のバッチクエリで、全プレイヤー分を取得する
  // （phasePrevBetCountの再計算・sawFlop判定に他プレイヤーの行が必要なため、
  // playerId絞り込みはしない。N+1は発生しない）。
  // ヒーロー自身のパネルを開いたときだけ、配札カードをLakeから引く（#353）。
  // 他プレイヤーのパネルでは`EVT_DEAL.Player`は自分の情報なので引かない。
  // `heroPanel`はフェッチ開始時のスナップショット（上記参照）。
  const [allActions, allPhases, replayDetails, heroDealtHoleCards] = await Promise.all([
    db.actions.where('handId').anyOf(handIds).toArray(),
    db.phases.where('handId').anyOf(handIds).toArray(),
    // マック行の穴埋め用（オプトイン時のみ）。主キー1回のbulkGetで、
    // 対象ハンド分だけを引く（N+1は発生しない）。
    readReplayImportEnabled()
      .then(enabled => enabled ? db.replayDetails.bulkGet(handIds) : [])
      .catch(() => []),
    // 失敗しても他の列は出す（フェイルオープン、#127踏襲）。
    heroPanel
      ? readHeroDealtHoleCardsByHandId(db, recentHands, playerId).catch(() => new Map<number, string[]>())
      : Promise.resolve(new Map<number, string[]>()),
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
    // ヒーロー自身の配札カード（#353）。公開由来が取れなかった行だけを埋める。
    // 自分の手札は最初から手元にある情報なので、公開ルールのゲートは掛けない。
    const holeCardsFromDeal = holeCardsFromResults === null && holeCardsFromReplay === null
      ? heroDealtHoleCards.get(hand.id) ?? null
      : null
    const preflopAmount = derivePreflopLineAmount(hand, playerId, actionsByHandId)

    return {
      handId: hand.id,
      approxTimestamp: hand.approxTimestamp ?? null,
      // BB単位表示用（#353）。そのハンド自身のBBを使う ―― SNG/MTTはブラインドが
      // 上がるので、別レベルのハンド同士はチップのままでは比較にならない。
      bigBlind: typeof hand.bigBlind === 'number' && Number.isFinite(hand.bigBlind) && hand.bigBlind > 0
        ? hand.bigBlind
        : null,
      position: resolvePosition(hand, playerId, actionsByHandId),
      holeCards: holeCardsFromResults ?? holeCardsFromReplay ?? holeCardsFromDeal,
      holeCardsSource: holeCardsFromResults !== null
        ? 'results'
        : holeCardsFromReplay !== null
          ? 'replay'
          : holeCardsFromDeal !== null ? 'dealt' : null,
      preflopLine: derivePreflopLine(hand, playerId, actionsByHandId),
      postflopLines: derivePostflopLines(hand.id, playerId, actionsByHandId),
      preflopLineAmountBB: preflopAmount.bb,
      preflopLineAmountChips: preflopAmount.chips,
      board: deriveBoard(hand.id, phasesByHandId),
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

  return sliceToLimit(result, effectiveLimit, participationOnly)
}

/**
 * キャッシュ済みの「最大件数ぶん」の結果を、呼び出し側が要求した条件へ
 * 切り出す（#341の件数、#353の「参加のみ」）。`computedAt`は算出時刻なので
 * ここでは変えない。
 *
 * 絞り込みは**limitより先に**掛ける。先にlimit件へ切ってから絞ると、
 * 例えば「25件」を選んでいるのにフォールド行が抜けて数行しか残らない、
 * ということが起きる。キャッシュは`RECENT_HANDS_ASSEMBLY_LIMIT`件ぶん
 * （表示上限の3倍）持っているので、その母集合から条件に合う行を新しい順に
 * limit件まで拾える。それでも足りない場合は拾えただけを返す ―― 追加クエリは
 * 投げない（母集合の広さの根拠は`RECENT_HANDS_ASSEMBLY_LIMIT`の定義参照）。
 */
function sliceToLimit(
  result: RecentHandsResult,
  limit: number,
  participationOnly: boolean
): RecentHandsResult {
  const filtered = participationOnly ? result.hands.filter(isVoluntaryParticipation) : result.hands
  if (filtered === result.hands && filtered.length <= limit) return result
  return { hands: filtered.slice(0, limit), computedAt: result.computedAt }
}

/** Test/debug helper: clears the module-level cache so tests don't leak state across cases. */
export function clearRecentHandsCache(): void {
  cache.clear()
}
