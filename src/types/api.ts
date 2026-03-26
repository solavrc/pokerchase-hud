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

// ===============================
// Base Schemas
// ===============================

/** WebSocket受信時にweb_accessible_resourceで付与される共通フィールド */
const messageSchema = z.object({
  ApiTypeId: z.number().int(),
  timestamp: z.number().int()
})

/** 各APIイベントの基底スキーマ */
const baseSchema = z.object({
  timestamp: z.number().int().optional().describe('Unix Milliseconds - WebSocket受信時に付与')
}).passthrough().describe('基底スキーマ: 未知プロパティは保持して後続処理に流す')

// ===============================
// Common Sub-Schemas (再利用可能な共通スキーマ)
// ===============================

/** 座席インデックスのスキーマ */
export const seatIndexSchema = z.union([
  z.literal(0), z.literal(1), z.literal(2),
  z.literal(3), z.literal(4), z.literal(5)
])

/** プレイヤー基本情報スキーマ */
export const playerBaseSchema = z.object({
  SeatIndex: seatIndexSchema,
  BetStatus: z.enum(BetStatusType),
  Chip: z.int().nonnegative(),
  BetChip: z.int().nonnegative()
})

/** ゲーム進行状況スキーマ */
export const progressBaseSchema = z.object({
  Phase: z.enum(PhaseType),
  Pot: z.int().nonnegative(),
  SidePot: z.array(z.int().nonnegative()).max(4),
  MinRaise: z.int().nonnegative(),
  NextActionTypes: z.array(z.enum(ActionType)).max(4),
  NextExtraLimitSeconds: z.int().nonnegative()
})

/** ユーザー情報スキーマ */
export const userInfoSchema = z.object({
  UserId: z.int().nonnegative(),
  UserName: z.string().describe('プレイヤー表示名'),
  FavoriteCharaId: z.string().describe('例: chara0001, fn_chara0003, nj_chara0002'),
  CostumeId: z.string().describe('例: costume00011, fn_costume00032'),
  EmblemId: z.string().describe('例: emblem0001, emblem0192, fn_emblem0001'),
  IsCpu: z.boolean(),
  IsOfficial: z.boolean(),
  Rank: z.object({
    RankId: z.string().describe('beginner | bronze | silver | gold | platinum | diamond | legend'),
    RankLvId: z.string().describe('RankIdと同値（現状の観測範囲）'),
    RankLvName: z.string().describe('例: ビギナー, ブロンズ, レジェンド（日本語表示名）'),
    RankName: z.string().describe('例: ビギナー, ブロンズ, レジェンド（RankLvNameと同値）'),
  }),
  SettingDecoIds: z.array(z.string()).length(7).describe('装飾品ID 7つ固定。prefix: k_deco, ta_deco, t_deco, b_deco, f_deco, eal_deco, esw_deco')
})

/** ホールカードスキーマ */
export const holeCardsSchema = z.array(z.int().min(0).max(51)).max(2)

/** コミュニティカードスキーマ */
export const communityCardsSchema = z.array(z.int().min(0).max(51)).max(5)

/**
 * APIイベントの個別Zodスキーマ
 * @description 各イベントタイプのスキーマ定義。再利用・拡張・テスト用途に公開
 */
export const apiEventSchemas = {
  [ApiType.EVT_ENTRY_QUEUED]: baseSchema.extend({
    ApiTypeId: z.literal(ApiType.EVT_ENTRY_QUEUED),
    BattleType: z.enum(BattleType),
    Code: z.literal(0),
    Id: z.string().describe(`ゲームタイプ別のセッション識別子:
      - SNG (BattleType=0): "stage006_002" 等。ルーム種別を表し、セッション一意ではない。セッション識別には最初の HandId を使用。
      - MTT (BattleType=1): "6078" 等（数値文字列）。トーナメントIDで同一トーナメント内のプレイヤーに共通。テーブル移動ごとに EVT_ENTRY_QUEUED が再発行されるため、1トーナメントで複数回出現する。
      - FRIEND_SIT_AND_GO (BattleType=2): "357589" 等（数値文字列）。フレンドマッチ固有ID。観測範囲では一意。
      - RING_GAME (BattleType=4): "50_100_0002" 等。ルーム種別（ステークス）を表し、セッション一意ではない。
      - FRIEND_RING_GAME (BattleType=5): 空文字列。
      - CLUB_MATCH (BattleType=6): "club_bt_2501_1_1" 等。クラブマッチ固有ID。`),
    IsRetire: z.boolean().describe('リタイア（途中退出）フラグ'),
  }).describe('参加申込 - テーブル着席時に発行。SNG/Ringでは1セッション1回。MTTではテーブル移動ごとに再発行。BattleTypeとIdを抽出してセッション管理に使用'),

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
      BetChip: z.int().nonnegative().describe('現在のベット額。参加直後は0'),
      BetStatus: z.enum(BetStatusType).describe('ベット状態。参加直後は通常0(NOT_IN_PLAY)'),
      Chip: z.int().nonnegative().describe('保有チップ量'),
      SeatIndex: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).describe('着席した席インデックス。現状HUDでは未使用だが、次のEVT_DEALを待たずに席マッピングを知る手段として有用'),
      Status: z.literal(0).describe('プレイヤー状態。参加時は常に0'),
      IsSafeLeave: z.boolean().optional().describe('安全退出フラグ（Ringゲーム）'),
    }).describe('参加プレイヤーのゲーム状態'),
    JoinUser: z.object({
      CostumeId: z.string().describe('例: costume00351'),
      EmblemId: z.string().describe('例: emblem0001'),
      FavoriteCharaId: z.string().describe('例: chara0035'),
      IsCpu: z.boolean().describe('CPUプレイヤーかどうか'),
      IsOfficial: z.boolean().describe('公式アカウントかどうか'),
      Rank: z.object({
        RankId: z.string().describe('beginner | bronze | silver | gold | platinum | diamond | legend'),
        RankLvId: z.string().describe('RankIdと同値（現状の観測範囲）'),
        RankLvName: z.string().describe('日本語表示名（例: レジェンド）'),
        RankName: z.string().describe('日本語表示名（RankLvNameと同値）'),
      }).describe('ランク情報。RankIdをsession.playersマッピングに保存'),
      SettingDecoIds: z.array(z.string()).length(7).describe('装飾品ID 7つ固定'),
      UserId: z.int().nonnegative().describe('プレイヤーID。session.players Mapのキーとして使用'),
      UserName: z.string().describe('プレイヤー表示名。session.players Mapの値として保存'),
      ClassLvId: z.string().optional().describe('リングゲームクラス。例: class_lv_j1, class_lv_k3, class_lv_a1, 空文字列=未設定'),
    }).describe('参加プレイヤーのユーザー情報。UserId→{UserName, Rank.RankId}をsession.players Mapに追記'),
  }).describe('プレイヤー途中参加 - ハンド間・ハンド中の両方で発生。MTTのテーブル移動、Ringの途中参加で発行。JoinUser.UserIdとUserNameでsession.players Map<UserId, {name, rank}>を更新'),

  [ApiType.EVT_DEAL]: baseSchema.extend({
    ApiTypeId: z.literal(ApiType.EVT_DEAL),
    Game: z.object({
      Ante: z.int().nonnegative().describe('アンテ額。アンテ優先モデル: ショートスタックはアンテに先に充当'),
      BigBlind: z.int().nonnegative().describe('BB額'),
      BigBlindSeat: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).describe('BBプレイヤーの席インデックス。WriteEntityStreamがポジション計算の基準に使用'),
      ButtonSeat: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).describe('ボタン（ディーラー）の席インデックス。PS形式エクスポートで使用'),
      CurrentBlindLv: z.int().min(1).describe('現在のブラインドレベル。リングゲーム: 常に1。トーナメント: BlindStructures[].Lvと対応'),
      NextBlindUnixSeconds: z.int().describe('次のブラインドレベルまでの時刻（Unix Seconds）。-1 = 最終レベル'),
      SmallBlind: z.int().nonnegative().describe('SB額'),
      SmallBlindSeat: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).describe('SBプレイヤーの席インデックス'),
    }).describe('ブラインド・アンテ・ポジション情報'),
    OtherPlayers: z.array(z.object({
      BetChip: z.int().nonnegative().describe('ブラインドとして投入した額（アンテは含まない）。アンテ+ブラインド支払い後の値'),
      BetStatus: z.union([z.enum(BetStatusType)]),
      Chip: z.int().nonnegative().describe('アンテ+ブラインド支払い後の残チップ。元チップ逆算: Chip + BetChip + Ante（ショートスタック時は不正確、Progress.Pot/人数で推定）'),
      SeatIndex: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
      Status: z.union([z.literal(0), z.literal(1), z.literal(5)]).describe('0=通常。要調査: 1,5 は 1%未満の割合で出現'),
      IsSafeLeave: z.boolean().optional().describe('安全退出フラグ（Ringゲーム）'),
    })).min(1).max(6).describe('ヒーロー以外のプレイヤー情報（アンテ・ブラインド支払い後の状態）'),
    Player: z.object({
      BetChip: z.int().nonnegative().describe('ブラインドとして投入した額（アンテは含まない）'),
      BetStatus: z.enum(BetStatusType),
      Chip: z.int().nonnegative().describe('アンテ+ブラインド支払い後の残チップ'),
      HoleCards: z.array(z.int().min(0).max(51)).max(2).describe('ヒーローのホールカード。カードインデックス 0-51（rank=card/4, suit=card%4）。テーブル移動直後は空配列[]'),
      SeatIndex: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).describe('ヒーローの席インデックス。UserId = SeatUserIds[Player.SeatIndex] でヒーロー識別'),
    }).optional().describe('ヒーロー情報。観戦モードではundefined。テーブル移動直後はHoleCards:[]'),
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
    ActionType: z.enum(ActionType).describe('0=CHECK, 1=BET, 2=FOLD, 3=CALL, 4=RAISE, 5=ALL_IN。ALL_INはエンティティ保存時にBET/CALL/RAISEに正規化される'),
    BetChip: z.int().nonnegative().describe('このアクション後のストリート内累計ベット額'),
    Chip: z.int().nonnegative().describe('このアクション後の残チップ'),
    Progress: z.object({
      MinRaise: z.int().nonnegative().describe('最小レイズ額'),
      NextActionSeat: z.union([z.literal(-2), z.literal(-1), z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).describe('-2:ハンド終了, -1:ストリート完了→次のカード配布, 0-5:次のアクションプレイヤーの席'),
      NextActionTypes: z.array(z.enum(ActionType)).max(4).describe('次のプレイヤーが実行可能なアクション種別'),
      NextExtraLimitSeconds: z.int().nonnegative(),
      Phase: z.enum(PhaseType).describe('現在のフェーズ（0=プリフロップ〜3=リバー）'),
      Pot: z.int().nonnegative().describe('現在のポット総額（全ストリートの累計）'),
      SidePot: z.array(z.int().nonnegative()).max(4).describe('サイドポット額の配列。オールインが発生した場合のみ'),
    }),
    SeatIndex: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).describe('アクション実行者の席インデックス。UserId = EVT_DEAL.SeatUserIds[SeatIndex]'),
  }).describe('プレイヤーアクション - アンテオールインプレイヤーには発行されない。タイムアウト/切断時にFOLDが送信されない場合がある'),

  [ApiType.EVT_DEAL_ROUND]: baseSchema.extend({
    ApiTypeId: z.literal(ApiType.EVT_DEAL_ROUND),
    CommunityCards: z.array(z.int().min(0).max(51)).min(1).max(3).describe('このストリートで新たに配られたカードのみ（累積ではない）。フロップ:3枚, ターン:1枚, リバー:1枚。カードインデックス 0-51（rank=card/4, suit=card%4）。オールイン後は発行されない場合がありEVT_HAND_RESULTS.CommunityCardsで補完が必要'),
    OtherPlayers: z.array(z.object({
      BetChip: z.literal(0).describe('新ストリート開始時にリセット。常に0'),
      BetStatus: z.enum(BetStatusType).describe('ベット状態。2=FOLDED（前ストリートでフォールド済み）, 3=ALL_IN（オールイン中）'),
      Chip: z.int().nonnegative().describe('現在の残チップ量'),
      SeatIndex: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).describe('席インデックス。EVT_DEAL.SeatUserIds[SeatIndex]でUserId取得'),
      Status: z.union([z.literal(0), z.literal(1)]).describe('0=通常。要調査: 1 は 1%未満の割合で出現'),
      IsSafeLeave: z.boolean().optional().describe('安全退出フラグ（Ringゲーム）'),
    })).min(1).max(6).describe('ヒーロー以外の全プレイヤー状態（フォールド済み・オールイン含む）'),
    Player: z.object({
      BetChip: z.literal(0).describe('新ストリート開始時にリセット。常に0'),
      BetStatus: z.enum(BetStatusType).describe('ヒーローのベット状態'),
      Chip: z.int().nonnegative().describe('ヒーローの現在の残チップ量'),
      HoleCards: z.array(z.int().min(0).max(51)).max(2).describe('ヒーローのホールカード。カードインデックス 0-51。EVT_DEALのHoleCardsと同じ値'),
      SeatIndex: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).describe('ヒーローの席インデックス'),
    }).optional().describe('ヒーロー情報。観戦モードではundefined'),
    Progress: z.object({
      MinRaise: z.literal(0).describe('新ストリート開始時にリセット。常に0'),
      NextActionSeat: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).describe('このストリートで最初にアクションするプレイヤーの席インデックス'),
      NextActionTypes: z.array(z.enum(ActionType)).min(2).max(3).describe('最初のプレイヤーが実行可能なアクション。通常 [CHECK, ALL_IN, BET] の3つ'),
      NextExtraLimitSeconds: z.int().nonnegative().describe('追加タイムバンク（秒）'),
      Phase: z.union([
        z.literal(PhaseType.FLOP),
        z.literal(PhaseType.TURN),
        z.literal(PhaseType.RIVER)
      ]).describe('このストリートのフェーズ。1=フロップ, 2=ターン, 3=リバー（0=プリフロップはEVT_DEALで処理）'),
      Pot: z.int().nonnegative().describe('現在のポット総額（前ストリートまでの累計）'),
      SidePot: z.array(z.int().nonnegative()).max(4).describe('サイドポット額の配列'),
    }).describe('ゲーム進行状況。AggregateEventsStreamがProgress.NextActionSeatで次アクション者の整合性チェックに使用'),
  }).describe('新ストリート開始 - フロップ/ターン/リバーのカード配布。CommunityCardsは新規配布分のみ（累積ではない）。オールイン後は発行されない場合がある'),

  [ApiType.EVT_HAND_RESULTS]: baseSchema.extend({
    ApiTypeId: z.literal(ApiType.EVT_HAND_RESULTS),
    CommunityCards: z.array(z.int().min(0).max(51)).max(5).describe('EVT_DEAL_ROUNDで未配信のカードのみ。全ストリート配信済みなら空配列[]。蓄積したEVT_DEAL_ROUNDのカードとマージしてフルボードを構築する'),
    DefeatStatus: z.union([z.literal(0), z.literal(1)]).describe('0=継続, 1=脱落(ELIMINATED)'),
    HandId: z.int().nonnegative().describe('ハンドの一意識別子。ここでのみ取得可能。セッション全体で単調増加。SNG/Ringのセッション識別やマルチプレイヤーハンド突合に使用可能'),
    HandLog: z.string().optional().describe('要調査: PokerChase内部のハンドログ文字列？'),
    OtherPlayers: z.array(z.object({
      BetChip: z.literal(0).describe('ハンド終了時は常に0（ベットはポットに回収済み）'),
      BetStatus: z.literal(-1).describe('ハンド終了時は常に-1(HAND_ENDED)'),
      Chip: z.int().nonnegative().describe('ハンド終了後の残チップ量（ポット獲得分を含む最終値）'),
      SeatIndex: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).describe('席インデックス。EVT_DEAL.SeatUserIds[SeatIndex]でUserId取得'),
      Status: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7)]).describe('0=通常, 5=ELIMINATED（脱落）, 6=NO_CALL?, 7=要調査。1-4も要調査'),
      IsSafeLeave: z.boolean().optional().describe('安全退出フラグ（Ringゲーム）'),
    })).min(1).max(5).describe('ヒーロー以外の全プレイヤーのハンド終了後状態。BetChip=0, BetStatus=-1は全ハンドで固定'),
    Player: z.object({
      BetChip: z.literal(0).describe('ハンド終了時は常に0（ベットはポットに回収済み）'),
      BetStatus: z.enum(BetStatusType).describe('ハンド終了時は通常-1(HAND_ENDED)'),
      Chip: z.int().nonnegative().describe('ヒーローのハンド終了後の残チップ量（ポット獲得分を含む最終値）'),
      SeatIndex: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).describe('ヒーローの席インデックス'),
    }).optional().describe('ヒーロー情報。観戦モード（約2%のハンド）ではundefined'),
    Pot: z.int().nonnegative().describe('最終ポット総額'),
    Results: z.array(z.object({
      HandRanking: z.union([z.literal(-1), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]).describe('ポット獲得の序列。1=最強, 2=次点, ...。-1=ポット獲得資格なし（敗北）。同一役の場合は同じ値'),
      Hands: z.array(z.int().min(0).max(51)).min(0).max(5).describe('役判定に使われた5枚のカード（カードインデックス 0-51）。ショーダウン時のみ。NO_CALL/SHOWDOWN_MUCK/FOLD_OPENでは空配列'),
      HoleCards: z.array(z.int().min(-1).max(51)).min(0).max(2).describe('ホールカード。ショーダウン: 2枚（公開）or [-1,-1]（マック）。NO_CALL: 空配列 or [-1,-1]。FOLD_OPEN: 2枚（自発公開）。マルチプレイヤーデータ収集では他プレイヤーのカードが取得可能なケース'),
      Ranking: z.union([z.literal(-2), z.literal(-1), z.int().nonnegative()]).describe('-2=In-Play（継続中）, -1=Multiway敗退（複数人脱落時）, 正の数=トーナメント敗退順位'),
      RankType: z.enum(RankType).describe('成立役。0-9=ポーカーハンド（0=ロイヤルフラッシュ〜9=ハイカード）。10=NO_CALL（無競争勝利）, 11=SHOWDOWN_MUCK（ショーダウンで敗北しマック）, 12=FOLD_OPEN（フォールド後に自発的にカード公開）'),
      RewardChip: z.int().nonnegative().describe('このプレイヤーが獲得したチップ量。0=敗北。サイドポットがある場合は各ポットからの獲得合計'),
      UserId: z.int().nonnegative().describe('プレイヤーID。EVT_DEAL.SeatUserIdsの値と一致。タイムアウト/切断プレイヤーはResults[]に含まれない場合がある'),
    })).min(1).max(5).describe(`ハンド結果の配列。HandRanking昇順（1=最強が先頭、-1=敗者が末尾）で並ぶ（99.9%のハンドで確認済み）。
      RankTypeによる結果パターン:
      - ShowDown (RankType 0-9): Hands=5枚, HoleCards=2枚 or [-1,-1]（マック時）
      - NoCall (RankType 10): Hands=空配列, HoleCards=空配列 or [-1,-1]
      - ShowDownMuck (RankType 11): Hands=空配列, HoleCards=空配列 or [-1,-1]
      - FoldOpen (RankType 12): Hands=空配列, HoleCards=2枚（自発公開）
      ※フォールド済みプレイヤーはFOLD_OPENしない限りResults[]に含まれない`),
    ResultType: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).describe('ハンド終了後の状態遷移。0=通常続行（次のハンドへ）, 1=要調査, 2=テーブル移動(MTT), 3=休憩開始(MTT), 4=テーブル離脱 or 対戦相手不在'),
    SidePot: z.array(z.int().nonnegative()).max(4).describe('サイドポット額の配列。オールインが発生した場合のみ値が入る'),
  }).describe('ハンド結果 - ハンド集約の終端。HandIdはここでのみ取得可能（EVT_DEAL→EVT_HAND_RESULTSが1ハンドの境界）。Results[]はHandRanking昇順で勝者→敗者の順。フォールド済みプレイヤーはResults[]に含まれない（FOLD_OPEN除く）'),

  [307]: baseSchema.extend({
    ApiTypeId: z.literal(307),
  }).describe('イベント開始'),

  [ApiType.EVT_SESSION_DETAILS]: baseSchema.extend({
    ApiTypeId: z.literal(ApiType.EVT_SESSION_DETAILS),
    BlindStructures: z.array(z.object({
      ActiveMinutes: z.int().describe('このレベルの持続時間（分）。-1 = 最終レベル（以降上昇なし）'),
      Ante: z.int().nonnegative().describe('このレベルのアンテ額'),
      BigBlind: z.int().nonnegative().describe('このレベルのBB額。SB = BigBlind / 2'),
      Lv: z.int().nonnegative().describe('ブラインドレベル番号（1-based）'),
    })).min(1).describe('ブラインド構造。トーナメント（SNG/MTT）で使用。リングゲームでは1エントリのみ（レベル上昇なし）'),
    CoinNum: z.int().describe('参加コスト。-1 = 無料'),
    DefaultChip: z.int().describe('初期チップ量'),
    IsReplay: z.boolean().describe('リプレイ（観戦モード）かどうか'),
    Items: z.array(z.object({
      ItemId: z.string().describe('例: season10_point, medal_0001, item0002, item0028'),
      Num: z.int().nonnegative(),
      ExpireAt: z.int().nonnegative().optional(),
    })).max(1),
    LimitSeconds: z.int().nonnegative().describe('アクション制限時間（秒）'),
    MoneyList: z.array(z.object({
      FreeMoney: z.int().nonnegative(),
      PaidMoney: z.int().nonnegative(),
    })).max(1),
    Name: z.string().describe('例: シーズンマッチ, 初級ルーム, ランクマッチ'),
    Name2: z.string().describe('例: 6人対戦【STAGEⅥ】, 空文字列の場合あり'),
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
      MaxBuyin: z.int().nonnegative().optional().describe('リングゲームの最大バイイン'),
      MinBuyin: z.int().nonnegative().optional().describe('リングゲームの最小バイイン'),
    }).optional().describe('リングゲーム固有ルール。BattleType=4,5 の場合のみ'),
    TournamentRule: z.object({
      NextBreakUnixSeconds: z.int().optional().describe('次の休憩までの時刻（Unix Seconds）'),
      RebuyChip: z.int().nonnegative().optional().describe('リバイで追加されるチップ量'),
      RebuyCostCoinNum: z.int().nonnegative().optional().describe('リバイのコイン費用'),
      RebuyCostTicket: z.object({
        ItemId: z.string().optional(),
        Num: z.int().nonnegative().optional(),
      }).optional().describe('リバイのチケット費用'),
      RebuyFinishUnixSeconds: z.int().optional().describe('リバイ受付終了時刻（Unix Seconds）'),
      RebuyLimit: z.int().nonnegative().optional().describe('リバイ回数上限'),
    }).optional().describe('トーナメント固有ルール。MTT（BattleType=1）の場合のみ'),
  }).describe('セッション詳細 - 1セッション1回発行。セッション名(Name)はAggregateEventsStreamがsession.nameに保存。BlindStructuresでブラインドレベル構造を提供'),

  [ApiType.EVT_SESSION_RESULTS]: baseSchema.extend({
    ApiTypeId: z.literal(ApiType.EVT_SESSION_RESULTS),
    Charas: z.array(z.object({
      Bond: z.int(),
      CharaId: z.string().describe('例: chara0010, fn_chara0003'),
      CostumeId: z.string().describe('例: costume00101'),
      Evolution: z.boolean(),
      Favorite: z.int(),
      Rank: z.int().nonnegative(),
      Stamps: z.array(z.object({
        StampId: z.string().describe('例: stamp1001, fn_stamp0312'),
        IsRelease: z.boolean(),
      })).length(12),
      TodayUpNum: z.int().nonnegative(),
    })).max(1),
    Costumes: z.array(z.unknown()),
    Decos: z.array(z.object({
      DecoId: z.string().describe('例: k_deco0069, ta_deco0055, t_deco0069'),
      IsSetting: z.boolean(),
    })).max(3),
    Emblems: z.array(z.unknown()),
    EventRewards: z.array(z.unknown()),
    IsLeave: z.boolean().describe('途中退出したかどうか'),
    IsRebuy: z.boolean().describe('リバイしたかどうか'),
    Items: z.array(z.object({
      ItemId: z.string().describe('例: item0002, item0028, item0038, medal_0001'),
      Num: z.int().nonnegative(),
    })).max(4),
    Money: z.object({
      FreeMoney: z.int().describe('-1=非表示'),
      PaidMoney: z.int().describe('-1=非表示'),
    }),
    Ranking: z.int().describe('最終順位（1-based）'),
    Rewards: z.array(z.object({
      BuffNum: z.int().nonnegative(),
      Category: z.int().nonnegative().describe('3=チケット, 8=コイン等'),
      Num: z.int().nonnegative(),
      TargetId: z.string().describe('例: item0002, 空文字列の場合あり'),
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
    IsTimerWinFinish: z.boolean().optional().describe('タイマー勝利で終了したか'),
    TableId: z.union([z.string(), z.int()]).optional().describe('テーブルID（文字列または数値）'),
    IsOverDailyLimit: z.boolean().optional().describe('デイリー制限超過フラグ'),
    IsChangeDay: z.boolean().optional().describe('日付変更フラグ'),
  }).describe('セッション終了 - 1セッション1回発行。最終順位(Ranking)、ランク変動(RankReward)を含む。background.tsはこのイベントでautoSyncService.onGameSessionEnd()をトリガー'),

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
      ClassLvId: z.string().optional().describe('リングゲームクラス。例: class_lv_j1, class_lv_k3, class_lv_a1, 空文字列=未設定'),
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
    WaitTableType: z.int().nonnegative().optional().describe('テーブル待機タイプ（0:通常）'),
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
  }).describe('プレイヤー着席 - テーブルの全プレイヤー名・ランクを提供。SNGでは1回、MTTではテーブル移動ごとに再発行。TableUsers[]からUserId→名前のマッピングを構築'),

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
  apiEventSchemas[ApiType.EVT_ENTRY_QUEUED],
  apiEventSchemas[202],
  apiEventSchemas[203],
  apiEventSchemas[204],
  apiEventSchemas[205],
  apiEventSchemas[206],
  apiEventSchemas[210],
  apiEventSchemas[212],
  apiEventSchemas[213],
  apiEventSchemas[214],
  apiEventSchemas[215],
  apiEventSchemas[220],
  apiEventSchemas[221],
  apiEventSchemas[224],
  apiEventSchemas[ApiType.EVT_PLAYER_JOIN],
  apiEventSchemas[ApiType.EVT_DEAL],
  apiEventSchemas[ApiType.EVT_ACTION],
  apiEventSchemas[ApiType.EVT_DEAL_ROUND],
  apiEventSchemas[ApiType.EVT_HAND_RESULTS],
  apiEventSchemas[307],
  apiEventSchemas[ApiType.EVT_SESSION_DETAILS],
  apiEventSchemas[ApiType.EVT_SESSION_RESULTS],
  apiEventSchemas[310],
  apiEventSchemas[311],
  apiEventSchemas[312],
  apiEventSchemas[ApiType.EVT_PLAYER_SEAT_ASSIGNED],
  apiEventSchemas[314],
  apiEventSchemas[315],
  apiEventSchemas[316],
  apiEventSchemas[317],
  apiEventSchemas[318],
  apiEventSchemas[319],
  apiEventSchemas[1201],
  apiEventSchemas[1202],
  apiEventSchemas[1203],
  apiEventSchemas[1204],
  apiEventSchemas[1301],
  apiEventSchemas[1302],
  apiEventSchemas[1303],
  apiEventSchemas[1304],
])

// ===============================
// Schema Access Functions
// ===============================

/**
 * 特定のApiTypeに対応するZodスキーマを取得
 * @param apiType - 取得したいイベントタイプ
 * @returns 対応するZodスキーマ、存在しない場合はundefined
 */
export function getEventSchema<T extends number>(
  apiType: T
): T extends keyof typeof apiEventSchemas 
  ? typeof apiEventSchemas[T]
  : z.ZodSchema | undefined {
  return apiEventSchemas[apiType as keyof typeof apiEventSchemas] as any
}

/**
 * 利用可能なイベントタイプの一覧を取得
 * @returns ApiTypeの配列
 */
export function getAvailableEventTypes(): number[] {
  return Object.keys(apiEventSchemas)
    .map(Number)
    .filter(k => !isNaN(k))
}

/**
 * イベントスキーマのフィールド名を取得（イントロスペクション）
 * @param apiType - イベントタイプ
 * @returns フィールド名の配列
 * @deprecated Zodの内部実装に依存するため、将来的に動作しない可能性があります
 */
export function getEventFields(apiType: number): string[] {
  const schema = apiEventSchemas[apiType as keyof typeof apiEventSchemas]
  if (!schema) return []
  
  // Zodスキーマのshapeプロパティへのアクセス（型アサーションが必要）
  if ('shape' in schema) {
    const shape = (schema as any).shape
    if (shape && typeof shape === 'object') {
      return Object.keys(shape)
    }
  }
  
  return []
}

/**
 * スキーマベースでイベントをパースして型付き結果を返す
 * @param apiType - イベントタイプ
 * @param data - パースするデータ
 * @returns パース結果（成功時は型付きデータ、失敗時はエラー）
 */
export function parseEventWithSchema<T extends ApiType>(
  apiType: T,
  data: unknown
): { success: true; data: ApiEvent<T> } | { success: false; error: z.ZodError | Error } {
  const schema = getEventSchema(apiType)
  if (!schema) {
    // スキーマが見つからない場合は通常のエラーを返す
    return { 
      success: false, 
      error: new Error(`No schema found for ApiType: ${apiType}`)
    }
  }
  
  const result = schema.safeParse(data)
  if (result.success) {
    return { success: true, data: result.data as ApiEvent<T> }
  }
  return { success: false, error: result.error }
}

// ===============================
// Type Derivation from Schemas
// ===============================

/** WebSocketメッセージの型（web_accessible_resourceで付与される） */
export type ApiMessage = z.infer<typeof messageSchema>

/**
 * Zodスキーマから生成される全ての既知イベントのdiscriminated union
 * Single Source of Truth
 */
type ApiEventAll = z.infer<typeof ApiEventSchema>

/**
 * APIイベント型
 * - ジェネリック指定時: 特定のイベント型を返す
 * - ジェネリックなし: 全イベントのdiscriminated unionを返す
 * 
 * 注: 内部的にはZodスキーマから生成される型を使用
 */
export type ApiEvent<T extends ApiType = ApiType> = T extends ApiType
  ? Extract<ApiEventAll, { ApiTypeId: T }>
  : ApiEventAll

/** ApiTypeの値の配列（アプリケーションで使用） */
export const ApiTypeValues = Object.values(ApiType).filter(v => typeof v === 'number') as ApiType[]

// ===============================
// Validation Functions
// ===============================

/** メッセージスキーマの検証（web_accessible_resource用） */
export const validateMessage = messageSchema.safeParse.bind(messageSchema)

/** APIイベントスキーマの検証 */
export const validateApiEvent = ApiEventSchema.safeParse.bind(ApiEventSchema)

/** 特定のApiTypeのイベントか検証 */
export const isApiEventType = <T extends ApiType>(
  event: unknown,
  apiType: T
): event is ApiEvent<T> => {
  const result = validateApiEvent(event)
  return result.success && result.data.ApiTypeId === apiType
}

/** アプリケーションで使用するイベントかチェック */
export const isApplicationApiEvent = (event: unknown): event is ApiEvent<ApiType> => {
  const result = validateApiEvent(event)
  return result.success && ApiTypeValues.includes(result.data.ApiTypeId as ApiType)
}

/** 検証エラーの詳細を取得 */
export const getValidationError = (error: z.ZodError) => {
  return error.issues.map(issue => ({
    path: issue.path.join('.') || 'root',
    message: issue.message,
    code: issue.code
  }))
}

/**
 * 検証と型ガードを同時に行うヘルパー関数
 * @param event - 検証するイベント
 * @returns 検証が成功した場合は型付きイベント、失敗した場合はnull
 */
export function parseApiEvent(event: unknown): ApiEventAll | null {
  const result = validateApiEvent(event)
  return result.success ? result.data : null
}

/**
 * 検証と特定型のチェックを同時に行うヘルパー関数
 * @param event - 検証するイベント
 * @param apiType - 期待するApiType
 * @returns 検証が成功した場合は型付きイベント、失敗した場合はnull
 */
export function parseApiEventType<T extends ApiType>(
  event: unknown,
  apiType: T
): ApiEvent<T> | null {
  const result = validateApiEvent(event)
  if (!result.success || result.data.ApiTypeId !== apiType) {
    return null
  }
  return result.data as ApiEvent<T>
}


// ===============================
// Domain-Specific Event Types
// ===============================

/** ハンド処理に必要なイベントのみを含む型 */
export type ApiHandEvent = 
  | ApiEvent<ApiType.EVT_DEAL>
  | ApiEvent<ApiType.EVT_ACTION>
  | ApiEvent<ApiType.EVT_DEAL_ROUND>
  | ApiEvent<ApiType.EVT_HAND_RESULTS>

/** セッション管理に必要なイベントのみを含む型 */
export type ApiSessionEvent = 
  | ApiEvent<ApiType.EVT_ENTRY_QUEUED>
  | ApiEvent<ApiType.EVT_SESSION_DETAILS>
  | ApiEvent<ApiType.EVT_SESSION_RESULTS>

/** プレイヤー情報に関するイベントのみを含む型 */
export type ApiPlayerEvent = 
  | ApiEvent<ApiType.EVT_PLAYER_SEAT_ASSIGNED>
  | ApiEvent<ApiType.EVT_PLAYER_JOIN>
