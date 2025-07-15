/**
 * Pot Odds Calculation Tests
 */

import { RealTimeStatsStream } from '../streams/realtime-stats-stream'
import { ApiType, PhaseType } from '../types'
import type { ApiHandEvent } from '../types'
import { Readable } from 'stream'

describe('Pot Odds Calculation', () => {
  let stream: RealTimeStatsStream

  beforeEach(() => {
    stream = new RealTimeStatsStream()
  })

  afterEach(() => {
    stream.reset()
  })

  test('ヒーローがベットに直面した時にポットオッズを計算する', (done) => {
    /**
     * シナリオ: プリフロップでBBのヒーローがUTGのレイズに直面
     * 検証内容:
     * - UTGが600にレイズ（ポット: 900）
     * - BBのヒーローは400コール必要
     * - ポットオッズ: 900:400 = 2.25:1 (30.8%)
     */
    const events: ApiHandEvent[] = [
      {
        ApiTypeId: ApiType.EVT_DEAL,
        timestamp: 100,
        SeatUserIds: [101, 102, 103, 104, 105, 106],
        Player: {
          SeatIndex: 1,  // BB position
          BetStatus: 1,
          HoleCards: [48, 49], // A♠ A♥
          Chip: 9800,
          BetChip: 200  // BB already posted
        },
        OtherPlayers: [
          { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 9900, BetChip: 100 }, // SB
          { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 10000, BetChip: 0 },  // UTG
          { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 10000, BetChip: 0 },
          { SeatIndex: 4, Status: 0, BetStatus: 1, Chip: 10000, BetChip: 0 },
          { SeatIndex: 5, Status: 0, BetStatus: 1, Chip: 10000, BetChip: 0 }
        ],
        Game: {
          CurrentBlindLv: 1,
          NextBlindUnixSeconds: 0,
          Ante: 0,
          SmallBlind: 100,
          BigBlind: 200,
          ButtonSeat: 5,
          SmallBlindSeat: 0,
          BigBlindSeat: 1
        },
        Progress: {
          Phase: PhaseType.PREFLOP,
          NextActionSeat: 2,
          NextActionTypes: [2, 3, 4, 5],
          NextExtraLimitSeconds: 30,
          MinRaise: 400,
          Pot: 300,
          SidePot: []
        }
      },
      // UTG raises to 600
      {
        ApiTypeId: ApiType.EVT_ACTION,
        timestamp: 200,
        SeatIndex: 2,
        ActionType: 4, // RAISE
        Chip: 9400,
        BetChip: 600,
        Progress: {
          Phase: PhaseType.PREFLOP,
          NextActionSeat: 3,
          NextActionTypes: [2, 3, 4, 5],
          NextExtraLimitSeconds: 30,
          MinRaise: 1000,
          Pot: 900,  // SB 100 + BB 200 + UTG 600
          SidePot: []
        }
      },
      // Others fold
      {
        ApiTypeId: ApiType.EVT_ACTION,
        timestamp: 300,
        SeatIndex: 3,
        ActionType: 2, // FOLD
        Chip: 10000,
        BetChip: 0,
        Progress: {
          Phase: PhaseType.PREFLOP,
          NextActionSeat: 4,
          NextActionTypes: [2, 3, 4, 5],
          NextExtraLimitSeconds: 30,
          MinRaise: 1000,
          Pot: 900,
          SidePot: []
        }
      },
      {
        ApiTypeId: ApiType.EVT_ACTION,
        timestamp: 400,
        SeatIndex: 4,
        ActionType: 2, // FOLD
        Chip: 10000,
        BetChip: 0,
        Progress: {
          Phase: PhaseType.PREFLOP,
          NextActionSeat: 5,
          NextActionTypes: [2, 3, 4, 5],
          NextExtraLimitSeconds: 30,
          MinRaise: 1000,
          Pot: 900,
          SidePot: []
        }
      },
      {
        ApiTypeId: ApiType.EVT_ACTION,
        timestamp: 500,
        SeatIndex: 5,
        ActionType: 2, // FOLD
        Chip: 10000,
        BetChip: 0,
        Progress: {
          Phase: PhaseType.PREFLOP,
          NextActionSeat: 0,
          NextActionTypes: [2, 3, 4, 5],
          NextExtraLimitSeconds: 30,
          MinRaise: 1000,
          Pot: 900,
          SidePot: []
        }
      },
      {
        ApiTypeId: ApiType.EVT_ACTION,
        timestamp: 600,
        SeatIndex: 0,
        ActionType: 2, // FOLD
        Chip: 9900,
        BetChip: 100,
        Progress: {
          Phase: PhaseType.PREFLOP,
          NextActionSeat: 1,  // Hero's turn!
          NextActionTypes: [2, 3, 4, 5],  // Can fold, call, or raise
          NextExtraLimitSeconds: 30,
          MinRaise: 1000,
          Pot: 900,
          SidePot: []
        }
      }
    ]

    const results: any[] = []
    stream.on('data', (data) => {
      results.push(data)
    })

    stream.on('end', () => {
      // Find the last stats event
      const lastStats = results.filter(r => r.stats && r.stats.potOdds).pop()
      
      expect(lastStats).toBeDefined()
      expect(lastStats.stats.potOdds).toBeDefined()
      
      const potOddsValue = lastStats.stats.potOdds.value
      expect(potOddsValue).toHaveProperty('percentage')
      expect(potOddsValue).toHaveProperty('ratio')
      
      // Should be around 30.8% (400 / (900 + 400))
      expect(potOddsValue.percentage).toBeCloseTo(30.8, 0)
      expect(potOddsValue.ratio).toMatch(/^\d+:\d+$/)  // Format check
      expect(potOddsValue.pot).toBe(1300)  // 900 + 400 (playable pot)
      expect(potOddsValue.call).toBe(400)
      
      done()
    })

    const readable = Readable.from([events])
    readable.pipe(stream)
  })

  test('ヒーローのターンでない時もコール可能額を表示', (done) => {
    /**
     * シナリオ: 他のプレイヤーのアクション待ち
     * 検証内容:
     * - NextActionSeatがヒーローではない
     * - ポットサイズとコール額が表示される（色は控えめ）
     */
    const events: ApiHandEvent[] = [
      {
        ApiTypeId: ApiType.EVT_DEAL,
        timestamp: 100,
        SeatUserIds: [101, 102, 103, 104, 105, 106],
        Player: {
          SeatIndex: 0,
          BetStatus: 1,
          HoleCards: [48, 49],
          Chip: 10000,
          BetChip: 0
        },
        OtherPlayers: [
          { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 9800, BetChip: 200 },
          { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 10000, BetChip: 0 },
          { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 10000, BetChip: 0 },
          { SeatIndex: 4, Status: 0, BetStatus: 1, Chip: 10000, BetChip: 0 },
          { SeatIndex: 5, Status: 0, BetStatus: 1, Chip: 9900, BetChip: 100 }
        ],
        Game: {
          CurrentBlindLv: 1,
          NextBlindUnixSeconds: 0,
          Ante: 0,
          SmallBlind: 100,
          BigBlind: 200,
          ButtonSeat: 4,
          SmallBlindSeat: 5,
          BigBlindSeat: 0
        },
        Progress: {
          Phase: PhaseType.PREFLOP,
          NextActionSeat: 1,  // Not hero's turn
          NextActionTypes: [2, 3, 4, 5],
          NextExtraLimitSeconds: 30,
          MinRaise: 400,
          Pot: 300,
          SidePot: []
        }
      }
    ]

    const results: any[] = []
    stream.on('data', (data) => {
      results.push(data)
    })

    stream.on('end', () => {
      // Should have stats with pot odds showing pot size only
      const statsEvents = results.filter(r => r.stats)
      expect(statsEvents.length).toBeGreaterThan(0)
      
      // Pot odds should exist but with isHeroTurn = false
      const withPotOdds = statsEvents.filter(r => r.stats.potOdds)
      expect(withPotOdds.length).toBeGreaterThan(0)
      
      const potOddsData = withPotOdds[0].stats.potOdds.value
      expect(potOddsData.isHeroTurn).toBe(false)
      expect(potOddsData.pot).toBe(500)  // 300 + 200 (BB needs to call 200)
      expect(potOddsData.call).toBe(200) // BB needs to call 200 to match SB+BB
      
      done()
    })

    const readable = Readable.from([events])
    readable.pipe(stream)
  })

  test('サイドポットを含めた合計ポットで計算する', (done) => {
    /**
     * シナリオ: オールインがあり、サイドポットが発生
     * 検証内容:
     * - メインポット: 1500
     * - サイドポット: [600]
     * - 合計ポット: 2100
     * - ヒーローは400コール必要
     * - ポットオッズ: 2100:400 = 5.25:1 (16.0%)
     */
    const events: ApiHandEvent[] = [
      {
        ApiTypeId: ApiType.EVT_DEAL,
        timestamp: 100,
        SeatUserIds: [101, 102, 103, 104, 105, 106],
        Player: {
          SeatIndex: 0,  // Hero at position 0
          BetStatus: 1,
          HoleCards: [48, 49], // A♠ A♥
          Chip: 9800,
          BetChip: 200  // Hero already in for 200
        },
        OtherPlayers: [
          { SeatIndex: 1, Status: 0, BetStatus: 3, Chip: 0, BetChip: 500 },    // All-in
          { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 9400, BetChip: 600 }, // Big bet
          { SeatIndex: 3, Status: 0, BetStatus: 2, Chip: 10000, BetChip: 0 },  // Folded
          { SeatIndex: 4, Status: 0, BetStatus: 2, Chip: 10000, BetChip: 0 },  // Folded
          { SeatIndex: 5, Status: 0, BetStatus: 2, Chip: 10000, BetChip: 0 }   // Folded
        ],
        Game: {
          CurrentBlindLv: 1,
          NextBlindUnixSeconds: 0,
          Ante: 0,
          SmallBlind: 100,
          BigBlind: 200,
          ButtonSeat: 5,
          SmallBlindSeat: 0,
          BigBlindSeat: 1
        },
        Progress: {
          Phase: PhaseType.FLOP,
          NextActionSeat: 0,  // Hero's turn
          NextActionTypes: [2, 3, 4, 5],  // Can fold, call, or raise
          NextExtraLimitSeconds: 30,
          MinRaise: 1200,
          Pot: 1500,      // Main pot
          SidePot: [600]  // Side pot
        }
      }
    ]

    const results: any[] = []
    stream.on('data', (data) => {
      results.push(data)
    })

    stream.on('end', () => {
      // Find stats with pot odds
      const withPotOdds = results.filter(r => r.stats && r.stats.potOdds)
      expect(withPotOdds.length).toBeGreaterThan(0)
      
      const potOddsData = withPotOdds[0].stats.potOdds.value
      expect(potOddsData.pot).toBe(2500)  // 2100 + 400 (playable pot)
      expect(potOddsData.call).toBe(400)  // 600 - 200
      expect(potOddsData.percentage).toBeCloseTo(16.0, 0)  // 400 / (2100 + 400)
      
      done()
    })

    const readable = Readable.from([events])
    readable.pipe(stream)
  })

  test('SPR（Stack to Pot Ratio）を計算する', (done) => {
    /**
     * シナリオ: プリフロップでポットに対するスタックの比率を計算
     * 検証内容:
     * - ヒーローのスタック: 9800
     * - 現在のポット: 900
     * - SPR: 9800 / 900 = 10.9
     */
    const events: ApiHandEvent[] = [
      {
        ApiTypeId: ApiType.EVT_DEAL,
        timestamp: 100,
        SeatUserIds: [101, 102, 103, 104, 105, 106],
        Player: {
          SeatIndex: 1,  // BB position
          BetStatus: 1,
          HoleCards: [48, 49], // A♠ A♥
          Chip: 9800,
          BetChip: 200  // BB already posted
        },
        OtherPlayers: [
          { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 9900, BetChip: 100 }, // SB
          { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 10000, BetChip: 0 },  // UTG
          { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 10000, BetChip: 0 },
          { SeatIndex: 4, Status: 0, BetStatus: 1, Chip: 10000, BetChip: 0 },
          { SeatIndex: 5, Status: 0, BetStatus: 1, Chip: 10000, BetChip: 0 }
        ],
        Game: {
          CurrentBlindLv: 1,
          NextBlindUnixSeconds: 0,
          Ante: 0,
          SmallBlind: 100,
          BigBlind: 200,
          ButtonSeat: 5,
          SmallBlindSeat: 0,
          BigBlindSeat: 1
        },
        Progress: {
          Phase: PhaseType.PREFLOP,
          NextActionSeat: 2,
          NextActionTypes: [2, 3, 4, 5],
          NextExtraLimitSeconds: 30,
          MinRaise: 400,
          Pot: 300,
          SidePot: []
        }
      },
      // UTG raises to 600
      {
        ApiTypeId: ApiType.EVT_ACTION,
        timestamp: 200,
        SeatIndex: 2,
        ActionType: 4, // RAISE
        Chip: 9400,
        BetChip: 600,
        Progress: {
          Phase: PhaseType.PREFLOP,
          NextActionSeat: 3,
          NextActionTypes: [2, 3, 4, 5],
          NextExtraLimitSeconds: 30,
          MinRaise: 1000,
          Pot: 900,  // SB 100 + BB 200 + UTG 600
          SidePot: []
        }
      }
    ]

    const results: any[] = []
    stream.on('data', (data) => {
      results.push(data)
    })

    stream.on('end', () => {
      // Find the last stats event with pot odds
      const lastStats = results.filter(r => r.stats && r.stats.potOdds).pop()
      
      expect(lastStats).toBeDefined()
      expect(lastStats.stats.potOdds).toBeDefined()
      
      const potOddsValue = lastStats.stats.potOdds.value
      expect(potOddsValue).toHaveProperty('spr')
      
      // SPR should be 9800 / 900 = 10.9 (rounded to 1 decimal)
      expect(potOddsValue.spr).toBe(10.9)
      
      done()
    })

    const readable = Readable.from([events])
    readable.pipe(stream)
  })

  test('低SPR状況（コミットポット）を検出する', (done) => {
    /**
     * シナリオ: フロップで大きなポット、小さなスタック
     * 検証内容:
     * - ヒーローのスタック: 1200
     * - 現在のポット: 2400
     * - SPR: 1200 / 2400 = 0.5 (コミットポット)
     */
    const events: ApiHandEvent[] = [
      {
        ApiTypeId: ApiType.EVT_DEAL,
        timestamp: 100,
        SeatUserIds: [101, 102, 103, 104, 105, 106],
        Player: {
          SeatIndex: 0,
          BetStatus: 1,
          HoleCards: [48, 49],
          Chip: 1200,  // Small stack
          BetChip: 0
        },
        OtherPlayers: [
          { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 0 },
          { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 0 },
          { SeatIndex: 3, Status: 0, BetStatus: 2, Chip: 5000, BetChip: 0 },
          { SeatIndex: 4, Status: 0, BetStatus: 2, Chip: 5000, BetChip: 0 },
          { SeatIndex: 5, Status: 0, BetStatus: 2, Chip: 5000, BetChip: 0 }
        ],
        Game: {
          CurrentBlindLv: 1,
          NextBlindUnixSeconds: 0,
          Ante: 0,
          SmallBlind: 100,
          BigBlind: 200,
          ButtonSeat: 5,
          SmallBlindSeat: 0,
          BigBlindSeat: 1
        },
        Progress: {
          Phase: PhaseType.FLOP,
          NextActionSeat: 0,
          NextActionTypes: [0, 1, 5],
          NextExtraLimitSeconds: 30,
          MinRaise: 0,
          Pot: 2400,  // Large pot
          SidePot: []
        }
      }
    ]

    const results: any[] = []
    stream.on('data', (data) => {
      results.push(data)
    })

    stream.on('end', () => {
      const lastStats = results.filter(r => r.stats && r.stats.potOdds).pop()
      
      expect(lastStats).toBeDefined()
      const potOddsValue = lastStats.stats.potOdds.value
      
      // SPR should be 1200 / 2400 = 0.5
      expect(potOddsValue.spr).toBe(0.5)
      
      done()
    })

    const readable = Readable.from([events])
    readable.pipe(stream)
  })

  test('ポットが0の時はSPRを計算しない', (done) => {
    /**
     * シナリオ: ゲーム開始前でポットが0
     * 検証内容:
     * - SPRは undefined になるべき
     */
    const events: ApiHandEvent[] = [
      {
        ApiTypeId: ApiType.EVT_DEAL,
        timestamp: 100,
        SeatUserIds: [101, 102, 103, 104, 105, 106],
        Player: {
          SeatIndex: 0,
          BetStatus: 1,
          HoleCards: [48, 49],
          Chip: 10000,
          BetChip: 0
        },
        OtherPlayers: [
          { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 10000, BetChip: 0 },
          { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 10000, BetChip: 0 },
          { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 10000, BetChip: 0 },
          { SeatIndex: 4, Status: 0, BetStatus: 1, Chip: 10000, BetChip: 0 },
          { SeatIndex: 5, Status: 0, BetStatus: 1, Chip: 10000, BetChip: 0 }
        ],
        Game: {
          CurrentBlindLv: 1,
          NextBlindUnixSeconds: 0,
          Ante: 0,
          SmallBlind: 100,
          BigBlind: 200,
          ButtonSeat: 5,
          SmallBlindSeat: 0,
          BigBlindSeat: 1
        },
        Progress: {
          Phase: PhaseType.PREFLOP,
          NextActionSeat: 2,
          NextActionTypes: [2, 3, 4, 5],
          NextExtraLimitSeconds: 30,
          MinRaise: 400,
          Pot: 0,  // No pot yet
          SidePot: []
        }
      }
    ]

    const results: any[] = []
    stream.on('data', (data) => {
      results.push(data)
    })

    stream.on('end', () => {
      const withPotOdds = results.filter(r => r.stats && r.stats.potOdds)
      
      if (withPotOdds.length > 0) {
        const potOddsValue = withPotOdds[0].stats.potOdds.value
        expect(potOddsValue.spr).toBeUndefined()
      }
      
      done()
    })

    const readable = Readable.from([events])
    readable.pipe(stream)
  })
})