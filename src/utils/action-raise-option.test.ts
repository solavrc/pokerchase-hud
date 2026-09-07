import type { Progress } from '../types'
import { ActionType, PhaseType } from '../types/game'
import { getApplicableActionMenu, getRaiseAvailability } from './action-raise-option'

const progress = (overrides: Partial<Progress> = {}): Progress => ({
  Phase: PhaseType.PREFLOP, NextActionSeat: 1,
  NextActionTypes: [ActionType.FOLD, ActionType.CALL],
  Pot: 500, SidePot: [], MinRaise: 500, NextExtraLimitSeconds: 15,
  ...overrides,
})

describe('getRaiseAvailability', () => {
  it.each([
    [[ActionType.FOLD, ActionType.CALL], false],
    [[ActionType.FOLD, ActionType.ALL_IN], false],
    [[ActionType.FOLD, ActionType.CALL, ActionType.ALL_IN], true],
    [[ActionType.FOLD, ActionType.CALL, ActionType.RAISE], true],
    [[ActionType.CHECK, ActionType.ALL_IN], true],
  ] as const)('同じ席・ストリートの選択肢 %j からレイズ可否を判定する', (options, expected) => {
    expect(getRaiseAvailability(getApplicableActionMenu(progress({ NextActionTypes: [...options] }), 1, PhaseType.PREFLOP), PhaseType.PREFLOP))
      .toBe(expected)
  })

  it.each([
    undefined,
    progress({ NextActionTypes: [] }),
    progress({ NextActionSeat: 2 }),
    progress({ Phase: PhaseType.FLOP }),
  ])('欠落・空・別席・別ストリートのメニューは不明として保持する', previous => {
    const menu = getApplicableActionMenu(previous, 1, PhaseType.PREFLOP)
    expect(menu).toBeUndefined()
    expect(getRaiseAvailability(menu, PhaseType.PREFLOP)).toBeUndefined()
  })

  it('ポストフロップのCHECK+ALL_INは先制BETなのでレイズ可とはしない', () => {
    expect(getRaiseAvailability(getApplicableActionMenu(progress({
      Phase: PhaseType.FLOP, NextActionTypes: [ActionType.CHECK, ActionType.ALL_IN],
    }), 1, PhaseType.FLOP), PhaseType.FLOP)).toBe(false)
  })
})
