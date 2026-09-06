import type { Progress } from '../types'
import { ActionType, PhaseType } from '../types/game'

/** 正規化と機会判定は、同じ席・ストリートの直前の非空メニューだけを使う（MUST）。 */
export function getApplicableActionMenu(
  progress: Progress | undefined,
  seatIndex: number,
  phase: PhaseType,
): readonly ActionType[] | undefined {
  if (!progress || progress.Phase !== phase || progress.NextActionSeat !== seatIndex ||
      !progress.NextActionTypes?.length) return undefined
  return progress.NextActionTypes
}

/** 対象確認済みメニューからレイズ可否を導く。不明は構造的な機会を維持する（MUST）。 */
export function getRaiseAvailability(
  options: readonly ActionType[] | undefined,
  phase: PhaseType,
): boolean | undefined {
  if (!options) return undefined
  // CALLとALL_INが並ぶ場合はコール額より増額できる。FOLD/ALL_INだけは
  // ショートコールなので、ALL_IN単独をレイズ権とみなさない（MUST NOT）。
  return options.includes(ActionType.RAISE) ||
    (options.includes(ActionType.ALL_IN) &&
      (options.includes(ActionType.CALL) ||
        (phase === PhaseType.PREFLOP && options.includes(ActionType.CHECK))))
}
