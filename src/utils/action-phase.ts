import type { ApiEvent } from '../types/api'
import { ApiType } from '../types/api'
import { PhaseType } from '../types/game'

/**
 * `EVT_ACTION.Progress.NextActionSeat` のハンド終了マーカー。
 * この値を持つ行の `Progress.Phase` は実際のストリートに関わらず3固定で届く。
 */
export const HAND_ENDING_NEXT_ACTION_SEAT = -2

const isPhaseType = (value: unknown): value is PhaseType =>
  value === PhaseType.PREFLOP ||
  value === PhaseType.FLOP ||
  value === PhaseType.TURN ||
  value === PhaseType.RIVER

/**
 * アクションを帰属させるストリートを決める（#340）。
 *
 * 従来は `EVT_DEAL_ROUND` で進むカウンタ（直近に push 済みのフェーズ）を使っていたが、
 * カウンタは複数の経路で遅れる:
 *
 * 1. 同一ミリ秒バースト（再接続時の一括再送）では主キー順 = ApiTypeId 昇順のため
 *    304（EVT_ACTION）が305（EVT_DEAL_ROUND）より前に並ぶ。
 *    `orderApiEventsForReplay` の strict predicate は孤立した2イベント群しか
 *    反転しないので、3件以上の複合群は保存順のまま残る（docs/api-events.md
 *    「Raw Event Lake のキー・順序・重複」）
 * 2. `EVT_DEAL_ROUND` の未受信
 * 3. テーブル移動時のバッファ融合
 *
 * `EVT_ACTION.Progress.Phase` は同じ payload の中に正しいストリートを持っており、
 * 保存順に対して頑健である。**ただしハンド終了行（`NextActionSeat === -2`）だけは
 * `Phase` が3固定**で届くため、素朴に採用すると終了アクションが常にリバー帰属に
 * なる。この行は MUST NOT 上書きし、進行中のストリート（`fallbackPhase`）を使う。
 *
 * 実測（2026-08-01 エクスポート / 40,932ハンド / 345,016アクション）: 終了行を
 * 除外した全数検査で `Progress.Phase` とカウンタが食い違うのは29ハンド・63行、
 * 終了行では28,637行が食い違う（＝除外条件が必須であることの実測根拠）。
 *
 * `EntityConverter`（バッチ）と `WriteEntityStream`（ライブ）は同一の帰属でなければ
 * ならない（AGENTS.md "Derived data changes need dual-pipeline parity"）ため、
 * 判定は必ずこの1関数を共有する。
 */
export const resolveActionPhase = (
  event: ApiEvent<ApiType.EVT_ACTION>,
  fallbackPhase: PhaseType
): PhaseType => {
  if (event.Progress?.NextActionSeat === HAND_ENDING_NEXT_ACTION_SEAT) return fallbackPhase
  const phase = event.Progress?.Phase
  return isPhaseType(phase) ? phase : fallbackPhase
}
