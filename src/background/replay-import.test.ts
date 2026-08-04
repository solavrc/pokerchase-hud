import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import Dexie from 'dexie'
import { PokerChaseDB } from '../db/poker-chase-db'
import { ApiType } from '../types/api'
import type { ReplayFetchItemResult } from '../replay/protocol'
import {
  REPLAY_DETAILS_BACKFILL_META_ID,
  REPLAY_IMPORT_QUEUE_META_ID,
  REPLAY_IMPORT_STATUS_META_ID,
  backfillReplayDetailsFromLake,
  __resetReplayImportForTests,
  drainReplayImportQueue,
  enqueueReplayHandId,
  projectReplayDetailEvents,
  sanitizeReplayDetailEvents,
  readReplayImportQueue,
  readReplayImportStatus,
  type ReplayImportDeps
} from './replay-import'
import {
  __resetActivePortStateForTests,
  claimActivePort,
  findActivePortForPlayer,
  markActivePortPlayerId,
  markActivePortSessionActive,
  markActivePortSessionInactive,
  readActivePortPlayerId,
  resolveGeneration
} from './active-port'
import {
  __resetPendingStorageWritesForTests,
  enqueuePendingStorageWrite,
  getPendingStorageWriteTail
} from './pending-storage-writes'

/** テスト用のダミーポート（依頼先の同一性だけを見る）。 */
const FAKE_PORT = { name: 'test-port' } as unknown as chrome.runtime.Port
const SECOND_FAKE_PORT = { name: 'second-test-port' } as unknown as chrome.runtime.Port

/** 2026-08-01 12:00 JST 相当。暦日の窓の基準に使う。 */
const NOW = Date.UTC(2026, 7, 1, 3, 0, 0)

const markSessionActive = (port: chrome.runtime.Port = FAKE_PORT): void => {
  claimActivePort(port, NOW)
  markActivePortSessionActive(resolveGeneration(port)!)
}

const markSessionInactive = (port: chrome.runtime.Port = FAKE_PORT): void => {
  claimActivePort(port, NOW)
  markActivePortSessionInactive(resolveGeneration(port)!)
}

/** `/replay/detail` の成功応答（ページ側で sanitize 済み ＝ `session` は無い）。 */
const detailOf = (handId: number) => ({
  result: 0,
  status: 0,
  appVer: '2.06',
  dataVer: '2_06_0_test',
  masterVer: 'master-test',
  param: {
    Game: { PlayerNum: 6, CommunityCardList: [39, 17, 11, 44, 24] },
    Player: { SeatIndex: 5, UserId: 561384657, HoleCardList: [40, 41] },
    HandId: handId
  }
})

describe('replay import layer', () => {
  let db: PokerChaseDB
  let fetchCalls: number[][]
  let fetchImpl: (handIds: number[]) => Promise<ReplayFetchItemResult[]>
  let keepAliveStarts: number
  let keepAliveStops: number

  const depsOf = (overrides: Partial<ReplayImportDeps> = {}): ReplayImportDeps => ({
    db,
    isEnabled: async () => true,
    now: () => NOW,
    intervalMs: 0,
    fetchDetails: async handIds => {
      fetchCalls.push(handIds)
      return fetchImpl(handIds)
    },
    // 既定のfairness判定はactive-port module、依頼先はテスト用の1port。
    resolvePort: () => FAKE_PORT,
    startKeepAlive: async () => {
      keepAliveStarts += 1
      return () => { keepAliveStops += 1 }
    },
    ...overrides
  })

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    await db.meta.clear()
    await db.apiEvents.clear()
    await db.replayDetails.clear()
    __resetReplayImportForTests()
    __resetActivePortStateForTests()
    __resetPendingStorageWritesForTests()
    fetchCalls = []
    keepAliveStarts = 0
    keepAliveStops = 0
    fetchImpl = async handIds => handIds.map(handId => ({ handId, ok: true, detail: detailOf(handId) }))
  })

  afterEach(() => db.close())

  /**
   * sola裁定（変更不可）: セッション中に過去ハンドの詳細が取れると、まだ
   * 伏せられている情報がセッション内で参照できてしまう。**セッション中は
   * `/replay/detail` を1本も撃たない。**
   */
  describe('不変条件: セッション中は取得しない', () => {
    test('Service Worker再起動直後のtoken未生成ではドレインを発火しない', async () => {
      const deps = depsOf()
      await enqueueReplayHandId(deps, 1000, NOW)

      // active-portのモジュール状態はbeforeEachで初期化済み。接続通知やauth-ready
      // がdrainを起動しても、最初のdedup済みgame eventまではunknownで止まる。
      await drainReplayImportQueue(deps, 'port-connect')

      expect(fetchCalls).toEqual([])
      expect(keepAliveStarts).toBe(0)
      expect(await db.replayDetails.count()).toBe(0)
      expect((await readReplayImportQueue(db)).map(entry => entry.handId)).toEqual([1000])
    })

    test('セッション開始→ハンド→キューは伸びるが取得は0本、セッション終了で初めて走る', async () => {
      const deps = depsOf()

      // --- セッション開始（201/308）---
      markSessionActive()

      // --- ハンドが進む: HandIdはキューへ積まれるだけ ---
      for (const handId of [1001, 1002, 1003]) {
        await enqueueReplayHandId(deps, handId, NOW)
      }
      expect((await readReplayImportQueue(db)).map(entry => entry.handId))
        .toEqual([1001, 1002, 1003])

      // セッション中は、明示的に流そうとしても1本も飛ばない
      await drainReplayImportQueue(deps)
      expect(fetchCalls).toEqual([])
      expect(await db.replayDetails.count()).toBe(0)

      // --- セッション終了（309）---
      markSessionInactive()
      await drainReplayImportQueue(deps)

      // 1件ずつ依頼する（バッチで渡すと、撃ち切るまでの数分の間に次の対局が
      // 始まっても残りが撃たれ続け、不変条件を破るため）
      expect(fetchCalls).toEqual([[1001], [1002], [1003]])
      expect(await db.replayDetails.count()).toBe(3)
      expect(await readReplayImportQueue(db)).toEqual([])
    })

    test('handover後のACTIVE portがunknownなら、旧portがinactiveでも撃たない', async () => {
      const deps = depsOf({ resolvePort: () => SECOND_FAKE_PORT })
      markSessionActive(FAKE_PORT)
      await enqueueReplayHandId(deps, 1250, NOW)
      markSessionInactive(FAKE_PORT)

      // 別portのgame eventがtokenを奪ったが、session境界はまだ不明。
      claimActivePort(SECOND_FAKE_PORT, NOW + 20_000)

      await drainReplayImportQueue(deps)
      expect(fetchCalls).toEqual([])
      expect((await readReplayImportQueue(db)).map(entry => entry.handId)).toEqual([1250])

      // 現在のACTIVE portが明示的にinactiveになって初めて流れる。
      markActivePortSessionInactive(resolveGeneration(SECOND_FAKE_PORT)!)
      await drainReplayImportQueue(deps)
      expect(fetchCalls).toEqual([[1250]])
    })

    test('ACTIVE portのsession状態がunknownなら取得しない', async () => {
      const deps = depsOf()
      await enqueueReplayHandId(deps, 1100, NOW)

      claimActivePort(FAKE_PORT, NOW)
      await drainReplayImportQueue(deps)

      expect(fetchCalls).toEqual([])
      expect((await readReplayImportQueue(db)).map(entry => entry.handId)).toEqual([1100])
    })

    test('取得の途中で再度セッションが始まったら、次の周回は走らない', async () => {
      const deps = depsOf()
      markSessionActive()
      await enqueueReplayHandId(deps, 1200, NOW)
      await enqueueReplayHandId(deps, 1201, NOW)
      markSessionInactive()

      fetchImpl = async handIds => {
        // 応答を組み立てている最中に次のセッションが始まる
        markSessionActive()
        return handIds.map(handId => ({ handId, ok: true, detail: detailOf(handId) }))
      }
      await drainReplayImportQueue(deps)
      // 1件目の応答中にセッションが始まるので、2件目は撃たれない
      expect(fetchCalls).toEqual([[1200]])
      // 応答と201/303が競合しても90001へ保存せず、両方を持ち越す。
      expect(await db.replayDetails.count()).toBe(0)
      expect((await readReplayImportQueue(db)).map(entry => entry.handId)).toEqual([1200, 1201])

      // 2周目も不変条件で止まる
      await enqueueReplayHandId(deps, 1202, NOW)
      await drainReplayImportQueue(deps)
      expect(fetchCalls).toEqual([[1200]])
    })

    test('page自律abortの空応答も現在activityで止め、次の依頼と書き込みへ進まない', async () => {
      const deps = depsOf()
      markSessionActive()
      await enqueueReplayHandId(deps, 1204, NOW)
      await enqueueReplayHandId(deps, 1205, NOW)
      markSessionInactive()

      fetchImpl = async () => {
        // pageが201を観測してHTTPをabortし、空RESULTを返す競合。
        markSessionActive()
        return []
      }
      await drainReplayImportQueue(deps)

      expect(fetchCalls).toEqual([[1204]])
      expect(await db.replayDetails.count()).toBe(0)
      expect(await db.apiEvents.where('ApiTypeId').equals(ApiType.REPLAY_HAND_DETAIL).count())
        .toBe(0)
      expect((await readReplayImportQueue(db)).map(entry => entry.handId))
        .toEqual([1204, 1205])
    })

    test('共通storage FIFO待ち中にセッションが始まったら保存せず持ち越す', async () => {
      let releaseBlocker!: () => void
      const blocker = enqueuePendingStorageWrite(() => new Promise<void>(resolve => {
        releaseBlocker = resolve
      }))
      const blockerTail = getPendingStorageWriteTail()
      const deps = depsOf()
      markSessionActive()
      await enqueueReplayHandId(deps, 1203, NOW)
      markSessionInactive()

      const drain = drainReplayImportQueue(deps)
      // 成功応答がguardedWriteとしてblockerの後ろへ積まれるまで待つ。
      for (let i = 0; i < 50 && getPendingStorageWriteTail() === blockerTail; i++) {
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      expect(getPendingStorageWriteTail()).not.toBe(blockerTail)

      // 実書き込みはまだ始まっていない。この間にdedup済み開始イベントが
      // ACTIVEへ遷移させる競合を再現する。
      markSessionActive()
      releaseBlocker()
      await blocker
      await drain

      expect(fetchCalls).toEqual([[1203]])
      expect(await db.replayDetails.get(1203)).toBeUndefined()
      expect(await db.apiEvents.where('ApiTypeId').equals(ApiType.REPLAY_HAND_DETAIL).count())
        .toBe(0)
      expect((await readReplayImportQueue(db)).map(entry => entry.handId)).toEqual([1203])
    })

    test('保存transactionのwrite lock待ち中にセッションが始まっても90001を書かない', async () => {
      const deps = depsOf()
      markSessionActive()
      await enqueueReplayHandId(deps, 1206, NOW)
      markSessionInactive()

      let resolveFetch!: () => void
      fetchImpl = handIds => new Promise(resolve => {
        resolveFetch = () => resolve(handIds.map(handId => ({
          handId,
          ok: true,
          detail: detailOf(handId)
        })))
      })
      const drain = drainReplayImportQueue(deps)
      for (let i = 0; i < 50 && !resolveFetch; i++) {
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      expect(resolveFetch).toBeDefined()

      let releaseBlocker!: () => void
      const blockerGate = new Promise<void>(resolve => { releaseBlocker = resolve })
      let notifyBlockerStarted!: () => void
      const blockerStarted = new Promise<void>(resolve => { notifyBlockerStarted = resolve })
      const blocker = db.transaction(
        'rw',
        db.apiEvents,
        db.meta,
        db.replayDetails,
        async () => {
          // 実際のrw transactionを先行させ、対象3 tableのwrite lockを保持する。
          await db.meta.put({ id: 'test-replay-write-lock', value: true, updatedAt: NOW })
          notifyBlockerStarted()
          await Dexie.waitFor(blockerGate)
        }
      )
      await blockerStarted

      const getSpy = jest.spyOn(db.replayDetails, 'get')
      const storeGetStarted = (): boolean =>
        (getSpy.mock.calls as unknown[][]).some(([handId]) => handId === 1206)
      resolveFetch()
      for (let i = 0; i < 50 && !storeGetStarted(); i++) {
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      expect(storeGetStarted()).toBe(true)
      // 外側のpost-fetch gateとtransaction callback先頭のgateは既にinactiveで
      // 通過済み。最初のreadが実lockで待つ間にactivityをACTIVEへ進める。
      markSessionActive()
      releaseBlocker()
      await blocker
      await drain

      expect(fetchCalls).toEqual([[1206]])
      expect(await db.replayDetails.get(1206)).toBeUndefined()
      expect(await db.apiEvents.where('ApiTypeId').equals(ApiType.REPLAY_HAND_DETAIL).count())
        .toBe(0)
      expect((await readReplayImportQueue(db)).map(entry => entry.handId)).toEqual([1206])
    })

    // Codexレビュー指摘: バッチでまとめて渡すと、ページ側が撃ち切るまでの
    // 数分の間に次の対局が始まっても残りが撃たれ続け、不変条件を破る。
    test('取得の途中でセッションが始まったら、その時点で撃つのをやめる', async () => {
      const deps = depsOf()
      markSessionActive()
      for (const handId of [1210, 1211, 1212, 1213]) {
        await enqueueReplayHandId(deps, handId, NOW)
      }
      markSessionInactive()

      fetchImpl = async handIds => {
        // 2件目の応答を返した直後に次の対局が始まる
        if (handIds[0] === 1211) markSessionActive()
        return handIds.map(handId => ({ handId, ok: true, detail: detailOf(handId) }))
      }
      await drainReplayImportQueue(deps)

      expect(fetchCalls).toEqual([[1210], [1211]])
      // 201/303と応答が競合した2件目も保存・決着せず、未発行分と共に残る。
      expect((await readReplayImportQueue(db)).map(entry => entry.handId)).toEqual([1211, 1212, 1213])
    })

    test('取得の途中で長時間操作が始まったら、その時点で撃つのをやめる', async () => {
      let busy = false
      const deps = depsOf({ isBusy: () => busy })
      markSessionInactive()
      await enqueueReplayHandId(deps, 1220, NOW)
      await enqueueReplayHandId(deps, 1221, NOW)

      fetchImpl = async handIds => {
        busy = true
        return handIds.map(handId => ({ handId, ok: true, detail: detailOf(handId) }))
      }
      await drainReplayImportQueue(deps)

      expect(fetchCalls).toEqual([[1220]])
      // 応答待ちの間に操作が始まった1件も保存せずに持ち越す（消えたDBへ
      // 書きに行かないため）。取りこぼしではなく、次の機会に回るだけ。
      expect((await readReplayImportQueue(db)).map(entry => entry.handId)).toEqual([1220, 1221])
      expect(await db.replayDetails.count()).toBe(0)
    })

    // Codexレビュー指摘: 実行中のドレインに相乗りさせると、既に中断へ
    // 向かっているドレインをそのまま返すだけになり、その契機（操作の終了・
    // ポート接続）が消費されて再開しない。
    test('実行中のドレインがあれば、もう1周だけ予約する', async () => {
      const deps = depsOf()
      markSessionInactive()
      await enqueueReplayHandId(deps, 1240, NOW)

      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      fetchImpl = async handIds => {
        await gate
        return handIds.map(handId => ({ handId, ok: true, detail: detailOf(handId) }))
      }

      const first = drainReplayImportQueue(deps)
      // 1周目の実行中に、別の契機（操作の終了など）でもう一度呼ばれる
      await enqueueReplayHandId(deps, 1241, NOW)
      const second = drainReplayImportQueue(deps)
      release()
      await Promise.all([first, second])

      // 予約された2周目が、1周目の後に積まれたHandIdを拾う
      expect(fetchCalls).toEqual([[1240], [1241]])
      expect(await readReplayImportQueue(db)).toEqual([])
    })

    test('rerun中の第3トリガーも直列化し、古いownerがsingle-flightを解除しない', async () => {
      const deps = depsOf()
      markSessionInactive()
      await enqueueReplayHandId(deps, 1240, NOW)

      let releaseFirst!: () => void
      let releaseSecond!: () => void
      let announceFirst!: () => void
      let announceSecond!: () => void
      const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
      const secondGate = new Promise<void>(resolve => { releaseSecond = resolve })
      const firstStarted = new Promise<void>(resolve => { announceFirst = resolve })
      const secondStarted = new Promise<void>(resolve => { announceSecond = resolve })
      let activeFetches = 0
      let maxActiveFetches = 0
      fetchImpl = async handIds => {
        activeFetches += 1
        maxActiveFetches = Math.max(maxActiveFetches, activeFetches)
        try {
          if (handIds[0] === 1240) {
            announceFirst()
            await firstGate
          } else if (handIds[0] === 1241) {
            announceSecond()
            await secondGate
          }
          return handIds.map(handId => ({ handId, ok: true, detail: detailOf(handId) }))
        } finally {
          activeFetches -= 1
        }
      }

      const first = drainReplayImportQueue(deps)
      await firstStarted
      await enqueueReplayHandId(deps, 1241, NOW)
      const second = drainReplayImportQueue(deps)
      releaseFirst()
      await secondStarted

      await enqueueReplayHandId(deps, 1242, NOW)
      const third = drainReplayImportQueue(deps)
      await Promise.resolve()
      expect(maxActiveFetches).toBe(1)

      releaseSecond()
      await Promise.all([first, second, third])

      expect(maxActiveFetches).toBe(1)
      expect(fetchCalls).toEqual([[1240], [1241], [1242]])
      expect(await readReplayImportQueue(db)).toEqual([])
    })

    /**
     * Codexレビュー指摘（P1）: `break` が抜けるのは `for` だけなので、そのまま
     * 進むと削除の最中に `meta` への書き込みへ行く。`deleteAllData()` は
     * このドレインを待たないため、`db.delete()` と競合する。
     */
    test('長時間操作で中断したときは meta にも書かない', async () => {
      let busy = false
      const deps = depsOf({ isBusy: () => busy })
      markSessionInactive()
      await enqueueReplayHandId(deps, 1230, NOW)
      const queueBefore = await db.meta.get(REPLAY_IMPORT_QUEUE_META_ID)

      fetchImpl = async handIds => {
        busy = true
        return handIds.map(handId => ({ handId, ok: true, detail: detailOf(handId) }))
      }
      await drainReplayImportQueue(deps)

      // キューのメタ行は触られていない（updatedAt も含めて同一）
      expect(await db.meta.get(REPLAY_IMPORT_QUEUE_META_ID)).toEqual(queueBefore)
      // 実行結果のメタ行も作られていない
      expect(await db.meta.get(REPLAY_IMPORT_STATUS_META_ID)).toBeUndefined()
    })

    test('実験フラグがOFFなら積みも取得もしない', async () => {
      const deps = depsOf({ isEnabled: async () => false })
      markSessionInactive()

      expect(await enqueueReplayHandId(deps, 1300, NOW)).toBe(false)
      expect(await readReplayImportQueue(db)).toEqual([])
      await drainReplayImportQueue(deps)
      expect(fetchCalls).toEqual([])
    })
  })

  /**
   * 認証エンベロープはページ側（main world）にしか無く、セッション終了時に
   * 必ず在るとは限らない。取れないときは**捨てずに持ち越す**。
   */
  describe('繰り延べ: エンベロープ不在時は持ち越して後で再開する', () => {
    test('セッション終了時に取得できなくてもキューは残り、再開時に取得する', async () => {
      const deps = depsOf()
      markSessionActive()
      await enqueueReplayHandId(deps, 1400, NOW)
      await enqueueReplayHandId(deps, 1401, NOW)
      markSessionInactive()

      // 1回目: エンベロープ不在（retryable）
      fetchImpl = async handIds => handIds.map(handId => ({
        handId, ok: false, error: 'auth-envelope-unavailable', retryable: true
      }))
      await drainReplayImportQueue(deps)

      expect(fetchCalls).toEqual([[1400], [1401]])
      expect(await db.replayDetails.count()).toBe(0)
      expect((await readReplayImportQueue(db)).map(entry => entry.handId)).toEqual([1400, 1401])
      expect(await readReplayImportStatus(db)).toMatchObject({ deferred: 2, stored: 0 })

      // 2回目: エンベロープが捕獲され、かつセッション外（ページ再読み込み後の
      // ポート接続がこの契機になる）
      fetchImpl = async handIds => handIds.map(handId => ({ handId, ok: true, detail: detailOf(handId) }))
      await drainReplayImportQueue(deps)

      expect(fetchCalls).toHaveLength(4)
      expect(await db.replayDetails.count()).toBe(2)
      expect(await readReplayImportQueue(db)).toEqual([])
    })

    test('繰り延べ中にセッションが始まったら、その間は再開しない', async () => {
      const deps = depsOf()
      markSessionInactive()
      await enqueueReplayHandId(deps, 1500, NOW)
      fetchImpl = async handIds => handIds.map(handId => ({
        handId, ok: false, error: 'auth-envelope-unavailable', retryable: true
      }))
      await drainReplayImportQueue(deps)
      expect(fetchCalls).toHaveLength(1)

      markSessionActive()
      await drainReplayImportQueue(deps)
      expect(fetchCalls).toHaveLength(1)
      expect((await readReplayImportQueue(db)).map(entry => entry.handId)).toEqual([1500])
    })
  })

  describe('期限切れの扱い', () => {
    // 2301 = 閲覧期限切れ（データは在るが暦日の窓の外）。再取得しても
    // 状況は変わらないので再試行しない。
    test('status 2301 は再試行せず、理由付きで数えて落とす', async () => {
      const deps = depsOf()
      markSessionInactive()
      await enqueueReplayHandId(deps, 1600, NOW)
      fetchImpl = async handIds => handIds.map(handId => ({
        handId, ok: false, error: 'API result 1 status 2301', retryable: false
      }))

      await drainReplayImportQueue(deps)
      expect(await readReplayImportQueue(db)).toEqual([])
      expect(await readReplayImportStatus(db)).toMatchObject({ expired: 1, notFound: 0 })

      // 2周目は撃たない（キューから消えている）
      await drainReplayImportQueue(deps)
      expect(fetchCalls).toHaveLength(1)
    })

    test('status 2302（データ無し）も同様に落とす', async () => {
      const deps = depsOf()
      markSessionInactive()
      await enqueueReplayHandId(deps, 1700, NOW)
      fetchImpl = async handIds => handIds.map(handId => ({
        handId, ok: false, error: 'API result 1 status 2302', retryable: false
      }))

      await drainReplayImportQueue(deps)
      expect(await readReplayImportStatus(db)).toMatchObject({ expired: 0, notFound: 1 })
      expect(await readReplayImportQueue(db)).toEqual([])
    })

    // 暦日の窓（当日−3日 00:00 JST）を過ぎたものは、撃つ前に落とす。
    // 撃っても2301が返るだけで、リクエストを1本無駄にする。
    test('暦日の窓を過ぎたHandIdはリクエストせずに破棄する', async () => {
      const deps = depsOf()
      markSessionActive()
      // 4暦日前 = 窓の外
      await enqueueReplayHandId(deps, 1800, NOW - 4 * 24 * 60 * 60 * 1000)
      await enqueueReplayHandId(deps, 1801, NOW)
      markSessionInactive()

      await drainReplayImportQueue(deps)

      expect(fetchCalls).toEqual([[1801]])
      expect(await readReplayImportStatus(db)).toMatchObject({ droppedBeforeRequest: 1, stored: 1 })
      expect(await readReplayImportQueue(db)).toEqual([])
    })
  })

  describe('保存形式（Lake + 索引）', () => {
    test('合成イベント（90001）としてLakeへ入り、replayDetailsへ射影される', async () => {
      const deps = depsOf()
      markSessionInactive()
      await enqueueReplayHandId(deps, 1900, NOW)
      await drainReplayImportQueue(deps)

      const lakeRows = await db.apiEvents
        .where('ApiTypeId').equals(ApiType.REPLAY_HAND_DETAIL).toArray() as any[]
      expect(lakeRows).toHaveLength(1)
      expect(lakeRows[0]).toMatchObject({
        ApiTypeId: 90001,
        HandId: 1900,
        fetchedAt: NOW,
        clientMeta: { appVer: '2.06', dataVer: '2_06_0_test', masterVer: 'master-test' }
      })
      expect(lakeRows[0].payload).toMatchObject({ HandId: 1900 })

      const record = await db.replayDetails.get(1900)
      expect(record).toMatchObject({ handId: 1900, fetchedAt: NOW })
    })

    /**
     * `session` は回転する資格情報。保存も輸出もしてはならない（MUST NOT）。
     * ページ側の `sanitizeReplayDetail` が落としているが、境界を越えた後の
     * 保存物にも残っていないことをここで固定する。
     */
    test('保存物にもLakeの行にも session / requestKey が含まれない', async () => {
      const deps = depsOf()
      markSessionInactive()
      await enqueueReplayHandId(deps, 2000, NOW)
      // 万一 sanitize をすり抜けた応答が来ても、保存物には載らないこと
      fetchImpl = async handIds => handIds.map(handId => ({
        handId,
        ok: true,
        detail: { ...detailOf(handId), session: 'rotating-secret', requestKey: 'uuid-secret' }
      }))
      await drainReplayImportQueue(deps)

      const record = await db.replayDetails.get(2000)
      expect(record).toBeDefined()
      expect(record).not.toHaveProperty('session')
      expect(JSON.stringify(record)).not.toContain('rotating-secret')
      expect(JSON.stringify(record)).not.toContain('uuid-secret')

      const lakeRows = await db.apiEvents
        .where('ApiTypeId').equals(ApiType.REPLAY_HAND_DETAIL).toArray()
      expect(JSON.stringify(lakeRows)).not.toContain('rotating-secret')
      expect(JSON.stringify(lakeRows)).not.toContain('uuid-secret')
      // エクスポートはLakeの行をそのまま書き出すので、上の2つで輸出経路も閉じる
      for (const row of lakeRows as any[]) {
        expect(row).not.toHaveProperty('session')
        expect(row).not.toHaveProperty('requestKey')
      }
    })

    /**
     * Codexレビュー指摘（P1）: `REPLAY_BRIDGE_RESULT` は同一オリジンのページから
     * 偽装でき、進行中の `requestId` もページから観測できる。ページ側の
     * サニタイズだけに頼ると、偽の成功応答の資格情報が永続化される。
     */
    test('偽装された応答の資格情報も保存境界で落とす', async () => {
      const deps = depsOf()
      markSessionInactive()
      await enqueueReplayHandId(deps, 2050, NOW)
      fetchImpl = async handIds => handIds.map(handId => ({
        handId,
        ok: true,
        // ページ側のサニタイズを通っていない（＝偽装された）形
        detail: {
          result: 0,
          session: 'forged-session',
          param: { Player: { UserId: 1, requestKey: 'forged-key' }, session: 'nested-forgery' }
        }
      }))
      await drainReplayImportQueue(deps)

      const record = await db.replayDetails.get(2050)
      expect(record).toBeDefined()
      expect(JSON.stringify(record)).not.toContain('forged')
      expect(JSON.stringify(record)).not.toContain('nested-forgery')
      const lakeRows = await db.apiEvents
        .where('ApiTypeId').equals(ApiType.REPLAY_HAND_DETAIL).toArray()
      expect(JSON.stringify(lakeRows)).not.toContain('forged')
    })

    test('同じHandIdは先勝ちで、二度は取得しない', async () => {
      const deps = depsOf()
      markSessionInactive()
      await enqueueReplayHandId(deps, 2100, NOW)
      await drainReplayImportQueue(deps)
      expect(fetchCalls).toHaveLength(1)

      // 同じHandIdが再び積まれても取得済みなので撃たない
      await enqueueReplayHandId(deps, 2100, NOW)
      await drainReplayImportQueue(deps)
      expect(fetchCalls).toHaveLength(1)
      expect(await db.replayDetails.count()).toBe(1)
    })

    // Codexレビュー指摘: NDJSONは検証前にそのままLakeへ入るので、インポート
    // ファイルに資格情報が残っていると索引・エクスポート・同期へ流れる。
    test('インポート由来の90001から資格情報を落とす', async () => {
      const rows: Array<Record<string, unknown>> = [{
        timestamp: NOW,
        ApiTypeId: 90001,
        HandId: 2900,
        payload: { session: 'leaked', Player: { UserId: 1, requestKey: 'leaked-key' } },
        fetchedAt: NOW,
        session: 'top-level-leak'
      }]
      sanitizeReplayDetailEvents(rows)
      expect(JSON.stringify(rows)).not.toContain('leaked')
      expect(JSON.stringify(rows)).not.toContain('top-level-leak')

      await projectReplayDetailEvents(db, rows)
      const record = await db.replayDetails.get(2900)
      expect(JSON.stringify(record)).not.toContain('leaked')
    })

    // NDJSONインポート/再構築でLakeへ入った90001を索引側へ追従させる入口。
    test('Lakeの90001行をreplayDetailsへ先勝ちで射影する', async () => {
      const inserted = await projectReplayDetailEvents(db, [
        { ApiTypeId: 90001, timestamp: NOW, HandId: 2200, payload: { a: 1 }, fetchedAt: NOW },
        { ApiTypeId: 90001, timestamp: NOW + 1, HandId: 2200, payload: { a: 2 }, fetchedAt: NOW + 1 },
        { ApiTypeId: ApiType.EVT_HAND_RESULTS, timestamp: NOW, HandId: 2201 }
      ])
      expect(inserted).toBe(1)
      expect(await db.replayDetails.get(2200)).toMatchObject({ payload: { a: 1 } })
      expect(await db.replayDetails.get(2201)).toBeUndefined()
    })
  })

  // Codexレビュー指摘: v7より前に取り込んだ90001（別端末がクラウド経由で
  // 送ったもの）は、バージョン移行が空のストアを作るだけなので索引に入らない。
  describe('既存90001の索引化（起動時の掃き出し）', () => {
    test('Lakeに在る90001を索引へ流し込み、目印を残して二度は走らない', async () => {
      await db.apiEvents.bulkAdd([
        { timestamp: NOW, ApiTypeId: ApiType.REPLAY_HAND_DETAIL, sequence: 0, HandId: 3100, payload: { a: 1 }, fetchedAt: NOW },
        { timestamp: NOW + 1, ApiTypeId: ApiType.EVT_HAND_RESULTS, sequence: 0, HandId: 3101 }
      ] as any)

      expect(await backfillReplayDetailsFromLake(db)).toBe(1)
      expect(await db.replayDetails.get(3100)).toMatchObject({ handId: 3100 })
      expect(await db.meta.get(REPLAY_DETAILS_BACKFILL_META_ID)).toBeDefined()

      // 2回目は目印を見て即座に返る（新しい行を足しても走らない）
      await db.apiEvents.add({
        timestamp: NOW + 2, ApiTypeId: ApiType.REPLAY_HAND_DETAIL, sequence: 0, HandId: 3102, payload: { a: 2 }, fetchedAt: NOW
      } as any)
      expect(await backfillReplayDetailsFromLake(db)).toBe(0)
      expect(await db.replayDetails.get(3102)).toBeUndefined()
    })

    test('資格情報が混じっていても索引には落として入れる', async () => {
      await db.apiEvents.add({
        timestamp: NOW, ApiTypeId: ApiType.REPLAY_HAND_DETAIL, sequence: 0,
        HandId: 3200, payload: { session: 'leaked-in-lake', Player: { UserId: 1 } }, fetchedAt: NOW
      } as any)

      await backfillReplayDetailsFromLake(db)
      expect(JSON.stringify(await db.replayDetails.get(3200))).not.toContain('leaked-in-lake')
    })
  })

  describe('キューの永続化', () => {
    test('キューは meta に載り、Service Worker再起動をまたいで残る', async () => {
      const deps = depsOf()
      markSessionActive()
      await enqueueReplayHandId(deps, 2300, NOW)

      const stored = await db.meta.get(REPLAY_IMPORT_QUEUE_META_ID)
      expect(stored?.value).toEqual({ pending: [{ handId: 2300, enqueuedAt: NOW }] })

      // 「再起動」= モジュールスコープの状態を捨てる
      __resetReplayImportForTests()
      expect((await readReplayImportQueue(db)).map(entry => entry.handId)).toEqual([2300])
    })

    test('同じHandIdを二重に積まない', async () => {
      const deps = depsOf()
      markSessionActive()
      await enqueueReplayHandId(deps, 2400, NOW)
      await enqueueReplayHandId(deps, 2400, NOW + 1000)
      expect(await readReplayImportQueue(db)).toEqual([{ handId: 2400, enqueuedAt: NOW }])
    })

    /**
     * 取得の起点（セッション終了）は keepalive が解除される瞬間でもある。
     * 1件1.5秒間隔の逐次取得は分単位になるので、起こしておかないとMV3の
     * 30秒アイドルで途中でworkerが落ちる。
     */
    test('取得の間だけService Workerを起こしておく', async () => {
      const deps = depsOf()
      markSessionInactive()
      await enqueueReplayHandId(deps, 2600, NOW)
      await drainReplayImportQueue(deps)
      expect(keepAliveStarts).toBe(1)
      expect(keepAliveStops).toBe(1)
    })

    test('フラグOFFならkeepaliveも起こさない', async () => {
      const deps = depsOf({ isEnabled: async () => false })
      markSessionInactive()
      await drainReplayImportQueue(deps)
      expect(keepAliveStarts).toBe(0)
    })

    // Codexレビュー指摘: 積む側はfire-and-forgetなので、直後の309が空の
    // メタ行を読みうる。読み落とすと次のセッション終了まで取得されない。
    test('積む書き込みが決着してから読む（直後のセッション終了で取り逃さない）', async () => {
      const deps = depsOf()
      markSessionActive()
      // awaitせずに積む（本番の`processEvent`と同じ形）
      void enqueueReplayHandId(deps, 2700, NOW)
      markSessionInactive()
      await drainReplayImportQueue(deps)
      expect(fetchCalls).toEqual([[2700]])
    })

    // Codexレビュー指摘: 繰り延べ中に別アカウントへログインすると、旧アカウントの
    // HandIdが新しい資格情報で2302になり、再試行不能として永久に捨てられる。
    // Codexレビュー指摘: 依頼先の無いエントリで間隔を消費すると、先頭に
    // 未接続アカウントが並んでいるだけで、実際に撃てる1件まで延々待たされる。
    test('依頼先の無いエントリでは間隔を消費しない', async () => {
      const reachable = { name: 'reachable' } as unknown as chrome.runtime.Port
      const deps = depsOf({
        intervalMs: 5_000,
        resolvePort: playerId => playerId === 777 ? reachable : undefined
      })
      markSessionActive()
      // 撃てない3件が先に並び、最後の1件だけが撃てる
      for (const handId of [3001, 3002, 3003]) {
        await enqueueReplayHandId({ ...deps, getPlayerId: () => 555 }, handId, NOW)
      }
      await enqueueReplayHandId({ ...deps, getPlayerId: () => 777 }, 3004, NOW)
      markSessionInactive()

      const startedAt = Date.now()
      await drainReplayImportQueue(deps)
      // 5秒の間隔を1度も挟まずに、撃てる1件へ到達している
      expect(Date.now() - startedAt).toBeLessThan(2_000)
      expect(fetchCalls).toEqual([[3004]])
      expect((await readReplayImportQueue(db)).map(entry => entry.handId))
        .toEqual([3001, 3002, 3003])
    })

    // Codexレビュー指摘: 実際の依頼先はポートで決まる。積んだアカウントを
    // 観測していないタブへ投げると2302が返り、再試行不能として永久に捨てる。
    test('積んだアカウントのタブが無ければ撃たずに持ち越す', async () => {
      const portFor111 = { name: 'tab-111' } as unknown as chrome.runtime.Port
      let connectedAccount = 111
      const deps = depsOf({
        getPlayerId: () => 111,
        resolvePort: playerId =>
          playerId === connectedAccount ? portFor111 : undefined
      })
      markSessionActive()
      await enqueueReplayHandId(deps, 2800, NOW)
      markSessionInactive()

      // 別アカウントのタブしか繋がっていない
      connectedAccount = 222
      await drainReplayImportQueue(deps)
      expect(fetchCalls).toEqual([])
      expect((await readReplayImportQueue(db)).map(entry => entry.handId)).toEqual([2800])

      // 元のアカウントで繋ぎ直せば流れる
      connectedAccount = 111
      await drainReplayImportQueue(deps)
      expect(fetchCalls).toEqual([[2800]])
    })

    test('handover中もqueued HandIdは積んだaccountを保持し、ACTIVE一致分だけ流す', async () => {
      const accountA = { name: 'account-a' } as unknown as chrome.runtime.Port
      const accountB = { name: 'account-b' } as unknown as chrome.runtime.Port
      const deps = depsOf({
        getPlayerId: readActivePortPlayerId,
        resolvePort: findActivePortForPlayer
      })

      claimActivePort(accountA, NOW)
      markActivePortPlayerId(resolveGeneration(accountA)!, 111)
      await enqueueReplayHandId(deps, 2811, NOW)

      claimActivePort(accountB, NOW + 20_000)
      markActivePortPlayerId(resolveGeneration(accountB)!, 222)
      await enqueueReplayHandId(deps, 2822, NOW + 20_000)
      markActivePortSessionInactive(resolveGeneration(accountB)!)

      await drainReplayImportQueue(deps)
      expect(fetchCalls).toEqual([[2822]])
      expect(await readReplayImportQueue(db)).toEqual([
        { handId: 2811, enqueuedAt: NOW, playerId: 111 }
      ])

      // 旧portの再利用後、次のDEALでaccountが新世代へ再確定すれば、queueに
      // 焼き付け済みの旧account attributionと一致して流れる。
      claimActivePort(accountA, NOW + 40_000)
      markActivePortPlayerId(resolveGeneration(accountA)!, 111)
      markActivePortSessionInactive(resolveGeneration(accountA)!)
      await drainReplayImportQueue(deps)
      expect(fetchCalls).toEqual([[2822], [2811]])
      expect(await readReplayImportQueue(db)).toEqual([])
    })

    test('長時間操作（インポート/再構築）の最中は取得しない', async () => {
      const deps = depsOf({ isBusy: () => true })
      markSessionInactive()
      await enqueueReplayHandId(deps, 2500, NOW)
      await drainReplayImportQueue(deps)
      expect(fetchCalls).toEqual([])
      expect((await readReplayImportQueue(db)).map(entry => entry.handId)).toEqual([2500])
    })
  })
})
