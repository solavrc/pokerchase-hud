import type { ApiEvent } from '../types/api'
import { ApiType } from '../types/api'
import { ActionType, PhaseType } from '../types/game'
import { resolveActionPhase } from './action-phase'

const action = (phase: number, nextActionSeat: number): ApiEvent<ApiType.EVT_ACTION> => ({
  ApiTypeId: ApiType.EVT_ACTION,
  timestamp: 1,
  SeatIndex: 0,
  ActionType: ActionType.CHECK,
  Chip: 100,
  BetChip: 0,
  Progress: {
    MinRaise: 0,
    NextActionSeat: nextActionSeat,
    NextActionTypes: [],
    NextExtraLimitSeconds: 0,
    Phase: phase,
    Pot: 0,
    SidePot: [],
  },
} as unknown as ApiEvent<ApiType.EVT_ACTION>)

describe('resolveActionPhase', () => {
  test('takes the street from the action itself even when the counter lags', () => {
    // 同一msバーストで EVT_DEAL_ROUND がまだ処理されていない状況。
    expect(resolveActionPhase(action(PhaseType.TURN, 3), PhaseType.PREFLOP)).toBe(PhaseType.TURN)
    expect(resolveActionPhase(action(PhaseType.FLOP, 3), PhaseType.PREFLOP)).toBe(PhaseType.FLOP)
  })

  test('keeps the running street for a hand-ending row, whose Phase is pinned to 3', () => {
    expect(resolveActionPhase(action(PhaseType.RIVER, -2), PhaseType.PREFLOP)).toBe(PhaseType.PREFLOP)
    expect(resolveActionPhase(action(PhaseType.RIVER, -2), PhaseType.TURN)).toBe(PhaseType.TURN)
    // 本当にリバーで終わったハンドは、進行中のストリートがリバーなので変わらない。
    expect(resolveActionPhase(action(PhaseType.RIVER, -2), PhaseType.RIVER)).toBe(PhaseType.RIVER)
  })

  test('falls back for a street-complete marker only when Phase is unusable', () => {
    // NextActionSeat=-1（ストリート完了）は Phase 固定の対象ではないので採用する。
    expect(resolveActionPhase(action(PhaseType.FLOP, -1), PhaseType.PREFLOP)).toBe(PhaseType.FLOP)
    // 想定外の Phase を持つ legacy/import 行はカウンタへ退避する。
    expect(resolveActionPhase(action(9, 3), PhaseType.TURN)).toBe(PhaseType.TURN)
  })
})
