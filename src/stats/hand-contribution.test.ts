import type { Action, Hand, Phase, Session } from '../types/entities'
import { ActionDetail, ActionType, BattleType, PhaseType, Position } from '../types/game'
import type { StatCalculationContext, StatDefinition } from '../types/stats'
import { formatPercentage } from './utils'
import { handsStat } from './core/hands'
import { vpipStat } from './core/vpip'
import { vpipFullStat } from './core/vpip-full'
import { pfrStat } from './core/pfr'
import { cbetStat } from './core/cbet'
import { cbetFoldStat } from './core/cbet-fold'
import { threeBetStat } from './core/3bet'
import { threeBetFoldStat } from './core/3bet-fold'
import { stealStat } from './core/steal'
import { foldToStealStat } from './core/fold-to-steal'
import { afStat } from './core/af'
import { afqStat } from './core/afq'
import { wtsdStat } from './core/wtsd'
import { wwsfStat } from './core/wwsf'
import { wtsdNoAiStat } from './core/wtsd-no-ai'
import { wwsfNoAiStat } from './core/wwsf-no-ai'
import { wsdStat } from './core/wsd'
import { riverCallAccuracyStat } from './core/river-call-accuracy'
import {
  HAND_STAT_COUNTER_VECTOR_LENGTH,
  HAND_STAT_COUNTER_ORDINALS,
  NUMERIC_STAT_IDS,
  addHandStatCounterVectors,
  createEmptyHandStatCounterVector,
  derivePlayerHandStatContribution,
  derivePlayerHandStatContributions,
  getStatCounter,
  getVpipFLayerCounter,
  statValueFromCounterVector,
  subtractHandStatCounterVectors,
  type NumericStatId,
} from './hand-contribution'

const STAT_DEFINITIONS = {
  hands: handsStat,
  vpip: vpipStat,
  vpipF: vpipFullStat,
  pfr: pfrStat,
  cbet: cbetStat,
  cbetFold: cbetFoldStat,
  '3bet': threeBetStat,
  '3betfold': threeBetFoldStat,
  steal: stealStat,
  foldToSteal: foldToStealStat,
  af: afStat,
  afq: afqStat,
  wtsd: wtsdStat,
  wwsf: wwsfStat,
  wtsdNoAi: wtsdNoAiStat,
  wwsfNoAi: wwsfNoAiStat,
  wsd: wsdStat,
  riverCallAccuracy: riverCallAccuracyStat,
} satisfies Record<NumericStatId, StatDefinition>

const session: Session = {
  id: 'single-hand-parity',
  battleType: BattleType.SIT_AND_GO,
  name: 'single-hand-parity',
  players: new Map(),
  reset: () => {},
}

function makeAction(
  playerId: number,
  index: number,
  phase: PhaseType,
  actionType: Exclude<ActionType, ActionType.ALL_IN>,
  position: Position,
  actionDetails: ActionDetail[] = []
): Action {
  return {
    handId: 101,
    index,
    playerId,
    phase,
    actionType,
    bet: 100,
    pot: 200,
    sidePot: [],
    position,
    actionDetails,
  }
}

const hand: Hand = {
  id: 101,
  approxTimestamp: 1_750_000_000_000,
  seatUserIds: [1, 2, 3, 4, 5, 6],
  winningPlayerIds: [1],
  smallBlind: 50,
  bigBlind: 100,
  bigBlindUserId: 6,
  session: { id: 's1', battleType: BattleType.SIT_AND_GO, name: 'SNG' },
  results: [],
}

const actions: Action[] = [
  makeAction(1, 0, PhaseType.PREFLOP, ActionType.RAISE, Position.BTN,
    [ActionDetail.VPIP, ActionDetail.STEAL_CHANCE, ActionDetail.STEAL]),
  makeAction(1, 1, PhaseType.FLOP, ActionType.BET, Position.BTN,
    [ActionDetail.CBET_CHANCE, ActionDetail.CBET]),
  makeAction(1, 2, PhaseType.TURN, ActionType.RAISE, Position.BTN),
  makeAction(1, 3, PhaseType.RIVER, ActionType.CALL, Position.BTN,
    [ActionDetail.RIVER_CALL, ActionDetail.RIVER_CALL_WON]),
  makeAction(2, 4, PhaseType.PREFLOP, ActionType.FOLD, Position.SB,
    [ActionDetail.FOLD_TO_STEAL_CHANCE, ActionDetail.FOLD_TO_STEAL]),
  makeAction(3, 5, PhaseType.PREFLOP, ActionType.RAISE, Position.BB,
    [ActionDetail.VPIP, ActionDetail.$3BET_CHANCE, ActionDetail.$3BET]),
  makeAction(3, 6, PhaseType.FLOP, ActionType.CALL, Position.BB,
    [ActionDetail.CBET_FOLD_CHANCE]),
  makeAction(3, 7, PhaseType.RIVER, ActionType.CALL, Position.BB,
    [ActionDetail.RIVER_CALL]),
  makeAction(4, 8, PhaseType.PREFLOP, ActionType.RAISE, Position.CO,
    [ActionDetail.VPIP]),
  makeAction(4, 9, PhaseType.PREFLOP, ActionType.FOLD, Position.CO,
    [ActionDetail.$3BET_FOLD_CHANCE, ActionDetail.$3BET_FOLD]),
  makeAction(5, 10, PhaseType.PREFLOP, ActionType.CALL, Position.HJ,
    [ActionDetail.VPIP]),
  makeAction(5, 11, PhaseType.FLOP, ActionType.FOLD, Position.HJ,
    [ActionDetail.CBET_FOLD_CHANCE, ActionDetail.CBET_FOLD]),
  // 別ハンド行は純粋関数の境界で除外される。
  { ...makeAction(1, 99, PhaseType.RIVER, ActionType.CALL, Position.BTN, [ActionDetail.RIVER_CALL]), handId: 999 },
]

const phases: Phase[] = [
  { handId: 101, phase: PhaseType.FLOP, seatUserIds: [1, 3, 5], communityCards: [1, 2, 3] },
  { handId: 101, phase: PhaseType.TURN, seatUserIds: [1, 3], communityCards: [1, 2, 3, 4] },
  { handId: 101, phase: PhaseType.RIVER, seatUserIds: [1, 3], communityCards: [1, 2, 3, 4, 5] },
  { handId: 101, phase: PhaseType.SHOWDOWN, seatUserIds: [1, 3], communityCards: [1, 2, 3, 4, 5] },
  { handId: 999, phase: PhaseType.SHOWDOWN, seatUserIds: [1], communityCards: [] },
]

function legacyContext(
  playerId: number,
  sourceHand: Hand = hand,
  sourceActions: readonly Action[] = actions,
  sourcePhases: readonly Phase[] = phases
): StatCalculationContext {
  const playerActions = sourceActions.filter(action =>
    action.handId === sourceHand.id && action.playerId === playerId
  )
  const playerPhases = sourcePhases.filter(phase =>
    phase.handId === sourceHand.id && phase.seatUserIds.includes(playerId)
  )
  return {
    playerId,
    actions: playerActions,
    phases: playerPhases,
    hands: [sourceHand],
    allPlayerActions: playerActions,
    allPlayerPhases: playerPhases,
    winningHandIds: sourceHand.winningPlayerIds.includes(playerId)
      ? new Set([sourceHand.id])
      : new Set(),
    session,
  }
}

describe('derivePlayerHandStatContributions', () => {
  it('1ハンドの全18数値指標が既存StatDefinitionと厳密に一致する', async () => {
    expect(NUMERIC_STAT_IDS).toHaveLength(18)
    const contributions = derivePlayerHandStatContributions(hand, actions, phases)
    expect(contributions.map(contribution => contribution.playerId)).toEqual([1, 2, 3, 4, 5, 6])

    for (const contribution of contributions) {
      for (const statId of NUMERIC_STAT_IDS) {
        const legacyValue = await STAT_DEFINITIONS[statId].calculate(legacyContext(contribution.playerId))
        expect(statValueFromCounterVector(contribution.counters, statId)).toStrictEqual(legacyValue)
      }
    }

    // 全指標について分子または分母が非0のケースを含め、0同士の比較だけにしない。
    for (const statId of NUMERIC_STAT_IDS) {
      expect(contributions.some(({ counters }) => {
        const [numerator, denominator] = getStatCounter(counters, statId)
        return numerator !== 0 || denominator !== 0
      })).toBe(true)
    }
  })

  it('HANDはdenominator=0の加算counterから既存のscalar表示へ射影する', () => {
    const contribution = derivePlayerHandStatContributions(hand, actions, phases)[0]!
    expect(getStatCounter(contribution.counters, 'hands')).toEqual([1, 0])
    expect(statValueFromCounterVector(contribution.counters, 'hands')).toBe(1)
    expect(handsStat.format?.(statValueFromCounterVector(contribution.counters, 'hands'))).toBe('1')
    expect(formatPercentage(statValueFromCounterVector(contribution.counters, 'vpip')))
      .toBe(formatPercentage(vpipStat.calculate(legacyContext(1))))
  })

  it('HandId=0でも全18指標が既存のtruthy判定を含めて一致する', async () => {
    const zeroHand: Hand = { ...hand, id: 0 }
    const zeroActions = actions
      .filter(action => action.handId === hand.id)
      .map(action => ({ ...action, handId: 0 }))
    const zeroPhases = phases
      .filter(phase => phase.handId === hand.id)
      .map(phase => ({ ...phase, handId: 0 }))
    const contribution = derivePlayerHandStatContribution(zeroHand, zeroActions, zeroPhases, 1)!

    for (const statId of NUMERIC_STAT_IDS) {
      const legacyValue = await STAT_DEFINITIONS[statId]
        .calculate(legacyContext(1, zeroHand, zeroActions, zeroPhases))
      expect(statValueFromCounterVector(contribution.counters, statId)).toStrictEqual(legacyValue)
    }
  })

  it('phase欠落の歴史DBではWWSFaの旧winning lookup境界を維持する', () => {
    const incompleteHand: Hand = { ...hand, winningPlayerIds: [1] }
    const flopActionOnly = actions.filter(action =>
      action.playerId === 1 && action.phase === PhaseType.FLOP
    )
    const contribution = derivePlayerHandStatContribution(
      incompleteHand,
      flopActionOnly,
      [],
      1
    )!

    // 旧ReadEntityはFLOP/SHOWDOWN phaseのあるhandだけをwinningHandIdsへ
    // 入れたため、phase欠落時は勝者でもWWSFaの分子に入らない。
    expect(getStatCounter(contribution.counters, 'wwsfNoAi')).toEqual([0, 1])
  })

  it('NaNとInfinityのapproxTimestampを旧hand順序と同じ欠損へ正規化する', () => {
    for (const approxTimestamp of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const contribution = derivePlayerHandStatContribution(
        { ...hand, approxTimestamp },
        actions,
        phases,
        1
      )!
      expect(contribution.approxTimestamp).toBeNull()
    }
  })

  it('version 1の固定vector ordinalを独立した期待値で凍結する', () => {
    expect(HAND_STAT_COUNTER_ORDINALS).toStrictEqual({
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
    })
    expect(HAND_STAT_COUNTER_VECTOR_LENGTH).toBe(42)
  })

  it('position・filter tag・VPIP·F全層を永続可能な値として保持する', () => {
    const contributions = derivePlayerHandStatContributions(hand, actions, phases)
    expect(contributions[0]!).toMatchObject({
      playerId: 1,
      handId: 101,
      approxTimestamp: hand.approxTimestamp,
      battleType: BattleType.SIT_AND_GO,
      tableSizeLayer: 'full',
      position: Position.BTN,
    })
    expect(contributions[5]!.position).toBe(Position.BB)
    expect(getVpipFLayerCounter(contributions[0]!.counters, 'full')).toEqual([1, 1])
    expect(getVpipFLayerCounter(contributions[0]!.counters, '4p')).toEqual([0, 0])

    const unknownHand: Hand = {
      ...hand,
      id: 202,
      approxTimestamp: undefined,
      seatUserIds: [7, 8, -1, -1, -1],
      bigBlindUserId: 8,
      session: {},
    }
    const [unknown] = derivePlayerHandStatContributions(unknownHand, [], [])
    expect(unknown).toMatchObject({
      approxTimestamp: null,
      battleType: null,
      tableSizeLayer: null,
      position: 'unknown',
    })
  })

  it.each([
    ['full', [1, 2, 3, 4, 5, 6]],
    ['4p', [1, 2, 3, 4, -1, -1]],
    ['3p', [1, 2, 3, -1, -1, -1]],
    ['hu', [1, 2, -1, -1, -1, -1]],
  ] as const)('VPIP·Fの%s層だけへ1ハンド分を加算する', (layer, seatUserIds) => {
    const layeredHand: Hand = { ...hand, seatUserIds: [...seatUserIds] }
    const contribution = derivePlayerHandStatContribution(layeredHand, actions, phases, 1)!

    expect(contribution.tableSizeLayer).toBe(layer)
    for (const candidate of ['full', '4p', '3p', 'hu'] as const) {
      expect(getVpipFLayerCounter(contribution.counters, candidate))
        .toEqual(candidate === layer ? [1, 1] : [0, 0])
    }
    expect(statValueFromCounterVector(contribution.counters, 'vpipF'))
      .toEqual(layer === 'full' ? [1, 1] : [0, 0])
  })

  it('fixed vectorを全0生成し、入力を変更せず加算・減算できる', () => {
    const zero = createEmptyHandStatCounterVector()
    expect(zero).toHaveLength(HAND_STAT_COUNTER_VECTOR_LENGTH)
    expect(zero.every(value => value === 0)).toBe(true)

    const contribution = derivePlayerHandStatContributions(hand, actions, phases)[0]!
    const doubled = addHandStatCounterVectors(contribution.counters, contribution.counters)
    expect(getStatCounter(doubled, 'hands')).toEqual([2, 0])
    expect(getStatCounter(doubled, 'vpip')).toEqual([2, 2])
    expect(subtractHandStatCounterVectors(doubled, contribution.counters)).toEqual(contribution.counters)
    expect(getStatCounter(contribution.counters, 'hands')).toEqual([1, 0])
  })

  it('単一player APIは必要なrecordだけを作り、未着席playerをnullにする', () => {
    const contribution = derivePlayerHandStatContribution(hand, actions, phases, 3)
    expect(contribution?.playerId).toBe(3)
    expect(contribution?.position).toBe(Position.BB)
    expect(derivePlayerHandStatContribution(hand, actions, phases, 999)).toBeNull()
  })
})
