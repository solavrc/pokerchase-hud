import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { PokerChaseDB } from '../db/poker-chase-db'
import { ApiType } from '../types/api'
import type { ReplayFetchItemResult } from '../replay/protocol'
import {
  REPLAY_IMPORT_QUEUE_META_ID,
  REPLAY_IMPORT_STATUS_META_ID,
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
  __resetUpdateManagerStateForTests,
  markSessionActive,
  markSessionInactive
} from './update-manager'

/** 2026-08-01 12:00 JST 相当。暦日の窓の基準に使う。 */
const NOW = Date.UTC(2026, 7, 1, 3, 0, 0)

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
    __resetUpdateManagerStateForTests()
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

    // SWはいつでも落ちうるので、再起動直後の`unknown`は「セッション中かも
    // しれない」が正しい。分からない間は撃たない。
    test('Service Worker再起動直後（セッション状態unknown）も取得しない', async () => {
      const deps = depsOf()
      await enqueueReplayHandId(deps, 1100, NOW)

      // `__resetUpdateManagerStateForTests()` が 'unknown' に戻している
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

      // 2周目も不変条件で止まる
      await enqueueReplayHandId(deps, 1202, NOW)
      await drainReplayImportQueue(deps)
      expect(fetchCalls).toEqual([[1200]])
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
      // 撃たなかった2件はキューに残る
      expect((await readReplayImportQueue(db)).map(entry => entry.handId)).toEqual([1212, 1213])
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
    test('積んだアカウントと違うアカウントでは撃たずに持ち越す', async () => {
      let currentPlayer: number | undefined = 111
      const deps = depsOf({ getPlayerId: () => currentPlayer })
      markSessionActive()
      await enqueueReplayHandId(deps, 2800, NOW)
      markSessionInactive()

      currentPlayer = 222
      await drainReplayImportQueue(deps)
      expect(fetchCalls).toEqual([])
      expect((await readReplayImportQueue(db)).map(entry => entry.handId)).toEqual([2800])

      // 元のアカウントへ戻れば取得する
      currentPlayer = 111
      await drainReplayImportQueue(deps)
      expect(fetchCalls).toEqual([[2800]])
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
