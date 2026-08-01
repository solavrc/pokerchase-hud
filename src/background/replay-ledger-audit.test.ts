import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { PokerChaseDB } from '../db/poker-chase-db'
import { REPLAY_PORT_LEDGER, type ReplayLedger } from '../replay/protocol'
import { ApiType } from '../types/api'
import {
  REPLAY_LEDGER_AUDIT_META_ID,
  __resetReplayLedgerQueueForTests,
  auditReplayLedger,
  handleReplayLedgerPortMessage
} from './replay-ledger-audit'
import type { Hand } from '../types/entities'

const HERO = 561384657
const NOW = 1785555471000

// 台帳の startTime(秒) より古い時刻。観測開始フロアがこれになるので、
// 検体の台帳エントリはすべて判定対象に入る。
const OLDEST_LOCAL_MS = 1785499000_000

const hand = (id: number, netChips: number | null, atMs = OLDEST_LOCAL_MS): Hand => ({
  id,
  approxTimestamp: atMs,
  seatUserIds: [HERO, 686412100, -1, -1, -1, -1],
  winningPlayerIds: [],
  smallBlind: 390,
  bigBlind: 780,
  session: { id: 'legend', battleType: 0, name: 'legend' },
  results: [],
  playerChipAccounting: {
    [String(HERO)]: netChips === null
      ? null
      : { grossPayout: Math.max(0, netChips), totalContribution: 0, netChips }
  }
} as unknown as Hand)

const ledgerOf = (hands: ReplayLedger['hands']): ReplayLedger => ({
  battleType: 0,
  cardOpenEndDate: 0,
  isExpiredCardOpen: false,
  hands
})

const depsOf = (db: PokerChaseDB, overrides: Partial<{
  waitUntilConsistent: () => Promise<void>
  getPlayerId: () => number | undefined
}> = {}) => ({
  db,
  waitUntilConsistent: overrides.waitUntilConsistent ?? (async () => undefined),
  getPlayerId: overrides.getPlayerId ?? (() => HERO as number | undefined),
  now: () => NOW
})

/**
 * `handleReplayLedgerPortMessage` は監査を投げっぱなしにするので、書き込みは
 * 数ティック後になる。何ティックかは監査内のDB往復の回数次第で変わるため
 * （`apiEvents` 参照を足した時点で `setTimeout(0)` 1回では足りなくなった）、
 * 固定待ちではなく書き込まれるまで待つ。
 */
const waitForAuditResult = async (db: PokerChaseDB): Promise<unknown> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const stored = await db.meta.get(REPLAY_LEDGER_AUDIT_META_ID)
    if (stored) return stored.value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('監査結果が書き込まれなかった')
}

describe('replay ledger audit', () => {
  let db: PokerChaseDB

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    await db.hands.clear()
    await db.meta.clear()
    await db.apiEvents.clear()
    __resetReplayLedgerQueueForTests()
  })

  afterEach(() => db.close())

  test('サーバの台帳にあってローカルに無いハンドをローカル不在として報告する', async () => {
    await db.hands.bulkPut([hand(100, 500), hand(102, -200)])

    const result = await auditReplayLedger(db, HERO, ledgerOf([
      { handId: 100, startTime: 1785500000, chipDiff: 500 },
      { handId: 101, startTime: 1785500060, chipDiff: 300 },
      { handId: 102, startTime: 1785500120, chipDiff: -200 }
    ]), NOW)

    expect(result.listedHands).toBe(3)
    expect(result.notCapturedHandIds).toEqual([101])
    expect(result.chipDiffMismatches).toEqual([])
    expect(result.unverifiableHands).toBe(0)
  })

  // Codexレビュー指摘: 派生テーブルの不在だけでキャプチャ欠損と断定しない。
  // キメラハンドの意図的な棄却など、rawはあるのにhandsが無い正常系がある。
  test('rawイベントがあってhandsが無い場合は欠損ではなく派生欠落として分類する', async () => {
    await db.hands.bulkPut([hand(700, 500)])
    // 701 は EVT_HAND_RESULTS が Lake に在るのに hands が無い（派生側で棄却）
    await db.apiEvents.add({
      timestamp: 1785500060_000 + 30_000,
      ApiTypeId: ApiType.EVT_HAND_RESULTS,
      sequence: 0,
      HandId: 701
    } as never)

    const result = await auditReplayLedger(db, HERO, ledgerOf([
      { handId: 700, startTime: 1785500000, chipDiff: 500 },
      { handId: 701, startTime: 1785500060, chipDiff: 300 },
      { handId: 702, startTime: 1785500120, chipDiff: 100 }
    ]), NOW)

    expect(result.derivationMissingHandIds).toEqual([701])
    expect(result.notCapturedHandIds).toEqual([702])
  })

  // Codexレビュー指摘: 新規インストール直後・再有効化直後・全データ削除後は、
  // 台帳に過去3日分が載る一方でローカルに無いのが正常。これを欠損に数えると
  // 初回だけで最大100件の偽陽性を永続化する。
  test('観測開始より前のハンドは欠損に数えず、対象から外す', async () => {
    // ローカル最古が 1785500100 秒 → それより前の台帳エントリは判定しない
    await db.hands.bulkPut([hand(800, 500, 1785500100_000)])

    const result = await auditReplayLedger(db, HERO, ledgerOf([
      { handId: 798, startTime: 1785400000, chipDiff: 10 },
      { handId: 799, startTime: 1785500000, chipDiff: 20 },
      { handId: 800, startTime: 1785500100, chipDiff: 500 }
    ]), NOW)

    expect(result.outOfObservationWindowHands).toBe(2)
    expect(result.listedHands).toBe(1)
    expect(result.notCapturedHandIds).toEqual([])
  })

  test('ローカルが空なら全件を対象外にする（新規インストール直後）', async () => {
    const result = await auditReplayLedger(db, HERO, ledgerOf([
      { handId: 900, startTime: 1785500000, chipDiff: 10 },
      { handId: 901, startTime: 1785500060, chipDiff: 20 }
    ]), NOW)

    expect(result.outOfObservationWindowHands).toBe(2)
    expect(result.notCapturedHandIds).toEqual([])
  })

  // Codexレビュー指摘: StartTimeはサーバ時刻、apiEvents.timestampはクライアントの
  // Date.now()。端末時計がずれていると生行が実在しても時間範囲から外れる。
  // 限定的な時間検索の空振りを「イベント非到着の証拠」にしてはいけない。
  test('端末時計が大きくずれていても、生行があれば欠損と断定しない', async () => {
    await db.hands.bulkPut([hand(1000, 500)])
    // 台帳の startTime より 10 日ぶん後ろにずれた受信時刻（時間範囲の外）
    await db.apiEvents.add({
      timestamp: 1785500060_000 + 10 * 86_400_000,
      ApiTypeId: ApiType.EVT_HAND_RESULTS,
      sequence: 0,
      HandId: 1001
    } as never)

    const result = await auditReplayLedger(db, HERO, ledgerOf([
      { handId: 1000, startTime: 1785500000, chipDiff: 500 },
      { handId: 1001, startTime: 1785500060, chipDiff: 300 }
    ]), NOW)

    expect(result.notCapturedHandIds).toEqual([])
    expect(result.derivationMissingHandIds).toEqual([1001])
  })

  // Codexレビュー指摘: startTimeはサーバ時刻、approxTimestampはクライアント時計。
  // 素朴に比べると、端末時計が進んでいれば観測済みのハンドまで対象外になる。
  test('端末時計が進んでいても、観測済みのハンドを対象外にしない', async () => {
    const SKEW = 6 * 3600_000 // 端末が6時間進んでいる
    // ローカルの3ハンドはすべてズレた時刻で記録されている
    await db.hands.bulkPut([
      hand(1200, 10, 1785500000_000 + SKEW),
      hand(1201, 20, 1785500060_000 + SKEW),
      hand(1202, 30, 1785500120_000 + SKEW)
    ])

    const result = await auditReplayLedger(db, HERO, ledgerOf([
      { handId: 1200, startTime: 1785500000, chipDiff: 10 },
      { handId: 1201, startTime: 1785500060, chipDiff: 20 },
      { handId: 1202, startTime: 1785500120, chipDiff: 30 }
    ]), NOW)

    // 補正が無いと floor(=1785500000000+SKEW) を全件が下回り全部対象外になる
    expect(result.outOfObservationWindowHands).toBe(0)
    expect(result.listedHands).toBe(3)
    expect(result.chipDiffMismatches).toEqual([])
  })

  test('ChipDiffとnetChipsの食い違いを報告する', async () => {
    await db.hands.bulkPut([hand(200, 500), hand(201, 999)])

    const result = await auditReplayLedger(db, HERO, ledgerOf([
      { handId: 200, startTime: 1785500000, chipDiff: 500 },
      { handId: 201, startTime: 1785500060, chipDiff: 300 }
    ]), NOW)

    expect(result.notCapturedHandIds).toEqual([])
    expect(result.chipDiffMismatches).toEqual([
      { handId: 201, ledgerChipDiff: 300, localNetChips: 999 }
    ])
  })

  // nullは「会計を確定できなかった」印であって誤った値ではない。不一致に
  // 数えると本物の不一致が埋もれるので、件数だけ別に持つ。
  test('会計が未確定(null)のハンドは不一致ではなく照合不能として数える', async () => {
    await db.hands.bulkPut([hand(300, null)])

    const result = await auditReplayLedger(db, HERO, ledgerOf([
      { handId: 300, startTime: 1785500000, chipDiff: 12345 }
    ]), NOW)

    expect(result.chipDiffMismatches).toEqual([])
    expect(result.unverifiableHands).toBe(1)
    expect(result.notCapturedHandIds).toEqual([])
  })

  test('ヒーロー未特定でも欠損検出は成立し、チップ照合だけ見送る', async () => {
    await db.hands.bulkPut([hand(400, 500)])

    const result = await auditReplayLedger(db, undefined, ledgerOf([
      { handId: 400, startTime: 1785500000, chipDiff: 500 },
      { handId: 401, startTime: 1785500060, chipDiff: 100 }
    ]), NOW)

    expect(result.notCapturedHandIds).toEqual([401])
    expect(result.unverifiableHands).toBe(1)
    expect(result.chipDiffMismatches).toEqual([])
  })

  test('結果をmetaへ書く（専用ストアを作らない＝Dexieのバージョンを消費しない）', async () => {
    await db.hands.bulkPut([hand(500, 500)])

    await auditReplayLedger(db, HERO, {
      battleType: 4,
      cardOpenEndDate: 1786000000,
      isExpiredCardOpen: false,
      hands: [{ handId: 500, startTime: 1785500000, chipDiff: 500 }]
    }, NOW)

    const stored = await db.meta.get(REPLAY_LEDGER_AUDIT_META_ID)
    expect(stored?.updatedAt).toBe(NOW)
    expect(stored?.value).toMatchObject({
      battleType: 4,
      cardOpenEndDate: 1786000000,
      listedHands: 1,
      notCapturedHandIds: [],
      chipDiffMismatches: []
    })
    // 全DBバージョンのストア一覧に台帳専用ストアが増えていないこと
    expect(db.tables.map(table => table.name)).not.toContain('replayLedger')
  })

  describe('handleReplayLedgerPortMessage', () => {
    test('台帳以外のメッセージは自分宛でないと申告する', () => {
      expect(handleReplayLedgerPortMessage({ ApiTypeId: 303 }, depsOf(db))).toBe(false)
      expect(handleReplayLedgerPortMessage(null, depsOf(db))).toBe(false)
    })

    // 形が違ってもイベント処理へ落とさない。不正なAPIイベントとして
    // 扱われるほうが紛らわしい。
    test('自分宛だが形が違う場合も処理済みとして返し、DBを触らない', async () => {
      expect(handleReplayLedgerPortMessage(
        { type: REPLAY_PORT_LEDGER, hands: 'not-an-array' }, depsOf(db)
      )).toBe(true)
      expect(handleReplayLedgerPortMessage(
        { type: REPLAY_PORT_LEDGER, hands: Array.from({ length: 201 }, (_, i) => ({ handId: i + 1, startTime: 0, chipDiff: 0 })) },
        depsOf(db)
      )).toBe(true)
      // こちらは同期的な早期リターンの検証なので固定待ちで足りる（監査が
      // 走ってしまう変異なら、待ち時間に関係なく最終的に書き込まれる）。
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(await db.meta.get(REPLAY_LEDGER_AUDIT_META_ID)).toBeUndefined()
    })

    // Codexレビュー指摘: 直前のEVT_HAND_RESULTSの書き込みは ingestionQueue に
    // 積まれるだけなので、待たずに照会すると受信済みのハンドを未キャプチャに
    // 分類しうる。復元前の playerId を固定する問題も同じ待ちで閉じる。
    test('取り込みの決着と状態復元を待ってから照合する', async () => {
      let released!: () => void
      const gate = new Promise<void>(resolve => { released = resolve })
      let playerIdReadyAt = -1
      let reads = 0

      expect(handleReplayLedgerPortMessage({
        type: REPLAY_PORT_LEDGER,
        battleType: 0,
        cardOpenEndDate: 0,
        isExpiredCardOpen: false,
        hands: [{ handId: 1100, startTime: 1785500000, chipDiff: 500 }]
      }, depsOf(db, {
        waitUntilConsistent: () => gate,
        getPlayerId: () => { playerIdReadyAt = ++reads; return HERO }
      }))).toBe(true)

      // 待ちが解けるまで照会も playerId の読み取りも起きていない
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(playerIdReadyAt).toBe(-1)
      expect(await db.meta.get(REPLAY_LEDGER_AUDIT_META_ID)).toBeUndefined()

      // 待っている間に書き込みが決着した、という想定
      await db.hands.bulkPut([hand(1100, 500)])
      released()

      expect(await waitForAuditResult(db)).toMatchObject({ notCapturedHandIds: [] })
      expect(playerIdReadyAt).toBe(1)
    })

    // Codexレビュー指摘: 同じキーへ書くので、重い監査が後発の軽い監査より
    // 遅く終わると古い結果が新しい結果を上書きする。
    test('複数の台帳が重なっても受信順に直列化して最後の結果を残す', async () => {
      await db.hands.bulkPut([hand(1300, 10), hand(1301, 20)])
      const ledgerMsg = (battleType: number, handId: number) => ({
        type: REPLAY_PORT_LEDGER,
        battleType,
        cardOpenEndDate: 0,
        isExpiredCardOpen: false,
        hands: [{ handId, startTime: 1785500000, chipDiff: handId === 1300 ? 10 : 20 }]
      })
      // 先に受けたほうを意図的に遅くする
      handleReplayLedgerPortMessage(ledgerMsg(0, 1300), depsOf(db, {
        waitUntilConsistent: () => new Promise(resolve => setTimeout(resolve, 60))
      }))
      handleReplayLedgerPortMessage(ledgerMsg(4, 1301), depsOf(db))

      await new Promise(resolve => setTimeout(resolve, 300))
      const stored = await db.meta.get(REPLAY_LEDGER_AUDIT_META_ID)
      expect((stored?.value as { battleType: number }).battleType).toBe(4)
    })

    test('台帳を受け取ると突き合わせを実行する', async () => {
      await db.hands.bulkPut([hand(600, 500)])
      expect(handleReplayLedgerPortMessage({
        type: REPLAY_PORT_LEDGER,
        battleType: 0,
        cardOpenEndDate: 0,
        isExpiredCardOpen: false,
        hands: [
          { handId: 600, startTime: 1785500000, chipDiff: 500 },
          { handId: 601, startTime: 1785500060, chipDiff: 700 }
        ]
      }, depsOf(db))).toBe(true)

      expect(await waitForAuditResult(db)).toMatchObject({ notCapturedHandIds: [601] })
    })
  })
})
