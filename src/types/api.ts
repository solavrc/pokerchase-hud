import * as z from 'zod'
import { ActionType, BattleType, BetStatusType, PhaseType, RankType } from './game'

export enum ApiType {
  /**
   * 参加申込:
   * - SitAndGo(ランク戦): { "ApiTypeId": 201, "Code": 0, "BattleType": 0, "Id": "new_stage007_010" }
   * - MTT: { "ApiTypeId": 201, "Code": 0, "BattleType": 1, "Id": "3164" }
   * - Ring: { "ApiTypeId": 201, "Code": 0, "BattleType": 4, "Id": "10_20_0001" }
   * - PrivateTable: { "ApiTypeId": 201, "Code": 0, "BattleType": 5, "Id": "" }
   * - ClubMatch: { "ApiTypeId": 201, "Code": 0, "BattleType": 6, "Id": "club_match_xxx" }
   */
  EVT_ENTRY_QUEUED = 201,
  /** プレイヤー途中参加: { "ApiTypeId": 301, "JoinUser": { "UserId": 240573596, "UserName": "リネット", "FavoriteCharaId": "chara0035", "CostumeId": "costume00351", "EmblemId": "emblem0001", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0009", "ta_deco0006", "nj3_t_deco0003", "b_deco0001", "f_deco0001", "eal_deco0003", "esw_deco0001"] }, "JoinPlayer": { "SeatIndex": 3, "Status": 0, "BetStatus": 0, "Chip": 2000, "BetChip": 0 } } */
  EVT_PLAYER_JOIN = 301,
  /** プリフロップ: { "ApiTypeId": 303, "SeatUserIds": [583654032, 619317634, 561384657, 575402650, 750532695, 172432670], "Game": { "CurrentBlindLv": 1, "NextBlindUnixSeconds": 1712648642, "Ante": 50, "SmallBlind": 100, "BigBlind": 200, "ButtonSeat": 5, "SmallBlindSeat": 0, "BigBlindSeat": 1 }, "Player": { "SeatIndex": 2, "BetStatus": 1, "HoleCards": [37, 51], "Chip": 19950, "BetChip": 0 }, "OtherPlayers": [{ "SeatIndex": 0, "Status": 0, "BetStatus": 1, "Chip": 19850, "BetChip": 100 }, { "SeatIndex": 1, "Status": 0, "BetStatus": 1, "Chip": 19750, "BetChip": 200 }, { "SeatIndex": 3, "Status": 0, "BetStatus": 1, "Chip": 19950, "BetChip": 0 }, { "SeatIndex": 4, "Status": 0, "BetStatus": 1, "Chip": 19950, "BetChip": 0 }, { "SeatIndex": 5, "Status": 0, "BetStatus": 1, "Chip": 19950, "BetChip": 0 }], "Progress": { "Phase": 0, "NextActionSeat": 2, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 1, "MinRaise": 400, "Pot": 600, "SidePot": [] } } */
  EVT_DEAL = 303,
  /** アクション: { "ApiTypeId": 304, "SeatIndex": 2, "ActionType": 4, "Chip": 19350, "BetChip": 600, "Progress": { "Phase": 0, "NextActionSeat": 3, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 1, "MinRaise": 1000, "Pot": 1200, "SidePot": [] } } */
  EVT_ACTION = 304,
  /** フロップ・ターン・リバー: { "ApiTypeId": 305, "CommunityCards": [1, 21, 44], "Player": { "SeatIndex": 2, "BetStatus": 2, "HoleCards": [35, 3], "Chip": 42550, "BetChip": 0 }, "OtherPlayers": [{ "SeatIndex": 0, "Status": 0, "BetStatus": 2, "Chip": 19800, "BetChip": 0 }, { "SeatIndex": 3, "Status": 0, "BetStatus": 1, "Chip": 19300, "BetChip": 0 }, { "SeatIndex": 4, "Status": 0, "BetStatus": 2, "Chip": 19900, "BetChip": 0 }, { "SeatIndex": 5, "Status": 0, "BetStatus": 1, "Chip": 16900, "BetChip": 0 }], "Progress": { "Phase": 1, "NextActionSeat": 3, "NextActionTypes": [0, 5, 1], "NextExtraLimitSeconds": 3, "MinRaise": 0, "Pot": 1550, "SidePot": [] } } */
  EVT_DEAL_ROUND = 305,
  /** ハンド結果: { "ApiTypeId": 306, "CommunityCards": [29, 22, 7, 32, 39], "Pot": 42700, "SidePot": [], "ResultType": 0, "DefeatStatus": 0, "HandId": 175859516, "Results": [{ "UserId": 561384657, "HoleCards": [37, 51], "RankType": 8, "Hands": [39, 37, 51, 32, 29], "HandRanking": 1, "Ranking": -2, "RewardChip": 42700 }, { "UserId": 619317634, "HoleCards": [1, 0], "RankType": 8, "Hands": [1, 0, 39, 32, 29], "HandRanking": -1, "Ranking": 6, "RewardChip": 0 }], "Player": { "SeatIndex": 2, "BetStatus": -1, "Chip": 42700, "BetChip": 0 }, "OtherPlayers": [{ "SeatIndex": 0, "Status": 0, "BetStatus": -1, "Chip": 19850, "BetChip": 0 }, { "SeatIndex": 1, "Status": 5, "BetStatus": -1, "Chip": 0, "BetChip": 0 }, { "SeatIndex": 3, "Status": 0, "BetStatus": -1, "Chip": 19950, "BetChip": 0 }, { "SeatIndex": 4, "Status": 0, "BetStatus": -1, "Chip": 19950, "BetChip": 0 }, { "SeatIndex": 5, "Status": 0, "BetStatus": -1, "Chip": 17550, "BetChip": 0 }] } */
  EVT_HAND_RESULTS = 306,
  /** イベント概要: { "ApiTypeId": 308, "CoinNum": -1, "Items": [{ "ItemId": "season10_point", "Num": 9 }], "Name": "シーズンマッチ", "Name2": "6人対戦【シーズン10】", "DefaultChip": 20000, "LimitSeconds": 8, "IsReplay": true, "BlindStructures": [{ "Lv": 1, "ActiveMinutes": 4, "BigBlind": 200, "Ante": 50 }, { "Lv": 2, "ActiveMinutes": 4, "BigBlind": 280, "Ante": 70 }, { "Lv": 3, "ActiveMinutes": 4, "BigBlind": 400, "Ante": 100 }, { "Lv": 4, "ActiveMinutes": 4, "BigBlind": 560, "Ante": 140 }, { "Lv": 5, "ActiveMinutes": 4, "BigBlind": 780, "Ante": 200 }, { "Lv": 6, "ActiveMinutes": 4, "BigBlind": 1100, "Ante": 280 }, { "Lv": 7, "ActiveMinutes": 4, "BigBlind": 1640, "Ante": 410 }, { "Lv": 8, "ActiveMinutes": 4, "BigBlind": 2500, "Ante": 630 }, { "Lv": 9, "ActiveMinutes": 4, "BigBlind": 3800, "Ante": 950 }, { "Lv": 10, "ActiveMinutes": 4, "BigBlind": 5700, "Ante": 1400 }, { "Lv": 11, "ActiveMinutes": 4, "BigBlind": 8600, "Ante": 2200 }, { "Lv": 12, "ActiveMinutes": 4, "BigBlind": 13000, "Ante": 3200 }, { "Lv": 13, "ActiveMinutes": 4, "BigBlind": 19600, "Ante": 4900 }, { "Lv": 14, "ActiveMinutes": 4, "BigBlind": 29500, "Ante": 7400 }, { "Lv": 15, "ActiveMinutes": 4, "BigBlind": 44300, "Ante": 11000 }, { "Lv": 16, "ActiveMinutes": -1, "BigBlind": 60000, "Ante": 15000 }] }, */
  EVT_SESSION_DETAILS = 308,
  /** イベント結果: { "ApiTypeId": 309, "Ranking": 3, "IsLeave": false, "IsRebuy": false, "TotalMatch": 285, "RankReward": { "IsSeasonal": true, "RankPoint": 11, "RankPointDiff": 2, "Rank": { "RankId": "diamond", "RankName": "ダイヤモンド", "RankLvId": "diamond", "RankLvName": "ダイヤモンド" }, "SeasonalRanking": 1458 }, "Rewards": [{ "Category": 8, "TargetId": "", "Num": 70 }, { "Category": 3, "TargetId": "item0002", "Num": 450 }, { "Category": 3, "TargetId": "item0028", "Num": 2 }], "EventRewards": [], "Charas": [{ "CharaId": "chara0010", "CostumeId": "costume00101", "Favorite": 29605, "Rank": 3, "TodayUpNum": 0, "Evolution": false, "Stamps": [{ "StampId": "stamp1001", "IsRelease": true }, { "StampId": "stamp1002", "IsRelease": true }, { "StampId": "stamp1003", "IsRelease": true }, { "StampId": "stamp1004", "IsRelease": true }, { "StampId": "stamp1005", "IsRelease": true }, { "StampId": "stamp1006", "IsRelease": true }, { "StampId": "stamp1007", "IsRelease": true }, { "StampId": "stamp1008", "IsRelease": false }, { "StampId": "stamp1009", "IsRelease": false }, { "StampId": "stamp1010", "IsRelease": false }, { "StampId": "stamp1011", "IsRelease": false }, { "StampId": "stamp1012", "IsRelease": false }] }], "Costumes": [], "Decos": [], "Items": [{ "ItemId": "item0002", "Num": 28900 }, { "ItemId": "item0028", "Num": 452 }, { "ItemId": "season10_point", "Num": 11 }], "Money": { "FreeMoney": -1, "PaidMoney": -1 }, "Emblems": [] } */
  EVT_SESSION_RESULTS = 309,
  /** プレイヤー着席: { "ApiTypeId": 313, "ProcessType": 0, "TableUsers": [{ "UserId": 583654032, "UserName": "シュレディンガー", "FavoriteCharaId": "nj_chara0002", "CostumeId": "nj_costume00022", "EmblemId": "emblem0003", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0001", "fn_ta_deco0007", "fn_t_deco0005", "b_deco0001", "f_deco0001", "eal_deco0002", "esw_deco0007"] }, { "UserId": 561384657, "UserName": "sola", "FavoriteCharaId": "chara0010", "CostumeId": "costume00101", "EmblemId": "emblem0001", "Rank": { "RankId": "diamond", "RankName": "ダイヤモンド", "RankLvId": "diamond", "RankLvName": "ダイヤモンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0001", "ta_deco0001", "t_deco0009", "b_deco0001", "f_deco0001", "eal_deco0001", "esw_deco0001"] }, { "UserId": 750532695, "UserName": "ちいまう", "FavoriteCharaId": "chara0022", "CostumeId": "costume00221", "EmblemId": "emblem0001", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0014", "ta_deco0001", "t_deco0012", "b_deco0001", "f_deco0001", "eal_deco0001", "esw_deco0006"] }, { "UserId": 172432670, "UserName": "ラロムジ", "FavoriteCharaId": "chara0001", "CostumeId": "costume00012", "EmblemId": "emblem0001", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0001", "ta_deco0001", "t_deco0001", "b_deco0001", "f_deco0001", "eal_deco0001", "esw_deco0001"] }, { "UserId": 575402650, "UserName": "夜菊0721", "FavoriteCharaId": "chara0021", "CostumeId": "costume00212", "EmblemId": "emblem0001", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0069", "ta_deco0055", "t_deco0069", "bg_deco0006", "f_deco0001", "eal_deco0007", "esw_deco0001"] }, { "UserId": 619317634, "UserName": "ぽちこん", "FavoriteCharaId": "chara0009", "CostumeId": "costume00092", "EmblemId": "emblem0001", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0062", "ta_deco0018", "t_deco0058", "b_deco0001", "f_deco0001", "eal_deco0002", "esw_deco0001"] }], "SeatUserIds": [583654032, 619317634, 561384657, 575402650, 750532695, 172432670] } */
  EVT_PLAYER_SEAT_ASSIGNED = 313,
}

/**
 * APIイベントスキーマの制約事項:
 * - 外部制御: スキーマはPokerChase APIにより提供され、開発者の制御外
 * - スキーマ変更: 予告なく部分的に変更される可能性があり、防御的コーディングが必要
 * - イベント順序: 論理的な順序が保証されている
 * - 接続問題: プレイヤー側のネットワーク問題によりイベントが失われる可能性がある
 */
const baseSchema = z.object({
  timestamp: z.int().optional().describe('イベント発生時刻 (Unix Milliseconds) WebSocketイベント受信時にローカルで付与')
}).strict().describe('基底スキーマ。strict: 未定義プロパティを検知')

const schema = {
  [ApiType.EVT_ENTRY_QUEUED]: baseSchema.extend({
    ApiTypeId: z.literal(201),
    BattleType: z.enum(BattleType),
    Code: z.literal(0),
    Id: z.string().describe('例: new_stage007_010 (一意にセッションを特定するものではない) → SessionIdとBattleTypeの抽出に使用'),
    IsRetire: z.boolean(),
  }).describe('参加申込 - セッション開始時に受信。SessionIdとBattleTypeを抽出'),

  [202]: baseSchema.extend({
    ApiTypeId: z.literal(202),
    Code: z.literal(0),
  }).describe('アクション完了'),

  [203]: baseSchema.extend({
    ApiTypeId: z.literal(203),
    Code: z.literal(0),
  }).describe('参加取消申込'),

  [204]: baseSchema.extend({
    ApiTypeId: z.literal(204),
    Code: z.literal(0),
  }).describe('ハンド開始'),

  [205]: baseSchema.extend({
    ApiTypeId: z.literal(205),
    Code: z.literal(0),
    RestExtraLimitSeconds: z.int().nonnegative(),
    RestLimitSeconds: z.int().nonnegative(),
  }).describe('タイムバンク'),

  [206]: baseSchema.extend({
    ApiTypeId: z.literal(206),
    Code: z.literal(0),
  }).describe('スタンプ送信'),

  [210]: baseSchema.extend({
    ApiTypeId: z.literal(210),
    Code: z.literal(0),
    HoleCardIndex: z.union([z.literal(0), z.literal(1)]),
    IsFoldOpen: z.boolean(),
  }).describe('マックハンド公開'),

  [212]: baseSchema.extend({
    ApiTypeId: z.literal(212),
    Code: z.literal(0),
  }).describe('退室完了'),

  [213]: baseSchema.extend({
    ApiTypeId: z.literal(213),
    Code: z.int().nonnegative(),
    IsCancel: z.boolean(),
    Error: z.object({
      AddParam: z.string(),
      Message: z.string().describe('例: ネットワークエラーが発生しました'),
      Status: z.int().nonnegative(),
    }).optional(),
  }).describe('参加取消申込結果'),

  [214]: baseSchema.extend({
    ApiTypeId: z.literal(214),
    AddonNum: z.int().nonnegative(),
    Chip: z.int().nonnegative(),
    Code: z.int().nonnegative(),
    Items: z.array(z.object({
      ItemId: z.string().describe('例: medal_0001'),
      Num: z.int().nonnegative(),
    })),
    Error: z.object({
      AddParam: z.string(),
      Message: z.string().describe('例: アドオンに失敗しました'),
      Status: z.int().nonnegative(),
    }).optional(),
    Status: z.int().nonnegative().optional(),
  }).describe('アドオン完了'),

  [215]: baseSchema.extend({
    ApiTypeId: z.literal(215),
    AddonStatus: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    Code: z.literal(0),
  }).describe('アドオン可能'),

  [220]: baseSchema.extend({
    ApiTypeId: z.literal(220),
    Code: z.literal(0),
  }),

  [221]: baseSchema.extend({
    ApiTypeId: z.literal(221),
    Code: z.literal(0),
  }),

  [224]: baseSchema.extend({
    ApiTypeId: z.literal(224),
    Code: z.literal(0),
    Status: z.literal(0),
  }),

  [ApiType.EVT_PLAYER_JOIN]: baseSchema.extend({
    ApiTypeId: z.literal(ApiType.EVT_PLAYER_JOIN),
    JoinPlayer: z.object({
      BetChip: z.int().nonnegative(),
      BetStatus: z.enum(BetStatusType),
      Chip: z.int().nonnegative(),
      SeatIndex: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
      Status: z.literal(0),
      IsSafeLeave: z.boolean().optional(),
    }),
    JoinUser: z.object({
      CostumeId: z.string(),
      EmblemId: z.string(),
      FavoriteCharaId: z.string(),
      IsCpu: z.boolean(),
      IsOfficial: z.boolean(),
      Rank: z.object({
        RankId: z.string(),
        RankLvId: z.string(),
        RankLvName: z.string(),
        RankName: z.string(),
      }),
      SettingDecoIds: z.array(z.string()).length(7),
      UserId: z.int().nonnegative(),
      UserName: z.string(),
      ClassLvId: z.string().optional(),
    }),
  }).describe('プレイヤー途中参加 - ゲーム中の新規参加時にプレイヤー名を提供'),

  [ApiType.EVT_DEAL]: baseSchema.extend({
    ApiTypeId: z.literal(ApiType.EVT_DEAL),
    Game: z.object({
      Ante: z.int().nonnegative(),
      BigBlind: z.int().nonnegative(),
      BigBlindSeat: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
      ButtonSeat: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
      CurrentBlindLv: z.int().min(1).describe('リングゲーム: 常に1'),
      NextBlindUnixSeconds: z.int(),
      SmallBlind: z.int().nonnegative(),
      SmallBlindSeat: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    }),
    OtherPlayers: z.array(z.object({
      BetChip: z.int().nonnegative(),
      BetStatus: z.union([z.enum(BetStatusType)]),
      Chip: z.int().nonnegative(),
      SeatIndex: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
      Status: z.union([z.literal(0), z.literal(1), z.literal(5)]).describe('要調査: 1,5 は 1%未満の割合で出現'),
      IsSafeLeave: z.boolean().optional(),
    })).min(1).max(6),
    Player: z.object({
      BetChip: z.int().nonnegative(),
      BetStatus: z.enum(BetStatusType),
      Chip: z.int().nonnegative(),
      HoleCards: z.array(z.int().min(0).max(51)).max(2).describe('カードインデックス (0: 2s, 51: Ac)'),
      SeatIndex: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).describe('ヒーロー識別用: UserId = SeatUserIds[Player.SeatIndex]'),
    }).optional().describe('観戦時存在しない - Playerフィールドがない場合は観戦モード'),
    Progress: z.object({
      MinRaise: z.int().nonnegative(),
      NextActionSeat: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
      NextActionTypes: z.array(z.enum(ActionType)).min(1).max(4),
      NextExtraLimitSeconds: z.int().nonnegative(),
      Phase: z.literal(PhaseType.PREFLOP),
      Pot: z.int().nonnegative(),
      SidePot: z.array(z.int()).max(4),
    }),
    SeatUserIds: z.array(z.int()).min(4).max(6).describe('-1=空席, 配列長=テーブル席数(4 or 6), インデックス=論理シート番号, 値=UserId'),
    MyRanking: z.object({
      ActiveNum: z.int().nonnegative(),
      AverageChip: z.int().nonnegative(),
      JoinNum: z.int().nonnegative(),
      Ranking: z.int().nonnegative(),
    }).optional().describe('トーナメント時のみ'),
  }).describe('プリフロップ - ハンド開始。ヒーロー識別に必須: Player.SeatIndexからUserIdを取得'),

  [ApiType.EVT_ACTION]: baseSchema.extend({
    ApiTypeId: z.literal(ApiType.EVT_ACTION),
    ActionType: z.enum(ActionType),
    BetChip: z.int().nonnegative(),
    Chip: z.int().nonnegative(),
    Progress: z.object({
      MinRaise: z.int().nonnegative(),
      NextActionSeat: z.union([z.literal(-2), z.literal(-1), z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).describe('-2:ハンド終了, -1:ストリート完了→次のカード配布'),
      NextActionTypes: z.array(z.enum(ActionType)).max(4),
      NextExtraLimitSeconds: z.int().nonnegative(),
      Phase: z.enum(PhaseType),
      Pot: z.int().nonnegative(),
      SidePot: z.array(z.int().nonnegative()).max(4),
    }),
    SeatIndex: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  }).describe('アクション'),

  [ApiType.EVT_DEAL_ROUND]: baseSchema.extend({
    ApiTypeId: z.literal(ApiType.EVT_DEAL_ROUND),
    CommunityCards: z.array(z.int().min(0).max(51)).min(1).max(3).describe('フロップ:3枚, ターン/リバー:1枚'),
    OtherPlayers: z.array(z.object({
      BetChip: z.literal(0).describe('新ストリートでリセット'),
      BetStatus: z.enum(BetStatusType),
      Chip: z.int().nonnegative(),
      SeatIndex: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
      Status: z.union([z.literal(0), z.literal(1)]).describe('要調査: 1 は 1%未満の割合で出現'),
      IsSafeLeave: z.boolean().optional(),
    })).min(1).max(6),
    Player: z.object({
      BetChip: z.literal(0).describe('新ストリートでリセット'),
      BetStatus: z.enum(BetStatusType),
      Chip: z.int().nonnegative(),
      HoleCards: z.array(z.int().min(0).max(51)).max(2),
      SeatIndex: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    }).optional().describe('観戦時存在しない'),
    Progress: z.object({
      MinRaise: z.literal(0).describe('新ストリートでリセット'),
      NextActionSeat: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
      NextActionTypes: z.array(z.enum(ActionType)).min(2).max(3),
      NextExtraLimitSeconds: z.int().nonnegative(),
      Phase: z.union([
        z.literal(PhaseType.FLOP),
        z.literal(PhaseType.TURN),
        z.literal(PhaseType.RIVER)
      ]).describe('1:フロップ, 2:ターン, 3:リバー'),
      Pot: z.int().nonnegative(),
      SidePot: z.array(z.int().nonnegative()).max(4),
    }),
  }).describe('フロップ・ターン・リバー'),

  [ApiType.EVT_HAND_RESULTS]: baseSchema.extend({
    ApiTypeId: z.literal(ApiType.EVT_HAND_RESULTS),
    CommunityCards: z.array(z.int().min(0).max(51)).max(5),
    DefeatStatus: z.union([z.literal(0), z.literal(1)]).describe('1: ELIMINATED'),
    HandId: z.int().nonnegative().describe('ハンド完了時にのみ利用可能 - 統計計算とハンドログ生成のトリガー'),
    HandLog: z.string().optional().describe('要調査'),
    OtherPlayers: z.array(z.object({
      BetChip: z.literal(0),
      BetStatus: z.literal(-1),
      Chip: z.int().nonnegative(),
      SeatIndex: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
      Status: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7)]).describe('5: ELIMINATED, 6: NO_CALL?, 7: 要調査'),
      IsSafeLeave: z.boolean().optional(),
    })).min(1).max(5),
    Player: z.object({
      BetChip: z.literal(0),
      BetStatus: z.enum(BetStatusType),
      Chip: z.int().nonnegative(),
      SeatIndex: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    }).optional(),
    Pot: z.int().nonnegative(),
    Results: z.array(z.object({
      HandRanking: z.union([z.literal(-1), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]).describe('ポット獲得可能な同一の役を複数人が持っていた場合の序列'),
      Hands: z.array(z.int().min(0).max(51)).min(0).max(5).describe('役判定5枚'),
      HoleCards: z.array(z.int().min(-1).max(51)).min(0).max(2).describe('ホールカード'),
      Ranking: z.union([z.literal(-2), z.literal(-1), z.int().nonnegative()]).describe('-2:In-Play, -1:Multiway敗退, 正の数:敗退順位'),
      RankType: z.enum(RankType).describe('成立役 または 10:NO_CALL, 11:SHOWDOWN_MUCK, 12:FOLD_OPEN'),
      RewardChip: z.int().nonnegative(),
      UserId: z.int().nonnegative(),
    })).min(1).max(5),
    ResultType: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).describe('ハンド終了後 2: テーブル移動, 3: 休憩開始, 4: テーブル離脱 または 対戦相手不在'),
    SidePot: z.array(z.int().nonnegative()).max(4),
  }).describe('ハンド結果'),

  [307]: baseSchema.extend({
    ApiTypeId: z.literal(307),
  }).describe('イベント開始'),

  [ApiType.EVT_SESSION_DETAILS]: baseSchema.extend({
    ApiTypeId: z.literal(ApiType.EVT_SESSION_DETAILS),
    BlindStructures: z.array(z.object({
      ActiveMinutes: z.int(),
      Ante: z.int().nonnegative(),
      BigBlind: z.int().nonnegative(),
      Lv: z.int().nonnegative(),
    })).min(1).describe('トーナメント時のみ'),
    CoinNum: z.int(),
    DefaultChip: z.int(),
    IsReplay: z.boolean(),
    Items: z.array(z.object({
      ItemId: z.string(),
      Num: z.int().nonnegative(),
      ExpireAt: z.int().nonnegative().optional(),
    })).max(1),
    LimitSeconds: z.int().nonnegative(),
    MoneyList: z.array(z.object({
      FreeMoney: z.int().nonnegative(),
      PaidMoney: z.int().nonnegative(),
    })).max(1),
    Name: z.string(),
    Name2: z.string(),
    RankingRewards: z.array(z.object({
      HighRanking: z.int().nonnegative(),
      LowRanking: z.int().nonnegative(),
      Rewards: z.array(z.object({
        Category: z.int().nonnegative(),
        TargetId: z.string(),
        Num: z.int().nonnegative(),
        BuffNum: z.int().nonnegative(),
      })).min(1),
    })).optional(),
    RingRule: z.object({
      MaxBuyin: z.int().nonnegative().optional(),
      MinBuyin: z.int().nonnegative().optional(),
    }).optional(),
    TournamentRule: z.object({
      NextBreakUnixSeconds: z.int().optional(),
      RebuyChip: z.int().nonnegative().optional(),
      RebuyCostCoinNum: z.int().nonnegative().optional(),
      RebuyCostTicket: z.object({
        ItemId: z.string().optional(),
        Num: z.int().nonnegative().optional(),
      }).optional(),
      RebuyFinishUnixSeconds: z.int().optional(),
      RebuyLimit: z.int().nonnegative().optional(),
    }).optional(),
  }).describe('イベント概要 - セッション名とゲーム設定を提供。セッション=完全なゲームインスタンス(トーナメント、リングゲーム等)'),

  [ApiType.EVT_SESSION_RESULTS]: baseSchema.extend({
    ApiTypeId: z.literal(ApiType.EVT_SESSION_RESULTS),
    Charas: z.array(z.object({
      Bond: z.int(),
      CharaId: z.string(),
      CostumeId: z.string(),
      Evolution: z.boolean(),
      Favorite: z.int(),
      Rank: z.int().nonnegative(),
      Stamps: z.array(z.record(z.string(), z.unknown())).length(12),
      TodayUpNum: z.int().nonnegative(),
    })).max(1),
    Costumes: z.array(z.unknown()),
    Decos: z.array(z.object({
      DecoId: z.string(),
      IsSetting: z.boolean(),
    })).max(3),
    Emblems: z.array(z.unknown()),
    EventRewards: z.array(z.unknown()),
    IsLeave: z.boolean(),
    IsRebuy: z.boolean(),
    Items: z.array(z.object({
      ItemId: z.string(),
      Num: z.int().nonnegative(),
    })).max(4),
    Money: z.object({
      FreeMoney: z.int(),
      PaidMoney: z.int(),
    }),
    Ranking: z.int(),
    Rewards: z.array(z.object({
      BuffNum: z.int().nonnegative(),
      Category: z.int().nonnegative(),
      Num: z.int().nonnegative(),
      TargetId: z.string(),
    })).max(5),
    TotalMatch: z.int().nonnegative(),
    BattleFinishTime: z.int().nonnegative().optional(),
    IsCountOverRingMedal: z.boolean().optional(),
    IsSeasonOver: z.boolean().optional(),
    PopupMessageTextKey: z.string().optional(),
    PopupTitleTextKey: z.string().optional(),
    RankReward: z.object({
      IsSeasonal: z.boolean(),
      Rank: z.object({
        RankId: z.string(),
        RankLvId: z.string(),
        RankLvName: z.string(),
        RankName: z.string(),
      }),
      RankPoint: z.int().nonnegative(),
      RankPointDiff: z.int(),
      SeasonalRanking: z.literal(0),
    }).optional(),
    ResultChip: z.int().nonnegative().optional(),
    RingReward: z.object({
      Class: z.record(z.string(), z.string()).optional(),
      ClassPoint: z.int().nonnegative().optional(),
      ClassPointBreakdownList: z.array(z.object({
        Point: z.int(),
        Type: z.union([z.literal(0), z.literal(1)]),
      })).max(2).optional(),
      ClassPointDiff: z.int().optional(),
      IsNotPlay: z.boolean().optional(),
      Ranking: z.int().nonnegative().optional(),
      ResultNum: z.int().optional(),
      Score: z.int().optional(),
      SeasonalKey: z.string().regex(/^\d+$/).optional(),
    }).optional(),
    TargetBlindLv: z.int().nonnegative().optional(),
    TournamentReward: z.object({
      JoinNum: z.int().optional(),
    }).optional(),
  }).describe('イベント結果'),

  [310]: baseSchema.extend({
    ApiTypeId: z.literal(310),
    SeatIndex: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    StampId: z.string(),
  }).describe('スタンプ受信'),

  [311]: baseSchema.extend({
    ApiTypeId: z.literal(311),
    NotifyCode: z.union([z.literal(1), z.literal(2), z.literal(202)]),
  }).describe('ハンド終了'),

  [312]: baseSchema.extend({
    ApiTypeId: z.literal(312),
    Code: z.int().nonnegative(),
    Error: z.object({
      AddParam: z.string(),
      Message: z.string().describe('例: 再読み込みのためにタイトルに戻ります | text_sync_error_message_code_8103'),
      Status: z.int().nonnegative(),
      Replaces: z.array(z.unknown()).optional(),
    }),
  }),

  [ApiType.EVT_PLAYER_SEAT_ASSIGNED]: baseSchema.extend({
    ApiTypeId: z.literal(ApiType.EVT_PLAYER_SEAT_ASSIGNED),
    IsLeave: z.boolean(),
    IsRetire: z.boolean(),
    ProcessType: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).describe('0:初期着席, 他:要調査'),
    SeatUserIds: z.array(z.int()).min(4).max(6).describe('-1=空席, 順番はランダムに割り当て'),
    TableUsers: z.array(z.object({
      CostumeId: z.string(),
      EmblemId: z.string(),
      FavoriteCharaId: z.string(),
      IsCpu: z.boolean(),
      IsOfficial: z.boolean(),
      Rank: z.object({
        RankId: z.string().describe('legend, diamond等'),
        RankLvId: z.string(),
        RankLvName: z.string(),
        RankName: z.string(),
      }),
      SettingDecoIds: z.array(z.string()).length(7),
      UserId: z.int().nonnegative(),
      UserName: z.string().describe('プレイヤー名 - 初期着席時に取得可能'),
      ClassLvId: z.string().optional(),
    })).min(1).max(6),
    BreakFinishUnixSeconds: z.int().nonnegative().optional(),
    CommunityCards: z.array(z.int()).max(5).optional().describe('途中参加時'),
    Game: z.object({
      Ante: z.int().nonnegative().optional(),
      BigBlind: z.int().nonnegative().optional(),
      BigBlindSeat: z.union([z.literal(-1), z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional().describe('-1:要調査'),
      ButtonSeat: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
      CurrentBlindLv: z.int().min(1).max(27).optional(),
      NextBlindUnixSeconds: z.union([z.int(), z.null()]).optional(),
      SmallBlind: z.int().nonnegative().optional(),
      SmallBlindSeat: z.union([z.literal(-1), z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional().describe('-1:要調査'),
    }).optional().describe('途中参加時'),
    IsSafeLeave: z.boolean().optional(),
    OtherPlayers: z.array(z.object({
      BetChip: z.int().nonnegative(),
      BetStatus: z.enum(BetStatusType),
      Chip: z.int().nonnegative(),
      SeatIndex: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
      Status: z.union([z.literal(0), z.literal(1)]),
      IsSafeLeave: z.boolean().optional(),
    })).max(5).optional().describe('途中参加時'),
    Player: z.object({
      BetChip: z.int().nonnegative().optional(),
      BetStatus: z.enum(BetStatusType).optional(),
      Chip: z.int().nonnegative().optional(),
      HoleCards: z.array(z.int()).max(2).optional(),
      SeatIndex: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
    }).optional().describe('途中参加時'),
    Progress: z.object({
      MinRaise: z.int().nonnegative().optional(),
      NextActionSeat: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
      NextActionTypes: z.array(z.enum(ActionType)).min(2).max(4).optional(),
      NextExtraLimitSeconds: z.int().nonnegative().optional(),
      Phase: z.enum(PhaseType).optional(),
      Pot: z.int().nonnegative().optional(),
      SidePot: z.array(z.int()).max(4).optional(),
    }).optional().describe('途中参加時'),
  }).describe('プレイヤー着席 - 初期プレイヤー名とランク情報を提供'),

  [314]: baseSchema.extend({
    ApiTypeId: z.literal(314),
    RankingRewards: z.array(z.object({
      HighRanking: z.int().nonnegative(),
      LowRanking: z.int().nonnegative(),
      Rewards: z.array(z.object({
        Category: z.union([z.literal(0), z.literal(3), z.literal(4)]).describe('0: PCM, 3: チケット, 4: 装飾品'),
        TargetId: z.string().describe('例: item0000'),
        Num: z.int().nonnegative(),
        BuffNum: z.int().nonnegative(),
      })),
    })),
  }).describe('プライズ変動'),

  [315]: baseSchema.extend({
    ApiTypeId: z.literal(315),
    FinishUnixSeconds: z.int().nonnegative().describe('休憩終了時刻 (Unix Seconds)'),
    MyRanking: z.object({
      ActiveNum: z.int().nonnegative(),
      AverageChip: z.int().nonnegative(),
      JoinNum: z.int().nonnegative(),
      Ranking: z.int().nonnegative(),
    }),
  }).describe('トーナメント: 休憩開始'),

  [316]: baseSchema.extend({
    ApiTypeId: z.literal(316),
    NextBreakUnixSeconds: z.int().nonnegative(),
    ProcessType: z.literal(0),
  }).describe('トーナメント: 休憩終了'),

  [317]: baseSchema.extend({
    ApiTypeId: z.literal(317),
    Ante: z.int().nonnegative(),
    BigBlind: z.int().nonnegative(),
    CurrentBlindLv: z.int().nonnegative(),
    NextBlindUnixSeconds: z.int().min(-1).describe('-1: 最終レベル'),
    SmallBlind: z.int().nonnegative(),
    TargetBlindLv: z.int().nonnegative().optional(),
  }).describe('トーナメント: ブラインドレベル上昇'),

  [318]: baseSchema.extend({
    ApiTypeId: z.literal(318),
    UserId: z.int().nonnegative(),
  }).describe('リング: テーブル最後の対戦相手が離脱'),

  [319]: baseSchema.extend({
    ApiTypeId: z.literal(319),
    MatchUserNum: z.int().nonnegative().describe('参加待機人数'),
  }).describe('参加申込結果'),

  [1201]: baseSchema.extend({
    ApiTypeId: z.literal(1201),
    chatType: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    Code: z.literal(0),
    OnlineStatus: z.array(z.int()).max(2),
    OnlineUserIds: z.array(z.int()).max(2),
    PrevMessage: z.array(z.object({
      Id: z.int().nonnegative(),
      Ms: z.string().describe('チャットメッセージ'),
      Ti: z.int().nonnegative().describe('Unix Seconds'),
      Us: z.object({
        Ic: z.object({
          Co: z.string(),
          Fr: z.string(),
        }),
        Id: z.int().nonnegative().describe('ユーザーID'),
        Na: z.string().describe('ユーザー名'),
      }),
      Co: z.string().optional().describe('例: jp'),
    })).max(50),
  }).describe('全体チャット: メッセージ履歴受信'),

  [1202]: baseSchema.extend({
    ApiTypeId: z.literal(1202),
    Code: z.int().nonnegative(),
    Error: z.object({
      AddParam: z.string().optional(),
      Message: z.string().optional().describe('すでに退席しています'),
      Status: z.literal(1).optional(),
    }).optional(),
  }),

  [1203]: baseSchema.extend({
    ApiTypeId: z.literal(1203),
    Code: z.literal(0),
  }).describe('全体チャット: 送信完了'),

  [1204]: baseSchema.extend({
    ApiTypeId: z.literal(1204),
    Code: z.literal(0),
    Messages: z.array(z.unknown()),
  }).describe('全体チャット: 送信失敗'),

  [1301]: baseSchema.extend({
    ApiTypeId: z.literal(1301),
    Message: z.object({
      Id: z.int().nonnegative(),
      Ms: z.string(),
      Ti: z.int().nonnegative(),
      Us: z.object({
        Ic: z.object({
          Co: z.string(),
          Fr: z.string(),
        }),
        Id: z.int().nonnegative(),
        Na: z.string(),
      }),
      Co: z.string().optional(),
    }),
  }).describe('全体チャット: メッセージ受信'),

  [1302]: baseSchema.extend({
    ApiTypeId: z.literal(1302),
    LatestMessageId: z.int().nonnegative(),
  }).describe('全体チャット: 最新メッセージID'),

  [1303]: baseSchema.extend({
    ApiTypeId: z.literal(1303),
    BattleType: z.enum(BattleType),
    Message: z.object({
      Id: z.int().nonnegative(),
      Ms: z.string(),
      Ti: z.int().nonnegative(),
      Us: z.object({
        Ic: z.object({
          Co: z.string(),
          Fr: z.string(),
        }),
        Id: z.int().nonnegative(),
        Na: z.string(),
      }),
      Co: z.string().optional(),
    }),
    RoomId: z.int().nonnegative(),
  }).describe('フレンド戦: 全体チャットで募集'),

  [1304]: baseSchema.extend({
    ApiTypeId: z.literal(1304),
    Status: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    UserId: z.int().nonnegative(),
  }).describe('フレンド: オンラインステータス'),
}

/** ApiEvent検証用schema: 全ApiTypeを含める */
export const ApiEventSchema = z.discriminatedUnion("ApiTypeId", [
  schema[ApiType.EVT_ENTRY_QUEUED],
  schema[202],
  schema[203],
  schema[204],
  schema[205],
  schema[206],
  schema[210],
  schema[212],
  schema[213],
  schema[214],
  schema[215],
  schema[220],
  schema[221],
  schema[224],
  schema[ApiType.EVT_PLAYER_JOIN],
  schema[ApiType.EVT_DEAL],
  schema[ApiType.EVT_ACTION],
  schema[ApiType.EVT_DEAL_ROUND],
  schema[ApiType.EVT_HAND_RESULTS],
  schema[307],
  schema[ApiType.EVT_SESSION_DETAILS],
  schema[ApiType.EVT_SESSION_RESULTS],
  schema[310],
  schema[311],
  schema[312],
  schema[ApiType.EVT_PLAYER_SEAT_ASSIGNED],
  schema[314],
  schema[315],
  schema[316],
  schema[317],
  schema[318],
  schema[319],
  schema[1201],
  schema[1202],
  schema[1203],
  schema[1204],
  schema[1301],
  schema[1302],
  schema[1303],
  schema[1304],
])

/** ApiEvent互換: 必要な型定義のみ含める */
export type ApiEvent<T extends ApiType = ApiType> =
  T extends ApiType.EVT_ENTRY_QUEUED ? z.infer<typeof schema[ApiType.EVT_ENTRY_QUEUED]> :
  T extends ApiType.EVT_PLAYER_JOIN ? z.infer<typeof schema[ApiType.EVT_PLAYER_JOIN]> :
  T extends ApiType.EVT_DEAL ? z.infer<typeof schema[ApiType.EVT_DEAL]> :
  T extends ApiType.EVT_ACTION ? z.infer<typeof schema[ApiType.EVT_ACTION]> :
  T extends ApiType.EVT_DEAL_ROUND ? z.infer<typeof schema[ApiType.EVT_DEAL_ROUND]> :
  T extends ApiType.EVT_HAND_RESULTS ? z.infer<typeof schema[ApiType.EVT_HAND_RESULTS]> :
  T extends ApiType.EVT_SESSION_DETAILS ? z.infer<typeof schema[ApiType.EVT_SESSION_DETAILS]> :
  T extends ApiType.EVT_SESSION_RESULTS ? z.infer<typeof schema[ApiType.EVT_SESSION_RESULTS]> :
  T extends ApiType.EVT_PLAYER_SEAT_ASSIGNED ? z.infer<typeof schema[ApiType.EVT_PLAYER_SEAT_ASSIGNED]> :
  never

export type ApiHandEvent = ApiEvent<ApiType.EVT_DEAL | ApiType.EVT_ACTION | ApiType.EVT_DEAL_ROUND | ApiType.EVT_HAND_RESULTS>
