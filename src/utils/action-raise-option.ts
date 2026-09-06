import type { Progress } from '../types'
import { ActionType, PhaseType } from '../types/game'

/** 現在の席・ストリートに対応する非空メニューだけを証拠にする（MUST）。 */
export function getRaiseAvailability(
  progress: Progress | undefined,
  seatIndex: number,
  phase: PhaseType,
): boolean | undefined {
  if (!progress || progress.Phase !== phase || progress.NextActionSeat !== seatIndex ||
      !progress.NextActionTypes?.length) return undefined

  const options = progress.NextActionTypes
  // CALLとALL_INが並ぶ場合はコール額より増額できる。FOLD/ALL_INだけは
  // ショートコールなので、ALL_IN単独をレイズ権とみなさない（MUST NOT）。
  return options.includes(ActionType.RAISE) ||
    (options.includes(ActionType.ALL_IN) &&
      (options.includes(ActionType.CALL) ||
        (phase === PhaseType.PREFLOP && options.includes(ActionType.CHECK))))
}
