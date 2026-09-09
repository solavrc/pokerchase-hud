/**
 * verify-stats: 独立oracle。
 *
 * raw NDJSON eventからVPIP / PFR / 3BET / 3BETFOLD / CBET / CBETFOLD / AF / AFq /
 * WTSD / WSD / WWSF / WTSDa / WWSFa / STEAL / FOLDTOSTEAL / RCAを直接計算する。
 * `src/stats`と`src/entity-converter`からは何もimportしない。可読性のため、wire protocolの
 * enumだけをimportする（`src/types/api`の`ApiType`、`src/types/game`の`ActionType` /
 * `BetStatusType` / `RankType`）。以下の検出規則はpipeline実装を参照せず、
 * docs/statistics.mdとdocs/api-events.mdに記録されたevent semanticsから書き起こしている。
 *
 * この独立性がtoolの目的である。entity-converter.tsまたはstats/core/*.tsに不具合が入っても
 * このfileは継承しないため、2つの誤実装が黙って一致する代わりに、実際の挙動差がcompare.tsの
 * 不一致として現れる。このfileへpipeline / stats codeをimportしてはならない（MUST NOT）。
 *
 * 以下のsemanticsは意図的にpipelineと同期している。根拠は、このharnessを作成した2026-07の
 * 実data監査（entity-converter.ts / src/stats/coreとの照合、PR #93〜#97）と、PT4 / HM3の
 * 公式定義に対する2026-07 conformance監査（#115）である。
 *  (a) 「saw flop」（WTSD / WWSFの分母）はFLOPのEVT_DEAL_ROUNDにある席ごとの
 *      `BetStatus === BET_ABLE || BetStatus === ALL_IN`（Player + OtherPlayers）から導出する。
 *      PT4 staffはWTSD / WWSFを「flops seen」に基づくと説明し、preflop all-inも明示的に
 *      含める（"Those stats are based on flops seen, not based on flops seen when not all-in,
 *      so all-in spots will count"）。この母集団から除くのはFOLDED playerだけである
 *      （#97の修正を維持）。
 *  (a2) opt-inの意思決定重視variant WTSDa / WWSFa（#115）は代わりに「flop actionを行った」
 *      hand、すなわち`phase === FLOP`のEVT_ACTIONが1件以上あるhandを母集団にする。
 *      BET_ABLEでflopを見たplayerはflopで必ず1回以上actionし、preflop all-in playerは
 *      actionしない。2つ目のBetStatus導出を追加せず、lineage semantics（PT4 custom stat
 *      "WTSD without preflop all-ins" / Hand2Note "Flop Any Action"）を再現する。
 *  (a4b) 305省略時も配信済みの場合も、FLOP参加は人物証拠から導出する。
 *      帰属可能なactive snapshot・postflop行動と、board3枚以上＋2名以上の正当な
 *      showdownにおける直接UIDを肯定し、既知preflop FOLD・明示不参加snapshotを否定する。
 *      FOLD_OPENやResultsの存在だけで肯定しない。
 *  (a6) 有効な別人JOINと同ms以後の旧席ACTIONは帰属させない。最初の人物不明ACTION
 *      以後は文脈依存の6指標を止めるが、既知CALL/RAISE/FOLDによる各preflop試行は
 *      個別に保つ。ALL_INの型だけは厳密に新しい人物帰属済みProgressで回復できる。
 *      席交代があり精算が解けない場合、勝利に依存する4指標は未知試行として除外する。
 *  (a3) VPIP / PFRの分母からwalkを除く。playerがBB（Game.BigBlindSeat）でpreflop actionが0件の
 *      handを対象とする。真のwalkのほか、`NextActionSeat === -2`となりBBのcheckがEVT_ACTIONで
 *      送られない「BB action skip」も含む（docs/api-events.md「EVT_ACTION: 送信されないケース」）。
 *      どちらもBBに自発的なpreflop decisionはない。preflopでfoldしたBB以外のplayerはdecisionを
 *      行っているため機会に残す。PT4 / HM3標準の分母「hands - walks」と同じである。
 *  (a4) AF / AFqはPOSTFLOPだけを対象にする。PT4公式定義は"Ratio of the times a player makes a
 *      POSTFLOP aggressive action (bet or raise) to the times they call"。両方の分数から
 *      preflop actionを除く。
 *  (a5) actionのstreet帰属にはEVT_DEAL_ROUNDで進むcounterではなく、そのaction自身の
 *      EVT_ACTION.Progress.Phaseを使う（#340）。同一millisecondのreconnect burstでは同timestamp行が
 *      ApiTypeId順になり、streetを開く305より304が先に保存されるうえ、
 *      orderApiEventsForReplayが反転するのは孤立した2-event groupだけなのでcounterが遅れる
 *      （docs/api-events.md）。EVT_DEAL_ROUND自体が送られない場合も遅れる。唯一の例外はhand終了行
 *      （`Progress.NextActionSeat === -2`）で、実streetにかかわらずPhaseが3に固定されるため、
 *      その行だけrunning streetを維持する。この判定はraw payloadからここで再導出し、pipelineの
 *      resolveActionPhaseをimportしない。
 *  (d2) Ringのhand中rebuy / add-on流入（#339）: Ring seatはhand中にchipを購入できるため、
 *      `start + payout - final`はcontributionを過小評価し、table totalも増え得る。流入はhand自身の
 *      snapshotから復元する。street内の`Chip + BetChip`は不変で、street境界ではそのstreet最後の
 *      BetChipだけ減るため、この不変量を越えた増加が流入になる。減少はsnapshot chain自体の破損
 *      （fused buffer / dropped event）を表すので、hand全体をfallbackさせる。同じ恒等式を
 *      EVT_HAND_RESULTSに対してもう一度評価する
 *      （`final == last snapshot - remaining street bet + RewardChip`）。buy-in capへのRing auto top-upは
 *      ここにだけ現れるためである。excessだけを流入とし、shortfallではendpointの読取りを維持する
 *      （既知の「redundant action not captured」signature）。このfileの独立性契約に従い、
 *      deriveMidHandChipInflowを独立に再導出する。
 *  (b) positionはGame.ButtonSeat / SmallBlindSeat / BigBlindSeatだけから導出し、seat順の回転や推論を
 *      使わない。これにより空席（bustしたplayer）も正しく扱う。
 *  (c) showdown参加はRankTypeでgateする。NO_CALLとFOLD_OPENを除外し、その他（0〜9の実役と
 *      SHOWDOWN_MUCK）をshowdownとして数える。
 *  (d) winnerはcontested awardが正のplayerである。RewardChipにはuncalled excess returnも含まれる
 *      ため、oracleはDEAL / RESULTSのstack snapshotからcontribution tierを独立に再構築し、
 *      contributorが1人だけのtierをすべて除く。
 *  (e) River Call Accuracy（RCA）: 分子はcontested awardを得たhandでplayerが行ったriver CALL action、
 *      分母はそのplayerの全river CALL action。src/stats/core/river-call-accuracy.tsの
 *      RIVER_CALL / RIVER_CALL_WON ActionDetail tagと同じである。riverでCALLした時点でRIVER_CALLを
 *      付け、EVT_HAND_RESULTSでwinnerが分かった後、そのwinnerが同handで行った全RIVER_CALL actionへ
 *      RIVER_CALL_WONを追加する（entity-converter.ts / write-entity-stream.ts参照）。
 *  (f) VPIP·F（vpipF。opt-inのHUD original stat。handoverは
 *      workspace/reports/pokerchase-hud-vpip-f-handover.md）: (a3)と同じVPIPの分子・分母を
 *      「full table layer」のhandだけに適用する。table type相対で、6-max hand
 *      （SeatUserIds.length === 6）は6席中5席以上がdealt（-1以外）、4-max hand
 *      （SeatUserIds.length === 4）は4席すべてがdealtなら対象になる。このfileの独立性契約に従い、
 *      src/stats/core/vpip-full.tsの`classifyVpipFLayer`をimportせず独立に再導出する。
 */
import { ApiType } from '../../types/api'
import { ActionType, BattleType, BetStatusType, PhaseType, RankType } from '../../types/game'

type ActionTypeNum = Exclude<ActionType, ActionType.ALL_IN>

/** Minimal shapes for the raw NDJSON fields this oracle reads. No schema/type imports beyond the enums above. */
interface RawSeatPlayer {
  SeatIndex: number
  BetStatus: BetStatusType
  Chip?: number
  BetChip?: number
}
interface RawGame {
  ButtonSeat: number
  SmallBlindSeat: number
  BigBlindSeat: number
  Ante?: number
}
interface RawDealEvent {
  ApiTypeId: ApiType.EVT_DEAL
  SeatUserIds: number[]
  Game: RawGame
  Progress: RawProgress
  Player?: RawSeatPlayer
  OtherPlayers?: RawSeatPlayer[]
}
interface RawProgress {
  NextActionTypes: number[]
  NextActionSeat?: number
  Phase?: number
  Pot?: number
  SidePot?: number[]
}
interface RawActionEvent {
  ApiTypeId: ApiType.EVT_ACTION
  SeatIndex: number
  ActionType: ActionType
  BetChip: number
  Chip?: number
  Progress: RawProgress
}
interface RawDealRoundEvent {
  ApiTypeId: ApiType.EVT_DEAL_ROUND
  Player?: RawSeatPlayer
  OtherPlayers: RawSeatPlayer[]
  Progress: RawProgress & { Phase: number }
  CommunityCards?: number[]
}
interface RawResultEntry {
  UserId: number
  RankType: RankType
  HandRanking?: number
  RewardChip: number
}
interface RawHandResultsEvent {
  ApiTypeId: ApiType.EVT_HAND_RESULTS
  HandId: number
  Results: RawResultEntry[]
  CommunityCards?: number[]
  Pot?: number
  SidePot?: number[]
  Player?: RawSeatPlayer
  OtherPlayers?: RawSeatPlayer[]
}
interface RawSessionStartEvent {
  ApiTypeId: ApiType.EVT_ENTRY_QUEUED
  BattleType: BattleType
}
interface RawJoinEvent {
  ApiTypeId: ApiType.EVT_PLAYER_JOIN
  JoinUser: { UserId: number }
  JoinPlayer: { SeatIndex: number }
}
type RawEvent = (RawDealEvent | RawActionEvent | RawDealRoundEvent | RawHandResultsEvent | RawSessionStartEvent | RawJoinEvent | { ApiTypeId: number }) & { timestamp?: number }

/** 人物の証拠は行順ではなく、正当な別人JOINより厳密に早いtimestampで閉じる。 */
function rawPersonEvidence(deal: RawDealEvent, events: RawEvent[]) {
  const boundaries = new Map<number, RawEvent>()
  for (const event of events) {
    if (event.ApiTypeId !== ApiType.EVT_PLAYER_JOIN) continue
    const join = event as RawJoinEvent
    const seat = join.JoinPlayer?.SeatIndex
    const userId = join.JoinUser?.UserId
    if (!Number.isSafeInteger(seat) || !Number.isSafeInteger(userId) || userId < 0 ||
        deal.SeatUserIds[seat] === undefined || deal.SeatUserIds[seat] === -1 ||
        deal.SeatUserIds[seat] === userId) continue
    const prior = boundaries.get(seat)
    if (!prior || event.timestamp! < prior.timestamp!) boundaries.set(seat, event)
  }
  const supported = (seat: number, event: RawEvent) => {
    const boundary = boundaries.get(seat)
    return deal.SeatUserIds[seat] !== undefined && deal.SeatUserIds[seat] !== -1 &&
      (!boundary || (Number.isFinite(event.timestamp) && Number.isFinite(boundary.timestamp) &&
        event.timestamp! < boundary.timestamp!))
  }
  const omitted = events.filter(event => event.ApiTypeId === ApiType.EVT_ACTION &&
    boundaries.has((event as RawActionEvent).SeatIndex) &&
    !supported((event as RawActionEvent).SeatIndex, event))
  const earlier = (a: RawEvent, b: RawEvent) =>
    Number.isFinite(a.timestamp) && Number.isFinite(b.timestamp) && a.timestamp! < b.timestamp!
  const contextKnown = (event: RawEvent) => omitted.every(unknown => earlier(event, unknown))
  const normalizationKnown = (event: RawEvent, progressSource: RawEvent | undefined, menu: readonly number[] | undefined) => {
    const relevant = omitted.filter(unknown => !earlier(event, unknown))
    if (relevant.length === 0) return true
    return Boolean(menu && progressSource && earlier(progressSource, event) &&
      relevant.every(unknown => earlier(unknown, progressSource)))
  }
  return { boundaries, supported, omitted, earlier, contextKnown, normalizationKnown }
}

const rawSeatSnapshot = (
  event: { Player?: RawSeatPlayer, OtherPlayers?: RawSeatPlayer[] },
  seatIndex: number
): RawSeatPlayer | undefined => {
  if (event.Player?.SeatIndex === seatIndex) return event.Player
  return event.OtherPlayers?.find(player => player.SeatIndex === seatIndex)
}

const rawPaysAnte = (deal: RawDealEvent, seatIndex: number): boolean => {
  const betStatus = rawSeatSnapshot(deal, seatIndex)?.BetStatus
  return betStatus === undefined ||
    betStatus === BetStatusType.BET_ABLE ||
    betStatus === BetStatusType.ALL_IN
}

const rawStartingStack = (deal: RawDealEvent, seatIndex: number): number | null => {
  const snapshot = rawSeatSnapshot(deal, seatIndex)
  if (snapshot?.Chip === undefined || snapshot.BetChip === undefined) return null

  const chipsAfterAnte = snapshot.Chip + snapshot.BetChip
  if (!rawPaysAnte(deal, seatIndex)) return chipsAfterAnte

  const ante = deal.Game.Ante ?? 0
  if (chipsAfterAnte > 0 || ante === 0) return chipsAfterAnte + ante

  const anteAllInSeats = deal.SeatUserIds
    .map((userId, index) => ({ userId, index }))
    .filter(({ userId, index }) =>
      userId !== -1 &&
      rawPaysAnte(deal, index) &&
      (rawSeatSnapshot(deal, index)?.Chip ?? 0) +
        (rawSeatSnapshot(deal, index)?.BetChip ?? 0) === 0)
  if (anteAllInSeats.length > 1 && (deal.Progress.SidePot?.length ?? 0) > 0) return null

  const contributorCount = deal.SeatUserIds.reduce((count, userId, index) =>
    userId !== -1 && rawPaysAnte(deal, index) ? count + 1 : count, 0)
  const pot = deal.Progress.Pot
  if (pot === undefined || contributorCount <= 0 || pot % contributorCount !== 0) return null

  const inferredStack = pot / contributorCount
  return Number.isSafeInteger(inferredStack) && inferredStack > 0 && inferredStack <= ante
    ? inferredStack
    : null
}

/** EVT_ACTION.Progress.NextActionSeat marker for "hand over"; its Phase is pinned to 3. */
const HAND_ENDING_NEXT_ACTION_SEAT = -2

/**
 * Street this action belongs to (semantic-sync (a5), #340). Independent
 * re-derivation: the action carries the authoritative street in its own
 * payload, except on the hand-ending row where Phase is pinned to 3.
 */
const rawActionPhase = (actionEvent: RawActionEvent, runningPhase: number): number => {
  if (actionEvent.Progress?.NextActionSeat === HAND_ENDING_NEXT_ACTION_SEAT) return runningPhase
  const phase = actionEvent.Progress?.Phase
  return phase === 0 || phase === 1 || phase === 2 || phase === 3 ? phase : runningPhase
}

/**
 * Ring mid-hand chip inflow per seat (semantic-sync (d2), #339), or null when
 * it cannot be established -- in which case the caller keeps the strict
 * "no inflow" reading. Ring only: a tournament has no mid-hand top-up, so an
 * increase there is a corruption signature rather than a rebuy.
 */
const rawMidHandInflow = (
  deal: RawDealEvent,
  results: RawHandResultsEvent,
  handEvents: RawEvent[],
  battleType: BattleType | undefined
): Map<number, number> | null => {
  if (battleType !== BattleType.RING_GAME && battleType !== BattleType.FRIEND_RING_GAME) return null

  const stack = new Map<number, number>()
  const streetBet = new Map<number, number>()
  const street = new Map<number, number>()
  const inflow = new Map<number, number>()
  for (let seatIndex = 0; seatIndex < deal.SeatUserIds.length; seatIndex++) {
    if (deal.SeatUserIds[seatIndex] === -1) continue
    const snapshot = rawSeatSnapshot(deal, seatIndex)
    if (snapshot?.Chip === undefined || snapshot.BetChip === undefined) return null
    stack.set(seatIndex, snapshot.Chip + snapshot.BetChip)
    streetBet.set(seatIndex, snapshot.BetChip)
    street.set(seatIndex, deal.Progress.Phase ?? 0)
    inflow.set(seatIndex, 0)
  }

  const observe = (seatIndex: number, phase: number, chip: number, betChip: number): boolean => {
    const previous = stack.get(seatIndex)
    if (previous === undefined) return true // seat not dealt into this hand
    // A snapshot from a street already left behind carries no new information.
    // Equal-millisecond compound groups are stored in ApiTypeId order, so a 305
    // can land after the 304s of a LATER street (the same ordering that #340 is
    // about); accounting for it chronologically would refund an already-settled
    // street bet and read it back as a rebuy.
    if (phase < street.get(seatIndex)!) return true
    if (!Number.isSafeInteger(chip) || !Number.isSafeInteger(betChip)) return false
    const settled = phase === street.get(seatIndex) ? previous : previous - streetBet.get(seatIndex)!
    const delta = chip + betChip - settled
    if (delta < 0) return false
    inflow.set(seatIndex, inflow.get(seatIndex)! + delta)
    stack.set(seatIndex, chip + betChip)
    streetBet.set(seatIndex, betChip)
    street.set(seatIndex, phase)
    return true
  }

  // Table-level running street. The hand-ending row's fallback MUST come from
  // here, not from the acting seat's own last-seen street: with 304s stored
  // ahead of their 305, that seat may not have acted on the new street yet, and
  // a per-seat fallback would read its already-settled blind/bet as an
  // unexplained decrease and void the whole hand's inflow.
  let tableStreet = deal.Progress.Phase ?? 0

  for (const event of handEvents) {
    if (event.ApiTypeId === ApiType.EVT_ACTION) {
      const actionEvt = event as RawActionEvent
      if (actionEvt.Chip === undefined) return null
      const isHandEnding = actionEvt.Progress?.NextActionSeat === HAND_ENDING_NEXT_ACTION_SEAT
      if (!isHandEnding) tableStreet = Math.max(tableStreet, rawActionPhase(actionEvt, tableStreet))
      const phase = isHandEnding ? tableStreet : rawActionPhase(actionEvt, tableStreet)
      if (!observe(actionEvt.SeatIndex, phase, actionEvt.Chip, actionEvt.BetChip)) return null
    } else if (event.ApiTypeId === ApiType.EVT_DEAL_ROUND) {
      const roundEvt = event as RawDealRoundEvent
      const phase = roundEvt.Progress.Phase
      tableStreet = Math.max(tableStreet, phase)
      const seats = roundEvt.Player ? [roundEvt.Player, ...roundEvt.OtherPlayers] : roundEvt.OtherPlayers
      for (const seat of seats) {
        if (seat.Chip === undefined) return null
        // A street-opening snapshot is stale for a seat already acting on that street.
        if (phase <= (street.get(seat.SeatIndex) ?? -1)) continue
        if (!observe(seat.SeatIndex, phase, seat.Chip, seat.BetChip ?? 0)) return null
      }
      for (const [seatIndex, seatStreet] of street) {
        if (seatStreet >= phase) continue
        stack.set(seatIndex, stack.get(seatIndex)! - streetBet.get(seatIndex)!)
        streetBet.set(seatIndex, 0)
        street.set(seatIndex, phase)
      }
    }
  }

  const payoutByUserId = new Map(results.Results.map(result => [result.UserId, result.RewardChip]))
  const resultSeats = [
    ...(results.Player ? [results.Player] : []),
    ...(results.OtherPlayers ?? []),
  ]
  for (const seat of resultSeats) {
    const previous = stack.get(seat.SeatIndex)
    if (previous === undefined || seat.Chip === undefined) continue
    const userId = deal.SeatUserIds[seat.SeatIndex]
    const payout = userId === undefined ? 0 : payoutByUserId.get(userId) ?? 0
    const excess = seat.Chip + (seat.BetChip ?? 0) - (previous - streetBet.get(seat.SeatIndex)! + payout)
    if (excess > 0) inflow.set(seat.SeatIndex, inflow.get(seat.SeatIndex)! + excess)
  }
  return inflow
}

/**
 * Independent winner resolution for the verification oracle.
 *
 * This deliberately does not import the production settlement helper. Exact
 * endpoint contributions are `start + payout - final`; contribution levels
 * reached by one player are uncalled returns, while levels reached by two or
 * more players are contested. Abbreviated legacy rows retain only an explicit
 * main-pot/NO_CALL winner signal.
 */
const resolveContestedWinners = (
  deal: RawDealEvent,
  results: RawHandResultsEvent,
  battleType: BattleType | undefined,
  handEvents: RawEvent[]
): Set<number> | undefined => {
  const people = rawPersonEvidence(deal, handEvents)
  const fallback = () => people.boundaries.size > 0 ? undefined : new Set(
    results.Results
      .filter(result =>
        result.RewardChip > 0 &&
        (result.HandRanking === 1 || result.RankType === RankType.NO_CALL))
      .map(result => result.UserId)
  )
  if (!Array.isArray(results.Results) ||
      !Array.isArray(results.SidePot) ||
      !Number.isSafeInteger(results.Pot)) return fallback()

  const userIds = deal.SeatUserIds.filter(userId => userId !== -1)
  // Semantic-sync (d2): mid-hand rebuy chips are not this hand's result, so
  // remove them from the final stack before contributions are derived.
  const inflow = people.boundaries.size > 0 ? null : rawMidHandInflow(deal, results, handEvents, battleType)
  const resultByUserId = new Map(results.Results.map(result => [result.UserId, result]))
  const starts = new Map<number, number>()
  const finalStacks = new Map<number, number>()
  for (let seatIndex = 0; seatIndex < deal.SeatUserIds.length; seatIndex++) {
    const userId = deal.SeatUserIds[seatIndex]
    if (userId === undefined || userId === -1) continue
    const startingStack = rawStartingStack(deal, seatIndex)
    if (startingStack !== null) starts.set(seatIndex, startingStack)

    const final = rawSeatSnapshot(results, seatIndex)
    if (final?.Chip !== undefined && final.BetChip !== undefined &&
        people.supported(seatIndex, results as RawEvent)) {
      // A seat that spends chips it bought mid-hand has a NEGATIVE counterfactual
      // "without the rebuy" stack; that is an accounting quantity, not corruption.
      finalStacks.set(seatIndex, final.Chip + final.BetChip - (inflow?.get(seatIndex) ?? 0))
    }
  }

  const occupiedSeatIndexes = deal.SeatUserIds
    .map((userId, seatIndex) => ({ userId, seatIndex }))
    .filter(({ userId }) => userId !== -1)
    .map(({ seatIndex }) => seatIndex)
  const isTournament = battleType === BattleType.SIT_AND_GO ||
    battleType === BattleType.TOURNAMENT ||
    battleType === BattleType.FRIEND_SIT_AND_GO ||
    battleType === BattleType.CLUB_MATCH
  const missingFinalSeatIndexes = occupiedSeatIndexes.filter(seatIndex => !finalStacks.has(seatIndex))
  if (people.boundaries.size === 0 && isTournament &&
      missingFinalSeatIndexes.length === 1 &&
      occupiedSeatIndexes.every(seatIndex => starts.has(seatIndex))) {
    const missingSeatIndex = missingFinalSeatIndexes[0]!
    const missingUserId = deal.SeatUserIds[missingSeatIndex]
    if (missingUserId !== undefined && results.Results.some(result => result.UserId === missingUserId)) {
      const totalStartingStack = occupiedSeatIndexes.reduce((sum, seatIndex) => sum + starts.get(seatIndex)!, 0)
      const knownFinalStack = occupiedSeatIndexes.reduce((sum, seatIndex) => sum + (finalStacks.get(seatIndex) ?? 0), 0)
      const inferredFinalStack = totalStartingStack - knownFinalStack
      if (!Number.isSafeInteger(inferredFinalStack) || inferredFinalStack < 0) return fallback()
      finalStacks.set(missingSeatIndex, inferredFinalStack)
    }
  }

  const identityContributions = people.boundaries.size > 0
    ? rawIdentityContributions(deal, results, battleType, handEvents)
    : undefined
  if (people.boundaries.size > 0 && !identityContributions) return undefined
  const contributions = new Map<number, number>()
  for (let seatIndex = 0; seatIndex < deal.SeatUserIds.length; seatIndex++) {
    const userId = deal.SeatUserIds[seatIndex]
    if (userId === undefined || userId === -1) continue
    if (identityContributions) {
      contributions.set(userId, identityContributions.get(userId)!)
      continue
    }
    const startingStack = starts.get(seatIndex)
    const finalStack = finalStacks.get(seatIndex)
    if (startingStack === undefined || finalStack === undefined) return fallback()

    const payout = resultByUserId.get(userId)?.RewardChip ?? 0
    const contribution = startingStack + payout - finalStack
    // A seat can commit its starting stack plus anything it bought mid-hand.
    const contributionCeiling = startingStack + (inflow?.get(seatIndex) ?? 0)
    if (!Number.isSafeInteger(contribution) || contribution < 0 || contribution > contributionCeiling) return fallback()
    contributions.set(userId, contribution)
  }

  const grossPot = results.Pot! + results.SidePot!.reduce((sum, pot) => sum + pot, 0)
  const grossPayout = results.Results.reduce((sum, result) => sum + result.RewardChip, 0)
  const totalContribution = [...contributions.values()].reduce((sum, contribution) => sum + contribution, 0)
  if (!Number.isSafeInteger(grossPot) ||
      grossPot !== grossPayout ||
      totalContribution < grossPayout) return fallback()

  const uncalledReturns = new Map<number, number>(userIds.map(userId => [userId, 0]))
  const levels = [...new Set(contributions.values())]
    .filter(contribution => contribution > 0)
    .sort((a, b) => a - b)
  let previousLevel = 0
  for (const level of levels) {
    const contributors = userIds.filter(userId => contributions.get(userId)! >= level)
    if (contributors.length === 1) {
      const userId = contributors[0]!
      uncalledReturns.set(userId, uncalledReturns.get(userId)! + (level - previousLevel))
    }
    previousLevel = level
  }

  const winners = new Set<number>()
  for (const userId of userIds) {
    // Resultsに行がない人の未対抗返却も0払出との差を検査し、矛盾を既知の負けにしない。
    const contestedAward = (resultByUserId.get(userId)?.RewardChip ?? 0) - (uncalledReturns.get(userId) ?? 0)
    if (!Number.isSafeInteger(contestedAward) || contestedAward < 0) return fallback()
    if (contestedAward > 0) winners.add(userId)
  }
  return winners
}

/**
 * 席交代がある場合の勝者証拠。個人のsnapshot列と厳密に早いFOLDだけで投入を閉じ、
 * 退出後の現金残高や新occupantの資金を旧人へ移さない。製品の会計helperは共有しない。
 */
function rawIdentityContributions(
  deal: RawDealEvent, results: RawHandResultsEvent,
  battleType: BattleType | undefined, events: RawEvent[]
): Map<number, number> | undefined {
  if (battleType !== BattleType.RING_GAME && battleType !== BattleType.FRIEND_RING_GAME) return undefined
  const people = rawPersonEvidence(deal, events)
  // JOINと303〜306が同msなら、その席の精算はFOLD済みでも閉じない。他席304も衝突に含む。
  // 一人でも投入が未知ならtier勝者は解けないが、行動・到達の独立した証拠は保持する。
  if ([...people.boundaries.values()].some(join => Number.isFinite(join.timestamp) &&
      events.some(event => event.timestamp === join.timestamp &&
        [ApiType.EVT_DEAL, ApiType.EVT_ACTION, ApiType.EVT_DEAL_ROUND, ApiType.EVT_HAND_RESULTS].includes(event.ApiTypeId)))) return undefined
  const contributions = new Map<number, number>()
  for (let seat = 0; seat < deal.SeatUserIds.length; seat++) {
    const userId = deal.SeatUserIds[seat]!
    if (userId === -1) continue
    const initial = rawSeatSnapshot(deal, seat)
    const start = rawStartingStack(deal, seat)
    if (start === null || initial?.Chip === undefined || initial.BetChip === undefined ||
        !people.supported(seat, deal as RawEvent)) return undefined
    let stack = initial.Chip + initial.BetChip
    let bet = initial.BetChip
    let seatPhase = deal.Progress.Phase ?? 0
    let tablePhase = seatPhase
    let inflow = 0
    let valid = true
    let noAction = true
    let inactive = [BetStatusType.NOT_IN_PLAY, BetStatusType.ELIMINATED].includes(initial.BetStatus) && bet === 0
    let fold: { chip: number, inflow: number } | undefined
    const observe = (snapshot: RawSeatPlayer, phase: number) => {
      if (phase < seatPhase) return
      const chip = snapshot.Chip
      const nextBet = snapshot.BetChip ?? 0
      if (!Number.isSafeInteger(chip) || !Number.isSafeInteger(nextBet)) { valid = false; return }
      const delta = chip! + nextBet - (stack - (phase > seatPhase ? bet : 0))
      if (delta < 0) valid = false
      else inflow += delta
      stack = chip! + nextBet
      bet = nextBet
      seatPhase = phase
    }
    for (const event of events) {
      if (event.ApiTypeId === ApiType.EVT_ACTION) {
        const action = event as RawActionEvent
        tablePhase = rawActionPhase(action, tablePhase)
        if (action.SeatIndex !== seat || !people.supported(seat, event)) continue
        noAction = false
        observe({ ...action, BetStatus: BetStatusType.BET_ABLE }, tablePhase)
        if (action.ActionType === ActionType.FOLD && valid && action.Chip !== undefined) {
          fold = { chip: action.Chip, inflow }
        }
      } else if (event.ApiTypeId === ApiType.EVT_DEAL_ROUND) {
        const round = event as RawDealRoundEvent
        tablePhase = round.Progress.Phase
        if (!people.supported(seat, event)) continue
        const snapshot = rawSeatSnapshot(round, seat)
        if (snapshot && tablePhase > seatPhase) observe(snapshot, tablePhase)
        if (snapshot && (!([BetStatusType.NOT_IN_PLAY, BetStatusType.ELIMINATED] as number[]).includes(snapshot.BetStatus) || (snapshot.BetChip ?? 0) !== 0)) inactive = false
      }
    }
    const payout = results.Results.find(result => result.UserId === userId)?.RewardChip ?? 0
    let contribution: number | undefined
    const final = rawSeatSnapshot(results, seat)
    if (people.boundaries.has(seat) || !final) {
      if (valid && fold && payout === 0) contribution = start + fold.inflow - fold.chip
      else if (valid && noAction && inactive && payout === 0) contribution = 0
    } else if (valid && final.Chip !== undefined && final.BetChip !== undefined) {
      const finalStack = final.Chip + final.BetChip
      const extra = Math.max(0, finalStack - (stack - bet + payout))
      contribution = start + inflow + extra + payout - finalStack
    }
    if (contribution === undefined || !Number.isSafeInteger(contribution) || contribution < 0) return undefined
    contributions.set(userId, contribution)
  }
  return contributions
}

/** Fraction-valued stat: [numerator, denominator]. */
export type OracleFraction = [number, number]

export interface OraclePlayerResult {
  playerId: number
  hands: number
  stats: {
    vpip: OracleFraction
    pfr: OracleFraction
    '3bet': OracleFraction
    '3betfold': OracleFraction
    cbet: OracleFraction
    cbetFold: OracleFraction
    af: OracleFraction
    afq: OracleFraction
    wtsd: OracleFraction
    wsd: OracleFraction
    wwsf: OracleFraction
    wtsdNoAi: OracleFraction
    wwsfNoAi: OracleFraction
    steal: OracleFraction
    foldToSteal: OracleFraction
    riverCallAccuracy: OracleFraction
    vpipF: OracleFraction
  }
}

export type OracleResult = Map<number, OraclePlayerResult>

interface PlayerAcc {
  hands: Set<number>
  vpip: number
  pfrHands: Set<number>
  /**
   * VPIPの機会hand。人物不明行だけのplayerは未知、それ以外は既知の最初の行動とwalkで判定する。
   * playerがそのhandのBBでpreflop actionを1回も行わなかった場合、真のwalkと
   * 「BB action skip」（`NextActionSeat === -2`でBBのEVT_ACTIONなし）のどちらでも、
   * このsetから除外する。通常の「hands played」件数として他の箇所（`hands` statなど）で
   * 使う`hands`からは除外しない。どちらの場合もBBには自発的なpreflop decisionがない。
   * BB以外のfoldはdecisionを行っているため、機会として数える。docs/api-events.md参照。
   */
  vpipOpportunityHands: Set<number>
  pfrOpportunityHands: Set<number>
  /**
   * VPIP·F (vpipF, see semantic-sync (f) above): same VPIP counter/opportunity
   * pair as `vpip`/`vpipOpportunityHands`, but scoped to "full table layer"
   * hands only (table-type-relative: 6-max >= 5 dealt, 4-max = 4 dealt).
   */
  vpipF: number
  vpipFOpportunityHands: Set<number>
  threeBetChance: number
  threeBet: number
  threeBetFoldChance: number
  threeBetFold: number
  cbetChance: number
  cbet: number
  cbetFoldChance: number
  cbetFold: number
  betRaise: number
  call: number
  fold: number
  flopsSeen: Set<number>
  showdownsReached: Set<number>
  wonAtShowdownAllHands: Set<number>
  showdownAllCount: Set<number>
  wonAfterFlop: Set<number>
  winEligibleFlops: Set<number>
  /**
   * WTSDa/WWSFa base (#115, opt-in decision-focused variant lineage: PT4
   * custom-stat "WTSD without preflop all-ins" / Hand2Note "Flop Any Action").
   * Hands where the player took at least one FLOP-phase action -- a BET_ABLE
   * flop-seer always acts at least once on the flop, while a preflop all-in
   * player never does, so this set is exactly the "saw flop, not all-in"
   * population without needing a separate BetStatus re-derivation.
   */
  flopActionHands: Set<number>
  flopActionShowdowns: Set<number>
  flopActionWins: Set<number>
  winEligibleFlopActions: Set<number>
  stealChance: number
  steal: number
  foldToStealChance: number
  foldToSteal: number
  riverCall: number
  riverCallWon: number
}

function newAcc(): PlayerAcc {
  return {
    hands: new Set(), vpip: 0, pfrHands: new Set(), vpipOpportunityHands: new Set(), pfrOpportunityHands: new Set(),
    vpipF: 0, vpipFOpportunityHands: new Set(),
    threeBetChance: 0, threeBet: 0, threeBetFoldChance: 0, threeBetFold: 0,
    cbetChance: 0, cbet: 0, cbetFoldChance: 0, cbetFold: 0,
    betRaise: 0, call: 0, fold: 0,
    flopsSeen: new Set(), showdownsReached: new Set(),
    wonAtShowdownAllHands: new Set(), showdownAllCount: new Set(), wonAfterFlop: new Set(), winEligibleFlops: new Set(),
    flopActionHands: new Set(), flopActionShowdowns: new Set(), flopActionWins: new Set(), winEligibleFlopActions: new Set(),
    stealChance: 0, steal: 0, foldToStealChance: 0, foldToSteal: 0,
    riverCall: 0, riverCallWon: 0,
  }
}

type PositionLabel = 'BB' | 'SB' | 'BTN' | 'CO' | 'HJ' | 'UTG' | 'OTHER'

/**
 * Derive seat -> position labels purely from ButtonSeat/SmallBlindSeat/BigBlindSeat
 * (independent re-derivation of the same rule src/utils/position-utils.ts implements).
 */
function computePositions(seatUserIds: number[], buttonSeat: number, sbSeat: number, bbSeat: number): Map<number, PositionLabel> {
  const n = seatUserIds.length
  const activeSeats: number[] = []
  for (let i = 0; i < n; i++) if (seatUserIds[i] !== -1) activeSeats.push(i)

  const posMap = new Map<number, PositionLabel>()

  if (activeSeats.length === 2) {
    // Heads-up: BTN === SB seat, the other seat is BB.
    for (const seat of activeSeats) {
      const pid = seatUserIds[seat]!
      posMap.set(pid, seat === bbSeat ? 'BB' : 'SB')
    }
    return posMap
  }

  const idxInActiveBtn = activeSeats.indexOf(buttonSeat)
  const postBtnOrder: number[] = []
  for (let k = 1; k <= activeSeats.length; k++) {
    postBtnOrder.push(activeSeats[(idxInActiveBtn + k) % activeSeats.length]!)
  }
  // postBtnOrder ends with BTN itself; label from the back: BTN, CO, HJ, then UTG for the rest.
  const labels: PositionLabel[] = new Array(postBtnOrder.length).fill('OTHER')
  labels[labels.length - 1] = 'BTN'
  if (labels.length - 2 >= 0) labels[labels.length - 2] = 'CO'
  if (labels.length - 3 >= 0) labels[labels.length - 3] = 'HJ'
  for (let i = 0; i < labels.length - 3; i++) labels[i] = 'UTG'

  for (let i = 0; i < postBtnOrder.length; i++) {
    const seat = postBtnOrder[i]!
    let label = labels[i]!
    if (seat === sbSeat) label = 'SB'
    else if (seat === bbSeat) label = 'BB'
    posMap.set(seatUserIds[seat]!, label)
  }
  return posMap
}

interface ActionRec {
  playerId: number
  actionType: ActionTypeNum
}

/** 対象確認済みメニューで正規化する。新postflop街の先制BET例外は優先する（MUST）。 */
function normalizeAllIn(
  actionEvent: RawActionEvent,
  nextTypes: readonly number[] | undefined,
  phase: number,
  opensNewStreet: boolean
): ActionTypeNum {
  if (actionEvent.ActionType !== ActionType.ALL_IN) return actionEvent.ActionType as ActionTypeNum
  if (opensNewStreet && phase > PhaseType.PREFLOP) return ActionType.BET
  if (!nextTypes) return ActionType.CALL
  if (nextTypes.includes(ActionType.BET)) return ActionType.BET
  if (nextTypes.includes(ActionType.ALL_IN) && nextTypes.includes(ActionType.CALL)) return ActionType.RAISE
  // CHECK可能ならコールすべき差額は無い。PREFLOPではBBが存在するため
  // RAISE、他の街では先制BETとして数える（MUST）。最小額に届かない
  // ALL_INではRAISE/BET自体が選択肢に無くても、この区別は変わらない。
  if (nextTypes.includes(ActionType.ALL_IN) && nextTypes.includes(ActionType.CHECK)) {
    return phase === PhaseType.PREFLOP ? ActionType.RAISE : ActionType.BET
  }
  return ActionType.CALL
}

/** FLOPに必要な直接事実だけをrawから再計算する。本体の参加・人物helperは共有しない（MUST NOT）。 */
function rawFlopParticipants(deal: RawDealEvent, results: RawHandResultsEvent, events: RawEvent[], boardCount: number) {
  const { supported } = rawPersonEvidence(deal, events)
  const active = new Set<number>()
  const inactive = new Set<number>()
  const postflop = new Set<number>()
  let sawRound = false
  let phase = 0
  for (const event of events) {
    if (event.ApiTypeId === ApiType.EVT_ACTION) {
      const action = event as RawActionEvent
      phase = rawActionPhase(action, phase)
      if (!supported(action.SeatIndex, event)) continue
      const userId = deal.SeatUserIds[action.SeatIndex]!
      if (phase === 0 && action.ActionType === ActionType.FOLD) inactive.add(userId)
      if (phase > 0) postflop.add(userId)
    } else if (event.ApiTypeId === ApiType.EVT_DEAL_ROUND) {
      const round = event as RawDealRoundEvent
      phase = round.Progress.Phase
      if (phase !== 1) continue
      sawRound = true
      for (const player of round.Player ? [round.Player, ...round.OtherPlayers] : round.OtherPlayers) {
        if (!supported(player.SeatIndex, event)) continue
        const userId = deal.SeatUserIds[player.SeatIndex]!
        if (player.BetStatus === BetStatusType.BET_ABLE || player.BetStatus === BetStatusType.ALL_IN) active.add(userId)
        if ([BetStatusType.FOLDED, BetStatusType.NOT_IN_PLAY, BetStatusType.ELIMINATED].includes(player.BetStatus)) inactive.add(userId)
      }
    }
  }
  if (!sawRound && boardCount < 3) return undefined
  for (const userId of postflop) if (!inactive.has(userId)) active.add(userId)
  const showdown = results.Results.filter(result => (result.RankType >= 0 && result.RankType <= 9) || result.RankType === 11)
  if (boardCount >= 3 && showdown.length >= 2) {
    for (const result of showdown) if (!inactive.has(result.UserId)) active.add(result.UserId)
  }
  return new Set(deal.SeatUserIds.filter(userId => userId !== -1 && active.has(userId)))
}

export interface RunOracleOptions {
  /** Emit hand-by-hand trace lines to the given sink for the listed hand IDs (debugging aid). */
  traceHandIds?: Set<number>
  trace?: (line: string) => void
  /** rawから独立導出したaction単位の判断を検証へ渡す。 */
  observeAction?: (action: {
    handId: number, actionIndex: number, playerId: number, phase: number,
    actionType: number, canRaise: boolean | null, threeBetChance: boolean,
  }) => void
}

/**
 * 完成したhandからplayer別の統計を返す。CLIはorderAndFilterApplicationEventsForReplayで
 * 現行schemaの検証を済ませて渡す。人物境界を検証する直接呼出しも検証済みrawを使う（MUST）。
 * ここではwire schemaを独立に複製せず、schemaを通った事実の意味論だけを再計算する。
 */
export function runOracle(events: unknown[], options: RunOracleOptions = {}): OracleResult {
  const players = new Map<number, PlayerAcc>()
  const acc = (pid: number): PlayerAcc => {
    let a = players.get(pid)
    if (!a) { a = newAcc(); players.set(pid, a) }
    return a
  }

  const trace = options.trace ?? ((line: string) => console.error(line))
  const traceHandIds = options.traceHandIds ?? new Set<number>()

  let currentHand: RawEvent[] = []
  let currentBattleType: BattleType | undefined
  let currentHandBattleType: BattleType | undefined
  // rawの同ms群を索引にし、DEAL前・RESULTS後のどちらに並ぶJOINも候補handへ渡す。
  // 303/306自体の前hand・次hand対応や、その同ms群の因果順を復元する索引ではない。
  const joinsByTimestamp = new Map<number, RawEvent[]>()
  for (const raw of events) {
    const event = raw as RawEvent
    if (event.ApiTypeId !== ApiType.EVT_PLAYER_JOIN || !Number.isFinite(event.timestamp)) continue
    const group = joinsByTimestamp.get(event.timestamp!) ?? []
    group.push(event)
    joinsByTimestamp.set(event.timestamp!, group)
  }

  function processHand(handEvents: RawEvent[], battleType: BattleType | undefined): void {
    const dealEvt = handEvents.find((e): e is RawDealEvent => e.ApiTypeId === ApiType.EVT_DEAL)
    const resultsEvt = handEvents.find((e): e is RawHandResultsEvent => e.ApiTypeId === ApiType.EVT_HAND_RESULTS)
    // Incomplete hand (session boundary / dropped event) -- excluded, same as the
    // pipeline's `handState.hand.id > 0` completeness check.
    if (!dealEvt || !resultsEvt) return
    // 306と同msの301はその完成handにも属する。終了より後の別時刻の通知は含めない。
    const resultIndex = handEvents.indexOf(resultsEvt as RawEvent)
    handEvents = handEvents.filter((event, index) => index <= resultIndex ||
      (event.ApiTypeId === ApiType.EVT_PLAYER_JOIN && event.timestamp === (resultsEvt as RawEvent).timestamp))
    const boundaryJoins = [dealEvt, resultsEvt].flatMap(event =>
      joinsByTimestamp.get((event as RawEvent).timestamp!) ?? [])
    handEvents = [...new Set([...handEvents, ...boundaryJoins])]

    // Table-move chimera hand rejection, kept in sync with
    // hasResultsOutsideDealtLineup (src/types/game.ts) / entity-converter.ts /
    // write-entity-stream.ts: if EVT_HAND_RESULTS.Results references a UserId
    // absent from this hand's EVT_DEAL.SeatUserIds, the RESULTS belongs to the
    // destination table reached via a mid-hand EVT_ENTRY_QUEUED move, not to the
    // buffered DEAL. The oracle must drop the same hands the pipeline drops or
    // verify-stats would report a spurious divergence.
    {
      const dealtUserIds = new Set(dealEvt.SeatUserIds.filter(id => id !== -1))
      const hasForeignResult = resultsEvt.Results.some(({ UserId }) => !dealtUserIds.has(UserId))
      if (hasForeignResult) return
    }

    // Fused-buffer rejection, kept in sync with write-entity-stream.ts /
    // entity-converter.ts: a duplicate EVT_DEAL_ROUND for the same phase is the
    // signature of a mid-hand table move/rebalance fusing two hands into one
    // buffer (the "dual board" observation -- 12/12 such hands in the real
    // capture carry a mid-hand EVT_ENTRY_QUEUED/EVT_PLAYER_SEAT_ASSIGNED; 3 of
    // them slip past the results-membership guard because both hands happen to
    // involve the same players).
    {
      const seenPhases = new Set<number>()
      for (const e of handEvents) {
        if (e.ApiTypeId !== ApiType.EVT_DEAL_ROUND) continue
        const p = (e as RawDealRoundEvent).Progress.Phase
        if (seenPhases.has(p)) return
        seenPhases.add(p)
      }
    }

    const seatUserIds = dealEvt.SeatUserIds
    const people = rawPersonEvidence(dealEvt, handEvents)
    const { ButtonSeat: buttonSeat, SmallBlindSeat: sbSeat, BigBlindSeat: bbSeat } = dealEvt.Game
    const posMap = computePositions(seatUserIds, buttonSeat, sbSeat, bbSeat)
    const handId = resultsEvt.HandId
    // BB player for this hand (VPIP/PFR walk-exclusion, #115); undefined if the
    // seat is somehow empty (defensive -- BigBlindSeat always points to an
    // occupied seat in real data per docs/api-events.md).
    const bbUserId = bbSeat !== -1 && seatUserIds[bbSeat] !== -1 ? seatUserIds[bbSeat] : undefined

    // VPIP·F (semantic-sync (f)): "full table layer" classification, table-type
    // relative -- independent re-derivation of classifyVpipFLayer.
    const dealtCount = seatUserIds.filter(id => id !== -1).length
    const tableSize = seatUserIds.length
    const isFullLayerHand = (tableSize === 6 && dealtCount >= 5) || (tableSize === 4 && dealtCount === 4)

    for (const pid of seatUserIds) {
      if (pid === -1) continue
      acc(pid).hands.add(handId)
    }

    // Street counter advanced by EVT_DEAL_ROUND. Semantic-sync (a5), #340:
    // this is only the FALLBACK for a hand-ending action row -- every action's
    // own Progress.Phase is authoritative for that action's attribution.
    let runningPhase = 0 // 0=preflop
    let prevProgress: RawProgress | undefined = dealEvt.Progress
    let progressSource: RawEvent | undefined = dealEvt as RawEvent
    const preflopRaisers: number[] = []
    let cBetter: number | undefined
    let cBetExecuted = false
    let cBetPhase: number | undefined
    let stealRaiser: number | undefined
    const preflopActionsSoFar: ActionRec[] = []
    // このhandでpreflop actionを1回以上行ったplayer。VPIP / PFRのwalk除外（#115）では、
    // preflop actionが0件のBBは、真のwalkでも「BB action skip」でも自発的なdecisionが
    // なかったものとして扱う。docs/api-events.md参照。
    const playersWithPreflopAction = new Set<number>()
    const omittedPreflop = new Set<number>()
    const preflopFolds = new Set<number>()
    const unknownPreflopAllIn = new Set<number>()
    // Running count of community cards seen via EVT_DEAL_ROUND this hand
    // (a4b below: used to detect a fully-omitted DEAL_ROUND sequence by
    // comparing against the final board size once EVT_HAND_RESULTS arrives).
    let dealRoundCommunityCardCount = 0
    // Count of river CALL actions by player this hand (RIVER_CALL is tagged
    // per-action in the product; RIVER_CALL_WON is resolved for ALL of a
    // winning player's river-call actions once EVT_HAND_RESULTS is known).
    const riverCallsThisHand = new Map<number, number>()

    const phaseActionsMap = new Map<number, ActionRec[]>([[0, []]])

    const perPlayerPhaseActionIdx = new Map<string, number>()
    const traceLines: string[] = []
    let actionIndex = 0

    for (const event of handEvents) {
      if (event.ApiTypeId === ApiType.EVT_ACTION) {
        const actionEvt = event as RawActionEvent
        const seatIndex = actionEvt.SeatIndex
        const playerId = seatUserIds[seatIndex]!
        // Semantic-sync (a5), #340: this action's own street, not the counter.
        const phase = rawActionPhase(actionEvt, runningPhase)
        const opensNewStreet = phase !== runningPhase
        runningPhase = phase
        if (!people.supported(seatIndex, event)) {
          // 終端Phase=3は街の証拠ではない。同msのpostflop行ではpreflop未知を閉じない。
          const terminal = actionEvt.Progress.NextActionSeat === HAND_ENDING_NEXT_ACTION_SEAT
          const earlierPostflop = handEvents.some(other => people.earlier(other, event) && (
            (other.ApiTypeId === ApiType.EVT_DEAL_ROUND && (other as RawDealRoundEvent).Progress.Phase > 0) ||
            (other.ApiTypeId === ApiType.EVT_ACTION &&
              (other as RawActionEvent).Progress.NextActionSeat !== HAND_ENDING_NEXT_ACTION_SEAT &&
              [1, 2, 3].includes((other as RawActionEvent).Progress.Phase!))))
          if (people.boundaries.has(seatIndex) && (phase === 0 || (terminal && !earlierPostflop))) omittedPreflop.add(playerId)
          prevProgress = undefined
          progressSource = undefined
          continue
        }
        // oracleは本体helperを使わず、対象席・街・非空の条件を独立に判定する（MUST）。
        const menu = prevProgress?.Phase === phase && prevProgress.NextActionSeat === seatIndex &&
          (prevProgress.NextActionTypes?.length ?? 0) > 0 ? prevProgress.NextActionTypes : undefined
        const normType = normalizeAllIn(actionEvt, menu, phase, opensNewStreet)
        const contextKnown = people.contextKnown(event)
        const normalizationKnown = actionEvt.ActionType !== ActionType.ALL_IN ||
          people.normalizationKnown(event, progressSource, menu)
        if (phase === 0 && !normalizationKnown) unknownPreflopAllIn.add(playerId)
        if (phase === 0 && actionEvt.ActionType === ActionType.FOLD) preflopFolds.add(playerId)
        if (!phaseActionsMap.has(phase)) phaseActionsMap.set(phase, [])

        const actionsInPhase = phaseActionsMap.get(phase) ?? []
        const betRaiseSoFarInPhase = actionsInPhase.filter(a => a.actionType === ActionType.BET || a.actionType === ActionType.RAISE).length
        const curPrevBetCount = betRaiseSoFarInPhase + (phase === 0 ? 1 : 0)

        const key = `${phase}:${playerId}`
        const phasePlayerActionIndex = perPlayerPhaseActionIdx.get(key) ?? 0
        const rec: ActionRec = { playerId, actionType: normType }

        if (phase === 0) playersWithPreflopAction.add(playerId)

        // WTSDa/WWSFa base (#115): any FLOP-phase action by this player this hand.
        if (phase === PhaseType.FLOP) acc(playerId).flopActionHands.add(handId)

        // VPIP: preflop, player's first preflop action, CALL or RAISE.
        if (phase === 0 && phasePlayerActionIndex === 0 &&
            (actionEvt.ActionType === ActionType.ALL_IN || normType === ActionType.CALL || normType === ActionType.RAISE)) {
          acc(playerId).vpip++
          // VPIP·F (semantic-sync (f)): same trigger, scoped to full-layer hands.
          if (isFullLayerHand) acc(playerId).vpipF++
        }

        // PFR: any preflop RAISE (unique hand count).
        if (phase === 0 && normType === ActionType.RAISE && normalizationKnown) {
          acc(playerId).pfrHands.add(handId)
        }

        // 同じ席・ストリートの非空メニューだけがレイズ不能の証拠になる（MUST）。
        // 実RAISEと未観測メニューは機会を維持し、3BETFOLDには適用しない。
        const menuAllowsRaise = menu?.some(type => type === ActionType.RAISE) ||
          (menu?.some(type => type === ActionType.ALL_IN) &&
            menu.some(type => type === ActionType.CALL ||
              (phase === 0 && type === ActionType.CHECK)))
        const threeBetChance = contextKnown && phase === 0 && curPrevBetCount === 2 &&
          (normType === ActionType.RAISE || !menu || Boolean(menuAllowsRaise))
        options.observeAction?.({
          handId, actionIndex: actionIndex++, playerId, phase, actionType: normType,
          canRaise: menu ? Boolean(menuAllowsRaise) : null, threeBetChance,
        })
        if (threeBetChance) {
          acc(playerId).threeBetChance++
          if (normType === ActionType.RAISE) acc(playerId).threeBet++
        }
        if (contextKnown && phase === 0 && curPrevBetCount === 3) {
          acc(playerId).threeBetFoldChance++
          if (normType === ActionType.FOLD) acc(playerId).threeBetFold++
        }

        // STEAL: preflop, no raise yet, late position (CO/BTN/SB), everyone before folded.
        const posLabel = posMap.get(playerId)
        if (contextKnown && phase === 0 && curPrevBetCount === 1 && (posLabel === 'CO' || posLabel === 'BTN' || posLabel === 'SB')) {
          const allFoldedBefore = preflopActionsSoFar.every(a => a.actionType === ActionType.FOLD)
          if (allFoldedBefore) {
            acc(playerId).stealChance++
            if (normType === ActionType.RAISE) {
              acc(playerId).steal++
              stealRaiser = playerId
            }
          }
        }

        // FOLD TO STEAL: blinds facing the identified steal raiser.
        if (contextKnown && phase === 0 && curPrevBetCount === 2 && (posLabel === 'SB' || posLabel === 'BB') && stealRaiser !== undefined && stealRaiser !== playerId) {
          acc(playerId).foldToStealChance++
          if (normType === ActionType.FOLD) acc(playerId).foldToSteal++
        }

        // CBET / CBETFOLD.
        if (contextKnown && phase !== 0 && cBetter !== undefined) {
          if (curPrevBetCount === 0) {
            if (cBetter === playerId) {
              if (phase === PhaseType.FLOP) acc(playerId).cbetChance++
              if (normType === ActionType.BET) {
                if (phase === PhaseType.FLOP) acc(playerId).cbet++
                cBetExecuted = true
                cBetPhase = phase
                cBetter = undefined
              } else {
                cBetter = undefined // missed opportunity
              }
            } else if (normType === ActionType.BET) {
              cBetter = undefined // donk bet
            }
          }
        }
        if (contextKnown && phase !== 0 && cBetExecuted && cBetPhase === phase && curPrevBetCount === 1) {
          acc(playerId).cbetFoldChance++
          if (normType === ActionType.FOLD) acc(playerId).cbetFold++
        }

        // AF / AFq: PT4 official definition is POSTFLOP-only ("Ratio of the
        // times a player makes a POSTFLOP aggressive action (bet or raise) to
        // the times they call"), #115. Preflop actions are excluded entirely.
        if (phase !== 0 && normalizationKnown) {
          if (normType === ActionType.BET || normType === ActionType.RAISE) acc(playerId).betRaise++
          if (normType === ActionType.CALL) acc(playerId).call++
          if (normType === ActionType.FOLD) acc(playerId).fold++
        }

        // RCA: RIVER_CALL is tagged on every river CALL action (denominator);
        // RIVER_CALL_WON is resolved below, once Results is known.
        if (phase === PhaseType.RIVER && normType === ActionType.CALL && normalizationKnown) {
          riverCallsThisHand.set(playerId, (riverCallsThisHand.get(playerId) ?? 0) + 1)
        }

        if (contextKnown && phase === 0 && normType === ActionType.RAISE) {
          preflopRaisers.push(playerId)
          cBetter = playerId
        }

        actionsInPhase.push(rec)
        phaseActionsMap.set(phase, actionsInPhase)
        perPlayerPhaseActionIdx.set(key, phasePlayerActionIndex + 1)
        if (phase === 0) preflopActionsSoFar.push(rec)

        prevProgress = actionEvt.Progress
        progressSource = event

        if (traceHandIds.has(handId)) {
          traceLines.push(`  seat${seatIndex}(P${playerId}) phase=${phase} raw=${actionEvt.ActionType} norm=${normType} prevBet=${curPrevBetCount} bet=${actionEvt.BetChip}`)
        }
      } else if (event.ApiTypeId === ApiType.EVT_ENTRY_QUEUED) {
        // 201はハンドを捨てず、直前メニューの根拠だけを失効させる（MUST）。
        prevProgress = undefined
        progressSource = undefined
      } else if (event.ApiTypeId === ApiType.EVT_DEAL_ROUND) {
        const roundEvt = event as RawDealRoundEvent
        runningPhase = roundEvt.Progress.Phase
        if (!phaseActionsMap.has(runningPhase)) phaseActionsMap.set(runningPhase, [])
        prevProgress = roundEvt.Progress
        progressSource = event
        // a4b: accumulate board size as actually dealt via EVT_DEAL_ROUND, to
        // compare against the final board once EVT_HAND_RESULTS arrives.
        dealRoundCommunityCardCount += roundEvt.CommunityCards?.length ?? 0

        if (runningPhase === 1) {
          cBetter = preflopRaisers.length > 0 ? preflopRaisers[preflopRaisers.length - 1] : undefined
        }
        if (traceHandIds.has(handId)) {
          traceLines.push(`[DEAL_ROUND phase=${runningPhase}]`)
        }
      }
    }

    const finalBoardCardCount = dealRoundCommunityCardCount + (resultsEvt.CommunityCards?.length ?? 0)
    const flopActivePlayers = rawFlopParticipants(dealEvt, resultsEvt, handEvents, finalBoardCardCount)

    // Showdown / WTSD / WSD / WWSF determination from Results.
    const results = resultsEvt.Results || []
    // Semantic-sync (d): independently remove uncalled-only contribution tiers.
    const winners = resolveContestedWinners(dealEvt, resultsEvt, battleType, handEvents)

    // Semantic-sync (e): RIVER_CALL_WON is added to every RIVER_CALL action
    // taken by a player who wins a contested award in this hand.
    for (const [pid, count] of riverCallsThisHand) {
      if (winners) acc(pid).riverCall += count
      if (winners?.has(pid)) acc(pid).riverCallWon += count
    }

    const showdownPlayers = new Set(results
      .filter(result => (result.RankType >= 0 && result.RankType <= 9) || result.RankType === RankType.SHOWDOWN_MUCK)
      .map(result => result.UserId))
    for (const r of results) {
      const pid = r.UserId
      // Semantic-sync (c): showdown participation is RankType-gated (NO_CALL and
      // FOLD_OPEN excluded; SHOWDOWN_MUCK and all real ranks count).
      const isShowdownParticipant = showdownPlayers.size >= 2 && showdownPlayers.has(pid)
      if (isShowdownParticipant && winners) {
        acc(pid).showdownAllCount.add(handId) // WSD denominator: ALL showdowns incl preflop all-in.
        if (winners.has(pid)) acc(pid).wonAtShowdownAllHands.add(handId)
      }
      if (flopActivePlayers?.has(pid) && isShowdownParticipant) {
        acc(pid).showdownsReached.add(handId) // WTSD numerator (flop seen -> showdown).
      }
      // WTSDa numerator (#115): base hand (flop action taken) that reached showdown.
      if (acc(pid).flopActionHands.has(handId) && isShowdownParticipant) {
        acc(pid).flopActionShowdowns.add(handId)
      }
    }

    if (traceHandIds.has(handId)) {
      trace(`--- Hand ${handId} --- seats=${JSON.stringify(seatUserIds)} btn=${buttonSeat} sb=${sbSeat} bb=${bbSeat}`)
      traceLines.forEach(trace)
      trace(`Results: ${JSON.stringify(results)}`)
    }

    if (flopActivePlayers) {
      for (const pid of flopActivePlayers) {
        acc(pid).flopsSeen.add(handId)
        if (winners) acc(pid).winEligibleFlops.add(handId)
        if (winners?.has(pid)) acc(pid).wonAfterFlop.add(handId)
      }
    }

    // WWSFa numerator (#115): base hand (flop action taken) that this player won.
    // Only players who acted on the flop can have this hand in flopActionHands,
    // so iterate the seated players for this hand rather than all known players.
    for (const pid of seatUserIds) {
      if (pid === -1) continue
      if (acc(pid).flopActionHands.has(handId) && winners) {
        acc(pid).winEligibleFlopActions.add(handId)
        if (winners.has(pid)) acc(pid).flopActionWins.add(handId)
      }
    }

    // VPIP/PFR opportunity hands (#115, PT4/HM walk-exclusion standard):
    // every seated player gets this hand as an opportunity UNLESS they are the
    // BB and never took a preflop action (true walk, or the "BB action skip"
    // path where all other players are all-in/folded before the BB acts).
    // Non-BB players who folded preflop still made a decision, so their
    // opportunity is retained even with zero preflop actions being impossible
    // for them (folding IS an action).
    for (const pid of seatUserIds) {
      if (pid === -1) continue
      const isBbWalk = pid === bbUserId && !playersWithPreflopAction.has(pid)
      const hasAction = playersWithPreflopAction.has(pid)
      const vpipKnown = !isBbWalk && (hasAction || !omittedPreflop.has(pid))
      if (vpipKnown) {
        acc(pid).vpipOpportunityHands.add(handId)
        // VPIP·F opportunity set (semantic-sync (f)): same walk-exclusion rule,
        // scoped to full-layer hands only.
        if (isFullLayerHand) acc(pid).vpipFOpportunityHands.add(handId)
      }
      if (acc(pid).pfrHands.has(handId) || (vpipKnown && !unknownPreflopAllIn.has(pid) &&
          (!omittedPreflop.has(pid) || preflopFolds.has(pid)))) acc(pid).pfrOpportunityHands.add(handId)
    }
  }

  for (const raw of events) {
    const e = raw as RawEvent
    if (e.ApiTypeId === ApiType.EVT_ENTRY_QUEUED) {
      currentBattleType = (e as RawSessionStartEvent).BattleType
    }
    if (e.ApiTypeId === ApiType.EVT_DEAL) {
      if (currentHand.length > 0) processHand(currentHand, currentHandBattleType)
      currentHand = [e]
      currentHandBattleType = currentBattleType
    } else if (currentHand.length > 0) {
      currentHand.push(e)
    }
  }
  if (currentHand.length > 0) processHand(currentHand, currentHandBattleType)

  const result: OracleResult = new Map()
  for (const [pid, a] of players.entries()) {
    result.set(pid, {
      playerId: pid,
      hands: a.hands.size,
      stats: {
        // VPIP/PFR denominators use the walk-excluded opportunity set (#115),
        // not the raw hands-played count.
        vpip: [a.vpip, a.vpipOpportunityHands.size],
        pfr: [a.pfrHands.size, a.pfrOpportunityHands.size],
        '3bet': [a.threeBet, a.threeBetChance],
        '3betfold': [a.threeBetFold, a.threeBetFoldChance],
        cbet: [a.cbet, a.cbetChance],
        cbetFold: [a.cbetFold, a.cbetFoldChance],
        af: [a.betRaise, a.call],
        afq: [a.betRaise, a.betRaise + a.call + a.fold],
        wtsd: [a.showdownsReached.size, a.flopsSeen.size],
        wsd: [a.wonAtShowdownAllHands.size, a.showdownAllCount.size],
        wwsf: [a.wonAfterFlop.size, a.winEligibleFlops.size],
        // WTSDa/WWSFa (#115): opt-in decision-focused variants, flop-action base.
        wtsdNoAi: [a.flopActionShowdowns.size, a.flopActionHands.size],
        wwsfNoAi: [a.flopActionWins.size, a.winEligibleFlopActions.size],
        steal: [a.steal, a.stealChance],
        foldToSteal: [a.foldToSteal, a.foldToStealChance],
        riverCallAccuracy: [a.riverCallWon, a.riverCall],
        vpipF: [a.vpipF, a.vpipFOpportunityHands.size],
      }
    })
  }
  return result
}
