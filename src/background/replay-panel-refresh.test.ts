/**
 * replay-panel-refresh.ts -- ドレイン中の通知の刻み。
 *
 * 2つの信号を別々に固定する:
 *  - キャッシュ無効化は**1件ごと**（安いので間引かない）
 *  - パネルへの通知は**間引く**（1件ごとに撃つと、1.5秒間隔で100件超のドレインの
 *    あいだ再フェッチが走り続ける）。ただしドレインの終わりの1回は必須。
 */
import {
  REPLAY_PANEL_REFRESH_BATCH_SIZE,
  REPLAY_PANEL_REFRESH_MIN_INTERVAL_MS,
  createReplayPanelRefresh
} from './replay-panel-refresh'

/** 実測の取得間隔（`REPLAY_FETCH_INTERVAL_MS`）。 */
const FETCH_INTERVAL_MS = 1_500

const harness = (intervalMs: number = FETCH_INTERVAL_MS) => {
  let now = 1_000_000
  const invalidateCache = jest.fn()
  const notifyPanels = jest.fn()
  const refresh = createReplayPanelRefresh({
    now: () => now,
    invalidateCache,
    notifyPanels
  })
  return {
    invalidateCache,
    notifyPanels,
    refresh,
    /** 1件保存したことにして、取得間隔ぶん時計を進める。 */
    store: (count = 1) => {
      for (let i = 0; i < count; i++) {
        refresh.onDetailStored()
        now += intervalMs
      }
    },
    advance: (ms: number) => { now += ms }
  }
}

describe('replay panel refresh', () => {
  test('キャッシュ無効化は保存1件ごとに走る（間引かない）', () => {
    const h = harness()
    h.store(12)
    expect(h.invalidateCache).toHaveBeenCalledTimes(12)
  })

  test('通知は間引かれる: 12件でも通知は4回（初回 + 5件ごと + 最後のflush）', () => {
    const h = harness()
    h.store(12)
    // 1件目（初回は即座に通す）、6件目、11件目。
    expect(h.notifyPanels).toHaveBeenCalledTimes(3)
    h.refresh.flush()
    // 12件目は閾値に届いていない -> flushが拾う。
    expect(h.notifyPanels).toHaveBeenCalledTimes(4)
  })

  test('100件のドレインでも通知は上限（件数/バッチ + 1）以内に収まる', () => {
    const h = harness()
    h.store(100)
    h.refresh.flush()
    expect(h.notifyPanels.mock.calls.length)
      .toBeLessThanOrEqual(Math.ceil(100 / REPLAY_PANEL_REFRESH_BATCH_SIZE) + 1)
    expect(h.invalidateCache).toHaveBeenCalledTimes(100)
  })

  test('最後のflushは必ず届く（MUST）: 閾値未満で終わっても1回送る', () => {
    const h = harness()
    h.store(1)
    h.notifyPanels.mockClear()
    h.store(REPLAY_PANEL_REFRESH_BATCH_SIZE - 1)
    // まだ閾値（件数・時間とも）に届いていない。
    expect(h.notifyPanels).not.toHaveBeenCalled()
    h.refresh.flush()
    expect(h.notifyPanels).toHaveBeenCalledTimes(1)
  })

  test('1件も保存していないドレインでは通知しない', () => {
    const h = harness()
    h.refresh.flush()
    expect(h.notifyPanels).not.toHaveBeenCalled()
    expect(h.invalidateCache).not.toHaveBeenCalled()
  })

  test('flushは残りを出し切るので、二度呼んでも重複して送らない', () => {
    const h = harness()
    h.store(2)
    h.notifyPanels.mockClear()
    h.refresh.flush()
    h.refresh.flush()
    expect(h.notifyPanels).toHaveBeenCalledTimes(1)
  })

  test('取得が遅いときは時間側の下限が効く（件数に届かなくても通知する）', () => {
    // 1件あたり間隔をminIntervalより長く取る = 毎回時間条件で通る。
    const h = harness(REPLAY_PANEL_REFRESH_MIN_INTERVAL_MS + 1)
    h.store(3)
    expect(h.notifyPanels).toHaveBeenCalledTimes(3)
  })
})
