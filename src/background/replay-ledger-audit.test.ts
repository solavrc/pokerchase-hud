import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { PokerChaseDB } from '../db/poker-chase-db'
import { REPLAY_PORT_LEDGER, type ReplayLedger } from '../replay/protocol'
import { ApiType } from '../types/api'
import {
  REPLAY_LEDGER_AUDIT_MAX_ATTEMPTS,
  REPLAY_LEDGER_AUDIT_META_ID,
  REPLAY_LEDGER_AUDIT_PENDING_META_ID,
  __resetReplayLedgerQueueForTests,
  auditReplayLedger,
  handleReplayLedgerPortMessage,
  resumePendingReplayLedgerAudits,
  type PendingReplayLedgerAudit
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

  // Codexレビュー指摘: 派生が全面停止すると hands が1件も一致せず、時計差を
  // 測れないので全件が対象外に落ちる ―― 監査が最も叫ぶべき場面で沈黙する。
  // 生行の有無は観測の直接証拠なので、観測窓の推定より優先しなければならない。
  test('派生が全面停止していても、生行があるハンドは派生欠落として報告する', async () => {
    // hands は空。生行だけが在る（スキーマ破損や派生の回帰を模す）
    for (const [handId, ts] of [[1400, 1785500030_000], [1401, 1785500090_000]] as const) {
      await db.apiEvents.add({
        timestamp: ts, ApiTypeId: ApiType.EVT_HAND_RESULTS, sequence: 0, HandId: handId
      } as never)
    }

    const result = await auditReplayLedger(db, HERO, ledgerOf([
      { handId: 1400, startTime: 1785500000, chipDiff: 10 },
      { handId: 1401, startTime: 1785500060, chipDiff: 20 }
    ]), NOW)

    expect(result.derivationMissingHandIds).toEqual([1400, 1401])
    expect(result.outOfObservationWindowHands).toBe(0)
    expect(result.notCapturedHandIds).toEqual([])
  })

  // 台帳のどのハンドも hands に無い（派生が壊れている）が、古いローカルハンドは
  // 在るので観測開始の下限は取れる ―― この場合、時計差は生行からしか測れない。
  // フォールバックが無いと補正不能になり、痕跡の無いハンドまで対象外に落ちる。
  test('handsから時計差を測れないときは生行の時刻で補正する', async () => {
    await db.hands.bulkPut([hand(999, 0, 1785400000_000)]) // 観測開始の下限のみ提供
    await db.apiEvents.add({
      timestamp: 1785500030_000, ApiTypeId: ApiType.EVT_HAND_RESULTS, sequence: 0, HandId: 1600
    } as never)

    const result = await auditReplayLedger(db, HERO, ledgerOf([
      { handId: 1600, startTime: 1785500000, chipDiff: 10 },
      { handId: 1601, startTime: 1785500060, chipDiff: 20 }
    ]), NOW)

    expect(result.derivationMissingHandIds).toEqual([1600])
    // 1601 は痕跡が無いが、下限より新しいと判定できるので対象外にはしない
    expect(result.notCapturedHandIds).toEqual([1601])
    expect(result.outOfObservationWindowHands).toBe(0)
  })

  // Codexレビュー指摘: hands が空でも生行が在れば観測はしていた。下限を
  // hands だけから取ると、生行のあるハンドの間に挟まれた本物の非到着を
  // 報告できない。
  test('handsが空でも、生行の時刻を観測開始の下限に使う', async () => {
    // 1800 は生行あり / 1801 は痕跡なし。hands は空。
    await db.apiEvents.add({
      timestamp: 1785500030_000, ApiTypeId: ApiType.EVT_HAND_RESULTS, sequence: 0, HandId: 1800
    } as never)

    const result = await auditReplayLedger(db, HERO, ledgerOf([
      { handId: 1800, startTime: 1785500000, chipDiff: 10 },
      { handId: 1801, startTime: 1785500060, chipDiff: 20 }
    ]), NOW)

    expect(result.derivationMissingHandIds).toEqual([1800])
    // 生行の下限より新しいので、痕跡が無いことを「観測前」で流さない
    expect(result.notCapturedHandIds).toEqual([1801])
    expect(result.outOfObservationWindowHands).toBe(0)
  })

  // Codexレビュー指摘: 台帳の全ハンドが hands にも生行にも無いと時計差を
  // 測れない。それはまさに「最近の全面的な非到着」で、監査が最も報告すべき
  // 状態なのに、全件を観測窓外にすると0件として隠れる。HandIdの単調増加を
  // 使えば時計なしで前後関係を決められる。
  test('時計差が測れなくても、HandIdの境界で最近の全面的な非到着を報告する', async () => {
    // 自分の古い履歴はある。台帳の新しいハンドは hands にも生行にも無い。
    await db.hands.bulkPut([hand(2000, 10, 1785400000_000)])

    const result = await auditReplayLedger(db, HERO, ledgerOf([
      { handId: 1999, startTime: 1785450000, chipDiff: 10 },
      { handId: 2001, startTime: 1785500000, chipDiff: 20 },
      { handId: 2002, startTime: 1785500060, chipDiff: 30 }
    ]), NOW)

    // 自分の最古ハンド(2000)より新しいものは判定対象、古いものは対象外
    expect(result.notCapturedHandIds).toEqual([2001, 2002])
    expect(result.outOfObservationWindowHands).toBe(1)
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

  // ヒーローが未特定だと `hands` をアカウントで絞れないので、観測開始の下限は
  // 台帳自身の生行から取る。それがあれば欠損検出は成立し、チップ照合だけを
  // 見送る。
  test('ヒーロー未特定でも、生行があれば欠損検出は成立しチップ照合だけ見送る', async () => {
    // 台帳の startTime と整合する記録時刻にする（時計差の中央値がここから出る）
    await db.hands.bulkPut([hand(400, 500, 1785500030_000)])
    await db.apiEvents.add({
      timestamp: 1785500030_000, ApiTypeId: ApiType.EVT_HAND_RESULTS, sequence: 0, HandId: 400
    } as never)

    const result = await auditReplayLedger(db, undefined, ledgerOf([
      { handId: 400, startTime: 1785500000, chipDiff: 500 },
      { handId: 401, startTime: 1785500060, chipDiff: 100 }
    ]), NOW)

    expect(result.notCapturedHandIds).toEqual([401])
    expect(result.unverifiableHands).toBe(1)
    expect(result.chipDiffMismatches).toEqual([])
  })

  // Codexレビュー指摘: 同じプロファイルを複数アカウントで使うと、DBに前の
  // アカウントの履歴が残る。全体の最古ハンドを下限にすると、切り替え直後に
  // 台帳の全件が偽のローカル不在として保存される。
  test('別アカウントの履歴があっても、観測開始の下限は現在のアカウントで決める', async () => {
    const OTHER = 111111111
    // 別アカウントのずっと古い履歴
    await db.hands.bulkPut([{
      ...hand(50, 0, 1785400000_000),
      seatUserIds: [OTHER, 686412100, -1, -1, -1, -1]
    } as never])
    // HERO の履歴はここから（時計差もこのハンドから測れる）
    await db.hands.bulkPut([hand(62, 30, 1785500120_000)])

    const result = await auditReplayLedger(db, HERO, ledgerOf([
      // HERO を観測し始める前のハンド。別アカウントの履歴を下限にすると
      // 「観測済みの期間」に入ってしまい、偽のローカル不在になる。
      { handId: 59, startTime: 1785450000, chipDiff: 10 },
      { handId: 62, startTime: 1785500120, chipDiff: 30 }
    ]), NOW)

    expect(result.outOfObservationWindowHands).toBe(1)
    expect(result.notCapturedHandIds).toEqual([])
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
      let reads = 0

      expect(handleReplayLedgerPortMessage({
        type: REPLAY_PORT_LEDGER,
        battleType: 0,
        cardOpenEndDate: 0,
        isExpiredCardOpen: false,
        hands: [{ handId: 1100, startTime: 1785500000, chipDiff: 500 }]
      }, depsOf(db, {
        waitUntilConsistent: () => gate,
        getPlayerId: () => { reads++; return HERO }
      }))).toBe(true)

      // 待ちが解けるまで照会は起きていない。playerId は受信時のアカウントを
      // 控えるために1回だけ読む（待った後にもう一度読んで一致を確かめる）。
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(reads).toBe(1)
      expect(await db.meta.get(REPLAY_LEDGER_AUDIT_META_ID)).toBeUndefined()

      // 待っている間に書き込みが決着した、という想定
      await db.hands.bulkPut([hand(1100, 500)])
      released()

      expect(await waitForAuditResult(db)).toMatchObject({ notCapturedHandIds: [] })
      expect(reads).toBe(2)
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

    // Codexレビュー指摘: インポートは生行を先にコミットして派生を後から作るので、
    // その最中に照会すると正常に処理中のハンドが派生欠落として永続化される。
    test('長時間操作の実行中は突き合わせを見送る', async () => {
      await db.hands.bulkPut([hand(1500, 10)])
      expect(handleReplayLedgerPortMessage({
        type: REPLAY_PORT_LEDGER,
        battleType: 0,
        cardOpenEndDate: 0,
        isExpiredCardOpen: false,
        hands: [{ handId: 1500, startTime: 1785500000, chipDiff: 10 }]
      }, { ...depsOf(db), isBusy: () => true })).toBe(true)

      await new Promise(resolve => setTimeout(resolve, 80))
      expect(await db.meta.get(REPLAY_LEDGER_AUDIT_META_ID)).toBeUndefined()
    })

    // Codexレビュー指摘: 開始時のチェックと照会の間にインポートが始まりうる。
    // 監査の間ずっと操作スロットを保持するとユーザー操作を待たせるので、
    // 読んだ結果を保存直前に捨てる形にした。
    test('照会の途中で長時間操作が始まったら結果を保存しない', async () => {
      await db.hands.bulkPut([hand(1700, 10)])
      let busy = false
      expect(handleReplayLedgerPortMessage({
        type: REPLAY_PORT_LEDGER,
        battleType: 0,
        cardOpenEndDate: 0,
        isExpiredCardOpen: false,
        hands: [{ handId: 1700, startTime: 1785500000, chipDiff: 10 }]
      }, {
        ...depsOf(db),
        // 開始時は idle、監査に入った直後に操作が始まる
        waitUntilConsistent: async () => { busy = false },
        isBusy: () => { const v = busy; busy = true; return v }
      })).toBe(true)

      await new Promise(resolve => setTimeout(resolve, 120))
      expect(await db.meta.get(REPLAY_LEDGER_AUDIT_META_ID)).toBeUndefined()
    })

    // Codexレビュー指摘: 待機中に別アカウントの EVT_DEAL が処理されると
    // playerId が上書きされ、Aの台帳をBの会計と突き合わせてしまう。
    // Codexレビュー指摘: 受信時のアカウントを .then() の中で読むと、先行監査の
    // 最中に切り替わった場合に2件目が「自分の番が来た時」の値を控えてしまい、
    // 変更ガードを素通りする。
    test('先行監査の最中にアカウントが変わっても、2件目は受信時の値で判定する', async () => {
      await db.hands.bulkPut([hand(2100, 10), hand(2101, 20)])
      let current: number | undefined = HERO
      const msg = (handId: number) => ({
        type: REPLAY_PORT_LEDGER,
        battleType: 0,
        cardOpenEndDate: 0,
        isExpiredCardOpen: false,
        hands: [{ handId, startTime: 1785500000, chipDiff: handId === 2100 ? 10 : 20 }]
      })
      // 1件目の待機中にアカウントが変わる。2件目は「受信時＝HERO」で控えて
      // いなければならない（.then() の中で読むと B を控えてしまう）。
      handleReplayLedgerPortMessage(msg(2100), depsOf(db, {
        waitUntilConsistent: async () => { current = 999999999 },
        getPlayerId: () => current
      }))
      handleReplayLedgerPortMessage(msg(2101), depsOf(db, { getPlayerId: () => current }))

      await new Promise(resolve => setTimeout(resolve, 120))
      // どちらもアカウント不一致で見送られる
      expect(await db.meta.get(REPLAY_LEDGER_AUDIT_META_ID)).toBeUndefined()
    })

    test('待機中にアカウントが変わったら突き合わせを見送る', async () => {
      await db.hands.bulkPut([hand(1900, 10)])
      let current: number | undefined = HERO
      expect(handleReplayLedgerPortMessage({
        type: REPLAY_PORT_LEDGER,
        battleType: 0,
        cardOpenEndDate: 0,
        isExpiredCardOpen: false,
        hands: [{ handId: 1900, startTime: 1785500000, chipDiff: 10 }]
      }, depsOf(db, {
        // 待っている間に別アカウントへ切り替わる
        waitUntilConsistent: async () => { current = 999999999 },
        getPlayerId: () => current
      }))).toBe(true)

      await new Promise(resolve => setTimeout(resolve, 80))
      expect(await db.meta.get(REPLAY_LEDGER_AUDIT_META_ID)).toBeUndefined()
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

  // Codexレビュー指摘: 全走査を伴う監査はService Workerの非アクティブ期限を
  // またぎうる。ポートのハンドラは既に同期的に返っているので、モジュール
  // スコープのキューごと消えると受け取った台帳が失われ、再開もできない。
  describe('Service Worker再起動をまたぐ再開', () => {
    const readPending = async (): Promise<PendingReplayLedgerAudit[]> => {
      const record = await db.meta.get(REPLAY_LEDGER_AUDIT_PENDING_META_ID)
      return ((record?.value as { pending?: PendingReplayLedgerAudit[] } | undefined)?.pending) ?? []
    }

    test('監査の実行中は台帳を控え、完了したら控えを外す', async () => {
      await db.hands.bulkPut([hand(3100, 10)])
      let released!: () => void
      const gate = new Promise<void>(resolve => { released = resolve })

      handleReplayLedgerPortMessage({
        type: REPLAY_PORT_LEDGER,
        battleType: 0,
        cardOpenEndDate: 0,
        isExpiredCardOpen: false,
        hands: [{ handId: 3100, startTime: 1785500000, chipDiff: 10 }]
      }, depsOf(db, { waitUntilConsistent: () => gate }))

      // 控えは監査の完了を待たずに書かれている（＝ここでworkerが死んでも残る）
      for (let attempt = 0; attempt < 100 && (await readPending()).length === 0; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      const pending = await readPending()
      expect(pending).toHaveLength(1)
      expect(pending[0]!.ledger.hands).toEqual([{ handId: 3100, startTime: 1785500000, chipDiff: 10 }])
      expect(pending[0]!.attempts).toBe(1)

      released()
      await waitForAuditResult(db)
      for (let attempt = 0; attempt < 100 && (await readPending()).length > 0; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(await readPending()).toEqual([])
    })

    test('控えが残っていれば起動時に突き合わせを再開する', async () => {
      await db.hands.bulkPut([hand(3300, 10)])
      // 前回のworkerが監査の途中で終了した状態を再現する
      await db.meta.put({
        id: REPLAY_LEDGER_AUDIT_PENDING_META_ID,
        value: {
          pending: [{
            ledger: ledgerOf([
              { handId: 3300, startTime: 1785500000, chipDiff: 10 },
              { handId: 3301, startTime: 1785500060, chipDiff: 20 }
            ]),
            playerIdAtReceipt: HERO,
            receivedAt: NOW - 1000,
            attempts: 1
          }]
        },
        updatedAt: NOW - 1000
      })

      await resumePendingReplayLedgerAudits(depsOf(db))

      expect(await waitForAuditResult(db)).toMatchObject({ notCapturedHandIds: [3301] })
      for (let attempt = 0; attempt < 100 && (await readPending()).length > 0; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(await readPending()).toEqual([])
    })

    // Codexレビュー指摘（3周目）: 走査位置を控えないと、Lakeが大きく1回の
    // worker寿命で走査し切れない場合にどの試行も同じ辺りで終わり、一度も
    // 完走しないまま上限に達して台帳だけが捨てられる。
    test('全走査の途中経過を控え、再開時はその位置から続ける', async () => {
      // 生行を多めに積み、途中まで走査した控えを用意する
      await db.apiEvents.bulkAdd(Array.from({ length: 60 }, (_, index) => ({
        timestamp: OLDEST_LOCAL_MS + index,
        ApiTypeId: ApiType.EVT_HAND_RESULTS,
        sequence: 0,
        HandId: 4000 + index
      })) as any)

      const progresses: unknown[] = []
      await auditReplayLedger(
        db,
        HERO,
        ledgerOf([{ handId: 4059, startTime: 1785500000, chipDiff: 10 }]),
        NOW,
        undefined,
        undefined,
        {
          // 既に確認済みとして持ち越された分は再走査しない
          resume: { found: [[4059, OLDEST_LOCAL_MS + 59]] },
          onProgress: progress => progresses.push(progress)
        }
      )

      const stored = await db.meta.get(REPLAY_LEDGER_AUDIT_META_ID)
      // 生行が在ると分かっているので「ローカル不在」にはならない
      expect((stored?.value as { notCapturedHandIds: number[] }).notCapturedHandIds).toEqual([])
      // 持ち越しで全て解決したので、走査自体が走らない（1ページも読まない）
      expect(progresses).toEqual([])
    })

    // 毎回worker停止で終わる台帳を、起動のたびに走らせ続けないため。
    test('再開の上限に達した控えは破棄して実行しない', async () => {
      await db.hands.bulkPut([hand(3500, 10)])
      await db.meta.put({
        id: REPLAY_LEDGER_AUDIT_PENDING_META_ID,
        value: {
          pending: [{
            ledger: ledgerOf([{ handId: 3500, startTime: 1785500000, chipDiff: 10 }]),
            playerIdAtReceipt: HERO,
            receivedAt: NOW - 1000,
            attempts: REPLAY_LEDGER_AUDIT_MAX_ATTEMPTS
          }]
        },
        updatedAt: NOW - 1000
      })

      await resumePendingReplayLedgerAudits(depsOf(db))

      await new Promise(resolve => setTimeout(resolve, 80))
      expect(await db.meta.get(REPLAY_LEDGER_AUDIT_META_ID)).toBeUndefined()
      expect(await readPending()).toEqual([])
    })

    test('控えが無ければ何も実行しない', async () => {
      await resumePendingReplayLedgerAudits(depsOf(db))
      await new Promise(resolve => setTimeout(resolve, 40))
      expect(await db.meta.get(REPLAY_LEDGER_AUDIT_META_ID)).toBeUndefined()
    })

    // Codexレビュー指摘（2周目）: 起動直後に同じbattleTypeの新しい台帳が届くと、
    // 再開側が読んだ古いスナップショットを後から書き戻して新しい控えを巻き戻し、
    // 監査キューでも古い結果が最後に上書きしうる。
    test('再開の最中に新しい台帳が届いたら、古い方は再開しない', async () => {
      await db.hands.bulkPut([hand(3700, 10), hand(3701, 20)])
      await db.meta.put({
        id: REPLAY_LEDGER_AUDIT_PENDING_META_ID,
        value: {
          pending: [{
            ledger: ledgerOf([{ handId: 3700, startTime: 1785500000, chipDiff: 10 }]),
            playerIdAtReceipt: HERO,
            receivedAt: NOW - 5000,
            attempts: 1
          }]
        },
        updatedAt: NOW - 5000
      })

      // 起動時の再開と、同じカテゴリの新規受信がほぼ同時に走る
      const resumed = resumePendingReplayLedgerAudits(depsOf(db))
      handleReplayLedgerPortMessage({
        type: REPLAY_PORT_LEDGER,
        battleType: 0,
        cardOpenEndDate: 0,
        isExpiredCardOpen: false,
        hands: [{ handId: 3701, startTime: 1785500060, chipDiff: 999 }]
      }, depsOf(db))
      await resumed

      await new Promise(resolve => setTimeout(resolve, 200))
      // 新しい台帳（chipDiff不一致）の結果が残っている ＝ 古い方に上書き
      // されていない
      const stored = await db.meta.get(REPLAY_LEDGER_AUDIT_META_ID)
      expect((stored?.value as { chipDiffMismatches: unknown[] }).chipDiffMismatches)
        .toHaveLength(1)
      expect(await readPending()).toEqual([])
    })
  })

  // Codexレビュー指摘（2周目）: `isBusy`を保存直前に一度読むだけでは、監査中に
  // 始まって確認前に終わった操作を検出できない。読んだスナップショットは
  // 操作前後が混ざっている。
  test('監査の最中に長時間操作が走り切っていたら結果を保存しない', async () => {
    await db.hands.bulkPut([hand(3900, 10)])
    let generation = 7
    const result = await auditReplayLedger(
      db,
      HERO,
      ledgerOf([{ handId: 3900, startTime: 1785500000, chipDiff: 10 }]),
      NOW,
      () => false,
      // 読み始めと書き戻しで世代が変わっている＝間に操作が1回走り切った
      () => generation++
    )
    expect(result.listedHands).toBe(1)
    expect(await db.meta.get(REPLAY_LEDGER_AUDIT_META_ID)).toBeUndefined()
  })
})
