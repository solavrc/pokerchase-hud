import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { PokerChaseDB } from '../db/poker-chase-db'
import { REPLAY_PORT_LEDGER, type ReplayLedger } from '../replay/protocol'
import { ApiType } from '../types/api'
import {
  REPLAY_LEDGER_AUDIT_META_ID,
  auditReplayLedger,
  handleReplayLedgerPortMessage
} from './replay-ledger-audit'
import type { Hand } from '../types/entities'

const HERO = 561384657
const NOW = 1785555471000

const hand = (id: number, netChips: number | null): Hand => ({
  id,
  approxTimestamp: NOW - 3600_000,
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

describe('replay ledger audit', () => {
  let db: PokerChaseDB

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    await db.hands.clear()
    await db.meta.clear()
    await db.apiEvents.clear()
  })

  afterEach(() => db.close())

  test('サーバの台帳にあってローカルに無いハンドをキャプチャ欠損として報告する', async () => {
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
      expect(handleReplayLedgerPortMessage({ ApiTypeId: 303 }, db, HERO, NOW)).toBe(false)
      expect(handleReplayLedgerPortMessage(null, db, HERO, NOW)).toBe(false)
    })

    // 形が違ってもイベント処理へ落とさない。不正なAPIイベントとして
    // 扱われるほうが紛らわしい。
    test('自分宛だが形が違う場合も処理済みとして返し、DBを触らない', async () => {
      expect(handleReplayLedgerPortMessage(
        { type: REPLAY_PORT_LEDGER, hands: 'not-an-array' }, db, HERO, NOW
      )).toBe(true)
      expect(handleReplayLedgerPortMessage(
        { type: REPLAY_PORT_LEDGER, hands: Array.from({ length: 201 }, (_, i) => ({ handId: i + 1, startTime: 0, chipDiff: 0 })) },
        db, HERO, NOW
      )).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 0))
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
      }, db, HERO, NOW)).toBe(true)

      await new Promise(resolve => setTimeout(resolve, 0))
      const stored = await db.meta.get(REPLAY_LEDGER_AUDIT_META_ID)
      expect(stored?.value).toMatchObject({ notCapturedHandIds: [601] })
    })
  })
})
