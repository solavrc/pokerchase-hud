import type { ApiEvent, ApiHandEvent } from '../types/api'
import { ApiType } from '../types/api'
import { BattleType, BetStatusType, RankType } from '../types/game'
import { HAND_ENDING_NEXT_ACTION_SEAT } from './action-phase'

type DealEvent = ApiEvent<ApiType.EVT_DEAL>
type HandResultsEvent = ApiEvent<ApiType.EVT_HAND_RESULTS>

interface ChipSnapshot {
  SeatIndex: number
  Chip: number
  BetChip: number
  BetStatus: number
}

export interface PlayerHandChipAccounting {
  /** EVT_HAND_RESULTS.Results[].RewardChip. Includes uncalled returns. */
  grossPayout: number
  /** Every chip committed during the hand, including forced posts and returned excess. */
  totalContribution: number
  /** grossPayout - totalContribution. */
  netChips: number
}

export type PlayerHandChipAccountingMap = Record<string, PlayerHandChipAccounting | null>

export interface HandRakeAccounting {
  /** Every chip committed during the hand, including an uncalled return. */
  totalContribution: number
  /** EVT_HAND_RESULTS gross payouts, including an uncalled return. */
  totalPayout: number
  /** Chips removed from the table: totalContribution - totalPayout. */
  rake: number
}

export interface PlayerHandSettlement {
  /** Chips won from tiers contested by at least two contributors. */
  contestedAward: number
  /** Chips returned from a contribution tier with no opposing contribution. */
  uncalledReturn: number
}

export type PlayerHandSettlementMap = Record<string, PlayerHandSettlement | null>

export interface HandSettlement {
  playerChipAccounting: PlayerHandChipAccountingMap
  playerSettlements: PlayerHandSettlementMap
  /** Players who received a positive contested award. */
  winningPlayerIds: number[]
}

const getDealSnapshot = (event: DealEvent, seatIndex: number): ChipSnapshot | undefined => {
  if (event.Player?.SeatIndex === seatIndex) return event.Player
  return event.OtherPlayers?.find(player => player.SeatIndex === seatIndex)
}

const getResultSnapshot = (event: HandResultsEvent, seatIndex: number): ChipSnapshot | undefined => {
  if (event.Player?.SeatIndex === seatIndex) return event.Player
  return event.OtherPlayers?.find(player => player.SeatIndex === seatIndex)
}

/**
 * Whether the seat paid this hand's ante. This is shared with HandLogProcessor
 * so the HUD and exported hand history use one interpretation of DEAL state.
 */
export const isAnteContributor = (event: DealEvent, seatIndex: number): boolean => {
  const betStatus = getDealSnapshot(event, seatIndex)?.BetStatus
  return betStatus === undefined ||
    betStatus === BetStatusType.BET_ABLE ||
    betStatus === BetStatusType.ALL_IN
}

/**
 * Stack after the ante but before restoring the posted blind. At EVT_DEAL,
 * Chip is after all forced posts and BetChip is the street-cumulative forced
 * amount (currently blinds), so Chip + BetChip restores it without double-
 * counting. The same rule also covers a future straddle-like forced post if
 * PokerChase reports it through BetChip.
 */
export const getPlayerChipsAfterAnte = (event: DealEvent, seatIndex: number): number | null => {
  const snapshot = getDealSnapshot(event, seatIndex)
  return snapshot ? snapshot.Chip + snapshot.BetChip : null
}

const countAnteContributors = (event: DealEvent): number =>
  event.SeatUserIds.reduce((count, userId, seatIndex) =>
    userId !== -1 && isAnteContributor(event, seatIndex) ? count + 1 : count, 0)

/**
 * Recover the stack immediately before this hand's forced posts.
 *
 * A normal stack is directly observable as Chip + BetChip + Ante. A player
 * reduced to Chip=0/BetChip=0 by a short ante has no per-seat starting amount
 * on the wire. We only accept the main-pot tier when it identifies that seat
 * uniquely (one such seat), or when every such seat necessarily shares the
 * same tier (no side pot). Otherwise the answer is deliberately unknown.
 */
export const deriveStartingStack = (event: DealEvent, seatIndex: number): number | null => {
  const snapshot = getDealSnapshot(event, seatIndex)
  if (!snapshot) return null

  const chipsAfterAnte = snapshot.Chip + snapshot.BetChip
  if (!isAnteContributor(event, seatIndex)) return chipsAfterAnte

  const ante = event.Game.Ante ?? 0
  if (chipsAfterAnte > 0 || ante === 0) return chipsAfterAnte + ante

  const anteAllInSeats = event.SeatUserIds
    .map((userId, index) => ({ userId, index }))
    .filter(({ userId, index }) =>
      userId !== -1 &&
      isAnteContributor(event, index) &&
      getPlayerChipsAfterAnte(event, index) === 0)
    .map(({ index }) => index)

  if (anteAllInSeats.length > 1 && event.Progress.SidePot.length > 0) return null

  const contributorCount = countAnteContributors(event)
  if (contributorCount <= 0 || event.Progress.Pot % contributorCount !== 0) return null

  const inferredStack = event.Progress.Pot / contributorCount
  if (!Number.isSafeInteger(inferredStack) || inferredStack <= 0 || inferredStack > ante) return null
  return inferredStack
}

/** 席インデックス → ハンド中に観測された外部チップ流入額（Ringのリバイイン／アドオン）。 */
export type MidHandChipInflowMap = ReadonlyMap<number, number>

const isRingBattleType = (battleType: BattleType | undefined): boolean =>
  battleType === BattleType.RING_GAME || battleType === BattleType.FRIEND_RING_GAME

/**
 * ハンド中の外部チップ流入（Ringのリバイイン／アドオン）をハンド内スナップショットから復元する。
 *
 * DEAL と RESULTS の2点だけでは「買い足しによる正当な流入」と「バッファ融合や
 * イベント欠落による破損」を区別できない。一方ハンド内のスナップショット
 * （`EVT_ACTION` の `Chip`/`BetChip`、`EVT_DEAL_ROUND` の per-seat `Chip`）は
 * 席ごとのスタックを連続的に観測しており、次の不変条件が成り立つ:
 *
 * - 同一ストリート内では `Chip + BetChip` は不変（ベットは `Chip` → `BetChip` の移動）
 * - ストリート境界では `Chip + BetChip` はちょうど直前ストリートの最終 `BetChip` だけ減る
 *
 * この不変条件からの**増加**だけがハンド中の外部流入である。**減少**は観測列自体が
 * 破綻しているシグネチャ（融合バッファ、ストリート境界のポット跳ね
 * = docs/api-events.md「クロージングコールの欠落」等）なので、1件でも見つけたら
 * null を返して保存則を厳格なまま維持する。
 *
 * 最後に `EVT_HAND_RESULTS` のスナップショットでも同じ恒等式
 * `終了スタック = 直近スナップショット - 残ストリート投入 + RewardChip` を評価する。
 * Ringの自動買い足し（バイイン上限への復帰）はハンド内スナップショットに一切現れず、
 * 終了スタックにだけ現れることがあるため、これを見ないと実測66ハンドが取りこぼされる。
 * ただしこの段階では**超過分だけを流入として計上し、不足は無視する**（＝従来どおり
 * 終点スタックを信じる）。不足は「捕捉されなかった冗長アクション」の既知シグネチャで
 * あり、それを破損として扱うと現在正しく解けているハンドを壊すためである。
 *
 * 流入を許容するのは Ring（BattleType 4/5）のみ。トーナメントにハンド中の買い足しは
 * 存在せず、そこでの増加は破損シグネチャなので MUST NOT 許容する。`battleType` が
 * 未知のキャプチャも同じ理由で許容しない（fail-closed）。
 *
 * 参照するのは `ApiHandEvent`（303/304/305/306）だけである。`EVT_PLAYER_JOIN` 等は
 * `AggregateEventsStream` のハンドバッファに入らず `EntityConverter` 側にだけ存在する
 * ため、判定材料にすると live↔batch parity が壊れる。
 */
export const deriveMidHandChipInflow = (
  deal: DealEvent,
  results: HandResultsEvent,
  handEvents: readonly ApiHandEvent[] | undefined,
  battleType: BattleType | undefined
): MidHandChipInflowMap | null => {
  if (!isRingBattleType(battleType) || !Array.isArray(handEvents)) return null
  if (!Array.isArray(deal.SeatUserIds)) return null

  /** 席インデックス → 直近スナップショットの `Chip + BetChip`。 */
  const stacks = new Map<number, number>()
  /** 席インデックス → 現ストリートの累計投入額（直近スナップショットの `BetChip`）。 */
  const streetBets = new Map<number, number>()
  /** 席インデックス → `streetBets` を記録した時点のフェーズ。 */
  const streets = new Map<number, number>()
  const inflow = new Map<number, number>()

  for (let seatIndex = 0; seatIndex < deal.SeatUserIds.length; seatIndex++) {
    if (deal.SeatUserIds[seatIndex] === -1) continue
    const snapshot = getDealSnapshot(deal, seatIndex)
    // 配札席のスナップショットが欠けていると連続観測が成立しない。
    if (!snapshot || !Number.isSafeInteger(snapshot.Chip) || !Number.isSafeInteger(snapshot.BetChip)) return null
    stacks.set(seatIndex, snapshot.Chip + snapshot.BetChip)
    streetBets.set(seatIndex, snapshot.BetChip)
    streets.set(seatIndex, deal.Progress.Phase)
    inflow.set(seatIndex, 0)
  }

  /**
   * 1席分のスナップショットを取り込む。不変条件からの減少を検出したら false。
   *
   * MUST: 既に観測したストリートより**手前**のスナップショットは読み飛ばす。
   * 同一ミリ秒の複合群は主キー順（`ApiTypeId` 昇順）で並ぶため、304が同時刻の
   * 305より前に来る（#340と同じ現象）。この並びでは、ターンのアクションで席を
   * 進めた後にフロップの305が届く。これを時系列として会計すると、既に精算した
   * ストリート投入額が二重に戻り、実際には無い買い足しとして計上されてしまう。
   * 後退したスナップショットは新しい情報を持たないので無視する。
   */
  const observe = (seatIndex: number, phase: number, chip: number, betChip: number): boolean => {
    const previousStack = stacks.get(seatIndex)
    // 配札されていない席（ハンド中に着席した別プレイヤー等）は追跡対象外。
    if (previousStack === undefined) return true
    if (phase < streets.get(seatIndex)!) return true
    if (!Number.isSafeInteger(chip) || !Number.isSafeInteger(betChip)) return false
    const settledStack = phase === streets.get(seatIndex)
      ? previousStack
      : previousStack - streetBets.get(seatIndex)!
    const delta = chip + betChip - settledStack
    if (delta < 0) return false
    inflow.set(seatIndex, inflow.get(seatIndex)! + delta)
    stacks.set(seatIndex, chip + betChip)
    streetBets.set(seatIndex, betChip)
    streets.set(seatIndex, phase)
    return true
  }

  for (const event of handEvents) {
    if (event.ApiTypeId === ApiType.EVT_ACTION) {
      // ハンド終了行の `Phase` は3固定なのでストリート判定に使えない（#340）。
      // 直前に観測したストリートの続きとして扱う。
      const phase = event.Progress.NextActionSeat === HAND_ENDING_NEXT_ACTION_SEAT
        ? streets.get(event.SeatIndex) ?? event.Progress.Phase
        : event.Progress.Phase
      if (!observe(event.SeatIndex, phase, event.Chip, event.BetChip)) return null
    } else if (event.ApiTypeId === ApiType.EVT_DEAL_ROUND) {
      const phase = event.Progress.Phase
      const snapshots = event.Player ? [event.Player, ...event.OtherPlayers] : event.OtherPlayers
      for (const snapshot of snapshots) {
        // ストリート開始スナップショットは、そのストリートで既にアクションを
        // 観測している席にとっては過去の情報である（上記 observe の doc 参照）。
        if (phase <= (streets.get(snapshot.SeatIndex) ?? -1)) continue
        if (!observe(snapshot.SeatIndex, phase, snapshot.Chip, snapshot.BetChip)) return null
      }
      // スナップショットに現れなかった配札席も、ストリート境界で投入額を精算する。
      for (const [seatIndex, street] of streets) {
        if (street >= phase) continue
        stacks.set(seatIndex, stacks.get(seatIndex)! - streetBets.get(seatIndex)!)
        streetBets.set(seatIndex, 0)
        streets.set(seatIndex, phase)
      }
    }
  }

  // 終了スタックの恒等式で、ハンド内に現れない自動買い足しを拾う（超過のみ計上）。
  if (!Array.isArray(results.Results) || !Array.isArray(results.OtherPlayers)) return inflow
  const payoutByUserId = new Map<number, number>()
  for (const result of results.Results) payoutByUserId.set(result.UserId, result.RewardChip)
  const resultSeats = [
    ...(results.Player ? [results.Player] : []),
    ...results.OtherPlayers,
  ]
  for (const snapshot of resultSeats) {
    const previousStack = stacks.get(snapshot.SeatIndex)
    if (previousStack === undefined) continue
    if (!Number.isSafeInteger(snapshot.Chip) || !Number.isSafeInteger(snapshot.BetChip)) return null
    const userId = deal.SeatUserIds[snapshot.SeatIndex]
    const payout = userId === undefined ? 0 : payoutByUserId.get(userId) ?? 0
    const predictedStack = previousStack - streetBets.get(snapshot.SeatIndex)! + payout
    const excess = snapshot.Chip + snapshot.BetChip - predictedStack
    if (excess > 0) inflow.set(snapshot.SeatIndex, inflow.get(snapshot.SeatIndex)! + excess)
  }

  return inflow
}

const emptyAccounting = (event: DealEvent): PlayerHandChipAccountingMap =>
  Object.fromEntries(event.SeatUserIds.filter(userId => userId !== -1).map(userId => [String(userId), null]))

const emptySettlements = (event: DealEvent): PlayerHandSettlementMap =>
  Object.fromEntries(event.SeatUserIds.filter(userId => userId !== -1).map(userId => [String(userId), null]))

/**
 * Derive exact signed per-player chip results from one causal DEAL -> RESULTS
 * pair. `RewardChip` is gross payout (and can be an uncalled return), so:
 *
 *   contribution = starting stack + gross payout - final stack
 *   net          = gross payout - contribution
 *
 * The equivalent final-start delta is used only after validating the payout,
 * lineup, and per-seat snapshots. EVT_ACTION.BetChip is intentionally not
 * summed: it is cumulative within each street, so replaying it as incremental
 * amounts would double-count calls/raises. Endpoint stacks also remain exact
 * when a redundant action was not captured. Any ambiguous or inconsistent
 * player remains null rather than receiving an estimated loss. Complete table
 * snapshots must also obey the game type's chip-conservation rule: tournament
 * chips are zero-sum, while Ring rake may remove chips but can never create
 * them. An unknown BattleType uses the Ring-safe rule (outflow is allowed,
 * chip creation is not) so a capture that starts before session metadata does
 * not erase legitimate raked winners.
 *
 * `inflow` は Ringのハンド中リバイイン／アドオンで席へ入ったチップ
 * （`deriveMidHandChipInflow`）。買い足しは「そのハンドの結果」ではないので、
 * 終了スタックから差し引いてから拠出額・保存則を評価する。省略時は流入ゼロ
 * （＝従来どおり厳格）として扱う。
 */
export const derivePlayerHandChipAccounting = (
  deal: DealEvent,
  results: HandResultsEvent,
  battleType: BattleType | undefined,
  inflow?: MidHandChipInflowMap
): PlayerHandChipAccountingMap => {
  const accounting = emptyAccounting(deal)
  const dealtUserIds = new Set(deal.SeatUserIds.filter(userId => userId !== -1))
  const isRing = isRingBattleType(battleType)
  const isTournament = battleType === BattleType.SIT_AND_GO ||
    battleType === BattleType.TOURNAMENT ||
    battleType === BattleType.FRIEND_SIT_AND_GO ||
    battleType === BattleType.CLUB_MATCH

  // Imported legacy/test rows can bypass the current API parser. Missing
  // settlement fields are an unknown result, never a reason to throw or infer.
  if (!Array.isArray(results.Results) ||
      !Array.isArray(results.SidePot) ||
      !Number.isSafeInteger(results.Pot) ||
      !Array.isArray(results.OtherPlayers)) return accounting

  if (results.Results.some(result => !dealtUserIds.has(result.UserId))) return accounting
  if (new Set(results.Results.map(result => result.UserId)).size !== results.Results.length) return accounting

  const grossPot = results.Pot + results.SidePot.reduce((sum, pot) => sum + pot, 0)
  const grossPayout = results.Results.reduce((sum, result) => sum + result.RewardChip, 0)
  if (!Number.isSafeInteger(grossPot) || grossPot !== grossPayout) return accounting

  const finalSeats = [
    ...(results.Player ? [results.Player] : []),
    ...results.OtherPlayers,
  ]
  const duplicateFinalSeat = finalSeats.some((snapshot, index) =>
    finalSeats.findIndex(candidate => candidate.SeatIndex === snapshot.SeatIndex) !== index)
  if (duplicateFinalSeat) return accounting

  const starts = new Map<number, number>()
  for (let seatIndex = 0; seatIndex < deal.SeatUserIds.length; seatIndex++) {
    if (deal.SeatUserIds[seatIndex] === -1) continue
    const startingStack = deriveStartingStack(deal, seatIndex)
    if (startingStack === null) continue
    starts.set(seatIndex, startingStack)
  }

  const finalStacks = new Map<number, number>()
  for (const snapshot of finalSeats) {
    const observedFinalStack = snapshot.Chip + snapshot.BetChip
    if (!Number.isSafeInteger(observedFinalStack) || observedFinalStack < 0) return accounting
    // ハンド中に買い足したチップはこのハンドの結果ではないため終了スタックから除く。
    // 買い足した席がそのチップを同じハンドで投じると、この「買い足しが無かったと
    // したときのスタック」は負になり得る（拠出は開始スタックを超えられる）。
    // 実在しないスタックではなく会計上の量なので、負値そのものは破損ではない。
    finalStacks.set(snapshot.SeatIndex, observedFinalStack - (inflow?.get(snapshot.SeatIndex) ?? 0))
  }

  const occupiedSeatIndexes = deal.SeatUserIds
    .map((userId, seatIndex) => ({ userId, seatIndex }))
    .filter(({ userId }) => userId !== -1)
    .map(({ seatIndex }) => seatIndex)

  // Tournament RESULTS commonly omits the local player's final snapshot even
  // when that player appears in Results[]. With complete starts and exactly
  // one such missing result seat, zero-sum conservation determines that final
  // stack exactly. Do not apply this to Ring (rake is unknown) or to a missing
  // folded seat whose contribution cannot be tied to a result row.
  const missingFinalSeatIndexes = occupiedSeatIndexes.filter(seatIndex => !finalStacks.has(seatIndex))
  if (isTournament &&
      missingFinalSeatIndexes.length === 1 &&
      occupiedSeatIndexes.every(seatIndex => starts.has(seatIndex))) {
    const missingSeatIndex = missingFinalSeatIndexes[0]!
    const missingUserId = deal.SeatUserIds[missingSeatIndex]
    if (missingUserId !== undefined && results.Results.some(result => result.UserId === missingUserId)) {
      const totalStartingStack = occupiedSeatIndexes.reduce((sum, seatIndex) => sum + starts.get(seatIndex)!, 0)
      const knownFinalStack = occupiedSeatIndexes.reduce((sum, seatIndex) => sum + (finalStacks.get(seatIndex) ?? 0), 0)
      const inferredFinalStack = totalStartingStack - knownFinalStack
      if (!Number.isSafeInteger(inferredFinalStack) || inferredFinalStack < 0) return accounting
      finalStacks.set(missingSeatIndex, inferredFinalStack)
    }
  }

  const hasCompleteTableSnapshots = occupiedSeatIndexes.every(seatIndex =>
    starts.has(seatIndex) && finalStacks.has(seatIndex))
  if (!isRing && !isTournament && !hasCompleteTableSnapshots) return accounting

  if (hasCompleteTableSnapshots) {
    const totalStartingStack = occupiedSeatIndexes.reduce((sum, seatIndex) => sum + starts.get(seatIndex)!, 0)
    const totalFinalStack = occupiedSeatIndexes.reduce((sum, seatIndex) => sum + finalStacks.get(seatIndex)!, 0)
    if (!Number.isSafeInteger(totalStartingStack) || !Number.isSafeInteger(totalFinalStack)) return accounting

    const chipDelta = totalFinalStack - totalStartingStack
    if ((isTournament && chipDelta !== 0) ||
        (isRing && chipDelta > 0) ||
        (!isTournament && !isRing && chipDelta > 0)) return accounting
  }

  for (let seatIndex = 0; seatIndex < deal.SeatUserIds.length; seatIndex++) {
    const userId = deal.SeatUserIds[seatIndex]
    if (userId === undefined || userId === -1) continue

    const startingStack = starts.get(seatIndex)
    const finalStack = finalStacks.get(seatIndex)
    if (startingStack === undefined || finalStack === undefined) continue

    const payout = results.Results.find(result => result.UserId === userId)?.RewardChip ?? 0
    const totalContribution = startingStack + payout - finalStack
    // 拠出できるのは開始スタック + ハンド中に買い足した分まで。
    const contributionCeiling = startingStack + (inflow?.get(seatIndex) ?? 0)
    if (!Number.isSafeInteger(totalContribution) ||
        totalContribution < 0 ||
        totalContribution > contributionCeiling) continue

    const netChips = payout - totalContribution
    if (!Number.isSafeInteger(netChips) || netChips !== finalStack - startingStack) continue

    accounting[String(userId)] = {
      grossPayout: payout,
      totalContribution,
      netChips,
    }
  }

  return accounting
}

/**
 * Derive an exact Ring-game rake from the same complete endpoint snapshots
 * used for signed player results. A partial snapshot is deliberately unknown:
 * treating an unobserved seat as zero contribution would falsely report
 * `Rake 0` in exported hand histories.
 *
 * This helper is intentionally Ring-only. Tournament rake is paid outside the
 * table chip economy and HandLogProcessor preserves its existing `Rake 0`
 * summary behavior separately.
 */
export const deriveHandRakeAccounting = (
  deal: DealEvent,
  results: HandResultsEvent,
  battleType: BattleType | undefined
): HandRakeAccounting | null => {
  if (!isRingBattleType(battleType)) return null

  // Imported legacy/test rows can bypass the current API parser. Guard every
  // collection before iterating or spreading so malformed snapshots remain an
  // unknown rake rather than aborting hand-log generation.
  if (!Array.isArray(deal.SeatUserIds) ||
      !Array.isArray(deal.OtherPlayers) ||
      !Array.isArray(results.OtherPlayers)) return null

  const occupiedSeatIndexes = deal.SeatUserIds
    .map((userId, seatIndex) => ({ userId, seatIndex }))
    .filter(({ userId }) => userId !== -1)
    .map(({ seatIndex }) => seatIndex)
  const occupiedSeatSet = new Set(occupiedSeatIndexes)
  const dealtUserIds = deal.SeatUserIds.filter(userId => userId !== -1)
  const dealSeats = [
    ...(deal.Player ? [deal.Player] : []),
    ...deal.OtherPlayers,
  ]
  const resultSeats = [
    ...(results.Player ? [results.Player] : []),
    ...results.OtherPlayers,
  ]
  const isExactSnapshot = (snapshots: ChipSnapshot[]): boolean =>
    snapshots.length === occupiedSeatIndexes.length &&
    new Set(snapshots.map(snapshot => snapshot.SeatIndex)).size === snapshots.length &&
    snapshots.every(snapshot => occupiedSeatSet.has(snapshot.SeatIndex))

  if (new Set(dealtUserIds).size !== dealtUserIds.length ||
      !isExactSnapshot(dealSeats) ||
      !isExactSnapshot(resultSeats)) return null

  const accounting = derivePlayerHandChipAccounting(deal, results, battleType)
  const entries = Object.values(accounting)
  if (entries.length === 0 || entries.some(entry => entry === null)) return null

  const totalContribution = entries.reduce((sum, entry) => sum + entry!.totalContribution, 0)
  const totalPayout = entries.reduce((sum, entry) => sum + entry!.grossPayout, 0)
  const rake = totalContribution - totalPayout

  if (!Number.isSafeInteger(totalContribution) ||
      !Number.isSafeInteger(totalPayout) ||
      !Number.isSafeInteger(rake) ||
      rake < 0) return null

  return { totalContribution, totalPayout, rake }
}

/**
 * Resolve gross payouts into contested awards and uncalled returns.
 *
 * A positive RewardChip is not sufficient to identify a winner: PokerChase
 * includes an unmatched excess contribution in RewardChip. Contribution tiers
 * make that distinction explicit. A tier reached by one contributor is an
 * uncalled return; a tier reached by two or more contributors is a contested
 * pot, whose eligible players are the result rows that reached that tier.
 *
 * The exact accounting gate intentionally runs first. If any contribution is
 * unknown, abbreviated legacy rows retain only their HandRanking=1 main-pot
 * winner signal; complete but inconsistent rows fail closed. Neither path
 * guesses from RewardChip alone. The gate also shares the tournament zero-sum
 * / Ring rake validation with Recent Hands. Exact winners are players with a
 * positive payout after their uncalled return is removed. The HandRanking
 * eligibility check prevents a payout from being attributed to a tier the
 * player could not have won, while still allowing a lower-ranked player to win
 * a side pot after the main-pot winner is no longer eligible.
 *
 * `handEvents` はこのハンドの `ApiHandEvent` 列（303〜306）。渡されると Ring の
 * ハンド中リバイイン／アドオンによるチップ流入を `deriveMidHandChipInflow` で
 * 復元し、終了スタックから差し引いてから会計する（#339）。省略しても結果は
 * 「流入ゼロ」で従来どおりであり、保存則ガードは弱まらない — 流入として
 * 認めるのはハンド内スナップショットが完全に整合している場合だけである。
 */
export const deriveHandSettlement = (
  deal: DealEvent,
  results: HandResultsEvent,
  battleType: BattleType | undefined,
  handEvents?: readonly ApiHandEvent[]
): HandSettlement => {
  const inflow = deriveMidHandChipInflow(deal, results, handEvents, battleType) ?? undefined
  const playerChipAccounting = derivePlayerHandChipAccounting(deal, results, battleType, inflow)
  const dealtSeatIndexes = deal.SeatUserIds
    .map((userId, seatIndex) => ({ userId, seatIndex }))
    .filter(({ userId }) => userId !== -1)
    .map(({ seatIndex }) => seatIndex)
  const hasIncompleteSnapshots = dealtSeatIndexes.some(seatIndex =>
    getDealSnapshot(deal, seatIndex) === undefined ||
    getResultSnapshot(results, seatIndex) === undefined)
  const unresolved = (): HandSettlement => ({
    playerChipAccounting,
    playerSettlements: emptySettlements(deal),
    // Imported legacy rows and intentionally abbreviated tests may omit seat
    // snapshots needed for exact tiers. Preserve only the unambiguous main-pot
    // winner signal in that compatibility case; never fall back to
    // RewardChip>0, which is the bug this resolver exists to prevent. Complete
    // but inconsistent settlements fail closed with no winners.
    winningPlayerIds: hasIncompleteSnapshots
      ? results.Results
          .filter(result =>
            result.RewardChip > 0 &&
            (result.HandRanking === 1 || result.RankType === RankType.NO_CALL))
          .map(result => result.UserId)
      : [],
  })

  const dealtUserIds = deal.SeatUserIds.filter(userId => userId !== -1)
  if (dealtUserIds.some(userId => playerChipAccounting[String(userId)] === null)) return unresolved()

  const contributions = new Map<number, number>(
    dealtUserIds.map(userId => [
      userId,
      playerChipAccounting[String(userId)]!.totalContribution,
    ])
  )
  const resultByUserId = new Map(results.Results.map(result => [result.UserId, result]))
  const uncalledReturns = new Map<number, number>(dealtUserIds.map(userId => [userId, 0]))
  const eligibleContestedWinners = new Set<number>()

  const contributionLevels = [...new Set(contributions.values())]
    .filter(contribution => contribution > 0)
    .sort((a, b) => a - b)
  let previousLevel = 0

  for (const level of contributionLevels) {
    const contributors = dealtUserIds.filter(userId => contributions.get(userId)! >= level)
    const tierAmount = (level - previousLevel) * contributors.length
    if (!Number.isSafeInteger(tierAmount) || tierAmount <= 0) return unresolved()

    if (contributors.length === 1) {
      const userId = contributors[0]!
      uncalledReturns.set(userId, uncalledReturns.get(userId)! + tierAmount)
    } else {
      const eligibleResults = contributors
        .map(userId => resultByUserId.get(userId))
        .filter((result): result is NonNullable<typeof result> =>
          result !== undefined &&
          (result.HandRanking > 0 ||
            (result.RankType === RankType.NO_CALL && result.RewardChip > 0)))
      if (eligibleResults.length === 0) return unresolved()

      const bestHandRanking = Math.min(...eligibleResults.map(result =>
        result.HandRanking > 0 ? result.HandRanking : 1))
      for (const result of eligibleResults) {
        const handRanking = result.HandRanking > 0 ? result.HandRanking : 1
        if (handRanking === bestHandRanking) eligibleContestedWinners.add(result.UserId)
      }
    }

    previousLevel = level
  }

  const playerSettlements: PlayerHandSettlementMap = {}
  let componentPayout = 0
  for (const userId of dealtUserIds) {
    const grossPayout = playerChipAccounting[String(userId)]!.grossPayout
    const uncalledReturn = uncalledReturns.get(userId)!
    const contestedAward = grossPayout - uncalledReturn
    if (!Number.isSafeInteger(contestedAward) || contestedAward < 0) return unresolved()
    if (contestedAward > 0 && !eligibleContestedWinners.has(userId)) return unresolved()

    playerSettlements[String(userId)] = { contestedAward, uncalledReturn }
    componentPayout += contestedAward + uncalledReturn
  }

  const grossPayout = results.Results.reduce((sum, result) => sum + result.RewardChip, 0)
  if (!Number.isSafeInteger(componentPayout) || componentPayout !== grossPayout) return unresolved()

  return {
    playerChipAccounting,
    playerSettlements,
    winningPlayerIds: dealtUserIds.filter(userId =>
      (playerSettlements[String(userId)]?.contestedAward ?? 0) > 0),
  }
}
