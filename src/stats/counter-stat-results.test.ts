import type { Action, Hand, Phase, Session } from '../types/entities'
import { ActionDetail, ActionType, BattleType, PhaseType, Position } from '../types/game'
import type { StatCalculationContext } from '../types/stats'
import { defaultRegistry, defaultStatDisplayConfigs } from './index'
import { derivePlayerHandStatContribution, NUMERIC_STAT_IDS } from './hand-contribution'
import {
  buildStatResultsFromCounters,
  getEffectiveStatDisplayConfigs,
} from './counter-stat-results'

const PLAYER_ID = 10

const hand: Hand = {
  id: 100,
  approxTimestamp: 1_000,
  seatUserIds: [PLAYER_ID, 20, 30, 40, 50, 60],
  winningPlayerIds: [PLAYER_ID],
  smallBlind: 50,
  bigBlind: 100,
  bigBlindUserId: 60,
  session: { battleType: BattleType.SIT_AND_GO },
  results: [],
}

const actions: Action[] = [{
  handId: hand.id,
  index: 0,
  playerId: PLAYER_ID,
  phase: PhaseType.PREFLOP,
  actionType: ActionType.RAISE,
  bet: 300,
  pot: 450,
  sidePot: [],
  position: Position.BTN,
  actionDetails: [ActionDetail.VPIP, ActionDetail.STEAL_CHANCE, ActionDetail.STEAL],
}]

const phases: Phase[] = [{
  handId: hand.id,
  phase: PhaseType.FLOP,
  seatUserIds: [PLAYER_ID, 20],
  communityCards: [1, 2, 3],
}]

const session: Session = {
  battleType: BattleType.SIT_AND_GO,
  players: new Map([[PLAYER_ID, { name: 'Alice', rank: 'diamond' }]]),
  reset: () => {},
}

describe('counter stat result materialization', () => {
  test('all registered history stats are represented by the contribution ABI', () => {
    const registeredHistoryIds = defaultRegistry.getAll()
      .map(stat => stat.id)
      .filter(id => id !== 'playerName')
    expect(new Set(registeredHistoryIds)).toEqual(new Set(NUMERIC_STAT_IDS))
  })

  test('matches the legacy registry result including player name and VPIP·F tooltip', async () => {
    const contribution = derivePlayerHandStatContribution(hand, actions, phases, PLAYER_ID)
    expect(contribution).not.toBeNull()
    if (!contribution) return

    const context: StatCalculationContext = {
      playerId: PLAYER_ID,
      hands: [hand],
      actions,
      phases,
      allPlayerActions: actions,
      allPlayerPhases: phases,
      winningHandIds: new Set([hand.id]),
      session,
    }
    const configs = getEffectiveStatDisplayConfigs(defaultStatDisplayConfigs)

    expect(buildStatResultsFromCounters(contribution.counters, PLAYER_ID, session, configs))
      .toStrictEqual(await defaultRegistry.calculateWithConfig(context, configs))
  })

  test('forces compact/classifier dependencies without mutating saved config', () => {
    const saved = defaultStatDisplayConfigs.map(config => ({ ...config, enabled: false }))
    const effective = getEffectiveStatDisplayConfigs(saved)

    expect(saved.every(config => !config.enabled)).toBe(true)
    expect(effective.find(config => config.id === 'vpip')?.enabled).toBe(true)
    expect(effective.find(config => config.id === 'vpipF')?.enabled).toBe(true)
  })
})
