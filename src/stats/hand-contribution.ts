import type { Action, Hand, Phase } from '../types/entities'
import { ActionDetail, ActionType, PhaseType, Position, type BattleType } from '../types/game'
import type { StatValue } from '../types/stats'
import { classifyTableSizeLayer, type TableSizeLayer } from '../utils/table-size'

/** 永続化した寄与の計算規則を識別する版。counterの意味・並びを変える変更はMUST更新する。 */
export const HAND_STAT_CONTRIBUTION_VERSION = 1 as const

/** HUDが履歴から計算する数値指標。並び順は永続counter vectorのABIでもある。 */
export const NUMERIC_STAT_IDS = [
  'hands',
  'vpip',
  'vpipF',
  'pfr',
  'cbet',
  'cbetFold',
  '3bet',
  '3betfold',
  'steal',
  'foldToSteal',
  'af',
  'afq',
  'wtsd',
  'wwsf',
  'wtsdNoAi',
  'wwsfNoAi',
  'wsd',
  'riverCallAccuracy',
] as const

export type NumericStatId = typeof NUMERIC_STAT_IDS[number]

/**
 * `full`は`vpipF`本体と同じcounterを参照するため、追加保存するのは残り3層だけ。
 * 1 player-handあたり2 numbersを節約しつつ、4層すべてを復元できる。
 */
const VPIP_F_EXTRA_COUNTER_KEYS = ['vpipF:4p', 'vpipF:3p', 'vpipF:hu'] as const
type VpipFExtraCounterKey = typeof VPIP_F_EXTRA_COUNTER_KEYS[number]
type HandStatCounterKey = NumericStatId | VpipFExtraCounterKey

/** version 1の固定ordinal。永続済みvectorはこの並びで解釈される。 */
export const HAND_STAT_COUNTER_ORDINALS = {
  hands: 0,
  vpip: 1,
  vpipF: 2,
  pfr: 3,
  cbet: 4,
  cbetFold: 5,
  '3bet': 6,
  '3betfold': 7,
  steal: 8,
  foldToSteal: 9,
  af: 10,
  afq: 11,
  wtsd: 12,
  wwsf: 13,
  wtsdNoAi: 14,
  wwsfNoAi: 15,
  wsd: 16,
  riverCallAccuracy: 17,
  'vpipF:4p': 18,
  'vpipF:3p': 19,
  'vpipF:hu': 20,
} as const satisfies Record<HandStatCounterKey, number>

/** `[numerator, denominator, ...]`を固定順に並べたDexie保存用vector。 */
export type HandStatCounterVector = number[]

export const HAND_STAT_COUNTER_VECTOR_LENGTH = 42

export type HandPosition = Position | 'unknown'

/** 1ハンドが1プレイヤーの統計へ与える、加減算可能な永続レコード。 */
export interface PlayerHandStatContribution {
  version: typeof HAND_STAT_CONTRIBUTION_VERSION
  playerId: number
  handId: number
  approxTimestamp: number | null
  battleType: BattleType | null
  tableSizeLayer: TableSizeLayer | null
  position: HandPosition
  counters: HandStatCounterVector
}

export type StatCounter = readonly [numerator: number, denominator: number]

function counterOffset(key: HandStatCounterKey): number {
  return HAND_STAT_COUNTER_ORDINALS[key] * 2
}

function assertCounterVector(vector: readonly number[]): void {
  if (vector.length !== HAND_STAT_COUNTER_VECTOR_LENGTH) {
    throw new RangeError(
      `Invalid hand stat counter vector length: ${vector.length} (expected ${HAND_STAT_COUNTER_VECTOR_LENGTH})`
    )
  }
}

function setCounter(
  vector: HandStatCounterVector,
  key: HandStatCounterKey,
  numerator: number,
  denominator: number
): void {
  const offset = counterOffset(key)
  vector[offset] = numerator
  vector[offset + 1] = denominator
}

/** 永続vectorと同じ長さの全0 counterを作る。 */
export function createEmptyHandStatCounterVector(): HandStatCounterVector {
  return Array<number>(HAND_STAT_COUNTER_VECTOR_LENGTH).fill(0)
}

/** 2つのcounter vectorを要素ごとに加算する。入力は変更しない。 */
export function addHandStatCounterVectors(
  left: readonly number[],
  right: readonly number[]
): HandStatCounterVector {
  assertCounterVector(left)
  assertCounterVector(right)
  return left.map((value, index) => value + right[index]!)
}

/** 2つのcounter vectorを要素ごとに減算する。入力は変更しない。 */
export function subtractHandStatCounterVectors(
  left: readonly number[],
  right: readonly number[]
): HandStatCounterVector {
  assertCounterVector(left)
  assertCounterVector(right)
  return left.map((value, index) => value - right[index]!)
}

/** 数値指標1件の加算済み分子・分母を読み出す。 */
export function getStatCounter(
  vector: readonly number[],
  statId: NumericStatId
): StatCounter {
  assertCounterVector(vector)
  const offset = counterOffset(statId)
  return [vector[offset]!, vector[offset + 1]!]
}

/** VPIP·Fの4層内訳を読み出す。`full`は主指標`vpipF`と同じ値。 */
export function getVpipFLayerCounter(
  vector: readonly number[],
  layer: TableSizeLayer
): StatCounter {
  const key: HandStatCounterKey = layer === 'full' ? 'vpipF' : `vpipF:${layer}`
  assertCounterVector(vector)
  const offset = counterOffset(key)
  return [vector[offset]!, vector[offset + 1]!]
}

/** counterを既存StatDefinitionの戻り値へ射影する。 */
export function statValueFromCounterVector(
  vector: readonly number[],
  statId: NumericStatId
): StatValue {
  const [numerator, denominator] = getStatCounter(vector, statId)
  return statId === 'hands' ? numerator : [numerator, denominator]
}

const VALID_POSITIONS = new Set<Position>([
  Position.BB,
  Position.SB,
  Position.BTN,
  Position.CO,
  Position.HJ,
  Position.UTG,
])

function resolvePosition(hand: Hand, playerId: number, actions: readonly Action[]): HandPosition {
  const preflopAction = actions.find(action => action.phase === PhaseType.PREFLOP)
  if (preflopAction) {
    return VALID_POSITIONS.has(preflopAction.position) ? preflopAction.position : 'unknown'
  }
  return hand.bigBlindUserId === playerId ? Position.BB : 'unknown'
}

function countActionDetail(actions: readonly Action[], detail: ActionDetail): number {
  return actions.filter(action => action.actionDetails.includes(detail)).length
}

function deriveCounters(
  hand: Hand,
  playerId: number,
  actions: readonly Action[],
  phases: readonly Phase[],
  tableSizeLayer: TableSizeLayer | null
): HandStatCounterVector {
  const counters = createEmptyHandStatCounterVector()
  const preflopActions = actions.filter(action => action.phase === PhaseType.PREFLOP)
  const postflopActions = actions.filter(action => action.phase !== PhaseType.PREFLOP)
  const flopPhases = phases.filter(phase => phase.phase === PhaseType.FLOP)
  const showdownPhases = phases.filter(phase => phase.phase === PhaseType.SHOWDOWN)
  const won = hand.winningPlayerIds.includes(playerId)
  // 旧ReadEntityStreamは勝者照合対象をFLOP/SHOWDOWN phaseが存在するhandへ
  // 絞っていた。古い不完全derived DBでもWWSFaの歴史値を変えない。
  const visibleToLegacyWinningLookup = flopPhases.length > 0 || showdownPhases.length > 0

  const vpipNumerator = countActionDetail(actions, ActionDetail.VPIP)
  const preflopOpportunity = hand.bigBlindUserId === playerId && preflopActions.length === 0 ? 0 : 1
  const pfrNumerator = preflopActions.some(action => action.actionType === ActionType.RAISE) ? 1 : 0
  const flopActionBase = actions.some(action => action.phase === PhaseType.FLOP) ? 1 : 0
  const sawFlop = flopPhases.length > 0 ? 1 : 0
  // 既存StatDefinitionの`p.handId &&`判定を、0も有効なHandIdのまま再現する。
  const hasTruthyHandId = hand.id !== 0
  const reachedShowdownAfterFlop = sawFlop > 0 && hasTruthyHandId ? showdownPhases.length : 0
  const aggressiveActions = postflopActions.filter(action =>
    action.actionType === ActionType.BET || action.actionType === ActionType.RAISE
  ).length
  const calls = postflopActions.filter(action => action.actionType === ActionType.CALL).length
  const aggressionDecisions = postflopActions.filter(action =>
    action.actionType === ActionType.BET ||
    action.actionType === ActionType.RAISE ||
    action.actionType === ActionType.CALL ||
    action.actionType === ActionType.FOLD
  ).length

  setCounter(counters, 'hands', 1, 0)
  setCounter(counters, 'vpip', vpipNumerator, preflopOpportunity)
  setCounter(counters, 'pfr', pfrNumerator, preflopOpportunity)
  setCounter(counters, 'cbet',
    actions.filter(action => action.phase === PhaseType.FLOP && action.actionDetails.includes(ActionDetail.CBET)).length,
    actions.filter(action => action.phase === PhaseType.FLOP && action.actionDetails.includes(ActionDetail.CBET_CHANCE)).length
  )
  setCounter(counters, 'cbetFold',
    countActionDetail(actions, ActionDetail.CBET_FOLD),
    countActionDetail(actions, ActionDetail.CBET_FOLD_CHANCE)
  )
  setCounter(counters, '3bet',
    countActionDetail(actions, ActionDetail.$3BET),
    countActionDetail(actions, ActionDetail.$3BET_CHANCE)
  )
  setCounter(counters, '3betfold',
    countActionDetail(actions, ActionDetail.$3BET_FOLD),
    countActionDetail(actions, ActionDetail.$3BET_FOLD_CHANCE)
  )
  setCounter(counters, 'steal',
    countActionDetail(actions, ActionDetail.STEAL),
    countActionDetail(actions, ActionDetail.STEAL_CHANCE)
  )
  setCounter(counters, 'foldToSteal',
    countActionDetail(actions, ActionDetail.FOLD_TO_STEAL),
    countActionDetail(actions, ActionDetail.FOLD_TO_STEAL_CHANCE)
  )
  setCounter(counters, 'af', aggressiveActions, calls)
  setCounter(counters, 'afq', aggressiveActions, aggressionDecisions)
  setCounter(counters, 'wtsd', reachedShowdownAfterFlop, sawFlop)
  setCounter(counters, 'wwsf', won && hasTruthyHandId ? flopPhases.length : 0, flopPhases.length)
  setCounter(counters, 'wtsdNoAi', flopActionBase > 0 && hasTruthyHandId ? showdownPhases.length : 0, flopActionBase)
  setCounter(counters, 'wwsfNoAi',
    won && visibleToLegacyWinningLookup && flopActionBase > 0 ? 1 : 0,
    flopActionBase
  )
  setCounter(counters, 'wsd', won && hasTruthyHandId ? showdownPhases.length : 0, showdownPhases.length)
  setCounter(counters, 'riverCallAccuracy',
    countActionDetail(actions, ActionDetail.RIVER_CALL_WON),
    countActionDetail(actions, ActionDetail.RIVER_CALL)
  )

  if (tableSizeLayer !== null) {
    const key: HandStatCounterKey = tableSizeLayer === 'full'
      ? 'vpipF'
      : `vpipF:${tableSizeLayer}`
    setCounter(counters, key, vpipNumerator, preflopOpportunity)
  }

  return counters
}

/**
 * 完成済みHand bundleを、着席playerIdごとの純粋な1ハンド寄与へ変換する。
 * actions/phasesに別ハンドが混ざっていても、handId一致行だけを使用する。
 */
function deriveContributionForPlayer(
  hand: Hand,
  handActions: readonly Action[],
  handPhases: readonly Phase[],
  tableSizeLayer: TableSizeLayer | null,
  playerId: number
): PlayerHandStatContribution {
  const playerActions = handActions.filter(action => action.playerId === playerId)
  const playerPhases = handPhases.filter(phase => phase.seatUserIds.includes(playerId))

  return {
    version: HAND_STAT_CONTRIBUTION_VERSION,
    playerId,
    handId: hand.id,
    // compareHandsNewestFirstと同じくNaN/Infinityは欠損時刻として扱う。
    approxTimestamp: Number.isFinite(hand.approxTimestamp) ? hand.approxTimestamp! : null,
    battleType: hand.session.battleType ?? null,
    tableSizeLayer,
    position: resolvePosition(hand, playerId, playerActions),
    counters: deriveCounters(
      hand,
      playerId,
      playerActions,
      playerPhases,
      tableSizeLayer
    ),
  }
}

/** 指定playerが着席していればその1件だけを導出し、未着席ならnullを返す。 */
export function derivePlayerHandStatContribution(
  hand: Hand,
  actions: readonly Action[],
  phases: readonly Phase[],
  playerId: number
): PlayerHandStatContribution | null {
  if (playerId === -1 || !hand.seatUserIds.includes(playerId)) return null
  const handActions = actions.filter(action => action.handId === hand.id)
  const handPhases = phases.filter(phase => phase.handId === hand.id)
  return deriveContributionForPlayer(
    hand,
    handActions,
    handPhases,
    classifyTableSizeLayer(hand),
    playerId
  )
}

export function derivePlayerHandStatContributions(
  hand: Hand,
  actions: readonly Action[],
  phases: readonly Phase[]
): PlayerHandStatContribution[] {
  const handActions = actions.filter(action => action.handId === hand.id)
  const handPhases = phases.filter(phase => phase.handId === hand.id)
  const playerIds = [...new Set(hand.seatUserIds.filter(playerId => playerId !== -1))]
  const tableSizeLayer = classifyTableSizeLayer(hand)

  return playerIds.map(playerId =>
    deriveContributionForPlayer(hand, handActions, handPhases, tableSizeLayer, playerId)
  )
}
