/**
 * replay-import.ts -- ドレインと表示側フック（`onDetailStored` /
 * `flushPanelRefresh`）の接続。
 *
 * 取得の間隔・ゲート・保存の意味論には触れない配管なので、ここで固定するのは
 * 「いつ呼ばれるか」だけ:
 *  - 実際に行が増えたときだけ`onDetailStored`（先勝ちで既に在った行では呼ばない）
 *  - ドレインの終わりには必ず`flushPanelRefresh`（中断した周回でも）
 *  - 1件も書かなかったドレインでは、パネルへの通知が1回も出ない
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { PokerChaseDB } from '../db/poker-chase-db'
import type { ReplayFetchItemResult } from '../replay/protocol'
import {
  __resetReplayImportForTests,
  drainReplayImportQueue,
  enqueueReplayHandId,
  type ReplayImportDeps
} from './replay-import'
import { createReplayPanelRefresh } from './replay-panel-refresh'
import {
  __resetActivePortStateForTests,
  claimActivePort,
  markActivePortSessionInactive,
  resolveGeneration
} from './active-port'
import {
  __resetPendingStorageWritesForTests
} from './pending-storage-writes'

const FAKE_PORT = { name: 'test-port' } as unknown as chrome.runtime.Port

/** 2026-08-01 12:00 JST 相当。 */
const NOW = Date.UTC(2026, 7, 1, 3, 0, 0)

const detailOf = (handId: number) => ({
  result: 0,
  status: 0,
  param: { HandId: handId, Player: { SeatIndex: 0, UserId: 1, HoleCardList: [40, 41] } }
})

describe('replay drain -> open-panel refresh hooks', () => {
  let db: PokerChaseDB
  let invalidateCache: jest.Mock
  let notifyPanels: jest.Mock
  let onDetailStored: jest.Mock
  let flushPanelRefresh: jest.Mock
  let fetchImpl: (handIds: number[]) => Promise<ReplayFetchItemResult[]>
  let fetchAllowed: boolean

  /** 本物の間引き実装を、無効化と通知だけspyへ差し替えて使う。 */
  const depsOf = (overrides: Partial<ReplayImportDeps> = {}): ReplayImportDeps => {
    const refresh = createReplayPanelRefresh({ now: () => NOW, invalidateCache, notifyPanels })
    onDetailStored = jest.fn(refresh.onDetailStored)
    flushPanelRefresh = jest.fn(refresh.flush)
    return {
      db,
      isEnabled: async () => true,
      now: () => NOW,
      intervalMs: 0,
      fetchDetails: async handIds => fetchImpl(handIds),
      resolvePort: () => FAKE_PORT,
      isFetchAllowed: () => fetchAllowed,
      startKeepAlive: async () => () => undefined,
      onDetailStored,
      flushPanelRefresh,
      ...overrides
    }
  }

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    await db.meta.clear()
    await db.apiEvents.clear()
    await db.replayDetails.clear()
    __resetReplayImportForTests()
    __resetActivePortStateForTests()
    __resetPendingStorageWritesForTests()
    claimActivePort(FAKE_PORT, NOW)
    markActivePortSessionInactive(resolveGeneration(FAKE_PORT)!)
    fetchAllowed = true
    invalidateCache = jest.fn()
    notifyPanels = jest.fn()
    fetchImpl = async handIds => handIds.map(handId => ({ handId, ok: true, detail: detailOf(handId) }))
  })

  afterEach(() => db.close())

  test('保存した件数ぶん無効化され、ドレイン末尾で必ず1回通知される', async () => {
    const deps = depsOf()
    for (const handId of [3001, 3002, 3003]) await enqueueReplayHandId(deps, handId, NOW)

    await drainReplayImportQueue(deps)

    expect(await db.replayDetails.count()).toBe(3)
    expect(onDetailStored).toHaveBeenCalledTimes(3)
    expect(invalidateCache).toHaveBeenCalledTimes(3)
    expect(flushPanelRefresh).toHaveBeenCalledTimes(1)
    // 3件は件数の閾値（5件）に届かない -> 通知は初回の1回と、末尾のflushの
    // 1回だけ。「1件ごとに撃たない」と「最後は必ず撃つ」が同時に見える。
    expect(notifyPanels).toHaveBeenCalledTimes(2)
  })

  test('1件も書かないドレインでは通知も無効化も起きない（キューが空）', async () => {
    const deps = depsOf()

    await drainReplayImportQueue(deps)

    expect(onDetailStored).not.toHaveBeenCalled()
    expect(invalidateCache).not.toHaveBeenCalled()
    expect(notifyPanels).not.toHaveBeenCalled()
  })

  test('先勝ちで既に索引に在るハンドは通知しない（行が増えていない）', async () => {
    await db.replayDetails.put({ handId: 3100, payload: { HandId: 3100 }, fetchedAt: NOW })
    const deps = depsOf()
    await enqueueReplayHandId(deps, 3100, NOW)

    await drainReplayImportQueue(deps)

    expect(onDetailStored).not.toHaveBeenCalled()
    expect(notifyPanels).not.toHaveBeenCalled()
  })

  test('セッション開始で中断しても、そこまでに保存した分は通知される', async () => {
    const deps = depsOf()
    for (const handId of [3201, 3202, 3203]) await enqueueReplayHandId(deps, handId, NOW)
    // 1本目の応答を返した直後に次の対局が始まった、という形。
    fetchImpl = async handIds => {
      fetchAllowed = false
      return handIds.map(handId => ({ handId, ok: true, detail: detailOf(handId) }))
    }

    await drainReplayImportQueue(deps)

    // 保存は0件（応答後のゲート再確認で持ち越す）でも、flushは必ず通る。
    expect(flushPanelRefresh).toHaveBeenCalledTimes(1)
    expect(notifyPanels).not.toHaveBeenCalled()
    expect(await db.replayDetails.count()).toBe(0)
  })
})
