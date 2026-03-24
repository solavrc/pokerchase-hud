/**
 * Shared test helpers for stat unit tests
 */
import { ActionType, PhaseType, Position } from '../../types/game'
import type { Action, Phase, Session } from '../../types/entities'
import type { StatCalculationContext } from '../../types/stats'

export function makeAction(overrides: Partial<Action> & { actionType: ActionType }): Action {
  return {
    index: 0,
    playerId: 1,
    phase: PhaseType.FLOP,
    bet: 100,
    pot: 200,
    sidePot: [],
    position: Position.BTN,
    actionDetails: [],
    ...overrides
  } as Action
}

export function makePhase(phase: PhaseType, handId: number): Phase {
  return {
    phase,
    handId,
    seatUserIds: [1, 2],
    communityCards: []
  } as Phase
}

const dummySession: Session = {
  id: 'test-session',
  battleType: 0,
  name: 'Test',
  players: new Map(),
  reset: () => {}
}

export function makeCalcContext(overrides: Partial<StatCalculationContext> = {}): StatCalculationContext {
  return {
    playerId: 1,
    actions: [],
    phases: [],
    hands: [],
    allPlayerActions: [],
    allPlayerPhases: [],
    winningHandIds: new Set(),
    session: dummySession,
    ...overrides
  }
}
