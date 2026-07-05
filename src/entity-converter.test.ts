import { EntityConverter } from '../src/entity-converter'
import {
  ApiType,
  BattleType,
  ActionType,
  PhaseType,
  ActionDetail,
  Position,
  BetStatusType,
  RankType,
  apiEventSchemas
} from '../src/types'
import type { ApiEvent, Session } from '../src/types'
import PokerChaseService, { PokerChaseDB } from '../src/app'
import { SessionState } from '../src/services/poker-chase-service'
import type { Action } from '../src/types'
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'

// ヘルパー関数：型安全にイベントを作成
function createEvent<T extends ApiType>(
  apiType: T,
  data: Omit<ApiEvent<T>, 'ApiTypeId'>,
  options?: { skipValidation?: boolean }
): ApiEvent<T> {
  const eventData = {
    ...data,
    ApiTypeId: apiType
  }
  
  // スキーマ検証をスキップする場合（無効なデータのテスト用）
  if (options?.skipValidation) {
    return eventData as ApiEvent<T>
  }
  
  // スキーマでパースして型安全にする
  const schema = apiEventSchemas[apiType]
  if (!schema) {
    throw new Error(`No schema found for ApiType: ${apiType}`)
  }
  
  const result = schema.parse(eventData)
  return result as ApiEvent<T>
}

/**
 * ライブ記録パイプライン（WriteEntityStream）と同一の書き込みを行い、
 * IndexedDBへの反映を待ってから読み取り結果を返すヘルパー。
 *
 * 背景（デフレーク）: 以前は`handAggregateStream`の'finish'イベント（Node Transform時代）
 * が上流Writableの完了のみを保証し、pipeで繋がった下流のWriteEntityStreamの非同期
 * transform内で行われる実際のDexie書き込みの完了は保証されなかった。そのため
 * 'finish'直後に`dbMock.<table>`を読むと書き込み未完了の状態を読んでしまう
 * レースコンディションがあった。
 *
 * 現在は`SimpleTransform.whenIdle()`がpipe()チェーンを下流まで連鎖的に辿って
 * 待つため、`service.handAggregateStream.whenIdle()`を待てば下流の書き込みも
 * 完了している。念のためのセーフティネットとして、`isReady`が真になるまでの
 * 短い間隔のポーリングは残す（タイムアウト時は分かりやすいエラーで失敗する）。
 */
async function pipeEventsAndWaitForReady<T>(
  service: PokerChaseService,
  read: () => Promise<T>,
  isReady: (result: T) => boolean,
  options: { timeoutMs?: number, intervalMs?: number, description?: string } = {}
): Promise<T> {
  const { timeoutMs = 5000, intervalMs = 50, description = 'expected rows' } = options

  await service.handAggregateStream.whenIdle()

  const startedAt = Date.now()
  let lastResult = await read()
  while (!isReady(lastResult)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `pipeEventsAndWaitForReady: timed out after ${timeoutMs}ms waiting for ${description}. ` +
        `Last observed result: ${JSON.stringify(lastResult)}`
      )
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
    lastResult = await read()
  }
  return lastResult
}

/**
 * `pipeEventsAndWaitForReady`の薄いラッパー。EC↔WESパリティテストで最も多く使われる
 * 「指定handIdのactions行がminCount件以上たまるまで待つ」パターンを簡潔に書ける。
 */
async function pipeEventsAndWaitForActions(
  service: PokerChaseService,
  dbMock: PokerChaseDB,
  events: ApiEvent[],
  { handId, minCount = 1 }: { handId: number, minCount?: number }
): Promise<Action[]> {
  for (const event of events) service.handAggregateStream.write(event)
  const actions = await pipeEventsAndWaitForReady(
    service,
    async () => {
      await dbMock.open()
      return (await dbMock.actions.where('handId').equals(handId).toArray())
        .sort((a, b) => a.index - b.index)
    },
    result => result.length >= minCount,
    { description: `dbMock.actions with handId=${handId} to have >= ${minCount} row(s)` }
  )
  return actions
}

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
        createEvent(ApiType.EVT_DEAL, {
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
        }),
        // EVT_ACTION - プレイヤーのレイズ
        createEvent(ApiType.EVT_ACTION, {
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
        }),
        // EVT_ACTION - 別プレイヤーのフォールド
        createEvent(ApiType.EVT_ACTION, {
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
        }),
        // EVT_DEAL_ROUND - フロップ
        createEvent(ApiType.EVT_DEAL_ROUND, {
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
        }),
        // EVT_ACTION - フロップでのチェック
        createEvent(ApiType.EVT_ACTION, {
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
        }),
        // EVT_HAND_RESULTS - ハンド終了
        createEvent(ApiType.EVT_HAND_RESULTS, {
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
        })
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
        createEvent(ApiType.EVT_DEAL, {
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
        }),
        createEvent(ApiType.EVT_ACTION, {
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
        }),
        createEvent(ApiType.EVT_HAND_RESULTS, {
          timestamp: 2002,
          HandId: 23456,
          CommunityCards: [],
          Pot: 2150,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [
            {
              UserId: 200,
              HoleCards: [],
              RankType: 10, // NO_CALL
              Hands: [],
              HandRanking: 1,
              Ranking: 1,
              RewardChip: 2150
            }
          ],
          OtherPlayers: [
            { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 1900, BetChip: 0 }
          ]
        })
      ]

      const result = converter.convertEventsToEntities(events)

      expect(result.actions[0]).toMatchObject({
        actionType: ActionType.BET, // ALL_INがBETに正規化される
        actionDetails: expect.arrayContaining([ActionDetail.ALL_IN])
      })
    })

    it('should handle incomplete hands (no EVT_HAND_RESULTS)', () => {
      const events: ApiEvent[] = [
        createEvent(ApiType.EVT_DEAL, {
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
          Progress: {
            Phase: 0,
            NextActionSeat: 2,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 50,
            Pot: 75,
            SidePot: []
          },
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 1975, BetChip: 25 },
            { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 1950, BetChip: 50 }
          ]
        }),
        createEvent(ApiType.EVT_ACTION, {
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
        })
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
        createEvent(ApiType.EVT_DEAL, {
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
            { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 1980, BetChip: 20 }
          ]
        }),
        createEvent(ApiType.EVT_HAND_RESULTS, {
          timestamp: 4001,
          HandId: 34567,
          CommunityCards: [],
          Pot: 30,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [
            {
              UserId: 400,
              HoleCards: [],
              RankType: 10, // NO_CALL
              Hands: [],
              HandRanking: 1,
              Ranking: 1,
              RewardChip: 30
            }
          ],
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: -1, Chip: 1990, BetChip: 0 },
            { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 1980, BetChip: 0 }
          ]
        }, { skipValidation: true }),
        // Hand 2
        createEvent(ApiType.EVT_DEAL, {
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
            { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 1980, BetChip: 20 }
          ]
        }),
        createEvent(ApiType.EVT_HAND_RESULTS, {
          timestamp: 4003,
          HandId: 34568,
          CommunityCards: [],
          Pot: 30,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [
            {
              UserId: 402,
              HoleCards: [],
              RankType: 10, // NO_CALL
              Hands: [],
              HandRanking: 1,
              Ranking: 1,
              RewardChip: 30
            }
          ],
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: -1, Chip: 1990, BetChip: 0 },
            { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 1980, BetChip: 0 }
          ]
        }, { skipValidation: true })
      ]

      const result = converter.convertEventsToEntities(events)

      expect(result.hands).toHaveLength(2)
      expect(result.hands[0]!.id).toBe(34567)
      expect(result.hands[1]!.id).toBe(34568)
    })

    it('should detect 3-bet opportunities and actions', () => {
      const events: ApiEvent[] = [
        createEvent(ApiType.EVT_DEAL, {
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
        }),
        // 1st bet (open raise)
        createEvent(ApiType.EVT_ACTION, {
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
        }),
        // 2nd bet (3-bet)
        createEvent(ApiType.EVT_ACTION, {
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
        }),
        // Fold to 3-bet
        createEvent(ApiType.EVT_ACTION, {
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
        }),
        createEvent(ApiType.EVT_HAND_RESULTS, {
          timestamp: 5004,
          HandId: 45678,
          CommunityCards: [],
          Pot: 1350,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [
            {
              UserId: 503,
              HoleCards: [],
              RankType: 10, // NO_CALL
              Hands: [],
              HandRanking: 1,
              Ranking: 1,
              RewardChip: 1350
            }
          ],
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: -1, Chip: 1950, BetChip: 0 },
            { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 1900, BetChip: 0 },
            { SeatIndex: 2, Status: 0, BetStatus: -1, Chip: 1700, BetChip: 0 }
          ]
        }, { skipValidation: true })
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
        createEvent(ApiType.EVT_DEAL, {
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
        }),
        // UTGからのアクション
        createEvent(ApiType.EVT_ACTION, {
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
        }),
        createEvent(ApiType.EVT_HAND_RESULTS, {
          timestamp: 6002,
          HandId: 56789,
          CommunityCards: [],
          Pot: 90,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [
            {
              UserId: 602,
              HoleCards: [],
              RankType: 10, // NO_CALL
              Hands: [],
              HandRanking: 1,
              Ranking: 1,
              RewardChip: 90
            }
          ],
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: -1, Chip: 1990, BetChip: 0 },
            { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 1980, BetChip: 0 },
            { SeatIndex: 3, Status: 0, BetStatus: -1, Chip: 2000, BetChip: 0 },
            { SeatIndex: 4, Status: 0, BetStatus: -1, Chip: 2000, BetChip: 0 },
            { SeatIndex: 5, Status: 0, BetStatus: -1, Chip: 2000, BetChip: 0 }
          ]
        }, { skipValidation: true })
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

    it('should extract session information from EVT_ENTRY_QUEUED and EVT_SESSION_DETAILS', () => {
      const events: ApiEvent[] = [
        // セッション開始
        createEvent(ApiType.EVT_ENTRY_QUEUED, {
          timestamp: 8000,
          Id: 'imported-session-123',
          BattleType: BattleType.TOURNAMENT,
          Code: 0,
          IsRetire: false
        }),
        // セッション詳細
        createEvent(ApiType.EVT_SESSION_DETAILS, {
          timestamp: 8001,
          Name: 'インポートテストトーナメント',
          BlindStructures: [{ Lv: 1, Ante: 0, BigBlind: 200, ActiveMinutes: 5 }],
          CoinNum: 0,
          DefaultChip: 2000,
          IsReplay: false,
          Items: [],
          LimitSeconds: 30,
          MoneyList: [],
          Name2: ''
        }),
        // ハンド開始
        createEvent(ApiType.EVT_DEAL, {
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
          Progress: {
            Phase: 0,
            NextActionSeat: 2,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 400,
            Pot: 300,
            SidePot: []
          },
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 1900, BetChip: 100 },
            { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 1800, BetChip: 200 }
          ]
        }),
        createEvent(ApiType.EVT_HAND_RESULTS, {
          timestamp: 8003,
          HandId: 78901,
          CommunityCards: [],
          Pot: 300,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [
            {
              UserId: 802,
              HoleCards: [],
              RankType: 10, // NO_CALL
              Hands: [],
              HandRanking: 1,
              Ranking: 1,
              RewardChip: 300
            }
          ],
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: -1, Chip: 1900, BetChip: 0 },
            { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 1800, BetChip: 0 }
          ]
        }, { skipValidation: true })
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
        createEvent(ApiType.EVT_ENTRY_QUEUED, {
          timestamp: 9000,
          Id: 'session-with-players',
          BattleType: BattleType.SIT_AND_GO,
          Code: 0,
          IsRetire: false
        }),
        // プレイヤー着席
        createEvent(ApiType.EVT_PLAYER_SEAT_ASSIGNED, {
          timestamp: 9001,
          IsLeave: false,
          IsRetire: false,
          ProcessType: 0,
          SeatUserIds: [900, 901, -1, -1, -1, -1],
          TableUsers: [
            {
              UserId: 900,
              UserName: 'Player1',
              FavoriteCharaId: 'chara01',
              CostumeId: 'costume01',
              EmblemId: 'emblem01',
              IsCpu: false,
              IsOfficial: false,
              SettingDecoIds: ['', '', '', '', '', '', ''],
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
              IsCpu: false,
              IsOfficial: false,
              SettingDecoIds: ['', '', '', '', '', '', ''],
              Rank: {
                RankId: 'diamond',
                RankName: 'ダイヤモンド',
                RankLvId: 'diamond',
                RankLvName: 'ダイヤモンド'
              }
            }
          ]
        }),
        // 途中参加プレイヤー
        createEvent(ApiType.EVT_PLAYER_JOIN, {
          timestamp: 9002,
          JoinPlayer: {
            BetChip: 0,
            BetStatus: BetStatusType.NOT_IN_PLAY,
            Chip: 2000,
            SeatIndex: 2,
            Status: 0
          },
          JoinUser: {
            UserId: 902,
            UserName: 'Player3',
            FavoriteCharaId: 'chara03',
            CostumeId: 'costume03',
            EmblemId: 'emblem03',
            IsCpu: false,
            IsOfficial: false,
            SettingDecoIds: ['', '', '', '', '', '', ''],
            Rank: {
              RankId: 'platinum',
              RankName: 'プラチナ',
              RankLvId: 'platinum',
              RankLvName: 'プラチナ'
            }
          }
        }),
        // ハンド開始
        createEvent(ApiType.EVT_DEAL, {
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
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 1950, BetChip: 50 },
            { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 1900, BetChip: 100 },
            { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 2000, BetChip: 0 }
          ]
        }),
        createEvent(ApiType.EVT_HAND_RESULTS, {
          timestamp: 9004,
          HandId: 89012,
          CommunityCards: [],
          Pot: 150,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [
            {
              UserId: 900,
              HoleCards: [],
              RankType: 10, // NO_CALL
              Hands: [],
              HandRanking: 1,
              Ranking: 1,
              RewardChip: 150
            }
          ],
          OtherPlayers: [
            { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 1900, BetChip: 0 },
            { SeatIndex: 2, Status: 0, BetStatus: -1, Chip: 2000, BetChip: 0 }
          ]
        }, { skipValidation: true })
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
        createEvent(ApiType.EVT_DEAL, {
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
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 1980, BetChip: 20 },
            { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 1960, BetChip: 40 }
          ]
        }),
        // プリフロップレイズ（cBetter候補）
        createEvent(ApiType.EVT_ACTION, {
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
        }),
        // SBコール
        createEvent(ApiType.EVT_ACTION, {
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
        }),
        // BBコール
        createEvent(ApiType.EVT_ACTION, {
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
        }),
        // フロップ
        createEvent(ApiType.EVT_DEAL_ROUND, {
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
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 1890, BetChip: 0 },
            { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 1920, BetChip: 0 }
          ]
        }),
        // SBチェック
        createEvent(ApiType.EVT_ACTION, {
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
        }),
        // BBチェック
        createEvent(ApiType.EVT_ACTION, {
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
        }),
        // cBetterのベット（CB）
        createEvent(ApiType.EVT_ACTION, {
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
        }),
        // SBフォールド（CBetFold）
        createEvent(ApiType.EVT_ACTION, {
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
        }),
        // BBコール
        createEvent(ApiType.EVT_ACTION, {
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
        }),
        // ターン以降省略...
        // ハンド結果（ショーダウン）
        createEvent(ApiType.EVT_HAND_RESULTS, {
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
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: -1, Chip: 1890, BetChip: 0 }
          ]
        }, { skipValidation: true })
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
        createEvent(ApiType.EVT_DEAL, {
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
          Progress: {
            Phase: 0,
            NextActionSeat: 2,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 100,
            Pot: 75,
            SidePot: []
          },
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 1975, BetChip: 25 },
            { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 1950, BetChip: 50 }
          ]
        }),
        // 無効なアクション（プレイヤーIDがない）
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 7001,
          SeatIndex: 10 as any, // 無効なシートインデックス
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
        }, { skipValidation: true }),
        createEvent(ApiType.EVT_HAND_RESULTS, {
          timestamp: 7002,
          HandId: 67890,
          CommunityCards: [],
          Pot: 125,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [
            {
              UserId: 700,
              HoleCards: [],
              RankType: 10, // NO_CALL
              Hands: [],
              HandRanking: 1,
              Ranking: 1,
              RewardChip: 125
            }
          ],
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: -1, Chip: 1975, BetChip: 0 },
            { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 1950, BetChip: 0 }
          ]
        }, { skipValidation: true })
      ]

      const result = converter.convertEventsToEntities(events)

      // 座席解決不能（範囲外のSeatIndex）なアクションはスキップされる。
      // ハンド自体は他の情報から正常に変換される（テーブル移動後の
      // 座席未解決アクションと同じ扱い。実データでは0.09%のハンドで発生）。
      expect(result.hands).toHaveLength(1)
      expect(result.actions).toHaveLength(0)
    })
  })

  /**
   * 回帰テスト（#104由来のリグレッション）
   *
   * 背景: `service.session`は#104以降、`id`/`battleType`/`name`がprototype上の
   * getterであるSessionStateクラスのインスタンス。EntityConverter内部で
   * `{ ...this.session, players: new Map(...) }`のようにオブジェクトスプレッドで
   * コピーすると、getterはコピーされず（privateな`_id`/`_battleType`/`_name`の方が
   * コピーされてしまい、それらは`Session`インターフェース上には存在しないため）、
   * `currentSession.id`等が`undefined`になってしまう。
   *
   * インポート系のパイプライン（インクリメンタルインポート等）はイベントウィンドウの
   * 先頭にEVT_ENTRY_QUEUEDが含まれない場合があり、その場合はEntityConverter内で
   * セッションIDが復元されないため、上記のスプレッドのバグがそのまま
   * `hand.session.id`/`battleType`の欠落として表面化する。
   */
  describe('SessionState seeding (regression, #104)', () => {
    it('carries over session id/battleType/name from a real SessionState instance even without a leading EVT_ENTRY_QUEUED', () => {
      // 実際のSessionStateインスタンスを構築し、setter経由でフィールドを設定する
      // （#104で導入されたクラス。id/battleType/nameはprototypeのgetterで公開される）
      const realSession = new SessionState(() => { })
      realSession.setId('real-session-456')
      realSession.setBattleType(BattleType.SIT_AND_GO)
      realSession.setName('Real Session')

      // EVT_ENTRY_QUEUEDを含まないイベントウィンドウ（インクリメンタルインポートを模した状況）
      const events: ApiEvent[] = [
        createEvent(ApiType.EVT_DEAL, {
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
        }),
        createEvent(ApiType.EVT_HAND_RESULTS, {
          timestamp: 1005,
          HandId: 22345,
          CommunityCards: [],
          Pot: 30,
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
              RewardChip: 30
            }
          ],
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: -1, Chip: 1990, BetChip: 0 },
            { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 1980, BetChip: 0 },
            { SeatIndex: 3, Status: 0, BetStatus: -1, Chip: 2000, BetChip: 0 },
            { SeatIndex: 4, Status: 0, BetStatus: -1, Chip: 2000, BetChip: 0 },
            { SeatIndex: 5, Status: 0, BetStatus: -1, Chip: 2000, BetChip: 0 }
          ]
        }, { skipValidation: true })
      ]

      // 事前条件: `Session`インターフェースに対するオブジェクトスプレッドではgetterが
      // 引き継がれないことを確認する（このバグの直接的な実証）
      const naiveSpread = { ...(realSession as unknown as Record<string, unknown>) }
      expect(naiveSpread.id).toBeUndefined()
      expect(naiveSpread.battleType).toBeUndefined()
      expect(naiveSpread.name).toBeUndefined()
      // 一方、getter経由では正しい値が読める
      expect(realSession.id).toBe('real-session-456')

      const converterWithRealSession = new EntityConverter(realSession)
      const result = converterWithRealSession.convertEventsToEntities(events)

      expect(result.hands).toHaveLength(1)
      expect(result.hands[0]).toMatchObject({
        session: {
          id: 'real-session-456',
          battleType: BattleType.SIT_AND_GO,
          name: 'Real Session'
        }
      })
    })
  })

  /**
   * ライブ記録パイプライン（WriteEntityStream）とインポート/リビルドパイプライン
   * （EntityConverter）のポジション整合性テスト
   *
   * 背景: WriteEntityStreamはEVT_DEAL.Game.BigBlindSeatを基準にポジションを算出するが、
   * 旧EntityConverter（getPositionUserIds）はBigBlindSeatを無視し、フルテーブルでは
   * 常にseat0をSBとみなすヒューリスティックだった。既存フィクスチャは全てBigBlindSeat: 1
   * （SBがseat0）だったため、このズレが表面化していなかった。
   * BigBlindSeatが1以外（=SBがseat0以外）の同一イベント列を両パイプラインに通し、
   * 生成されるActionが完全に一致することを確認する。
   */
  describe('position parity with WriteEntityStream', () => {
    it('produces identical action positions to the live recording pipeline when BigBlindSeat !== 1', async () => {
      // 4人テーブル。ButtonSeat=1, SmallBlindSeat=2, BigBlindSeat=3
      // （SBがseat0ではないケース。ここが壊れていたヒューリスティックを踏み抜く）
      const events: ApiEvent[] = [
        createEvent(ApiType.EVT_DEAL, {
          timestamp: 20000,
          SeatUserIds: [10, 20, 30, 40],
          Game: {
            CurrentBlindLv: 1,
            NextBlindUnixSeconds: 20000000,
            Ante: 0,
            SmallBlind: 10,
            BigBlind: 20,
            ButtonSeat: 1,
            SmallBlindSeat: 2,
            BigBlindSeat: 3
          },
          Player: {
            SeatIndex: 0,
            BetStatus: 1,
            HoleCards: [37, 51],
            Chip: 1980,
            BetChip: 0
          },
          Progress: {
            Phase: 0,
            NextActionSeat: 0,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 40,
            Pot: 30,
            SidePot: []
          },
          OtherPlayers: [
            { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 2000, BetChip: 0 },
            { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 1990, BetChip: 10 },
            { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 1980, BetChip: 20 }
          ]
        }),
        // UTG(seat0, player10)がレイズ
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 20001,
          SeatIndex: 0,
          ActionType: ActionType.RAISE,
          Chip: 1920,
          BetChip: 60,
          Progress: {
            Phase: 0,
            NextActionSeat: 1,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 100,
            Pot: 90,
            SidePot: []
          }
        }),
        // BTN(seat1, player20)がフォールド
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 20002,
          SeatIndex: 1,
          ActionType: ActionType.FOLD,
          Chip: 2000,
          BetChip: 0,
          Progress: {
            Phase: 0,
            NextActionSeat: 2,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 100,
            Pot: 90,
            SidePot: []
          }
        }),
        // SB(seat2, player30)がコール
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 20003,
          SeatIndex: 2,
          ActionType: ActionType.CALL,
          Chip: 1940,
          BetChip: 60,
          Progress: {
            Phase: 0,
            NextActionSeat: 3,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 100,
            Pot: 150,
            SidePot: []
          }
        }),
        // BB(seat3, player40)がフォールド
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 20004,
          SeatIndex: 3,
          ActionType: ActionType.FOLD,
          Chip: 1980,
          BetChip: 0,
          Progress: {
            Phase: 0,
            NextActionSeat: -1,
            NextActionTypes: [],
            NextExtraLimitSeconds: 0,
            MinRaise: 0,
            Pot: 150,
            SidePot: []
          }
        }),
        // フロップ
        createEvent(ApiType.EVT_DEAL_ROUND, {
          timestamp: 20005,
          CommunityCards: [1, 21, 44],
          Progress: {
            Phase: 1,
            NextActionSeat: 2,
            NextActionTypes: [0, 1, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 0,
            Pot: 150,
            SidePot: []
          },
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 1920, BetChip: 0 },
            { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 1940, BetChip: 0 }
          ]
        }),
        // SB(seat2, player30)がチェック
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 20006,
          SeatIndex: 2,
          ActionType: ActionType.CHECK,
          Chip: 1940,
          BetChip: 0,
          Progress: {
            Phase: 1,
            NextActionSeat: 0,
            NextActionTypes: [0, 1, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 0,
            Pot: 150,
            SidePot: []
          }
        }),
        // UTG(seat0, player10)がベット
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 20007,
          SeatIndex: 0,
          ActionType: ActionType.BET,
          Chip: 1820,
          BetChip: 100,
          Progress: {
            Phase: 1,
            NextActionSeat: 2,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 200,
            Pot: 250,
            SidePot: []
          }
        }),
        // SB(seat2, player30)がフォールド
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 20008,
          SeatIndex: 2,
          ActionType: ActionType.FOLD,
          Chip: 1940,
          BetChip: 0,
          Progress: {
            Phase: 1,
            NextActionSeat: -2,
            NextActionTypes: [],
            NextExtraLimitSeconds: 0,
            MinRaise: 0,
            Pot: 250,
            SidePot: []
          }
        }),
        createEvent(ApiType.EVT_HAND_RESULTS, {
          timestamp: 20009,
          HandId: 999001,
          CommunityCards: [1, 21, 44],
          Pot: 250,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [
            {
              UserId: 10,
              HoleCards: [37, 51],
              RankType: 10,
              Hands: [],
              HandRanking: 1,
              Ranking: 1,
              RewardChip: 250
            }
          ],
          OtherPlayers: [
            { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 2000, BetChip: 0 },
            { SeatIndex: 2, Status: 0, BetStatus: -1, Chip: 1940, BetChip: 0 },
            { SeatIndex: 3, Status: 0, BetStatus: -1, Chip: 1980, BetChip: 0 }
          ]
        })
      ]

      // --- ライブ記録パイプライン: WriteEntityStream経由 ---
      const dbMock = new PokerChaseDB(indexedDB, IDBKeyRange)
      const service = new PokerChaseService({ db: dbMock })
      // restoreState()（コンストラクタ内でトリガーされる非同期処理）の完了を待たないと、
      // handAggregateStreamへの書き込みとレースしてIndexedDBの読み取りが空になることがある
      await service.ready

      // --- インポート/リビルドパイプライン: EntityConverter経由 ---
      const importResult = converter.convertEventsToEntities(events)
      const importActions = importResult.actions.slice().sort((a, b) => a.index - b.index)

      const liveActions = (await pipeEventsAndWaitForActions(service, dbMock, events, {
        handId: 999001,
        minCount: importActions.length
      })).slice().sort((a, b) => a.index - b.index)

      expect(liveActions.length).toBeGreaterThan(0)
      expect(importActions.length).toBe(liveActions.length)

      const pickComparable = (action: Action) => ({
        playerId: action.playerId,
        phase: action.phase,
        actionType: action.actionType,
        position: action.position,
        actionDetails: action.actionDetails
      })

      expect(importActions.map(pickComparable)).toEqual(liveActions.map(pickComparable))

      // 具体的な期待値も明示しておく（BigBlindSeat=3 → SBはseat2=player30、BBはseat3=player40）
      const positionsByPlayer = new Map(liveActions.map(a => [a.playerId, a.position]))
      expect(positionsByPlayer.get(30)).toBe(Position.SB)
      expect(positionsByPlayer.get(40)).toBe(Position.BB)
      expect(positionsByPlayer.get(20)).toBe(Position.BTN)
      expect(positionsByPlayer.get(10)).toBe(Position.CO) // 4人卓: BTNの次はCO

      const importPositionsByPlayer = new Map(importActions.map(a => [a.playerId, a.position]))
      expect(importPositionsByPlayer).toEqual(positionsByPlayer)
    })

    /**
     * 空席（SeatUserIds内の-1）を含むケースの整合性テスト。
     *
     * 背景: `rotateArrayFromIndex(seatUserIds, BigBlindSeat + 1).reverse()`で座席配列を
     * 回転させ、その配列上のインデックスからポジションを逆算する方式（修正前の実装）は、
     * 「全座席が連続して埋まっている」ことを暗黙に仮定していた。トーナメントのバスト等で
     * 空席（-1）が生じると、その-1が回転後の配列内でスロットを占有し続けるため、実プレイヤーの
     * インデックスがズレてポジションが誤って算出される。
     *
     * 具体例: SeatUserIds=[-1,-1,A,B,-1,C], Game={ButtonSeat:2, SmallBlindSeat:3, BigBlindSeat:5}
     * では、A(seat2)が実際のBTN、B(seat3)が実際のSBだが、修正前の方式では
     * Bをrotate後配列のインデックス2（=BTN）、Aをインデックス3（=CO）と誤ってラベル付けする。
     * 修正後はGame.ButtonSeat/SmallBlindSeat/BigBlindSeatから直接算出するため、
     * 空席の有無に関わらずA=BTN、B=SB、C=BBと正しく判定される。
     *
     * このテストは修正前のロジックに戻すと失敗する（`git stash`で確認済み）。
     */
    it('produces identical and correct action positions when SeatUserIds contains empty seats (-1)', async () => {
      const A = 100, B = 200, C = 300
      const events: ApiEvent[] = [
        createEvent(ApiType.EVT_DEAL, {
          timestamp: 30000,
          SeatUserIds: [-1, -1, A, B, -1, C],
          Game: {
            CurrentBlindLv: 1,
            NextBlindUnixSeconds: 30000000,
            Ante: 0,
            SmallBlind: 10,
            BigBlind: 20,
            ButtonSeat: 2,
            SmallBlindSeat: 3,
            BigBlindSeat: 5
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
            { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 1990, BetChip: 10 },
            { SeatIndex: 5, Status: 0, BetStatus: 1, Chip: 1980, BetChip: 20 }
          ]
        }),
        // BTN(seat2, playerA)がレイズ
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 30001,
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
        }),
        // SB(seat3, playerB)がコール
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 30002,
          SeatIndex: 3,
          ActionType: ActionType.CALL,
          Chip: 1940,
          BetChip: 60,
          Progress: {
            Phase: 0,
            NextActionSeat: 5,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 100,
            Pot: 150,
            SidePot: []
          }
        }),
        // BB(seat5, playerC)がフォールド
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 30003,
          SeatIndex: 5,
          ActionType: ActionType.FOLD,
          Chip: 1980,
          BetChip: 0,
          Progress: {
            Phase: 0,
            NextActionSeat: -1,
            NextActionTypes: [],
            NextExtraLimitSeconds: 0,
            MinRaise: 0,
            Pot: 150,
            SidePot: []
          }
        }),
        createEvent(ApiType.EVT_HAND_RESULTS, {
          timestamp: 30004,
          HandId: 999002,
          CommunityCards: [],
          Pot: 150,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [
            {
              UserId: A,
              HoleCards: [37, 51],
              RankType: 10, // NO_CALL
              Hands: [],
              HandRanking: 1,
              Ranking: 1,
              RewardChip: 150
            }
          ],
          OtherPlayers: [
            { SeatIndex: 3, Status: 0, BetStatus: -1, Chip: 1940, BetChip: 0 },
            { SeatIndex: 5, Status: 0, BetStatus: -1, Chip: 1980, BetChip: 0 }
          ]
        }, { skipValidation: true })
      ]

      // --- ライブ記録パイプライン: WriteEntityStream経由 ---
      const dbMock = new PokerChaseDB(indexedDB, IDBKeyRange)
      const service = new PokerChaseService({ db: dbMock })
      await service.ready

      // --- インポート/リビルドパイプライン: EntityConverter経由 ---
      const importResult = converter.convertEventsToEntities(events)
      const importActions = importResult.actions.slice().sort((a, b) => a.index - b.index)

      const liveActions = (await pipeEventsAndWaitForActions(service, dbMock, events, {
        handId: 999002,
        minCount: importActions.length
      })).slice().sort((a, b) => a.index - b.index)

      expect(liveActions.length).toBeGreaterThan(0)
      expect(importActions.length).toBe(liveActions.length)

      const pickComparable = (action: Action) => ({
        playerId: action.playerId,
        phase: action.phase,
        actionType: action.actionType,
        position: action.position,
        actionDetails: action.actionDetails
      })

      expect(importActions.map(pickComparable)).toEqual(liveActions.map(pickComparable))

      // 空席があっても、明示的なButtonSeat/SmallBlindSeat/BigBlindSeatから
      // 正しくポジションが割り当てられることを検証する
      const positionsByPlayer = new Map(liveActions.map(a => [a.playerId, a.position]))
      expect(positionsByPlayer.get(A)).toBe(Position.BTN)
      expect(positionsByPlayer.get(B)).toBe(Position.SB)
      expect(positionsByPlayer.get(C)).toBe(Position.BB)

      const importPositionsByPlayer = new Map(importActions.map(a => [a.playerId, a.position]))
      expect(importPositionsByPlayer).toEqual(positionsByPlayer)
    })

    /**
     * 座席解決不能なEVT_ACTIONのスキップ（EC↔WESパリティ）
     *
     * 背景: 途中着席（EVT_ENTRY_QUEUED）によるテーブル移動後、直前にバッファされた
     * EVT_DEALのSeatUserIdsには新テーブルの座席が反映されていない状態のまま
     * EVT_ACTIONが届くことがある。この場合`seatUserIds[event.SeatIndex]`は
     * undefinedまたは-1（空席）を返す。
     * 実データ検証: 完走した27ハンド / 68アクション（全ハンドの0.09%）でこの状況を確認。
     * 修正前は`playerId ?? 0`でplayerId=0を捏造し、position=-3の実在しないアクションが
     * actionsテーブルに混入していた。修正後は両パイプラインとも該当アクションを
     * 丸ごとスキップし、ハンドの他のアクションは正常に処理を継続する。
     */
    it('skips an EVT_ACTION with an unresolvable SeatIndex in BOTH pipelines, leaving other actions intact', async () => {
      const events: ApiEvent[] = [
        createEvent(ApiType.EVT_DEAL, {
          timestamp: 40000,
          SeatUserIds: [400, 401, -1, -1],
          Game: {
            CurrentBlindLv: 1,
            NextBlindUnixSeconds: 40000000,
            Ante: 0,
            SmallBlind: 10,
            BigBlind: 20,
            ButtonSeat: 0,
            SmallBlindSeat: 0,
            BigBlindSeat: 1
          },
          Progress: {
            Phase: 0,
            NextActionSeat: 0,
            NextActionTypes: [ActionType.CALL, ActionType.FOLD],
            NextExtraLimitSeconds: 15,
            MinRaise: 40,
            Pot: 30,
            SidePot: []
          },
          OtherPlayers: [
            { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 1980, BetChip: 20 }
          ]
        }),
        // BTN/SB(seat0, player400)がコール
        // NextActionSeat: 3 は、次に届く（座席未解決の）アクションのSeatIndexと一致させておく。
        // AggregateEventsStreamは`Progress.NextActionSeat !== event.SeatIndex`の場合に
        // 順序不整合とみなしてバッファをクリアしてしまうため、このテストでは
        // その整合性チェック自体はパスさせ、EVT_ACTIONハンドラ内のスキップ処理
        // （本テストの対象）だけを検証する
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 40001,
          SeatIndex: 0,
          ActionType: ActionType.CALL,
          Chip: 1980,
          BetChip: 20,
          Progress: {
            Phase: 0,
            NextActionSeat: 3,
            NextActionTypes: [ActionType.CHECK, ActionType.BET],
            NextExtraLimitSeconds: 15,
            MinRaise: 40,
            Pot: 40,
            SidePot: []
          }
        }),
        // 途中着席によるテーブル移動後の座席未反映アクション（SeatIndex=3は空席=-1を指す）
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 40002,
          SeatIndex: 3,
          ActionType: ActionType.CALL,
          BetChip: 20,
          Chip: 0,
          Progress: {
            Phase: 0,
            NextActionSeat: 1,
            NextActionTypes: [ActionType.CHECK, ActionType.BET],
            NextExtraLimitSeconds: 15,
            MinRaise: 40,
            Pot: 40,
            SidePot: []
          }
        }, { skipValidation: true }),
        // BB(seat1, player401)がチェック
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 40003,
          SeatIndex: 1,
          ActionType: ActionType.CHECK,
          Chip: 1980,
          BetChip: 0,
          Progress: {
            Phase: 0,
            NextActionSeat: -1,
            NextActionTypes: [],
            NextExtraLimitSeconds: 0,
            MinRaise: 0,
            Pot: 40,
            SidePot: []
          }
        }),
        createEvent(ApiType.EVT_HAND_RESULTS, {
          timestamp: 40004,
          HandId: 999020,
          CommunityCards: [],
          Pot: 40,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [
            {
              UserId: 400,
              HoleCards: [],
              RankType: RankType.NO_CALL,
              Hands: [],
              HandRanking: 1,
              Ranking: 1,
              RewardChip: 40
            }
          ],
          OtherPlayers: [
            { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 1980, BetChip: 0 }
          ]
        }, { skipValidation: true })
      ]

      // --- インポート/リビルドパイプライン: EntityConverter経由 ---
      const importResult = converter.convertEventsToEntities(events)
      expect(importResult.hands).toHaveLength(1)
      // 座席解決不能なアクション（SeatIndex=3）はスキップされ、残り2件のみ含まれる
      expect(importResult.actions).toHaveLength(2)
      expect(importResult.actions.every(a => a.playerId === 400 || a.playerId === 401)).toBe(true)
      expect(importResult.actions.some(a => a.actionType === ActionType.CALL && a.playerId === 400)).toBe(true)
      expect(importResult.actions.some(a => a.actionType === ActionType.CHECK && a.playerId === 401)).toBe(true)

      // --- ライブ記録パイプライン: WriteEntityStream経由 ---
      const dbMock = new PokerChaseDB(indexedDB, IDBKeyRange)
      const service = new PokerChaseService({ db: dbMock })
      await service.ready
      const liveActions = await pipeEventsAndWaitForActions(service, dbMock, events, {
        handId: 999020,
        minCount: importResult.actions.length
      })

      // 両パイプラインとも同じ2件のアクションのみ（不正なアクションは混入しない）
      expect(liveActions).toHaveLength(2)
      expect(liveActions.every(a => a.playerId === 400 || a.playerId === 401)).toBe(true)
      expect(liveActions.some(a => a.position === -3 as Position)).toBe(false)

      const pickComparable = (action: Action) => ({
        playerId: action.playerId,
        phase: action.phase,
        actionType: action.actionType,
        position: action.position,
        actionDetails: action.actionDetails
      })
      expect(importResult.actions.slice().sort((a, b) => a.index - b.index).map(pickComparable))
        .toEqual(liveActions.slice().sort((a, b) => a.index - b.index).map(pickComparable))
    })

    /**
     * テーブル移動キメラハンドの棄却（EC↔WESパリティ）
     *
     * 背景: MTTでヒーローがハンド途中に別テーブルへ移動する（EVT_ENTRY_QUEUED）と、
     * クライアントは移動先テーブルで進行中だったハンドの残り（EVT_ACTIONの末尾、
     * および対応するEVT_HAND_RESULTS）を受信する。移動先のEVT_ACTION.SeatIndexが
     * 偶然、旧テーブルの有効な席番号・NextActionSeatの遷移パターンと一致すると、
     * #100のSeatIndex未解決ガードをすり抜けてハンドバッファが継続してしまい、
     * 旧テーブルのEVT_DEAL（座席構成・ブラインド・ヒーローのホールカード）と
     * 新テーブルのEVT_HAND_RESULTS（HandId・勝者・獲得チップ）が1つのハンドとして
     * 混ざり合う「キメラハンド」が生成される。
     *
     * 実データ検証（393,830イベント、31,392完走ハンド）: この機序で71ハンド
     * （0.23%）が汚染されており、うち25ハンドはSeatIndex未解決アクションを伴う
     * （23ハンドはResults[]が新テーブルの座席構成と完全一致、2ハンドは新旧混在）。
     * 残り46ハンドはSeatIndex未解決アクションを伴わない（席番号の偶然の一致）が、
     * 全てEVT_ENTRY_QUEUED直後の最初の完走ハンドであり、同一機序による汚染と
     * 断定できる。修正: EVT_HAND_RESULTS.Results[]のUserIdが1件でも配札時の
     * seatUserIdsに存在しない場合、バッファ中のハンドを丸ごと棄却する
     * （hasResultsOutsideDealtLineup、src/types/game.ts）。
     */
    it('rejects a table-move chimera hand (RESULTS references players outside the dealt lineup) in BOTH pipelines', async () => {
      const tableAEvents: ApiEvent[] = [
        // テーブルAでのDEAL（座席構成: 500, 501, 502, 503）
        createEvent(ApiType.EVT_DEAL, {
          timestamp: 50000,
          SeatUserIds: [500, 501, 502, 503],
          Game: {
            CurrentBlindLv: 1,
            NextBlindUnixSeconds: 50000000,
            Ante: 0,
            SmallBlind: 10,
            BigBlind: 20,
            ButtonSeat: 0,
            SmallBlindSeat: 1,
            BigBlindSeat: 2
          },
          Progress: {
            Phase: 0,
            NextActionSeat: 3,
            NextActionTypes: [ActionType.CALL, ActionType.FOLD, ActionType.RAISE],
            NextExtraLimitSeconds: 15,
            MinRaise: 40,
            Pot: 30,
            SidePot: []
          },
          OtherPlayers: [
            { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 990, BetChip: 10 },
            { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 980, BetChip: 20 },
            { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 1000, BetChip: 0 }
          ]
        }),
        // 移動前の正常なアクション（テーブルAの座席501=player501によるコール）
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 50001,
          SeatIndex: 3,
          ActionType: ActionType.CALL,
          Chip: 980,
          BetChip: 20,
          Progress: {
            Phase: 0,
            NextActionSeat: 0,
            NextActionTypes: [ActionType.CALL, ActionType.FOLD, ActionType.RAISE],
            NextExtraLimitSeconds: 15,
            MinRaise: 40,
            Pot: 50,
            SidePot: []
          }
        }),
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 50002,
          SeatIndex: 0,
          ActionType: ActionType.CALL,
          Chip: 980,
          BetChip: 20,
          Progress: {
            Phase: 0,
            NextActionSeat: 1,
            NextActionTypes: [ActionType.CALL, ActionType.CHECK, ActionType.RAISE],
            NextExtraLimitSeconds: 15,
            MinRaise: 40,
            Pot: 70,
            SidePot: []
          }
        }),
        // ここでヒーローがEVT_ENTRY_QUEUEDにより別テーブルへ移動する（本テストの
        // 対象コードはハンドイベントのみを見るため、AggregateEventsStream相当の
        // 集約はテスト対象外。EC/WESどちらも「1ハンド分のイベント配列」を受け取る
        // 前提のため、集約済みの配列をそのまま構築する）。
        // 移動先テーブルの残りアクション。SeatIndex=1は偶然テーブルAの有効な
        // 座席（player501）を指すため、#100のSeatIndex未解決ガードはすり抜ける。
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 50003,
          SeatIndex: 1,
          ActionType: ActionType.CHECK,
          Chip: 5000,
          BetChip: 0,
          Progress: {
            Phase: 0,
            NextActionSeat: -1,
            NextActionTypes: [],
            NextExtraLimitSeconds: 0,
            MinRaise: 0,
            Pot: 70,
            SidePot: []
          }
        }, { skipValidation: true }),
        // 移動先テーブルのEVT_HAND_RESULTS。UserId 900/901はテーブルAのDEALの
        // 座席構成（500, 501, 502, 503）に一切含まれない（ゼロオーバーラップの
        // 実データ観測ケース、HandId 258419183と同型）。
        createEvent(ApiType.EVT_HAND_RESULTS, {
          timestamp: 50004,
          HandId: 999030,
          CommunityCards: [],
          Pot: 700,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [
            {
              UserId: 900,
              HoleCards: [],
              RankType: RankType.NO_CALL,
              Hands: [],
              HandRanking: 1,
              Ranking: 1,
              RewardChip: 700
            },
            {
              UserId: 901,
              HoleCards: [],
              RankType: RankType.NO_CALL,
              Hands: [],
              HandRanking: 2,
              Ranking: -1,
              RewardChip: 0
            }
          ],
          OtherPlayers: [
            { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 5700, BetChip: 0 }
          ]
        }, { skipValidation: true })
      ]

      // --- インポート/リビルドパイプライン: EntityConverter経由 ---
      const importResult = converter.convertEventsToEntities(tableAEvents)
      // キメラハンドは棄却され、hands/phases/actionsのいずれにも現れない
      expect(importResult.hands).toHaveLength(0)
      expect(importResult.hands.some(h => h.id === 999030)).toBe(false)

      // --- ライブ記録パイプライン: WriteEntityStream経由 ---
      const dbMock = new PokerChaseDB(indexedDB, IDBKeyRange)
      const service = new PokerChaseService({ db: dbMock })
      await service.ready
      for (const event of tableAEvents) service.handAggregateStream.write(event)
      await service.handAggregateStream.whenIdle()

      const liveHand = await dbMock.hands.get(999030)
      expect(liveHand).toBeUndefined()
      const liveActions = await dbMock.actions.where('handId').equals(999030).toArray()
      expect(liveActions).toHaveLength(0)
      const livePhases = await dbMock.phases.where('handId').equals(999030).toArray()
      expect(livePhases).toHaveLength(0)
    })

    /**
     * 対照実験: 正常なRESULTS（配札時のseatUserIdsの部分集合）は引き続き受理される。
     * キメラハンド棄却ガードが、通常のフォールド落ち（Results[]がseatUserIdsの
     * 全員ではなく一部のみを含む、ごく一般的なケース）まで誤って棄却しないことを
     * 確認する。
     */
    it('still accepts a normal hand whose RESULTS is a subset of the dealt lineup', async () => {
      const events: ApiEvent[] = [
        createEvent(ApiType.EVT_DEAL, {
          timestamp: 51000,
          SeatUserIds: [600, 601, 602, 603],
          Game: {
            CurrentBlindLv: 1,
            NextBlindUnixSeconds: 51000000,
            Ante: 0,
            SmallBlind: 10,
            BigBlind: 20,
            ButtonSeat: 0,
            SmallBlindSeat: 1,
            BigBlindSeat: 2
          },
          Progress: {
            Phase: 0,
            NextActionSeat: 3,
            NextActionTypes: [ActionType.CALL, ActionType.FOLD, ActionType.RAISE],
            NextExtraLimitSeconds: 15,
            MinRaise: 40,
            Pot: 30,
            SidePot: []
          },
          OtherPlayers: [
            { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 990, BetChip: 10 },
            { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 980, BetChip: 20 },
            { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 1000, BetChip: 0 }
          ]
        }),
        // 3名がフォールドし、602(BB)だけがポットを獲得して終わる、ごく普通のハンド
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 51001,
          SeatIndex: 3,
          ActionType: ActionType.FOLD,
          Chip: 1000,
          BetChip: 0,
          Progress: {
            Phase: 0,
            NextActionSeat: 0,
            NextActionTypes: [ActionType.CALL, ActionType.FOLD, ActionType.RAISE],
            NextExtraLimitSeconds: 15,
            MinRaise: 40,
            Pot: 30,
            SidePot: []
          }
        }),
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 51002,
          SeatIndex: 0,
          ActionType: ActionType.FOLD,
          Chip: 1000,
          BetChip: 0,
          Progress: {
            Phase: 0,
            NextActionSeat: 1,
            NextActionTypes: [ActionType.CALL, ActionType.FOLD, ActionType.RAISE],
            NextExtraLimitSeconds: 15,
            MinRaise: 40,
            Pot: 30,
            SidePot: []
          }
        }),
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 51003,
          SeatIndex: 1,
          ActionType: ActionType.FOLD,
          Chip: 990,
          BetChip: 10,
          Progress: {
            Phase: 0,
            NextActionSeat: -2,
            NextActionTypes: [],
            NextExtraLimitSeconds: 0,
            MinRaise: 0,
            Pot: 30,
            SidePot: []
          }
        }),
        createEvent(ApiType.EVT_HAND_RESULTS, {
          timestamp: 51004,
          HandId: 999031,
          CommunityCards: [],
          Pot: 30,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [
            {
              UserId: 602,
              HoleCards: [],
              RankType: RankType.NO_CALL,
              Hands: [],
              HandRanking: 1,
              Ranking: 1,
              RewardChip: 30
            }
          ],
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: -1, Chip: 1000, BetChip: 0 },
            { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 990, BetChip: 0 },
            { SeatIndex: 3, Status: 0, BetStatus: -1, Chip: 1000, BetChip: 0 }
          ]
        }, { skipValidation: true })
      ]

      // --- インポート/リビルドパイプライン: EntityConverter経由 ---
      const importResult = converter.convertEventsToEntities(events)
      expect(importResult.hands).toHaveLength(1)
      expect(importResult.hands[0]?.id).toBe(999031)
      expect(importResult.hands[0]?.winningPlayerIds).toEqual([602])

      // --- ライブ記録パイプライン: WriteEntityStream経由 ---
      const dbMock = new PokerChaseDB(indexedDB, IDBKeyRange)
      const service = new PokerChaseService({ db: dbMock })
      await service.ready
      for (const event of events) service.handAggregateStream.write(event)
      await service.handAggregateStream.whenIdle()

      const liveHand = await dbMock.hands.get(999031)
      expect(liveHand).toBeDefined()
      expect(liveHand?.winningPlayerIds).toEqual([602])
    })
  })

  /**
   * フェーズ所属（Phase.seatUserIds）と勝者定義（Hand.winningPlayerIds）のパリティ
   *
   * バグ1: EntityConverterのEVT_DEAL_ROUNDハンドラは新フェーズのseatUserIdsに
   * `handState.hand.seatUserIds`（配札時の全員）をそのまま使い回していたため、
   * プリフロップで既にフォールドしたプレイヤーもフロップ/ターン/リバーを
   * 「見た」ことになっていた（WriteEntityStreamはevent.Player/OtherPlayersを
   * BetStatus===BET_ABLEでフィルタしてから使用）。これによりWTSD/WWSFの分母が
   * 水増しされる（オラクル比較で該当プレイヤーのWWSF分母が130 vs 真値39など）。
   *
   * バグ2: 勝者定義がEC（RewardChip>0）とWES（HandRanking===1）で乖離していた。
   * サイドポット発生ハンド（実データの8.23%）のうち44.25%でこの2定義が異なる
   * 勝者集合を返す（メインポットの役が最強でも、サイドポットのみを獲得した
   * プレイヤーはHandRanking!==1だがRewardChip>0になるため）。WWSF/W$SDは
   * 「ポットの一部でも獲得したか」を問うPT4準拠の定義であり、RewardChip>0が
   * 正しい。両パスをRewardChip>0に統一する。
   *
   * バグ3: RIVER_CALL_WON（River Call Accuracy統計の分子）はWriteEntityStreamの
   * EVT_HAND_RESULTSハンドラにのみ実装されており、EntityConverterには存在しな
   * かった（実データで3,297件のRIVER_CALLアクション中0件がRIVER_CALL_WON）。
   */
  describe('phase membership, winner definition, and river-call-won parity', () => {
    it('excludes a preflop folder from the flop phase seatUserIds in BOTH pipelines (scenario a)', async () => {
      // 4人テーブル（seat3は空席）。UTG(seat0, player A)がプリフロップでフォールドし、
      // 残り2人(B, C)がフロップ・ターン・リバーを経てショーダウンに至る。
      // フォールドしたAはフロップ以降のPhase.seatUserIdsに含まれてはならない。
      const A = 111, B = 222, C = 333
      const events: ApiEvent[] = [
        createEvent(ApiType.EVT_DEAL, {
          timestamp: 40000,
          SeatUserIds: [A, B, C, -1],
          Game: {
            CurrentBlindLv: 1,
            NextBlindUnixSeconds: 40000000,
            Ante: 0,
            SmallBlind: 10,
            BigBlind: 20,
            ButtonSeat: 0,
            SmallBlindSeat: 1,
            BigBlindSeat: 2
          },
          Player: {
            SeatIndex: 0,
            BetStatus: 1,
            HoleCards: [37, 51],
            Chip: 1980,
            BetChip: 0
          },
          Progress: {
            Phase: 0,
            NextActionSeat: 0,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 40,
            Pot: 30,
            SidePot: []
          },
          OtherPlayers: [
            { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 1990, BetChip: 10 },
            { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 1980, BetChip: 20 }
          ]
        }),
        // UTG(seat0, A)がフォールド
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 40001,
          SeatIndex: 0,
          ActionType: ActionType.FOLD,
          Chip: 1980,
          BetChip: 0,
          Progress: {
            Phase: 0,
            NextActionSeat: 1,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 40,
            Pot: 30,
            SidePot: []
          }
        }),
        // SB(seat1, B)がコール
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 40002,
          SeatIndex: 1,
          ActionType: ActionType.CALL,
          Chip: 1980,
          BetChip: 20,
          Progress: {
            Phase: 0,
            NextActionSeat: 2,
            NextActionTypes: [2, 3],
            NextExtraLimitSeconds: 15,
            MinRaise: 0,
            Pot: 40,
            SidePot: []
          }
        }),
        // BB(seat2, C)がチェック
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 40003,
          SeatIndex: 2,
          ActionType: ActionType.CHECK,
          Chip: 1980,
          BetChip: 0,
          Progress: {
            Phase: 0,
            NextActionSeat: -1,
            NextActionTypes: [],
            NextExtraLimitSeconds: 0,
            MinRaise: 0,
            Pot: 40,
            SidePot: []
          }
        }),
        // フロップ: BとCのみ引き続き参加（Aはフォールド済みのためOtherPlayersに含まれない）
        createEvent(ApiType.EVT_DEAL_ROUND, {
          timestamp: 40004,
          CommunityCards: [1, 21, 44],
          Progress: {
            Phase: 1,
            NextActionSeat: 1,
            NextActionTypes: [0, 1, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 0,
            Pot: 40,
            SidePot: []
          },
          OtherPlayers: [
            { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 1980, BetChip: 0 }
          ],
          Player: {
            SeatIndex: 1,
            BetStatus: 1,
            HoleCards: [3, 4],
            Chip: 1980,
            BetChip: 0
          }
        }),
        // SB(seat1, B)がチェック
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 40005,
          SeatIndex: 1,
          ActionType: ActionType.CHECK,
          Chip: 1980,
          BetChip: 0,
          Progress: {
            Phase: 1,
            NextActionSeat: 2,
            NextActionTypes: [0, 1, 5],
            NextExtraLimitSeconds: 15,
            MinRaise: 0,
            Pot: 40,
            SidePot: []
          }
        }),
        // BB(seat2, C)がチェック
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 40006,
          SeatIndex: 2,
          ActionType: ActionType.CHECK,
          Chip: 1980,
          BetChip: 0,
          Progress: {
            Phase: 1,
            NextActionSeat: -1,
            NextActionTypes: [],
            NextExtraLimitSeconds: 0,
            MinRaise: 0,
            Pot: 40,
            SidePot: []
          }
        }),
        createEvent(ApiType.EVT_HAND_RESULTS, {
          timestamp: 40007,
          HandId: 999010,
          CommunityCards: [7, 8],
          Pot: 40,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [
            {
              UserId: B,
              HoleCards: [3, 4],
              RankType: RankType.HIGH_CARD,
              Hands: [1, 3, 4, 7, 8],
              HandRanking: 1,
              Ranking: 1,
              RewardChip: 40
            },
            {
              UserId: C,
              HoleCards: [5, 6],
              RankType: RankType.HIGH_CARD,
              Hands: [1, 5, 6, 7, 8],
              HandRanking: -1,
              Ranking: 2,
              RewardChip: 0
            }
          ],
          OtherPlayers: [
            { SeatIndex: 2, Status: 0, BetStatus: -1, Chip: 1980, BetChip: 0 }
          ]
        })
      ]

      // --- ライブ記録パイプライン: WriteEntityStream経由 ---
      const dbMock = new PokerChaseDB(indexedDB, IDBKeyRange)
      const service = new PokerChaseService({ db: dbMock })
      await service.ready

      // --- インポート/リビルドパイプライン: EntityConverter経由 ---
      const importResult = converter.convertEventsToEntities(events)
      const importPhases = importResult.phases.slice().sort((a, b) => a.phase - b.phase)

      for (const event of events) service.handAggregateStream.write(event)
      const livePhases = (await pipeEventsAndWaitForReady(
        service,
        async () => {
          await dbMock.open()
          return (await dbMock.phases.where('handId').equals(999010).toArray())
        },
        result => result.length >= importPhases.length,
        { description: `dbMock.phases with handId=999010 to have >= ${importPhases.length} row(s)` }
      )).sort((a, b) => a.phase - b.phase)

      const pickComparablePhase = (phase: typeof livePhases[0]) => ({
        phase: phase.phase,
        seatUserIds: [...phase.seatUserIds].sort((a, b) => a - b)
      })

      // ライブパイプライン: フロップのseatUserIdsはB,Cのみ（Aはフォールド済みで除外）
      const liveFlopPhase = livePhases.find(p => p.phase === PhaseType.FLOP)
      expect(liveFlopPhase).toBeDefined()
      expect([...liveFlopPhase!.seatUserIds].sort((a, b) => a - b)).toEqual([B, C])
      expect(liveFlopPhase!.seatUserIds).not.toContain(A)

      // インポート/リビルドパイプライン: 修正後はライブと同じくAを含まない
      const importFlopPhase = importPhases.find(p => p.phase === PhaseType.FLOP)
      expect(importFlopPhase).toBeDefined()
      expect([...importFlopPhase!.seatUserIds].sort((a, b) => a - b)).toEqual([B, C])
      expect(importFlopPhase!.seatUserIds).not.toContain(A)

      // 両パイプラインの全フェーズが完全一致
      expect(importPhases.map(pickComparablePhase)).toEqual(livePhases.map(pickComparablePhase))
    })

    /**
     * サイドポット勝者の不一致（scenario b）。
     *
     * 実データ（pokerchase_raw_data_2026-07-04T18-31-12-252Z.ndjson、HandId=269804225）
     * から抽出したハンドを匿名化したもの。ヘッズアップでプリフロップオールイン、
     * アンテ差によるサイドポットが発生し、メインポット勝者（HandRanking=1、
     * RewardChip=3576）とサイドポット勝者（HandRanking=2、RewardChip=14412）が
     * 異なるプレイヤーになる。
     *
     * `Pot(3576) + SidePot(14412) === sum(RewardChip)(3576+14412)` の不変条件を維持。
     */
    it('unifies main-pot and side-pot winners under RewardChip>0 in BOTH pipelines (scenario b)', async () => {
      const WINNER_MAIN = 850121266 // メインポット勝者（HandRanking=1）
      const WINNER_SIDE = 561384657 // サイドポットのみの勝者（HandRanking=2、RewardChip>0）
      const events: ApiEvent[] = [
        createEvent(ApiType.EVT_DEAL, {
          timestamp: 50000,
          SeatUserIds: [WINNER_SIDE, -1, -1, WINNER_MAIN, -1, -1],
          Game: {
            CurrentBlindLv: 12,
            NextBlindUnixSeconds: 1729100631,
            Ante: 3200,
            SmallBlind: 6500,
            BigBlind: 13000,
            ButtonSeat: 3,
            SmallBlindSeat: 3,
            BigBlindSeat: 0
          },
          Player: {
            SeatIndex: 0,
            BetStatus: 1,
            HoleCards: [49, 8],
            Chip: 162012,
            BetChip: 13000
          },
          Progress: {
            Phase: 0,
            NextActionSeat: 0,
            NextActionTypes: [0],
            NextExtraLimitSeconds: 12,
            MinRaise: 0,
            Pot: 3576,
            SidePot: [14412]
          },
          OtherPlayers: [
            { SeatIndex: 3, Status: 0, BetStatus: 3, Chip: 0, BetChip: 0 }
          ]
        }, { skipValidation: true }),
        // ヒーロー(seat0, WINNER_SIDE)がオールイン後のチェック扱い（進行イベント）
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 50001,
          SeatIndex: 0,
          ActionType: ActionType.CHECK,
          Chip: 162012,
          BetChip: 13000,
          Progress: {
            Phase: 3,
            NextActionSeat: -2,
            NextActionTypes: [],
            NextExtraLimitSeconds: 0,
            MinRaise: 0,
            Pot: 3576,
            SidePot: [14412]
          }
        }, { skipValidation: true }),
        createEvent(ApiType.EVT_HAND_RESULTS, {
          timestamp: 50002,
          HandId: 269804225,
          CommunityCards: [40, 7, 2, 33, 39],
          Pot: 3576,
          SidePot: [14412],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [
            {
              UserId: WINNER_MAIN,
              HoleCards: [25, 35],
              RankType: RankType.STRAIGHT,
              Hands: [35, 33, 40, 39, 25],
              HandRanking: 1,
              Ranking: -2,
              RewardChip: 3576
            },
            {
              UserId: WINNER_SIDE,
              HoleCards: [49, 8],
              RankType: RankType.TWO_PAIR,
              Hands: [49, 40, 39, 33, 8],
              HandRanking: 2,
              Ranking: -2,
              RewardChip: 14412
            }
          ],
          OtherPlayers: [
            { SeatIndex: 3, Status: 0, BetStatus: -1, Chip: 3576, BetChip: 0 }
          ]
        }, { skipValidation: true })
      ]

      // 不変条件の確認: Pot + sum(SidePot) === sum(RewardChip)
      const resultsEvt = events.find(e => e.ApiTypeId === ApiType.EVT_HAND_RESULTS)!
      const totalReward = resultsEvt.Results!.reduce((sum, r) => sum + r.RewardChip, 0)
      expect(resultsEvt.Pot + resultsEvt.SidePot!.reduce((a, b) => a + b, 0)).toBe(totalReward)

      // --- ライブ記録パイプライン: WriteEntityStream経由 ---
      const dbMock = new PokerChaseDB(indexedDB, IDBKeyRange)
      const service = new PokerChaseService({ db: dbMock })
      await service.ready

      // --- インポート/リビルドパイプライン: EntityConverter経由 ---
      const importResult = converter.convertEventsToEntities(events)
      const importHand = importResult.hands.find(h => h.id === 269804225)

      for (const event of events) service.handAggregateStream.write(event)
      const liveHand = await pipeEventsAndWaitForReady(
        service,
        async () => {
          await dbMock.open()
          return dbMock.hands.get(269804225)
        },
        result => result !== undefined && result.winningPlayerIds.length >= (importHand?.winningPlayerIds.length ?? 0),
        { description: 'dbMock.hands row 269804225 with winningPlayerIds populated' }
      )

      // 修正前のWES（HandRanking===1）ではWINNER_SIDEを見逃していたが、
      // 修正後はRewardChip>0に統一されているため、両者ともサイドポット勝者を含む
      expect(liveHand).toBeDefined()
      expect(importHand).toBeDefined()
      expect(new Set(liveHand!.winningPlayerIds)).toEqual(new Set([WINNER_MAIN, WINNER_SIDE]))
      expect(new Set(importHand!.winningPlayerIds)).toEqual(new Set([WINNER_MAIN, WINNER_SIDE]))
      expect(new Set(importHand!.winningPlayerIds)).toEqual(new Set(liveHand!.winningPlayerIds))

      // 旧HandRanking===1定義ではWINNER_SIDEが漏れることの確認（回帰防止のドキュメント）
      const oldDefinitionWinners = new Set(
        resultsEvt.Results!.filter(r => r.HandRanking === 1).map(r => r.UserId)
      )
      expect(oldDefinitionWinners.has(WINNER_SIDE)).toBe(false)
    })

    /**
     * リバーコール勝利（scenario c）。
     *
     * 実データ（HandId=271929009）から抽出したヘッズアップハンドを匿名化。
     * プリフロップ レイズ/コール、フロップ チェック/チェック、ターン ベット/コール、
     * リバー ベット/コールを経てスプリットポット（両者HandRanking=1、RewardChip>0）
     * に至る。リバーでコールしたseat0のプレイヤー(WINNER_CALLER)は
     * RIVER_CALL_WONが付与されるべき。
     */
    it('tags RIVER_CALL_WON on the import path for a winning river call (scenario c)', async () => {
      const WINNER_CALLER = 111222333 // seat0, リバーでコールして勝利
      const OPPONENT = 444555666 // seat3, リバーでベットして勝利（スプリット）
      const events: ApiEvent[] = [
        createEvent(ApiType.EVT_DEAL, {
          timestamp: 60000,
          SeatUserIds: [WINNER_CALLER, -1, -1, OPPONENT, -1, -1],
          Game: {
            CurrentBlindLv: 9,
            NextBlindUnixSeconds: 1729533620,
            Ante: 950,
            SmallBlind: 1900,
            BigBlind: 3800,
            ButtonSeat: 0,
            SmallBlindSeat: 0,
            BigBlindSeat: 3
          },
          Player: {
            SeatIndex: 3,
            BetStatus: 1,
            HoleCards: [10, 34],
            Chip: 107880,
            BetChip: 3800
          },
          Progress: {
            Phase: 0,
            NextActionSeat: 0,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 12,
            MinRaise: 7600,
            Pot: 7600,
            SidePot: []
          },
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 64520, BetChip: 1900 }
          ]
        }, { skipValidation: true }),
        // seat0(WINNER_CALLER)がレイズ
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 60001,
          SeatIndex: 0,
          ActionType: ActionType.RAISE,
          Chip: 58820,
          BetChip: 7600,
          Progress: {
            Phase: 0,
            NextActionSeat: 3,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 12,
            MinRaise: 11400,
            Pot: 13300,
            SidePot: []
          }
        }),
        // seat3(OPPONENT)がコール
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 60002,
          SeatIndex: 3,
          ActionType: ActionType.CALL,
          Chip: 104080,
          BetChip: 7600,
          Progress: {
            Phase: 0,
            NextActionSeat: -1,
            NextActionTypes: [],
            NextExtraLimitSeconds: 0,
            MinRaise: 0,
            Pot: 17100,
            SidePot: []
          }
        }),
        // フロップ: 両者チェック
        createEvent(ApiType.EVT_DEAL_ROUND, {
          timestamp: 60003,
          CommunityCards: [15, 30, 25],
          Progress: {
            Phase: 1,
            NextActionSeat: 3,
            NextActionTypes: [0, 1, 5],
            NextExtraLimitSeconds: 12,
            MinRaise: 0,
            Pot: 17100,
            SidePot: []
          },
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 58820, BetChip: 0 }
          ],
          Player: {
            SeatIndex: 3,
            BetStatus: 1,
            HoleCards: [10, 34],
            Chip: 104080,
            BetChip: 0
          }
        }),
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 60004,
          SeatIndex: 3,
          ActionType: ActionType.CHECK,
          Chip: 104080,
          BetChip: 0,
          Progress: {
            Phase: 1,
            NextActionSeat: 0,
            NextActionTypes: [0, 1, 5],
            NextExtraLimitSeconds: 12,
            MinRaise: 0,
            Pot: 17100,
            SidePot: []
          }
        }),
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 60005,
          SeatIndex: 0,
          ActionType: ActionType.CHECK,
          Chip: 58820,
          BetChip: 0,
          Progress: {
            Phase: 1,
            NextActionSeat: -1,
            NextActionTypes: [],
            NextExtraLimitSeconds: 0,
            MinRaise: 0,
            Pot: 17100,
            SidePot: []
          }
        }),
        // ターン: OPPONENTがベット、WINNER_CALLERがコール
        createEvent(ApiType.EVT_DEAL_ROUND, {
          timestamp: 60006,
          CommunityCards: [23],
          Progress: {
            Phase: 2,
            NextActionSeat: 3,
            NextActionTypes: [0, 1, 5],
            NextExtraLimitSeconds: 12,
            MinRaise: 0,
            Pot: 17100,
            SidePot: []
          },
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 58820, BetChip: 0 }
          ],
          Player: {
            SeatIndex: 3,
            BetStatus: 1,
            HoleCards: [10, 34],
            Chip: 104080,
            BetChip: 0
          }
        }),
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 60007,
          SeatIndex: 3,
          ActionType: ActionType.BET,
          Chip: 98380,
          BetChip: 5700,
          Progress: {
            Phase: 2,
            NextActionSeat: 0,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 12,
            MinRaise: 11400,
            Pot: 22800,
            SidePot: []
          }
        }),
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 60008,
          SeatIndex: 0,
          ActionType: ActionType.CALL,
          Chip: 53120,
          BetChip: 5700,
          Progress: {
            Phase: 2,
            NextActionSeat: -1,
            NextActionTypes: [],
            NextExtraLimitSeconds: 0,
            MinRaise: 0,
            Pot: 28500,
            SidePot: []
          }
        }),
        // リバー: OPPONENTがベット、WINNER_CALLERがコール（これがRIVER_CALL_WON対象）
        createEvent(ApiType.EVT_DEAL_ROUND, {
          timestamp: 60009,
          CommunityCards: [39],
          Progress: {
            Phase: 3,
            NextActionSeat: 3,
            NextActionTypes: [0, 1, 5],
            NextExtraLimitSeconds: 12,
            MinRaise: 0,
            Pot: 28500,
            SidePot: []
          },
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 53120, BetChip: 0 }
          ],
          Player: {
            SeatIndex: 3,
            BetStatus: 1,
            HoleCards: [10, 34],
            Chip: 98380,
            BetChip: 0
          }
        }),
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 60010,
          SeatIndex: 3,
          ActionType: ActionType.BET,
          Chip: 84130,
          BetChip: 14250,
          Progress: {
            Phase: 3,
            NextActionSeat: 0,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 12,
            MinRaise: 28500,
            Pot: 42750,
            SidePot: []
          }
        }),
        createEvent(ApiType.EVT_ACTION, {
          timestamp: 60011,
          SeatIndex: 0,
          ActionType: ActionType.CALL,
          Chip: 38870,
          BetChip: 14250,
          Progress: {
            Phase: 3,
            NextActionSeat: -2,
            NextActionTypes: [],
            NextExtraLimitSeconds: 0,
            MinRaise: 0,
            Pot: 57000,
            SidePot: []
          }
        }),
        createEvent(ApiType.EVT_HAND_RESULTS, {
          timestamp: 60012,
          HandId: 271929009,
          CommunityCards: [],
          Pot: 57000,
          SidePot: [],
          ResultType: 0,
          DefeatStatus: 0,
          Results: [
            {
              UserId: WINNER_CALLER,
              HoleCards: [5, 33],
              RankType: RankType.STRAIGHT,
              Hands: [39, 33, 30, 25, 23],
              HandRanking: 1,
              Ranking: -2,
              RewardChip: 28500
            },
            {
              UserId: OPPONENT,
              HoleCards: [10, 34],
              RankType: RankType.STRAIGHT,
              Hands: [39, 34, 30, 25, 23],
              HandRanking: 1,
              Ranking: -2,
              RewardChip: 28500
            }
          ],
          OtherPlayers: [
            { SeatIndex: 0, Status: 0, BetStatus: -1, Chip: 67370, BetChip: 0 }
          ]
        })
      ]

      // --- インポート/リビルドパイプライン: EntityConverter経由 ---
      const importResult = converter.convertEventsToEntities(events)
      const importHand = importResult.hands.find(h => h.id === 271929009)
      expect(importHand).toBeDefined()
      expect(new Set(importHand!.winningPlayerIds)).toEqual(new Set([WINNER_CALLER, OPPONENT]))

      const riverCallAction = importResult.actions.find(a =>
        a.handId === 271929009 &&
        a.playerId === WINNER_CALLER &&
        a.phase === PhaseType.RIVER &&
        a.actionType === ActionType.CALL
      )
      expect(riverCallAction).toBeDefined()
      expect(riverCallAction!.actionDetails).toContain(ActionDetail.RIVER_CALL)
      expect(riverCallAction!.actionDetails).toContain(ActionDetail.RIVER_CALL_WON)

      // --- ライブ記録パイプライン: WriteEntityStream経由（既に正しく動作している基準） ---
      const dbMock = new PokerChaseDB(indexedDB, IDBKeyRange)
      const service = new PokerChaseService({ db: dbMock })
      await service.ready
      const liveHandActions = await pipeEventsAndWaitForActions(service, dbMock, events, {
        handId: 271929009,
        minCount: importResult.actions.filter(a => a.handId === 271929009).length
      })
      const liveRiverCallAction = liveHandActions
        .find(a => a.playerId === WINNER_CALLER && a.phase === PhaseType.RIVER && a.actionType === ActionType.CALL)
      expect(liveRiverCallAction).toBeDefined()
      expect(liveRiverCallAction!.actionDetails).toContain(ActionDetail.RIVER_CALL_WON)

      // 両パイプラインが完全一致
      expect(riverCallAction!.actionDetails.slice().sort()).toEqual(liveRiverCallAction!.actionDetails.slice().sort())
    })
  })

  /**
   * SHOWDOWNフェーズ生成のRankTypeゲーティング
   *
   * バグ: 修正前は`Results.length > 1`のみでSHOWDOWNフェーズを生成していたため、
   * 「無競争勝利（NO_CALL）＋フォールド後の自発公開（FOLD_OPEN）」のような、実際には
   * カードを比較していない2件の結果でも誤ってSHOWDOWNフェーズが作られていた
   * （実データ393,830件中、複数結果ハンド12,329件のうち692件＝5.6%で発生）。
   * これによりWTSD/W$SDの分母が水増しされる。
   * CLAUDE.mdのConfirmed Statistical Definitionsに従い、ショーダウン参加者は
   * 「実役（RankType 0-9）またはSHOWDOWN_MUCK（11）」のみとし、NO_CALL（10）と
   * FOLD_OPEN（12）は除外する。
   */
  describe('SHOWDOWN phase gating by RankType', () => {
    // 2人テーブルでプリフロップにオールインし、そのままハンド結果を迎える最小フィクスチャ。
    // Resultsだけを差し替えて各RankTypeの組み合わせを検証する。
    const buildHeadsUpAllInEvents = (results: ApiEvent<ApiType.EVT_HAND_RESULTS>['Results']): ApiEvent[] => [
      createEvent(ApiType.EVT_DEAL, {
        timestamp: 3000,
        SeatUserIds: [300, 301, -1, -1, -1, -1],
        Game: {
          CurrentBlindLv: 1,
          NextBlindUnixSeconds: 3000000,
          Ante: 0,
          SmallBlind: 50,
          BigBlind: 100,
          ButtonSeat: 0,
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
      }),
      createEvent(ApiType.EVT_ACTION, {
        timestamp: 3001,
        SeatIndex: 0,
        ActionType: ActionType.ALL_IN,
        Chip: 0,
        BetChip: 2000,
        Progress: {
          Phase: 0,
          NextActionSeat: 1,
          NextActionTypes: [ActionType.BET],
          NextExtraLimitSeconds: 15,
          MinRaise: 4000,
          Pot: 2150,
          SidePot: []
        }
      }),
      createEvent(ApiType.EVT_HAND_RESULTS, {
        timestamp: 3002,
        HandId: 34567,
        CommunityCards: [1, 21, 44, 2, 15],
        Pot: 2150,
        SidePot: [],
        ResultType: 0,
        DefeatStatus: 0,
        Results: results,
        OtherPlayers: [
          { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 1900, BetChip: 0 }
        ]
      }, { skipValidation: true })
    ]

    it('does NOT create a SHOWDOWN phase for NO_CALL + FOLD_OPEN (uncontested win, no cards compared)', () => {
      // 実例（hand 295913653）: 相手がフォールドしたため無競争勝利（NO_CALL）。
      // フォールドしたプレイヤーは自発的にカードを公開した（FOLD_OPEN）だけで、
      // ショーダウンは発生していない。
      const events = buildHeadsUpAllInEvents([
        {
          UserId: 300,
          HoleCards: [],
          RankType: RankType.NO_CALL,
          Hands: [],
          HandRanking: 1,
          Ranking: 1,
          RewardChip: 2150
        },
        {
          UserId: 301,
          HoleCards: [48, 13],
          RankType: RankType.FOLD_OPEN,
          Hands: [],
          HandRanking: -1,
          Ranking: -1,
          RewardChip: 0
        }
      ])

      // インポート/リビルドパイプライン: EntityConverter経由
      // （ライブ記録パイプライン=WriteEntityStreamでの同等テストは次のitを参照）
      const importResult = converter.convertEventsToEntities(events)
      expect(importResult.phases.find(p => p.phase === PhaseType.SHOWDOWN)).toBeUndefined()
    })

    it('does NOT create a SHOWDOWN phase for NO_CALL + FOLD_OPEN via the live WriteEntityStream pipeline either', async () => {
      const events = buildHeadsUpAllInEvents([
        {
          UserId: 300,
          HoleCards: [],
          RankType: RankType.NO_CALL,
          Hands: [],
          HandRanking: 1,
          Ranking: 1,
          RewardChip: 2150
        },
        {
          UserId: 301,
          HoleCards: [48, 13],
          RankType: RankType.FOLD_OPEN,
          Hands: [],
          HandRanking: -1,
          Ranking: -1,
          RewardChip: 0
        }
      ])

      // インポート/リビルドパイプラインの結果を先に求め、ライブパイプラインが
      // 書き込むべきフェーズ数（このハンドはSHOWDOWNなしのPREFLOPのみ）の基準にする
      const importResult = converter.convertEventsToEntities(events)
      const importPhasesForHand = importResult.phases.filter(p => p.handId === 34567)

      const dbMock = new PokerChaseDB(indexedDB, IDBKeyRange)
      const service = new PokerChaseService({ db: dbMock })
      await service.ready
      for (const event of events) service.handAggregateStream.write(event)
      const livePhases = await pipeEventsAndWaitForReady(
        service,
        async () => {
          await dbMock.open()
          return dbMock.phases.where('handId').equals(34567).toArray()
        },
        result => result.length >= importPhasesForHand.length,
        { description: `dbMock.phases with handId=34567 to have >= ${importPhasesForHand.length} row(s)` }
      )

      expect(livePhases.find(p => p.phase === PhaseType.SHOWDOWN)).toBeUndefined()
    })

    it('creates a SHOWDOWN phase for a real rank vs SHOWDOWN_MUCK (loser mucked, but showdown occurred)', () => {
      // ショーダウンが発生し、敗者がマックした（SHOWDOWN_MUCK）ケース。CLAUDE.mdの定義通り、
      // SHOWDOWN_MUCKはショーダウンとしてカウントする。
      const events = buildHeadsUpAllInEvents([
        {
          UserId: 300,
          HoleCards: [37, 51],
          RankType: RankType.ONE_PAIR,
          Hands: [1, 21, 44, 37, 51],
          HandRanking: 1,
          Ranking: 1,
          RewardChip: 2150
        },
        {
          UserId: 301,
          HoleCards: [],
          RankType: RankType.SHOWDOWN_MUCK,
          Hands: [],
          HandRanking: -1,
          Ranking: -1,
          RewardChip: 0
        }
      ])

      const importResult = converter.convertEventsToEntities(events)
      const showdownPhase = importResult.phases.find(p => p.phase === PhaseType.SHOWDOWN)
      expect(showdownPhase).toBeDefined()
      expect(showdownPhase!.seatUserIds).toEqual([300, 301])
    })

    it('does NOT create a SHOWDOWN phase for a real rank vs NO_CALL (only one player actually revealed)', () => {
      // RankType 0-9とNO_CALLの組み合わせは実データ上は稀だが、NO_CALLは常に「比較していない」
      // ことを意味するため、もう片方が実役でもショーダウン参加者は1名のみとなり、
      // SHOWDOWNフェーズは生成されないべき。
      const events = buildHeadsUpAllInEvents([
        {
          UserId: 300,
          HoleCards: [37, 51],
          RankType: RankType.HIGH_CARD,
          Hands: [1, 21, 44, 37, 51],
          HandRanking: 1,
          Ranking: 1,
          RewardChip: 2150
        },
        {
          UserId: 301,
          HoleCards: [],
          RankType: RankType.NO_CALL,
          Hands: [],
          HandRanking: -1,
          Ranking: -1,
          RewardChip: 0
        }
      ])

      const importResult = converter.convertEventsToEntities(events)
      expect(importResult.phases.find(p => p.phase === PhaseType.SHOWDOWN)).toBeUndefined()
    })
  })
})
