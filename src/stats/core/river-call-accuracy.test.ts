/**
 * River Call Accuracy Statistics Tests
 */

import { riverCallAccuracyStat } from './river-call-accuracy'
import { ActionDetail, ActionType, PhaseType, Position } from '../../types/game'
import type { Action, Session } from '../../types/entities'
import type { StatCalculationContext } from '../../types/stats'

describe('riverCallAccuracyStat', () => {
  const createAction = (
    playerId: number,
    phase: PhaseType,
    actionType: ActionType,
    actionDetails: ActionDetail[] = []
  ): Action => ({
    handId: 1,
    index: 0,
    playerId,
    phase,
    actionType,
    bet: 100,
    pot: 300,
    sidePot: [],
    position: Position.BTN,
    actionDetails
  })

  const createContext = (actions: Action[], winningHandIds: number[] = []): StatCalculationContext => ({
    playerId: 1,
    actions,
    phases: [],
    hands: [],
    allPlayerActions: actions,
    allPlayerPhases: [],
    winningHandIds: new Set(winningHandIds),
    session: {
      id: 'test',
      battleType: undefined,
      name: 'Test Session',
      players: new Map(),
      reset: () => {}
    } as Session
  })

  describe('calculate', () => {
    it('should return 0/0 when no river calls', () => {
      const context = createContext([])
      const result = riverCallAccuracyStat.calculate(context)
      expect(result).toEqual([0, 0])
    })

    it('should count river calls correctly', () => {
      const actions = [
        createAction(1, PhaseType.RIVER, ActionType.CALL, [ActionDetail.RIVER_CALL]),
        createAction(1, PhaseType.RIVER, ActionType.CALL, [ActionDetail.RIVER_CALL]),
        createAction(1, PhaseType.RIVER, ActionType.BET, [])
      ]
      const context = createContext(actions)
      const result = riverCallAccuracyStat.calculate(context)
      expect(result).toEqual([0, 2])
    })

    it('should count winning river calls correctly', () => {
      const actions = [
        createAction(1, PhaseType.RIVER, ActionType.CALL, [ActionDetail.RIVER_CALL, ActionDetail.RIVER_CALL_WON]),
        createAction(1, PhaseType.RIVER, ActionType.CALL, [ActionDetail.RIVER_CALL]),
        createAction(1, PhaseType.RIVER, ActionType.CALL, [ActionDetail.RIVER_CALL, ActionDetail.RIVER_CALL_WON])
      ]
      const context = createContext(actions, [1])
      const result = riverCallAccuracyStat.calculate(context)
      expect(result).toEqual([2, 3])
    })

    it('should calculate 100% accuracy when all river calls win', () => {
      const actions = [
        createAction(1, PhaseType.RIVER, ActionType.CALL, [ActionDetail.RIVER_CALL, ActionDetail.RIVER_CALL_WON]),
        createAction(1, PhaseType.RIVER, ActionType.CALL, [ActionDetail.RIVER_CALL, ActionDetail.RIVER_CALL_WON])
      ]
      const context = createContext(actions, [1])
      const result = riverCallAccuracyStat.calculate(context)
      expect(result).toEqual([2, 2])
    })

    it('should ignore non-river calls', () => {
      const actions = [
        createAction(1, PhaseType.TURN, ActionType.CALL, []),
        createAction(1, PhaseType.FLOP, ActionType.CALL, []),
        createAction(1, PhaseType.RIVER, ActionType.CALL, [ActionDetail.RIVER_CALL])
      ]
      const context = createContext(actions)
      const result = riverCallAccuracyStat.calculate(context)
      expect(result).toEqual([0, 1])
    })
  })

  describe('detectActionDetails', () => {
    it('should detect river call', () => {
      const context = {
        playerId: 1,
        actionType: ActionType.CALL as Exclude<ActionType, ActionType.ALL_IN>,
        phase: PhaseType.RIVER,
        phasePlayerActionIndex: 0,
        phasePrevBetCount: 2
      }
      const details = riverCallAccuracyStat.detectActionDetails!(context)
      expect(details).toContain(ActionDetail.RIVER_CALL)
    })

    it('should not detect river call for non-call actions', () => {
      const context = {
        playerId: 1,
        actionType: ActionType.BET as Exclude<ActionType, ActionType.ALL_IN>,
        phase: PhaseType.RIVER,
        phasePlayerActionIndex: 0,
        phasePrevBetCount: 1
      }
      const details = riverCallAccuracyStat.detectActionDetails!(context)
      expect(details).toEqual([])
    })

    it('should not detect river call for non-river phases', () => {
      const context = {
        playerId: 1,
        actionType: ActionType.CALL as Exclude<ActionType, ActionType.ALL_IN>,
        phase: PhaseType.TURN,
        phasePlayerActionIndex: 0,
        phasePrevBetCount: 2
      }
      const details = riverCallAccuracyStat.detectActionDetails!(context)
      expect(details).toEqual([])
    })
  })

  describe('format', () => {
    it('should format percentage correctly', () => {
      expect(riverCallAccuracyStat.format!([1, 2])).toBe('50.0% (1/2)')
      expect(riverCallAccuracyStat.format!([3, 4])).toBe('75.0% (3/4)')
      expect(riverCallAccuracyStat.format!([0, 0])).toBe('-')
    })
  })
})