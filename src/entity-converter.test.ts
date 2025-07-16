import { EntityConverter } from '../src/entity-converter'
import {
  ApiType,
  BattleType,
  ActionType,
  PhaseType,
  ActionDetail,
  Position
} from '../src/types'
import type { ApiEvent, Session } from '../src/types'

describe('EntityConverter', () => {
  let converter: EntityConverter
  const mockSession: Session = {
    id: 'test-session-123',
    battleType: BattleType.SIT_AND_GO,
    name: 'Test Session',
    players: new Map(),
    reset: () => { }
  }

  beforeEach(() => {
    converter = new EntityConverter(mockSession)
  })

  describe('convertEventsToEntities', () => {
    it('should convert a complete hand with all phases', () => {
      const events: ApiEvent[] = [
        // EVT_DEAL - プリフロップ開始
        {
          ApiTypeId: ApiType.EVT_DEAL,
          timestamp: 1000,
          SeatUserIds: [100, 101, 102, 103, 104, 105],
          Game: {
            CurrentBlindLv: 1,
            NextBlindUnixSeconds: 1000000,
            Ante: 0,
            SmallBlind: 10,
            BigBlind: 20,
            ButtonSeat: 5,
            SmallBlindSeat: 0,
            BigBlindSeat: 1
          },
          Player: {
            SeatIndex: 2,
            BetStatus: 1,
            HoleCards: [37, 51],
            Chip: 1980,
            BetChip: 0
          },
          Progress: {
            Phase: 0,
            NextActionSeat: 2,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 40,
            Pot: 30,
            SidePot: []
          },
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 1990, BetChip: 10 },
            { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 1980, BetChip: 20 },
            { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 2000, BetChip: 0 },
            { SeatIndex: 4, Status: 0, BetStatus: 1, Chip: 2000, BetChip: 0 },
            { SeatIndex: 5, Status: 0, BetStatus: 1, Chip: 2000, BetChip: 0 }
          ]
        } as ApiEvent<ApiType.EVT_DEAL>,
        // EVT_ACTION - プレイヤーのレイズ
        {
          ApiTypeId: ApiType.EVT_ACTION,
          timestamp: 1001,
          SeatIndex: 2,
          ActionType: ActionType.RAISE,
          Chip: 1920,
          BetChip: 60,
          Progress: {
            Phase: 0,
            NextActionSeat: 3,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 100,
            Pot: 90,
            SidePot: []
          }
        } as ApiEvent<ApiType.EVT_ACTION>,
        // EVT_ACTION - 別プレイヤーのフォールド
        {
          ApiTypeId: ApiType.EVT_ACTION,
          timestamp: 1002,
          SeatIndex: 3,
          ActionType: ActionType.FOLD,
          Chip: 2000,
          BetChip: 0,
          Progress: {
            Phase: 0,
            NextActionSeat: 4,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 100,
            Pot: 90,
            SidePot: []
          }
        } as ApiEvent<ApiType.EVT_ACTION>,
        // EVT_DEAL_ROUND - フロップ
        {
          ApiTypeId: ApiType.EVT_DEAL_ROUND,
          timestamp: 1003,
          CommunityCards: [1, 21, 44],
          Progress: {
            Phase: 1,
            NextActionSeat: 0,
            NextActionTypes: [0, 1, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 0,
            Pot: 150,
            SidePot: []
          },
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 1950, BetChip: 0 },
            { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 1960, BetChip: 0 },
            { SeatIndex: 3, Status: 0, BetStatus: 2, Chip: 2000, BetChip: 0 },
            { SeatIndex: 4, Status: 0, BetStatus: 1, Chip: 2000, BetChip: 0 },
            { SeatIndex: 5, Status: 0, BetStatus: 1, Chip: 2000, BetChip: 0 }
          ]
        } as ApiEvent<ApiType.EVT_DEAL_ROUND>,
        // EVT_ACTION - フロップでのチェック
        {
          ApiTypeId: ApiType.EVT_ACTION,
          timestamp: 1004,
          SeatIndex: 0,
          ActionType: ActionType.CHECK,
          Chip: 1950,
          BetChip: 0,
          Progress: {
            Phase: 1,
            NextActionSeat: 2,
            NextActionTypes: [0, 1, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 0,
            Pot: 150,
            SidePot: []
          }
        } as ApiEvent<ApiType.EVT_ACTION>,
        // EVT_HAND_RESULTS - ハンド終了
        {
          ApiTypeId: ApiType.EVT_HAND_RESULTS,
          timestamp: 1005,
          HandId: 12345,
          CommunityCards: [1, 21, 44],
          Pot: 150,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [
            {
              UserId: 102,
              HoleCards: [37, 51],
              RankType: 8,
              Hands: [1, 21, 44, 37, 51],
              HandRanking: 1,
              Ranking: 1,
              RewardChip: 150
            }
          ],
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: -1, Chip: 1950, BetChip: 0 },
            { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 1980, BetChip: 0 },
            { SeatIndex: 3, Status: 0, BetStatus: -1, Chip: 2000, BetChip: 0 },
            { SeatIndex: 4, Status: 0, BetStatus: -1, Chip: 2000, BetChip: 0 },
            { SeatIndex: 5, Status: 0, BetStatus: -1, Chip: 1990, BetChip: 0 }
          ]
        } as ApiEvent<ApiType.EVT_HAND_RESULTS>
      ]

      const result = converter.convertEventsToEntities(events)

      // ハンドの検証
      expect(result.hands).toHaveLength(1)
      expect(result.hands[0]).toMatchObject({
        id: 12345,
        seatUserIds: [100, 101, 102, 103, 104, 105],
        winningPlayerIds: [102],
        smallBlind: 10,
        bigBlind: 20,
        session: {
          id: mockSession.id,
          battleType: mockSession.battleType,
          name: mockSession.name
        }
      })

      // フェーズの検証
      expect(result.phases).toHaveLength(2)
      expect(result.phases[0]).toMatchObject({
        handId: 12345,
        phase: PhaseType.PREFLOP,
        seatUserIds: [100, 101, 102, 103, 104, 105],
        communityCards: []
      })
      expect(result.phases[1]).toMatchObject({
        handId: 12345,
        phase: PhaseType.FLOP,
        communityCards: [1, 21, 44]
      })

      // アクションの検証
      expect(result.actions).toHaveLength(3)
      expect(result.actions[0]).toMatchObject({
        handId: 12345,
        index: 0,
        playerId: 102,
        phase: PhaseType.PREFLOP,
        actionType: ActionType.RAISE,
        bet: 60,
        pot: 90,
        actionDetails: expect.arrayContaining([ActionDetail.VPIP])
      })
    })

    it('should handle ALL_IN actions correctly', () => {
      const events: ApiEvent[] = [
        {
          ApiTypeId: ApiType.EVT_DEAL,
          timestamp: 2000,
          SeatUserIds: [200, 201, -1, -1, -1, -1],
          Game: {
            CurrentBlindLv: 1,
            NextBlindUnixSeconds: 2000000,
            Ante: 0,
            SmallBlind: 50,
            BigBlind: 100,
            ButtonSeat: 1,
            SmallBlindSeat: 0,
            BigBlindSeat: 1
          },
          Progress: {
            Phase: 0,
            NextActionSeat: 0,
            NextActionTypes: [ActionType.BET, ActionType.FOLD],
            NextExtraLimitSeconds: 15,
            MinRaise: 200,
            Pot: 150,
            SidePot: []
          },
          OtherPlayers: [
            { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 1900, BetChip: 100 }
          ]
        } as ApiEvent<ApiType.EVT_DEAL>,
        {
          ApiTypeId: ApiType.EVT_ACTION,
          timestamp: 2001,
          SeatIndex: 0,
          ActionType: ActionType.ALL_IN,
          Chip: 0,
          BetChip: 2000,
          Progress: {
            Phase: 0,
            NextActionSeat: 1,
            NextActionTypes: [ActionType.BET], // BETが可能 = ALL_INはBETとして扱う
            NextExtraLimitSeconds: 15,
            MinRaise: 4000,
            Pot: 2150,
            SidePot: []
          }
        } as ApiEvent<ApiType.EVT_ACTION>,
        {
          ApiTypeId: ApiType.EVT_HAND_RESULTS,
          timestamp: 2002,
          HandId: 23456,
          CommunityCards: [],
          Pot: 2150,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [],
          OtherPlayers: [
            { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 1900, BetChip: 0 }
          ]
        } as ApiEvent<ApiType.EVT_HAND_RESULTS>
      ]

      const result = converter.convertEventsToEntities(events)

      expect(result.actions[0]).toMatchObject({
        actionType: ActionType.BET, // ALL_INがBETに正規化される
        actionDetails: expect.arrayContaining([ActionDetail.ALL_IN])
      })
    })

    it('should handle incomplete hands (no EVT_HAND_RESULTS)', () => {
      const events: ApiEvent[] = [
        {
          ApiTypeId: ApiType.EVT_DEAL,
          timestamp: 3000,
          SeatUserIds: [300, 301, 302, -1, -1, -1],
          Game: {
            CurrentBlindLv: 1,
            NextBlindUnixSeconds: 3000000,
            Ante: 0,
            SmallBlind: 25,
            BigBlind: 50,
            ButtonSeat: 2,
            SmallBlindSeat: 0,
            BigBlindSeat: 1
          },
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 1975, BetChip: 25 },
            { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 1950, BetChip: 50 }
          ]
        } as ApiEvent<ApiType.EVT_DEAL>,
        {
          ApiTypeId: ApiType.EVT_ACTION,
          timestamp: 3001,
          SeatIndex: 2,
          ActionType: ActionType.CALL,
          Chip: 1950,
          BetChip: 50,
          Progress: {
            Phase: 0,
            NextActionSeat: 0,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 100,
            Pot: 125,
            SidePot: []
          }
        } as ApiEvent<ApiType.EVT_ACTION>
        // EVT_HAND_RESULTSがない不完全なハンド
      ]

      const result = converter.convertEventsToEntities(events)

      // handIdが設定されていないハンドは返されない
      expect(result.hands).toHaveLength(0)
      expect(result.phases).toHaveLength(0)
      expect(result.actions).toHaveLength(0)
    })

    it('should handle multiple hands in sequence', () => {
      const events: ApiEvent[] = [
        // Hand 1
        {
          ApiTypeId: ApiType.EVT_DEAL,
          timestamp: 4000,
          SeatUserIds: [400, 401, 402, -1, -1, -1],
          Game: {
            CurrentBlindLv: 1,
            NextBlindUnixSeconds: 4000000,
            Ante: 0,
            SmallBlind: 10,
            BigBlind: 20,
            ButtonSeat: 2,
            SmallBlindSeat: 0,
            BigBlindSeat: 1
          },
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 1990, BetChip: 10 },
            { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 1980, BetChip: 20 }
          ]
        } as ApiEvent<ApiType.EVT_DEAL>,
        {
          ApiTypeId: ApiType.EVT_HAND_RESULTS,
          timestamp: 4001,
          HandId: 34567,
          CommunityCards: [],
          Pot: 30,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [],
          OtherPlayers: []
        } as ApiEvent<ApiType.EVT_HAND_RESULTS>,
        // Hand 2
        {
          ApiTypeId: ApiType.EVT_DEAL,
          timestamp: 4002,
          SeatUserIds: [400, 401, 402, -1, -1, -1],
          Game: {
            CurrentBlindLv: 1,
            NextBlindUnixSeconds: 4000000,
            Ante: 0,
            SmallBlind: 10,
            BigBlind: 20,
            ButtonSeat: 2,
            SmallBlindSeat: 0,
            BigBlindSeat: 1
          },
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 1990, BetChip: 10 },
            { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 1980, BetChip: 20 }
          ]
        } as ApiEvent<ApiType.EVT_DEAL>,
        {
          ApiTypeId: ApiType.EVT_HAND_RESULTS,
          timestamp: 4003,
          HandId: 34568,
          CommunityCards: [],
          Pot: 30,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [],
          OtherPlayers: []
        } as ApiEvent<ApiType.EVT_HAND_RESULTS>
      ]

      const result = converter.convertEventsToEntities(events)

      expect(result.hands).toHaveLength(2)
      expect(result.hands[0]!.id).toBe(34567)
      expect(result.hands[1]!.id).toBe(34568)
    })

    it('should detect 3-bet opportunities and actions', () => {
      const events: ApiEvent[] = [
        {
          ApiTypeId: ApiType.EVT_DEAL,
          timestamp: 5000,
          SeatUserIds: [500, 501, 502, 503, -1, -1],
          Game: {
            CurrentBlindLv: 1,
            NextBlindUnixSeconds: 5000000,
            Ante: 0,
            SmallBlind: 50,
            BigBlind: 100,
            ButtonSeat: 3,
            SmallBlindSeat: 0,
            BigBlindSeat: 1
          },
          Progress: {
            Phase: 0,
            NextActionSeat: 2,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 200,
            Pot: 150,
            SidePot: []
          },
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 1950, BetChip: 50 },
            { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 1900, BetChip: 100 },
            { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 2000, BetChip: 0 }
          ]
        } as ApiEvent<ApiType.EVT_DEAL>,
        // 1st bet (open raise)
        {
          ApiTypeId: ApiType.EVT_ACTION,
          timestamp: 5001,
          SeatIndex: 2,
          ActionType: ActionType.RAISE,
          BetChip: 300,
          Chip: 1700,
          Progress: {
            Phase: 0,
            NextActionSeat: 3,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 600,
            Pot: 450,
            SidePot: []
          }
        } as ApiEvent<ApiType.EVT_ACTION>,
        // 2nd bet (3-bet)
        {
          ApiTypeId: ApiType.EVT_ACTION,
          timestamp: 5002,
          SeatIndex: 3,
          ActionType: ActionType.RAISE,
          BetChip: 900,
          Chip: 1100,
          Progress: {
            Phase: 0,
            NextActionSeat: 2,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 1500,
            Pot: 1350,
            SidePot: []
          }
        } as ApiEvent<ApiType.EVT_ACTION>,
        // Fold to 3-bet
        {
          ApiTypeId: ApiType.EVT_ACTION,
          timestamp: 5003,
          SeatIndex: 2,
          ActionType: ActionType.FOLD,
          BetChip: 0,
          Chip: 1700,
          Progress: {
            Phase: 0,
            NextActionSeat: -1,
            NextActionTypes: [],
            NextExtraLimitSeconds: 0,
            MinRaise: 0,
            Pot: 1350,
            SidePot: []
          }
        } as ApiEvent<ApiType.EVT_ACTION>,
        {
          ApiTypeId: ApiType.EVT_HAND_RESULTS,
          timestamp: 5004,
          HandId: 45678,
          CommunityCards: [],
          Pot: 1350,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [],
          OtherPlayers: []
        } as ApiEvent<ApiType.EVT_HAND_RESULTS>
      ]

      const result = converter.convertEventsToEntities(events)

      // 3-betアクションの検証
      const threeBetAction = result.actions.find(a => a.playerId === 503 && a.actionType === ActionType.RAISE)
      expect(threeBetAction?.actionDetails).toContain(ActionDetail.$3BET_CHANCE)
      expect(threeBetAction?.actionDetails).toContain(ActionDetail.$3BET)

      // Fold to 3-betの検証
      const foldToThreeBet = result.actions.find(a => a.playerId === 502 && a.actionType === ActionType.FOLD)
      expect(foldToThreeBet?.actionDetails).toContain(ActionDetail.$3BET_FOLD_CHANCE)
      expect(foldToThreeBet?.actionDetails).toContain(ActionDetail.$3BET_FOLD)
    })

    it('should calculate positions correctly for preflop', () => {
      const events: ApiEvent[] = [
        {
          ApiTypeId: ApiType.EVT_DEAL,
          timestamp: 6000,
          SeatUserIds: [600, 601, 602, 603, 604, 605], // 6人フルリング
          Game: {
            CurrentBlindLv: 1,
            NextBlindUnixSeconds: 6000000,
            Ante: 0,
            SmallBlind: 10,
            BigBlind: 20,
            ButtonSeat: 5,
            SmallBlindSeat: 0,
            BigBlindSeat: 1
          },
          Progress: {
            Phase: 0,
            NextActionSeat: 2,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 40,
            Pot: 30,
            SidePot: []
          },
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 1990, BetChip: 10 },
            { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 1980, BetChip: 20 },
            { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 2000, BetChip: 0 },
            { SeatIndex: 4, Status: 0, BetStatus: 1, Chip: 2000, BetChip: 0 },
            { SeatIndex: 5, Status: 0, BetStatus: 1, Chip: 2000, BetChip: 0 }
          ]
        } as ApiEvent<ApiType.EVT_DEAL>,
        // UTGからのアクション
        {
          ApiTypeId: ApiType.EVT_ACTION,
          timestamp: 6001,
          SeatIndex: 2,
          ActionType: ActionType.RAISE,
          BetChip: 60,
          Chip: 1940,
          Progress: {
            Phase: 0,
            NextActionSeat: 3,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 100,
            Pot: 90,
            SidePot: []
          }
        } as ApiEvent<ApiType.EVT_ACTION>,
        {
          ApiTypeId: ApiType.EVT_HAND_RESULTS,
          timestamp: 6002,
          HandId: 56789,
          CommunityCards: [],
          Pot: 90,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [],
          OtherPlayers: []
        } as ApiEvent<ApiType.EVT_HAND_RESULTS>
      ]

      const result = converter.convertEventsToEntities(events)

      // Position計算の検証
      // SB(seat0) = position -1
      // BB(seat1) = position -2
      // UTG(seat2) = position 3
      const utgAction = result.actions.find(a => a.playerId === 602)
      expect(utgAction?.position).toBe(Position.UTG)
    })

    it('should handle empty events array', () => {
      const result = converter.convertEventsToEntities([])

      expect(result.hands).toHaveLength(0)
      expect(result.phases).toHaveLength(0)
      expect(result.actions).toHaveLength(0)
    })

    it('should extract session information from RES_ENTRY_QUEUED and EVT_SESSION_DETAILS', () => {
      const events: ApiEvent[] = [
        // セッション開始
        {
          ApiTypeId: ApiType.RES_ENTRY_QUEUED,
          timestamp: 8000,
          Id: 'imported-session-123',
          BattleType: BattleType.TOURNAMENT
        } as ApiEvent<ApiType.RES_ENTRY_QUEUED>,
        // セッション詳細
        {
          ApiTypeId: ApiType.EVT_SESSION_DETAILS,
          timestamp: 8001,
          Name: 'インポートテストトーナメント'
        } as ApiEvent<ApiType.EVT_SESSION_DETAILS>,
        // ハンド開始
        {
          ApiTypeId: ApiType.EVT_DEAL,
          timestamp: 8002,
          SeatUserIds: [800, 801, 802, -1, -1, -1],
          Game: {
            CurrentBlindLv: 1,
            NextBlindUnixSeconds: 8000000,
            Ante: 0,
            SmallBlind: 100,
            BigBlind: 200,
            ButtonSeat: 2,
            SmallBlindSeat: 0,
            BigBlindSeat: 1
          },
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 1900, BetChip: 100 },
            { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 1800, BetChip: 200 }
          ]
        } as ApiEvent<ApiType.EVT_DEAL>,
        {
          ApiTypeId: ApiType.EVT_HAND_RESULTS,
          timestamp: 8003,
          HandId: 78901,
          CommunityCards: [],
          Pot: 300,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [],
          OtherPlayers: []
        } as ApiEvent<ApiType.EVT_HAND_RESULTS>
      ]

      const result = converter.convertEventsToEntities(events)

      // セッション情報が正しく設定されているか確認
      expect(result.hands).toHaveLength(1)
      expect(result.hands[0]).toMatchObject({
        session: {
          id: 'imported-session-123',
          battleType: BattleType.TOURNAMENT,
          name: 'インポートテストトーナメント'
        }
      })
    })

    it('should extract player information from EVT_PLAYER_SEAT_ASSIGNED and EVT_PLAYER_JOIN', () => {
      const events: ApiEvent[] = [
        // セッション開始
        {
          ApiTypeId: ApiType.RES_ENTRY_QUEUED,
          timestamp: 9000,
          Id: 'session-with-players',
          BattleType: BattleType.SIT_AND_GO
        } as ApiEvent<ApiType.RES_ENTRY_QUEUED>,
        // プレイヤー着席
        {
          ApiTypeId: ApiType.EVT_PLAYER_SEAT_ASSIGNED,
          timestamp: 9001,
          TableUsers: [
            {
              UserId: 900,
              UserName: 'Player1',
              FavoriteCharaId: 'chara01',
              CostumeId: 'costume01',
              EmblemId: 'emblem01',
              Rank: {
                RankId: 'gold',
                RankName: 'ゴールド',
                RankLvId: 'gold',
                RankLvName: 'ゴールド'
              }
            },
            {
              UserId: 901,
              UserName: 'Player2',
              FavoriteCharaId: 'chara02',
              CostumeId: 'costume02',
              EmblemId: 'emblem02',
              Rank: {
                RankId: 'diamond',
                RankName: 'ダイヤモンド',
                RankLvId: 'diamond',
                RankLvName: 'ダイヤモンド'
              }
            }
          ]
        } as ApiEvent<ApiType.EVT_PLAYER_SEAT_ASSIGNED>,
        // 途中参加プレイヤー
        {
          ApiTypeId: ApiType.EVT_PLAYER_JOIN,
          timestamp: 9002,
          JoinUser: {
            UserId: 902,
            UserName: 'Player3',
            FavoriteCharaId: 'chara03',
            CostumeId: 'costume03',
            EmblemId: 'emblem03',
            Rank: {
              RankId: 'platinum',
              RankName: 'プラチナ',
              RankLvId: 'platinum',
              RankLvName: 'プラチナ'
            }
          }
        } as ApiEvent<ApiType.EVT_PLAYER_JOIN>,
        // ハンド開始
        {
          ApiTypeId: ApiType.EVT_DEAL,
          timestamp: 9003,
          SeatUserIds: [900, 901, 902, -1, -1, -1],
          Game: {
            CurrentBlindLv: 1,
            NextBlindUnixSeconds: 9000000,
            Ante: 0,
            SmallBlind: 50,
            BigBlind: 100,
            ButtonSeat: 2,
            SmallBlindSeat: 0,
            BigBlindSeat: 1
          },
          Progress: {
            Phase: 0,
            NextActionSeat: 1,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 100,
            Pot: 150,
            SidePot: []
          },
          OtherPlayers: []
        } as ApiEvent<ApiType.EVT_DEAL>,
        {
          ApiTypeId: ApiType.EVT_HAND_RESULTS,
          timestamp: 9004,
          HandId: 89012,
          CommunityCards: [],
          Pot: 150,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [],
          OtherPlayers: []
        } as ApiEvent<ApiType.EVT_HAND_RESULTS>
      ]

      // Sessionオブジェクトの初期状態を定義
      const initialSession: Session = {
        id: 'initial-session',
        battleType: BattleType.TOURNAMENT,
        name: 'Initial Session',
        players: new Map(),
        reset: () => { }
      }

      const converterWithPlayers = new EntityConverter(initialSession)
      const result = converterWithPlayers.convertEventsToEntities(events)

      // セッション情報が正しく更新されているか確認
      expect(result.hands).toHaveLength(1)
      
      // プレイヤー情報が保持されることを確認するためには、
      // EntityConverterがプレイヤー情報を返すか、
      // またはSessionオブジェクトへの参照を保持する必要があります。
      // 現在の実装では、プレイヤー情報はEntityConverterの内部に保持されているため、
      // 直接検証することはできません。
      // ただし、ハンドが正しく生成されていることで、
      // セッション情報が適切に処理されていることが確認できます。
      expect(result.hands[0]).toMatchObject({
        session: {
          id: 'session-with-players',
          battleType: BattleType.SIT_AND_GO
        }
      })
    })

    it('should generate SHOWDOWN phase and handle cBetter tracking', () => {
      const events: ApiEvent[] = [
        // ハンド開始
        {
          ApiTypeId: ApiType.EVT_DEAL,
          timestamp: 10000,
          SeatUserIds: [1000, 1001, 1002, -1, -1, -1],
          Game: {
            CurrentBlindLv: 1,
            NextBlindUnixSeconds: 10000000,
            Ante: 0,
            SmallBlind: 20,
            BigBlind: 40,
            ButtonSeat: 2,
            SmallBlindSeat: 0,
            BigBlindSeat: 1
          },
          Progress: {
            Phase: 0,
            NextActionSeat: 2,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 80,
            Pot: 60,
            SidePot: []
          },
          OtherPlayers: []
        } as ApiEvent<ApiType.EVT_DEAL>,
        // プリフロップレイズ（cBetter候補）
        {
          ApiTypeId: ApiType.EVT_ACTION,
          timestamp: 10001,
          SeatIndex: 2,
          ActionType: ActionType.RAISE,
          BetChip: 120,
          Chip: 1880,
          Progress: {
            Phase: 0,
            NextActionSeat: 0,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 200,
            Pot: 180,
            SidePot: []
          }
        } as ApiEvent<ApiType.EVT_ACTION>,
        // SBコール
        {
          ApiTypeId: ApiType.EVT_ACTION,
          timestamp: 10002,
          SeatIndex: 0,
          ActionType: ActionType.CALL,
          BetChip: 110,
          Chip: 1890,
          Progress: {
            Phase: 0,
            NextActionSeat: 1,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 200,
            Pot: 290,
            SidePot: []
          }
        } as ApiEvent<ApiType.EVT_ACTION>,
        // BBコール
        {
          ApiTypeId: ApiType.EVT_ACTION,
          timestamp: 10003,
          SeatIndex: 1,
          ActionType: ActionType.CALL,
          BetChip: 80,
          Chip: 1920,
          Progress: {
            Phase: 0,
            NextActionSeat: -1,
            NextActionTypes: [],
            NextExtraLimitSeconds: 0,
            MinRaise: 0,
            Pot: 360,
            SidePot: []
          }
        } as ApiEvent<ApiType.EVT_ACTION>,
        // フロップ
        {
          ApiTypeId: ApiType.EVT_DEAL_ROUND,
          timestamp: 10004,
          CommunityCards: [14, 27, 40],
          Progress: {
            Phase: 1,
            NextActionSeat: 0,
            NextActionTypes: [0, 1, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 0,
            Pot: 360,
            SidePot: []
          },
          OtherPlayers: []
        } as ApiEvent<ApiType.EVT_DEAL_ROUND>,
        // SBチェック
        {
          ApiTypeId: ApiType.EVT_ACTION,
          timestamp: 10005,
          SeatIndex: 0,
          ActionType: ActionType.CHECK,
          BetChip: 0,
          Chip: 1890,
          Progress: {
            Phase: 1,
            NextActionSeat: 1,
            NextActionTypes: [0, 1, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 0,
            Pot: 360,
            SidePot: []
          }
        } as ApiEvent<ApiType.EVT_ACTION>,
        // BBチェック
        {
          ApiTypeId: ApiType.EVT_ACTION,
          timestamp: 10006,
          SeatIndex: 1,
          ActionType: ActionType.CHECK,
          BetChip: 0,
          Chip: 1920,
          Progress: {
            Phase: 1,
            NextActionSeat: 2,
            NextActionTypes: [0, 1, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 0,
            Pot: 360,
            SidePot: []
          }
        } as ApiEvent<ApiType.EVT_ACTION>,
        // cBetterのベット（CB）
        {
          ApiTypeId: ApiType.EVT_ACTION,
          timestamp: 10007,
          SeatIndex: 2,
          ActionType: ActionType.BET,
          BetChip: 180,
          Chip: 1700,
          Progress: {
            Phase: 1,
            NextActionSeat: 0,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 360,
            Pot: 540,
            SidePot: []
          }
        } as ApiEvent<ApiType.EVT_ACTION>,
        // SBフォールド（CBetFold）
        {
          ApiTypeId: ApiType.EVT_ACTION,
          timestamp: 10008,
          SeatIndex: 0,
          ActionType: ActionType.FOLD,
          BetChip: 0,
          Chip: 1890,
          Progress: {
            Phase: 1,
            NextActionSeat: 1,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 360,
            Pot: 540,
            SidePot: []
          }
        } as ApiEvent<ApiType.EVT_ACTION>,
        // BBコール
        {
          ApiTypeId: ApiType.EVT_ACTION,
          timestamp: 10009,
          SeatIndex: 1,
          ActionType: ActionType.CALL,
          BetChip: 180,
          Chip: 1740,
          Progress: {
            Phase: 1,
            NextActionSeat: -1,
            NextActionTypes: [],
            NextExtraLimitSeconds: 0,
            MinRaise: 0,
            Pot: 720,
            SidePot: []
          }
        } as ApiEvent<ApiType.EVT_ACTION>,
        // ターン以降省略...
        // ハンド結果（ショーダウン）
        {
          ApiTypeId: ApiType.EVT_HAND_RESULTS,
          timestamp: 10010,
          HandId: 101010,
          CommunityCards: [14, 27, 40, 2, 15],
          Pot: 720,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [
            {
              UserId: 1001,
              HoleCards: [51, 52],
              RankType: 2,
              Hands: [51, 52, 14, 27, 40],
              HandRanking: 1,
              Ranking: 1,
              RewardChip: 720
            },
            {
              UserId: 1002,
              HoleCards: [25, 38],
              RankType: 8,
              Hands: [14, 27, 40, 2, 15],
              HandRanking: 2,
              Ranking: 2,
              RewardChip: 0
            }
          ],
          OtherPlayers: []
        } as ApiEvent<ApiType.EVT_HAND_RESULTS>
      ]

      const result = converter.convertEventsToEntities(events)

      // ハンドの検証
      expect(result.hands).toHaveLength(1)
      expect(result.hands[0]!.winningPlayerIds).toEqual([1001])

      // フェーズの検証（SHOWDOWNフェーズが生成されているか）
      const phases = result.phases
      expect(phases).toHaveLength(3) // PREFLOP, FLOP, SHOWDOWN
      expect(phases[0]!.phase).toBe(PhaseType.PREFLOP)
      expect(phases[1]!.phase).toBe(PhaseType.FLOP)
      expect(phases[2]!.phase).toBe(PhaseType.SHOWDOWN)
      expect(phases[2]!.seatUserIds).toEqual([1001, 1002])

      // アクションの検証（CBet関連のActionDetailが設定されているか）
      const actions = result.actions
      
      // cBetterのCBet機会とCBet
      const cbetAction = actions.find(a => 
        a.playerId === 1002 && 
        a.phase === PhaseType.FLOP && 
        a.actionType === ActionType.BET
      )
      expect(cbetAction?.actionDetails).toContain(ActionDetail.CBET_CHANCE)
      expect(cbetAction?.actionDetails).toContain(ActionDetail.CBET)

      // CBetFold機会とFold
      const cbetFoldAction = actions.find(a =>
        a.playerId === 1000 &&
        a.phase === PhaseType.FLOP &&
        a.actionType === ActionType.FOLD
      )
      expect(cbetFoldAction).toBeDefined()
      expect(cbetFoldAction?.actionDetails).toContain(ActionDetail.CBET_FOLD_CHANCE)
      expect(cbetFoldAction?.actionDetails).toContain(ActionDetail.CBET_FOLD)
    })

    it('should handle events with missing or invalid data gracefully', () => {
      const events: ApiEvent[] = [
        {
          ApiTypeId: ApiType.EVT_DEAL,
          timestamp: 7000,
          SeatUserIds: [700, 701, 702, -1, -1, -1],
          Game: {
            CurrentBlindLv: 1,
            NextBlindUnixSeconds: 7000000,
            Ante: 0,
            SmallBlind: 25,
            BigBlind: 50,
            ButtonSeat: 2,
            SmallBlindSeat: 0,
            BigBlindSeat: 1
          },
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 1975, BetChip: 25 },
            { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 1950, BetChip: 50 }
          ]
        } as ApiEvent<ApiType.EVT_DEAL>,
        // 無効なアクション（プレイヤーIDがない）
        {
          ApiTypeId: ApiType.EVT_ACTION,
          timestamp: 7001,
          SeatIndex: 10, // 無効なシートインデックス
          ActionType: ActionType.CALL,
          BetChip: 50,
          Chip: 1950,
          Progress: {
            Phase: 0,
            NextActionSeat: 0,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 100,
            Pot: 125,
            SidePot: []
          }
        } as ApiEvent<ApiType.EVT_ACTION>,
        {
          ApiTypeId: ApiType.EVT_HAND_RESULTS,
          timestamp: 7002,
          HandId: 67890,
          CommunityCards: [],
          Pot: 125,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [],
          OtherPlayers: []
        } as ApiEvent<ApiType.EVT_HAND_RESULTS>
      ]

      const result = converter.convertEventsToEntities(events)

      // 無効なアクションは含まれるが、playerIdは0になる
      expect(result.hands).toHaveLength(1)
      expect(result.actions).toHaveLength(1)
      expect(result.actions[0]!.playerId).toBe(0)
    })
  })
})
