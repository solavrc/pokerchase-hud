/**
 * AggregateEventsStream Tests
 *
 * セッション境界イベント（EVT_ENTRY_QUEUED）がハンドの途中に割り込むケースの回帰テスト。
 *
 * 実データ（393,830イベント）では、MTTのテーブル移動により EVT_ENTRY_QUEUED が
 * EVT_DEAL〜EVT_HAND_RESULTS の間に1,241回割り込む。テーブル移動後もハンド自体は
 * 中断されず、残りのアクションは新しい席番号で配信され続ける。しかし
 * resetSession() は service.session をリセットするだけで、Stream側の
 * this.progress（移動前の席番号を基準にしたNextActionSeat）はクリアされないままだった。
 * そのため移動後最初のEVT_ACTIONが古いthis.progressと席不一致とみなされ、
 * ハンドバッファ（this.events）が誤ってクリアされ、最終的なEVT_HAND_RESULTSが
 * EVT_DEAL始まりでないバッファに積まれて無言でドロップされていた
 * （実データで32,221ハンド中920ハンド=2.9%が消失、933件の不一致中785件がこのケース）。
 */
import PokerChaseService, { PokerChaseDB } from '../app'
import type { ApiEvent } from '../app'
import { ApiType } from '../types'
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'

describe('AggregateEventsStream', () => {
  test('EVT_ENTRY_QUEUEDがハンド途中（テーブル移動）に割り込んでも、そのハンドは欠損なく出力される', async () => {
    const events: ApiEvent[] = [
      // --- Hand 1: 3人テーブルで開始 ---
      {
        ApiTypeId: ApiType.EVT_DEAL,
        SeatUserIds: [101, 102, 103],
        Game: { CurrentBlindLv: 1, NextBlindUnixSeconds: 0, Ante: 0, SmallBlind: 100, BigBlind: 200, ButtonSeat: 0, SmallBlindSeat: 1, BigBlindSeat: 2 },
        Player: { SeatIndex: 0, BetStatus: 1, HoleCards: [0, 1], Chip: 5000, BetChip: 0 },
        OtherPlayers: [
          { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 100, IsSafeLeave: false },
          { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 200, IsSafeLeave: false },
        ],
        Progress: { Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 400, Pot: 300, SidePot: [] },
        timestamp: 1000,
      },
      {
        ApiTypeId: ApiType.EVT_ACTION,
        SeatIndex: 0,
        ActionType: 2,
        Chip: 5000,
        BetChip: 0,
        Progress: { Phase: 0, NextActionSeat: 1, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 400, Pot: 300, SidePot: [] },
        timestamp: 1001,
      },
      // --- セッション境界: MTTのテーブル移動でEVT_ENTRY_QUEUEDが割り込む。
      //     ハンド自体は中断されず、以降のアクションは新しい席番号で配信され続ける
      //     （新しいEVT_DEALは来ない＝同一ハンドの継続）。 ---
      {
        ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
        Code: 0,
        BattleType: 1,
        Id: '9999',
        IsRetire: false,
        timestamp: 1002,
      },
      // 移動後、SBを持つプレイヤーがcallする。新テーブルでは席番号が再割当てされるため
      // （旧seat1 → 新テーブルでは物理的にseat4扱いで配信される等）、移動前のthis.progress
      // が指すNextActionSeat（=1）と実際に配信されるSeatIndex（=4）が一致しなくなる。
      // これが実データにおける933件中785件の「席不一致」の実体である。
      {
        ApiTypeId: ApiType.EVT_ACTION,
        SeatIndex: 4,
        ActionType: 2,
        Chip: 4900,
        BetChip: 200,
        Progress: { Phase: 0, NextActionSeat: 2, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 400, Pot: 500, SidePot: [] },
        timestamp: 1003,
      },
      {
        ApiTypeId: ApiType.EVT_ACTION,
        SeatIndex: 2,
        ActionType: 0,
        Chip: 4800,
        BetChip: 200,
        Progress: { Phase: 3, NextActionSeat: -2, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 600, SidePot: [] },
        timestamp: 1004,
      },
      {
        ApiTypeId: ApiType.EVT_HAND_RESULTS,
        CommunityCards: [],
        Pot: 600,
        SidePot: [],
        ResultType: 0,
        DefeatStatus: 0,
        HandId: 555,
        HandLog: '',
        Results: [{ UserId: 101, HoleCards: [], RankType: 10, Hands: [], HandRanking: 1, Ranking: -2, RewardChip: 600 }],
        Player: { SeatIndex: 0, BetStatus: -1, Chip: 5000, BetChip: 0 },
        OtherPlayers: [
          { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 4900, BetChip: 0, IsSafeLeave: false },
          { SeatIndex: 2, Status: 0, BetStatus: -1, Chip: 4800, BetChip: 0, IsSafeLeave: false },
        ],
        timestamp: 1005,
      },
    ]

    const dbMock = new PokerChaseDB(indexedDB, IDBKeyRange)
    const service = new PokerChaseService({ db: dbMock })

    const emittedHands: ApiEvent[][] = []
    service.handAggregateStream.on('data', (hand: ApiEvent[]) => emittedHands.push(hand))
    for (const event of events) service.handAggregateStream.write(event)
    await service.handAggregateStream.whenIdle()

    // テーブル移動を挟んだハンドが、DEALからHAND_RESULTSまで欠損なく1つ出力される
    expect(emittedHands.length).toBe(1)

    const hand = emittedHands[0]!
    expect(hand[0]?.ApiTypeId).toBe(ApiType.EVT_DEAL)
    expect(hand.at(-1)?.ApiTypeId).toBe(ApiType.EVT_HAND_RESULTS)
    expect((hand.at(-1) as { HandId: number }).HandId).toBe(555)
    // 移動前後すべてのEVT_ACTION（3件）がバッファに残っていること
    expect(hand.filter(e => e.ApiTypeId === ApiType.EVT_ACTION).length).toBe(3)
  })

  test('セッション境界を挟まない通常のハンドは従来通り出力される', async () => {
    const events: ApiEvent[] = [
      {
        ApiTypeId: ApiType.EVT_DEAL,
        SeatUserIds: [101, 102],
        Game: { CurrentBlindLv: 1, NextBlindUnixSeconds: 0, Ante: 0, SmallBlind: 100, BigBlind: 200, ButtonSeat: 0, SmallBlindSeat: 0, BigBlindSeat: 1 },
        Player: { SeatIndex: 0, BetStatus: 1, HoleCards: [0, 1], Chip: 5000, BetChip: 100 },
        OtherPlayers: [{ SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 200, IsSafeLeave: false }],
        Progress: { Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 400, Pot: 300, SidePot: [] },
        timestamp: 2000,
      },
      {
        ApiTypeId: ApiType.EVT_ACTION,
        SeatIndex: 0,
        ActionType: 0,
        Chip: 4900,
        BetChip: 200,
        Progress: { Phase: 3, NextActionSeat: -2, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 400, SidePot: [] },
        timestamp: 2001,
      },
      {
        ApiTypeId: ApiType.EVT_HAND_RESULTS,
        CommunityCards: [],
        Pot: 400,
        SidePot: [],
        ResultType: 0,
        DefeatStatus: 0,
        HandId: 777,
        HandLog: '',
        Results: [{ UserId: 102, HoleCards: [], RankType: 10, Hands: [], HandRanking: 1, Ranking: -2, RewardChip: 400 }],
        Player: { SeatIndex: 0, BetStatus: -1, Chip: 4900, BetChip: 0 },
        OtherPlayers: [{ SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 4900, BetChip: 0, IsSafeLeave: false }],
        timestamp: 2002,
      },
    ]

    const dbMock = new PokerChaseDB(indexedDB, IDBKeyRange)
    const service = new PokerChaseService({ db: dbMock })

    const emittedHands: ApiEvent[][] = []
    service.handAggregateStream.on('data', (hand: ApiEvent[]) => emittedHands.push(hand))
    for (const event of events) service.handAggregateStream.write(event)
    await service.handAggregateStream.whenIdle()

    expect(emittedHands.length).toBe(1)
    expect((emittedHands[0]!.at(-1) as { HandId: number }).HandId).toBe(777)
  })

  test('タイムアウト/切断でEVT_ACTIONが送信されないハンドも欠損なく出力される（NextActionSeat不一致で捨てない）', async () => {
    // docs/api-events.md「EVT_ACTION: 送信されないケース」記載の通り、タイムアウト/切断時は
    // 期待された次アクター（NextActionSeat）の明示的なFOLDが送信されず、次のEVT_ACTIONは
    // 別の席番号から届く。当該プレイヤーはEVT_HAND_RESULTS.Resultsにも現れない。
    // 実データでの検証（393,830イベント）ではセッション境界外の不一致80件中71件がこの
    // シグネチャに一致した。以前はこのNextActionSeat不一致だけでハンドバッファ全体を
    // クリアしていたため、このような正常系のハンドが丸ごと欠損していた。
    const events: ApiEvent[] = [
      {
        ApiTypeId: ApiType.EVT_DEAL,
        SeatUserIds: [101, 102, 103],
        Game: { CurrentBlindLv: 1, NextBlindUnixSeconds: 0, Ante: 0, SmallBlind: 100, BigBlind: 200, ButtonSeat: 0, SmallBlindSeat: 1, BigBlindSeat: 2 },
        Player: { SeatIndex: 0, BetStatus: 1, HoleCards: [0, 1], Chip: 5000, BetChip: 0 },
        OtherPlayers: [
          { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 100, IsSafeLeave: false },
          { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 200, IsSafeLeave: false },
        ],
        // NextActionSeat=1 (seat1/userId102がアクションする番)だが、実際にはこのプレイヤーの
        // FOLDは送信されない（タイムアウト/切断）。
        Progress: { Phase: 0, NextActionSeat: 1, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 400, Pot: 300, SidePot: [] },
        timestamp: 3000,
      },
      // seat1（userId102）のアクションはスキップされ、次に届くのはseat2（userId103）。
      // NextActionSeat(1) !== event.SeatIndex(2) の不一致が発生する。
      {
        ApiTypeId: ApiType.EVT_ACTION,
        SeatIndex: 2,
        ActionType: 3,
        Chip: 4800,
        BetChip: 200,
        Progress: { Phase: 3, NextActionSeat: -2, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 500, SidePot: [] },
        timestamp: 3001,
      },
      {
        ApiTypeId: ApiType.EVT_HAND_RESULTS,
        CommunityCards: [],
        Pot: 500,
        SidePot: [],
        ResultType: 0,
        DefeatStatus: 0,
        HandId: 888,
        HandLog: '',
        // userId102（タイムアウトしたプレイヤー）はResultsに現れない
        Results: [
          { UserId: 101, HoleCards: [], RankType: 10, Hands: [], HandRanking: 1, Ranking: -2, RewardChip: 500 },
          { UserId: 103, HoleCards: [], RankType: 11, Hands: [], HandRanking: -1, Ranking: -2, RewardChip: 0 },
        ],
        Player: { SeatIndex: 0, BetStatus: -1, Chip: 5300, BetChip: 0 },
        OtherPlayers: [
          { SeatIndex: 1, Status: 1, BetStatus: -1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
          { SeatIndex: 2, Status: 0, BetStatus: -1, Chip: 4800, BetChip: 0, IsSafeLeave: false },
        ],
        timestamp: 3002,
      },
    ]

    const dbMock = new PokerChaseDB(indexedDB, IDBKeyRange)
    const service = new PokerChaseService({ db: dbMock })

    const emittedHands: ApiEvent[][] = []
    service.handAggregateStream.on('data', (hand: ApiEvent[]) => emittedHands.push(hand))
    for (const event of events) service.handAggregateStream.write(event)
    await service.handAggregateStream.whenIdle()

    // NextActionSeat不一致（タイムアウト/切断の正常系）だけを理由にハンドが消えないこと
    expect(emittedHands.length).toBe(1)

    const hand = emittedHands[0]!
    expect(hand[0]?.ApiTypeId).toBe(ApiType.EVT_DEAL)
    expect(hand.at(-1)?.ApiTypeId).toBe(ApiType.EVT_HAND_RESULTS)
    expect((hand.at(-1) as { HandId: number }).HandId).toBe(888)
    expect(hand.filter(e => e.ApiTypeId === ApiType.EVT_ACTION).length).toBe(1)
  })
})
