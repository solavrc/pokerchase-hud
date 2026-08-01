/**
 * `/replay/detail` が受け付ける期間の判定。
 *
 * 実測（2026-08-01、43秒の分解能で境界を確認）: 取得できるのは
 * **「当日 − 3日」の 00:00 JST 以降**に始まったハンドだけで、経過時間では
 * ない。したがって実際の窓は 72〜96時間で変動し（深夜0時直後が最短）、
 * **深夜0時をまたぐと丸一日分が一斉に落ちる**。
 *
 * この判定はサーバの拒否（status 2301）を待たずに手元で落とすためのもの。
 * 期限切れの HandId を投げても 2301 が返るだけで再取得の見込みは無く、
 * リクエストを1本無駄にする。境界付近の誤差を避けるため、判定は
 * **サーバより緩く**（＝手元では落としすぎない）してあり、最終的な真偽は
 * サーバの 2301 が決める。
 */

/** JST（UTC+9）。PokerChase のサーバ時刻基準。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

/** 取得可能な暦日の遡り幅（当日を含めて4暦日ぶん）。 */
export const REPLAY_WINDOW_CALENDAR_DAYS = 3

/**
 * `now` 時点で取得可能な最古の時刻（Unix Milliseconds）。
 * 「当日 − `REPLAY_WINDOW_CALENDAR_DAYS` 日」の 00:00 JST。
 */
export const replayWindowFloorMs = (now: number): number => {
  const jstMidnight = Math.floor((now + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS
  return jstMidnight - REPLAY_WINDOW_CALENDAR_DAYS * DAY_MS
}

/** `handTimeMs`（ハンドの観測時刻）が `now` 時点でまだ取得可能か。 */
export const isWithinReplayWindow = (handTimeMs: number, now: number): boolean =>
  handTimeMs >= replayWindowFloorMs(now)
