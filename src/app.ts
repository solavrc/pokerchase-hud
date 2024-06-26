import Dexie, { type Table } from 'dexie'
import { Transform } from 'stream'
import { content_scripts } from '../manifest.json'

/**
 * Event Lifecycle:
 *
 * - PREFLOP
 * 303 EVT_DEAL
 * 304 EVT_ACTION[]
 *
 * - FLOP
 * 305 EVT_DEAL_ROUND (Progress.Phase === 1)
 * 304 EVT_ACTION[]
 *
 * - TURN
 * 305 EVT_DEAL_ROUND (Progress.Phase === 2)
 * 304 EVT_ACTION[]
 *
 * - RIVER
 * 305 EVT_DEAL_ROUND (Progress.Phase === 3)
 * 304 EVT_ACTION[]
 *
 * - SHOWDOWN (OR ALL OTHER PLAYERS FOLDED)
 * 306 EVT_HAND_RESULTS
 */
export enum ApiType {
  /**
   * 参加申込:
   * - SitAndGo: { "ApiTypeId": 201, "Code": 0, "BattleType": 0, "Id": "new_stage007_010" }
   * - MTT: { "ApiTypeId": 201, "Code": 0, "BattleType": 1, "Id": "3164" }
   * - Ring: { "ApiTypeId": 201, "Code": 0, "BattleType": 4, "Id": "10_20_0001" }
   * - FriendRing: { "ApiTypeId": 201, "Code": 0, "BattleType": 5, "Id": "" }
   */
  RES_ENTRY_QUEUED = 201,
  /** アクション完了: { "ApiTypeId": 202, "Code": 0 } */
  RES_ACTION_COMPLETED = 202,
  /** 参加取消申込: { "ApiTypeId": 203, "Code": 0 } */
  RES_ENTRY_CANCEL_QUEUED = 203,
  /** ハンド開始: { "ApiTypeId": 204, "Code": 0 } */
  RES_HAND_STARTED = 204,
  /** タイムバンク: { "ApiTypeId": 205, "Code": 0, "RestLimitSeconds": 8, "RestExtraLimitSeconds": 12 } */
  RES_TIME_REMAINED = 205,
  /** スタンプ送信: { "ApiTypeId": 206, "Code": 0 } */
  RES_STAMP_SENT = 206,
  /** マックハンド公開: { "ApiTypeId": 210, "Code": 0, "HoleCardIndex": 0, "IsFoldOpen": true } */
  RES_OPEN_FOLDED_HAND = 210,
  /** 退室完了: { "ApiTypeId": 212, "Code": 0 } */
  RES_LEAVE_COMPLETED = 212,
  /** 参加取消申込結果: { "ApiTypeId": 213, "Code": 0, "IsCancel": false } */
  RES_ENTRY_CANCELED = 213,
  /** アドオン完了: { "ApiTypeId": 214, "Code": 0, "Items": [{ "ItemId": "medal_0001", "Num": 10047 }],"Chip": 2000, "AddonNum": 2000 }' */
  RES_ADDON_COMPLETED = 214,
  /** アドオン可能: { "ApiTypeId": 215, "Code": 0, "AddonStatus": 0 } */
  RES_ADDON_READY = 215,
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
  /** イベント開始: { "ApiTypeId": 307 } */
  EVT_SESSION_STARTED = 307,
  /** イベント概要: { "ApiTypeId": 308, "CoinNum": -1, "Items": [{ "ItemId": "season10_point", "Num": 9 }], "Name": "シーズンマッチ", "Name2": "6人対戦【シーズン10】", "DefaultChip": 20000, "LimitSeconds": 8, "IsReplay": true, "BlindStructures": [{ "Lv": 1, "ActiveMinutes": 4, "BigBlind": 200, "Ante": 50 }, { "Lv": 2, "ActiveMinutes": 4, "BigBlind": 280, "Ante": 70 }, { "Lv": 3, "ActiveMinutes": 4, "BigBlind": 400, "Ante": 100 }, { "Lv": 4, "ActiveMinutes": 4, "BigBlind": 560, "Ante": 140 }, { "Lv": 5, "ActiveMinutes": 4, "BigBlind": 780, "Ante": 200 }, { "Lv": 6, "ActiveMinutes": 4, "BigBlind": 1100, "Ante": 280 }, { "Lv": 7, "ActiveMinutes": 4, "BigBlind": 1640, "Ante": 410 }, { "Lv": 8, "ActiveMinutes": 4, "BigBlind": 2500, "Ante": 630 }, { "Lv": 9, "ActiveMinutes": 4, "BigBlind": 3800, "Ante": 950 }, { "Lv": 10, "ActiveMinutes": 4, "BigBlind": 5700, "Ante": 1400 }, { "Lv": 11, "ActiveMinutes": 4, "BigBlind": 8600, "Ante": 2200 }, { "Lv": 12, "ActiveMinutes": 4, "BigBlind": 13000, "Ante": 3200 }, { "Lv": 13, "ActiveMinutes": 4, "BigBlind": 19600, "Ante": 4900 }, { "Lv": 14, "ActiveMinutes": 4, "BigBlind": 29500, "Ante": 7400 }, { "Lv": 15, "ActiveMinutes": 4, "BigBlind": 44300, "Ante": 11000 }, { "Lv": 16, "ActiveMinutes": -1, "BigBlind": 60000, "Ante": 15000 }] }, */
  EVT_SESSION_DETAILS = 308,
  /** イベント結果: { "ApiTypeId": 309, "Ranking": 3, "IsLeave": false, "IsRebuy": false, "TotalMatch": 285, "RankReward": { "IsSeasonal": true, "RankPoint": 11, "RankPointDiff": 2, "Rank": { "RankId": "diamond", "RankName": "ダイヤモンド", "RankLvId": "diamond", "RankLvName": "ダイヤモンド" }, "SeasonalRanking": 1458 }, "Rewards": [{ "Category": 8, "TargetId": "", "Num": 70 }, { "Category": 3, "TargetId": "item0002", "Num": 450 }, { "Category": 3, "TargetId": "item0028", "Num": 2 }], "EventRewards": [], "Charas": [{ "CharaId": "chara0010", "CostumeId": "costume00101", "Favorite": 29605, "Rank": 3, "TodayUpNum": 0, "Evolution": false, "Stamps": [{ "StampId": "stamp1001", "IsRelease": true }, { "StampId": "stamp1002", "IsRelease": true }, { "StampId": "stamp1003", "IsRelease": true }, { "StampId": "stamp1004", "IsRelease": true }, { "StampId": "stamp1005", "IsRelease": true }, { "StampId": "stamp1006", "IsRelease": true }, { "StampId": "stamp1007", "IsRelease": true }, { "StampId": "stamp1008", "IsRelease": false }, { "StampId": "stamp1009", "IsRelease": false }, { "StampId": "stamp1010", "IsRelease": false }, { "StampId": "stamp1011", "IsRelease": false }, { "StampId": "stamp1012", "IsRelease": false }] }], "Costumes": [], "Decos": [], "Items": [{ "ItemId": "item0002", "Num": 28900 }, { "ItemId": "item0028", "Num": 452 }, { "ItemId": "season10_point", "Num": 11 }], "Money": { "FreeMoney": -1, "PaidMoney": -1 }, "Emblems": [] } */
  EVT_SESSION_RESULTS = 309,
  /** スタンプ受信: { "ApiTypeId": 310, "SeatIndex": 5, "StampId": "stamp0102" } */
  EVT_STAMP_RECEIVED = 310,
  /** ハンド終了: { "ApiTypeId": 311, "NotifyCode": 1 } */
  EVT_HAND_COMPLETED = 311,
  /** プレイヤー着席: { "ApiTypeId": 313, "ProcessType": 0, "TableUsers": [{ "UserId": 583654032, "UserName": "シュレディンガー", "FavoriteCharaId": "nj_chara0002", "CostumeId": "nj_costume00022", "EmblemId": "emblem0003", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0001", "fn_ta_deco0007", "fn_t_deco0005", "b_deco0001", "f_deco0001", "eal_deco0002", "esw_deco0007"] }, { "UserId": 561384657, "UserName": "sola", "FavoriteCharaId": "chara0010", "CostumeId": "costume00101", "EmblemId": "emblem0001", "Rank": { "RankId": "diamond", "RankName": "ダイヤモンド", "RankLvId": "diamond", "RankLvName": "ダイヤモンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0001", "ta_deco0001", "t_deco0009", "b_deco0001", "f_deco0001", "eal_deco0001", "esw_deco0001"] }, { "UserId": 750532695, "UserName": "ちいまう", "FavoriteCharaId": "chara0022", "CostumeId": "costume00221", "EmblemId": "emblem0001", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0014", "ta_deco0001", "t_deco0012", "b_deco0001", "f_deco0001", "eal_deco0001", "esw_deco0006"] }, { "UserId": 172432670, "UserName": "ラロムジ", "FavoriteCharaId": "chara0001", "CostumeId": "costume00012", "EmblemId": "emblem0001", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0001", "ta_deco0001", "t_deco0001", "b_deco0001", "f_deco0001", "eal_deco0001", "esw_deco0001"] }, { "UserId": 575402650, "UserName": "夜菊0721", "FavoriteCharaId": "chara0021", "CostumeId": "costume00212", "EmblemId": "emblem0001", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0069", "ta_deco0055", "t_deco0069", "bg_deco0006", "f_deco0001", "eal_deco0007", "esw_deco0001"] }, { "UserId": 619317634, "UserName": "ぽちこん", "FavoriteCharaId": "chara0009", "CostumeId": "costume00092", "EmblemId": "emblem0001", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0062", "ta_deco0018", "t_deco0058", "b_deco0001", "f_deco0001", "eal_deco0002", "esw_deco0001"] }], "SeatUserIds": [583654032, 619317634, 561384657, 575402650, 750532695, 172432670] } */
  EVT_PLAYER_SEAT_ASSIGNED = 313,
  /** プライズ変動: { "ApiTypeId": 314, "RankingRewards": [{ "HighRanking": 1, "LowRanking": 1, "Rewards": [{ "Category": 4, "TargetId": "eal_deco0007", "Num": 1 }, { "Category": 0, "TargetId": "item0000", "Num": 2000 }, { "Category": 4, "TargetId": "kg_bg_deco0001", "Num": 1 }, { "Category": 3, "TargetId": "kg_item0001", "Num": 200 }, { "Category": 4, "TargetId": "kg_k_deco0006", "Num": 1 }, { "Category": 4, "TargetId": "kg_ta_deco0005", "Num": 1 }, { "Category": 4, "TargetId": "kg_t_deco0005", "Num": 1}] }, { "HighRanking": 2, "LowRanking": 2, "Rewards": [{ "Category": 4, "TargetId": "eal_deco0007", "Num": 1 }, { "Category": 0, "TargetId": "item0000", "Num": 1200 }, { "Category": 4, "TargetId": "kg_bg_deco0001", "Num": 1 }, { "Category": 3, "TargetId": "kg_item0001", "Num": 170 }, { "Category": 4, "TargetId": "kg_k_deco0006", "Num": 1 }, { "Category": 4, "TargetId": "kg_ta_deco0005", "Num": 1 }, { "Category": 4, "TargetId": "kg_t_deco0005", "Num": 1 }] }, { "HighRanking": 3, "LowRanking": 3, "Rewards": [{ "Category": 4, "TargetId": "eal_deco0007", "Num": 1 }, { "Category": 0, "TargetId": "item0000", "Num": 1000 }, { "Category": 4, "TargetId": "kg_bg_deco0001", "Num": 1 }, { "Category": 3, "TargetId": "kg_item0001", "Num": 150 }, { "Category": 4, "TargetId": "kg_k_deco0006", "Num": 1 }, { "Category": 4, "TargetId": "kg_ta_deco0005", "Num": 1 }, { "Category": 4, "TargetId": "kg_t_deco0005", "Num": 1 }] }, { "HighRanking": 4, "LowRanking": 4, "Rewards": [{ "Category": 4, "TargetId": "eal_deco0007", "Num": 1 }, { "Category": 0, "TargetId": "item0000", "Num": 900 }, { "Category": 4, "TargetId": "kg_bg_deco0001", "Num": 1 }, { "Category": 3, "TargetId": "kg_item0001", "Num": 130 }, { "Category": 4, "TargetId": "kg_k_deco0006", "Num": 1 }, { "Category": 4, "TargetId": "kg_ta_deco0005", "Num": 1 }, { "Category": 4, "TargetId": "kg_t_deco0005", "Num": 1 }] }, { "HighRanking": 5, "LowRanking": 5, "Rewards": [{ "Category": 4, "TargetId": "eal_deco0007", "Num": 1 }, { "Category": 0, "TargetId": "item0000", "Num": 800 }, { "Category": 4, "TargetId": "kg_bg_deco0001", "Num": 1 }, { "Category": 3, "TargetId": "kg_item0001", "Num": 130 }, { "Category": 4, "TargetId": "kg_k_deco0006", "Num": 1 }, { "Category": 4, "TargetId": "kg_ta_deco0005", "Num": 1 }, { "Category": 4, "TargetId": "kg_t_deco0005", "Num": 1 }] }, { "HighRanking": 6, "LowRanking": 6, "Rewards": [{ "Category": 4, "TargetId": "eal_deco0007", "Num": 1 }, { "Category": 0, "TargetId": "item0000", "Num": 700 }, { "Category": 4, "TargetId": "kg_bg_deco0001", "Num": 1 }, { "Category": 3, "TargetId": "kg_item0001", "Num": 100 }, { "Category": 4, "TargetId": "kg_k_deco0006", "Num": 1 }, { "Category": 4, "TargetId": "kg_ta_deco0005", "Num": 1 }, { "Category": 4, "TargetId": "kg_t_deco0005", "Num": 1 }] }, { "HighRanking": 7, "LowRanking": 7, "Rewards": [{ "Category": 4, "TargetId": "eal_deco0007", "Num": 1 }, { "Category": 0, "TargetId": "item0000", "Num": 600 }, { "Category": 4, "TargetId": "kg_bg_deco0001", "Num": 1 }, { "Category": 3, "TargetId": "kg_item0001", "Num": 90 }, { "Category": 4, "TargetId": "kg_k_deco0006", "Num": 1 }, { "Category": 4, "TargetId": "kg_ta_deco0005", "Num": 1 }, { "Category": 4, "TargetId": "kg_t_deco0005", "Num": 1 }] }, { "HighRanking": 8, "LowRanking": 8, "Rewards": [{ "Category": 4, "TargetId": "eal_deco0007", "Num": 1 }, { "Category": 0, "TargetId": "item0000", "Num": 500 }, { "Category": 4, "TargetId": "kg_bg_deco0001", "Num": 1 }, { "Category": 3, "TargetId": "kg_item0001", "Num": 90 }, { "Category": 4, "TargetId": "kg_k_deco0006", "Num": 1 }, { "Category": 4, "TargetId": "kg_ta_deco0005", "Num": 1 }, { "Category": 4, "TargetId": "kg_t_deco0005", "Num": 1 }] }, { "HighRanking": 9, "LowRanking": 9, "Rewards": [{ "Category": 4, "TargetId": "eal_deco0007", "Num": 1 }, { "Category": 0, "TargetId": "item0000", "Num": 400 }, { "Category": 4, "TargetId": "kg_bg_deco0001", "Num": 1 }, { "Category": 3, "TargetId": "kg_item0001", "Num": 90 }, { "Category": 4, "TargetId": "kg_k_deco0006", "Num": 1 }, { "Category": 4, "TargetId": "kg_ta_deco0005", "Num": 1 }, { "Category": 4, "TargetId": "kg_t_deco0005", "Num": 1 }] }, { "HighRanking": 10, "LowRanking": 10, "Rewards": [{ "Category": 4, "TargetId": "eal_deco0007", "Num": 1 }, { "Category": 0, "TargetId": "item0000", "Num": 300 }, { "Category": 4, "TargetId": "kg_bg_deco0001", "Num": 1 }, { "Category": 3, "TargetId": "kg_item0001", "Num": 90 }, { "Category": 4, "TargetId": "kg_k_deco0006", "Num": 1 }, { "Category": 4, "TargetId": "kg_ta_deco0005", "Num": 1 }, { "Category": 4, "TargetId": "kg_t_deco0005", "Num": 1 }] }, { "HighRanking": 11, "LowRanking": 30, "Rewards": [{ "Category": 0, "TargetId": "item0000", "Num": 200 }, { "Category": 3, "TargetId": "kg_item0001", "Num": 80 }, { "Category": 4, "TargetId": "kg_k_deco0006", "Num": 1 }, { "Category": 4, "TargetId": "kg_ta_deco0005", "Num": 1 }, { "Category": 4, "TargetId": "kg_t_deco0005", "Num": 1 }] }, { "HighRanking": 31, "LowRanking": 50, "Rewards": [{ "Category": 0, "TargetId": "item0000", "Num": 100 }, { "Category": 3, "TargetId": "kg_item0001", "Num": 70 }, { "Category": 4, "TargetId": "kg_k_deco0006", "Num": 1 }, { "Category": 4, "TargetId": "kg_ta_deco0005", "Num": 1 }, { "Category": 4, "TargetId": "kg_t_deco0005", "Num": 1 }] }, { "HighRanking": 51, "LowRanking": 80, "Rewards": [{ "Category": 3, "TargetId": "kg_item0001", "Num": 50 }]}]} */
  EVT_REWARD_CHANGED = 314,
  /** ブラインドレベル上昇: { "ApiTypeId": 317, "CurrentBlindLv": 2, "NextBlindUnixSeconds": 1712648882, "Ante": 70, "SmallBlind": 140, "BigBlind": 280 } */
  EVT_BLIND_RAISED = 317,
  /** 参加申込結果: { "ApiTypeId": 319, "MatchUserNum": 6 } */
  EVT_ENTRY_COMPLETED = 319,
}

enum ActionType {
  CHECK = 0,
  BET = 1,
  FOLD = 2,
  CALL = 3,
  RAISE = 4,
  ALL_IN = 5
}

enum BattleType {
  SIT_AND_GO = 0,
  TOURNAMENT = 1,
  FRIEND_SIT_AND_GO = 2,
  RING_GAME = 4,
  FRIEND_RING_GAME = 5,
}

enum BetStatusType {
  HAND_ENDED = -1,
  NOT_IN_PLAY = 0,
  BET_ABLE = 1,
  FOLDED = 2,
  ALL_IN = 3
}

enum PhaseType {
  PREFLOP = 0,
  FLOP = 1,
  TURN = 2,
  RIVER = 3,
  /** 独自追加 */
  SHOWDOWN = 4,
}

/** `FOLD`したプレイヤーは`FOLD_OPEN`しない限り含まれない */
enum RankType {
  ROYAL_FLUSH = 0,
  STRAIGHT_FLUSH = 1,
  FOUR_OF_A_KIND = 2,
  FULL_HOUSE = 3,
  FLUSH = 4,
  STRAIGHT = 5,
  THREE_OF_A_KIND = 6,
  TWO_PAIR = 7,
  ONE_PAIR = 8,
  HIGH_CARD = 9,
  NO_CALL = 10,
  SHOWDOWN_MUCK = 11,
  FOLD_OPEN = 12
}

interface BlindStructure {
  Lv: number
  ActiveMinutes: number
  BigBlind: number
  Ante: number
}

interface Chara {
  CharaId: string
  CostumeId: string
  Favorite: number
  Rank: number
  TodayUpNum: number
  Evolution: boolean
  Stamps: Stamp[]
}

interface EventDetail {
  ItemId: string
  Num: number
}

interface Game {
  CurrentBlindLv: number
  NextBlindUnixSeconds: number
  Ante: number
  SmallBlind: number
  BigBlind: number
  ButtonSeat: 0 | 1 | 2 | 3 | 4 | 5
  SmallBlindSeat: 0 | 1 | 2 | 3 | 4 | 5
  BigBlindSeat: 0 | 1 | 2 | 3 | 4 | 5
}

interface Item {
  ItemId: string
  Num: number
}

interface OtherPlayer extends Omit<Player, 'HoleCards'> {
  Status: 0 | 5
}

interface Player {
  SeatIndex: 0 | 1 | 2 | 3 | 4 | 5
  BetStatus: BetStatusType
  Chip: number
  BetChip: number
  HoleCards: [number, number] | []
}

interface JoinPlayer extends Omit<Player, 'HoleCards'> {
  Status: 0
}

interface Progress {
  Phase: PhaseType
  NextActionSeat: -2 | -1 | 0 | 1 | 2 | 3 | 4 | 5
  NextActionTypes: ActionType[]
  NextExtraLimitSeconds: number
  MinRaise: number
  Pot: number
  SidePot: number[]
}

interface RankReward {
  IsSeasonal: boolean
  RankPoint: number
  RankPointDiff: number
  Rank: {
    RankId: string
    RankName: string
    RankLvId: string
    RankLvName: string
  }
  SeasonalRanking: number
}

interface RankingReward {
  HighRanking: number
  LowRanking: number
  Rewards: Reward[]
}

interface ResultBase {
  UserId: number
  HandRanking: -1 | 1 | 2 | 3 | 4 | 5 | 6
  Ranking: -2 | -1 | 1 | 2 | 3 | 4 | 5 | 6
  RewardChip: number
}

interface ShowDownResult extends ResultBase {
  RankType: RankType.ROYAL_FLUSH | RankType.STRAIGHT_FLUSH | RankType.FOUR_OF_A_KIND | RankType.FULL_HOUSE | RankType.FLUSH | RankType.STRAIGHT | RankType.THREE_OF_A_KIND | RankType.TWO_PAIR | RankType.ONE_PAIR | RankType.HIGH_CARD
  Hands: [number, number, number, number, number]
  HoleCards: [number, number]
}

interface NoCallOrShowDownMuckResult extends ResultBase {
  RankType: RankType.NO_CALL | RankType.SHOWDOWN_MUCK
  Hands: never[]
  HoleCards: never[]
}

interface FoldOpenResult extends ResultBase {
  RankType: RankType.FOLD_OPEN
  Hands: never[]
  HoleCards: [number, number]
}

type Result =
  | ShowDownResult
  | NoCallOrShowDownMuckResult
  | FoldOpenResult

interface Reward {
  Category: number
  TargetId: string
  Num: number
}

interface RingReward {
  ResultNum: number
  Ranking: number
  Score: number
}

interface Stamp {
  StampId: string
  IsRelease: boolean
}

interface TableUser {
  UserId: number
  UserName: string
  FavoriteCharaId: string
  CostumeId: string
  EmblemId: string
  Rank: {
    RankId: 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond' | 'legend'
    RankName: 'ブロンズ' | 'シルバー' | 'ゴールド' | 'プラチナ' | 'ダイヤモンド' | 'レジェンド'
    RankLvId: 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond' | 'legend'
    RankLvName: 'ブロンズ' | 'シルバー' | 'ゴールド' | 'プラチナ' | 'ダイヤモンド' | 'レジェンド'
  }
  IsOfficial: boolean
  IsCpu: boolean
  SettingDecoIds: string[]
}

interface ApiEventBase<T extends ApiType> {
  ApiTypeId: T
  timestamp?: number
}

export type ApiEvent<T extends ApiType = ApiType> =
  T extends ApiType.RES_ENTRY_QUEUED ? ApiEventBase<ApiType.RES_ENTRY_QUEUED> & { Code: 0, BattleType: BattleType, Id: string } :
  T extends ApiType.RES_ACTION_COMPLETED ? ApiEventBase<ApiType.RES_ACTION_COMPLETED> & { Code: 0 } :
  T extends ApiType.RES_ENTRY_CANCEL_QUEUED ? ApiEventBase<ApiType.RES_ENTRY_CANCEL_QUEUED> & { Code: 0 } :
  T extends ApiType.RES_HAND_STARTED ? ApiEventBase<ApiType.RES_HAND_STARTED> & { Code: 0 } :
  T extends ApiType.RES_TIME_REMAINED ? ApiEventBase<ApiType.RES_TIME_REMAINED> & { Code: 0, RestExtraLimitSeconds: number, RestLimitSeconds: number } :
  T extends ApiType.RES_STAMP_SENT ? ApiEventBase<ApiType.RES_STAMP_SENT> & { Code: 0 } :
  T extends ApiType.RES_OPEN_FOLDED_HAND ? ApiEventBase<ApiType.RES_OPEN_FOLDED_HAND> & { Code: 0, HoleCardIndex: number, IsFoldOpen: boolean } :
  T extends ApiType.RES_LEAVE_COMPLETED ? ApiEventBase<ApiType.RES_LEAVE_COMPLETED> & { Code: 0 } :
  T extends ApiType.RES_ENTRY_CANCELED ? ApiEventBase<ApiType.RES_ENTRY_CANCELED> & { Code: 0, IsCancel: boolean } :
  T extends ApiType.RES_ADDON_COMPLETED ? ApiEventBase<ApiType.RES_ADDON_COMPLETED> & { Code: 0, Items: Item[], Chip: number, AddonNum: number } :
  T extends ApiType.RES_ADDON_READY ? ApiEventBase<ApiType.RES_ADDON_READY> & { Code: 0, AddonStatus: number } :
  T extends ApiType.EVT_PLAYER_JOIN ? ApiEventBase<ApiType.EVT_PLAYER_JOIN> & { JoinUser: TableUser, JoinPlayer: JoinPlayer } :
  T extends ApiType.EVT_DEAL ? ApiEventBase<ApiType.EVT_DEAL> & { Game: Game, OtherPlayers: OtherPlayer[], Player?: Player, Progress: Progress, SeatUserIds: number[], MyRanking?: { Ranking: number, JoinNum: number, AverageChip: number, ActiveNum: number } } :
  T extends ApiType.EVT_ACTION ? ApiEventBase<ApiType.EVT_ACTION> & { ActionType: ActionType, BetChip: number, Chip: number, Progress: Progress, SeatIndex: number } :
  T extends ApiType.EVT_DEAL_ROUND ? ApiEventBase<ApiType.EVT_DEAL_ROUND> & { CommunityCards: number[], OtherPlayers: OtherPlayer[], Player?: Player, Progress: Progress } :
  T extends ApiType.EVT_HAND_RESULTS ? ApiEventBase<ApiType.EVT_HAND_RESULTS> & { CommunityCards: number[], DefeatStatus: number, HandId: number, OtherPlayers: OtherPlayer[], Player?: Omit<Player, 'HoleCards'>, Pot: number, Results: Result[], ResultType: number, SidePot: number[] } :
  T extends ApiType.EVT_SESSION_STARTED ? ApiEventBase<ApiType.EVT_SESSION_STARTED> :
  T extends ApiType.EVT_SESSION_DETAILS ? ApiEventBase<ApiType.EVT_SESSION_DETAILS> & { BlindStructures: BlindStructure[], CoinNum: number, DefaultChip: number, IsReplay: boolean, Items: EventDetail[], LimitSeconds: number, Name: string, Name2: string, MoneyList?: unknown[], RingRule?: { MinBuyin: number, MaxBuyin: number }, TournamentRule?: { RebuyLimit: number, RebuyCostCoinNum: number, RebuyCostTicket: { ItemId: string, Num: number }, RebuyChip: number, RebuyFinishUnixSeconds: number, NextBreakUnixSeconds: number }, RankingRewards?: RankingReward[] } :
  T extends ApiType.EVT_SESSION_RESULTS ? ApiEventBase<ApiType.EVT_SESSION_RESULTS> & { Charas: Chara[], Costumes: unknown[], Decos: unknown[], Emblems: unknown[], EventRewards: unknown[], IsLeave: boolean, IsRebuy: boolean, Items: Item[], Money: { FreeMoney: number, PaidMoney: number }, Ranking: number, RankReward?: RankReward, Rewards: Reward[], RingReward?: RingReward, TotalMatch: number } :
  T extends ApiType.EVT_STAMP_RECEIVED ? ApiEventBase<ApiType.EVT_STAMP_RECEIVED> & { SeatIndex: number, StampId: string } :
  T extends ApiType.EVT_HAND_COMPLETED ? ApiEventBase<ApiType.EVT_HAND_COMPLETED> & { NotifyCode: number } :
  T extends ApiType.EVT_PLAYER_SEAT_ASSIGNED ? ApiEventBase<ApiType.EVT_PLAYER_SEAT_ASSIGNED> & { ProcessType: number, TableUsers: TableUser[], SeatUserIds: number[], CommunityCards?: number[], Player?: Player, OtherPlayers?: OtherPlayer[], Game?: Game, Progress?: Progress } :
  T extends ApiType.EVT_REWARD_CHANGED ? ApiEventBase<ApiType.EVT_REWARD_CHANGED> & { RankingRewards: RankingReward[] } :
  T extends ApiType.EVT_BLIND_RAISED ? ApiEventBase<ApiType.EVT_BLIND_RAISED> & { Ante: number, BigBlind: number, CurrentBlindLv: number, NextBlindUnixSeconds: number, SmallBlind: number } :
  T extends ApiType.EVT_ENTRY_COMPLETED ? ApiEventBase<ApiType.EVT_ENTRY_COMPLETED> & { MatchUserNum: number } :
  never

export interface Hand {
  /** `EVT_HAND_RESULTS`まで未確定 */
  id: number
  approxTimestamp?: number
  seatUserIds: number[]
  winningPlayerIds: number[]
  smallBlind: number
  bigBlind: number
  session: Omit<Session, 'reset'>
  results: Result[]
}

export interface Phase {
  handId?: number
  phase: PhaseType
  seatUserIds: number[]
  communityCards: number[]
}

enum Position {
  BB = -2,
  SB = -1,
  BTN = 0,
  CO = 1,
  HJ = 2,
  UTG = 3,
}

enum ActionDetail {
  ALL_IN = 'ALL_IN',
  VPIP = 'VPIP',
  CBET = 'CBET',
  CBET_CHANCE = 'CBET_CHANCE',
  CBET_FOLD = 'CBET_FOLD',
  CBET_FOLD_CHANCE = 'CBET_FOLD_CHANCE',
  $3BET = '3BET',
  $3BET_CHANCE = '3BET_CHANCE',
  $3BET_FOLD = '3BET_FOLD',
  $3BET_FOLD_CHANCE = '3BET_FOLD_CHANCE',
}

export interface Action {
  handId?: number
  index: number
  playerId: number
  phase: PhaseType
  actionType: Exclude<ActionType, ActionType.ALL_IN>
  bet: number
  pot: number
  sidePot: number[]
  position: Position
  actionDetails: ActionDetail[]
}

export class PokerChaseDB extends Dexie {
  apiEvents!: Table<ApiEvent, number>
  hands!: Table<Hand, number>
  phases!: Table<Phase, number>
  actions!: Table<Action, number>
  constructor(indexedDB: IDBFactory, iDBKeyRange: typeof IDBKeyRange) {
    super('PokerChaseDB', { indexedDB, IDBKeyRange: iDBKeyRange })
    this.version(1).stores({
      /** @see https://dexie.org/docs/Version/Version.stores() */
      apiEvents: '[timestamp+ApiTypeId],timestamp,ApiTypeId',
      hands: 'id,*seatUserIds,*winningPlayerIds',
      phases: '[handId+phase],handId,*seatUserIds,phase',
      actions: '[handId+index],handId,playerId,phase,actionType,*actionDetails',
    })
  }
}

type ApiHandEvent = ApiEvent<ApiType.EVT_DEAL | ApiType.EVT_ACTION | ApiType.EVT_DEAL_ROUND | ApiType.EVT_HAND_RESULTS>
type TransformCallback<T> = (error?: Error | null, data?: T) => void

/**
 * `ApiEvent`をHand単位で集約
 * - Hand: `ApiType.EVT_DEAL` ~ `ApiType.EVT_HAND_RESULTS`
 * - ログ順序を保証するため同期的実行
 */
class AggregateEventsStream extends Transform {
  private service: PokerChaseService
  private events: ApiHandEvent[] = []
  private progress?: Progress
  private lastTimestamp = 0
  constructor(service: PokerChaseService) {
    super({ objectMode: true })
    this.service = service
  }
  _transform(event: ApiEvent, _: string, callback: TransformCallback<ApiEvent[]>) {
    try {
      /** 順序整合性チェック */
      if (this.lastTimestamp > event.timestamp!)
        this.events = []
      switch (event.ApiTypeId) {
        case ApiType.RES_ENTRY_QUEUED:
          this.service.session.reset()
          this.service.session.id = event.Id
          this.service.session.battleType = event.BattleType
          break
        case ApiType.EVT_SESSION_DETAILS:
          this.service.session.name = event.Name
          break
        case ApiType.EVT_DEAL:
          this.progress = event.Progress
          this.events = []
          this.events.push(event)
          this.service.playerId = event.Player?.SeatIndex
            ? event.SeatUserIds.at(event.Player.SeatIndex)
            : undefined
          break
        case ApiType.EVT_DEAL_ROUND:
          this.progress = event.Progress
          this.events.push(event)
          break
        case ApiType.EVT_ACTION:
          /** 順序整合性チェック */
          if (this.progress && this.progress.NextActionSeat !== event.SeatIndex)
            this.events = []
          this.progress = event.Progress
          this.events.push(event)
          break
        case ApiType.EVT_HAND_RESULTS:
          this.events.push(event)
          if (this.events[0].ApiTypeId === ApiType.EVT_DEAL)
            this.push(this.events)
          break
      }
      callback()
    } catch (error: unknown) {
      if (error instanceof Error) {
        callback(error)
      } else {
        callback({ name: 'UNKNOWN_ERROR', message: JSON.stringify(error) })
      }
    }
  }
}

interface HandState {
  hand: Hand
  actions: Action[]
  phases: Phase[]
}

interface ExistPlayerStats {
  playerId: number
  hands: number
  vpip: [top: number, bottom: number]
  pfr: [top: number, bottom: number]
  flopCB: [top: number, bottom: number]
  $3Bet: [top: number, bottom: number]
  $3BetFold: [top: number, bottom: number]
  af: [top: number, bottom: number]
  afq: [top: number, bottom: number]
  /** Went to Showdown: (Total Times Went to Showdown / Total Times Saw The Flop) includes PREFLOP ALL_IN  */
  wtsd: [top: number, bottom: number]
  /** Won When Saw Flop: (Total times Won Money after seeing the Flop / Total Times Saw The Flop) excludes PREFLOP ALL_IN */
  wwsf: [top: number, bottom: number]
  /** Won Money At Showdown: (Total Times Won Money at Showdown / Total Times Went to Showdown) includes PREFLOP ALL_IN */
  w$sd: [top: number, bottom: number]
}

export type PlayerStats = ExistPlayerStats | { playerId: -1 }

class WriteEntityStream extends Transform {
  private service: PokerChaseService
  constructor(service: PokerChaseService) {
    super({ objectMode: true })
    this.service = service
  }
  async _transform(events: ApiHandEvent[], _: string, callback: TransformCallback<number[]>) {
    try {
      const { hand, actions, phases } = this.toHandState(events)
      await this.service.db.transaction('rw', this.service.db.hands, this.service.db.phases, this.service.db.actions, () => {
        return Promise.all([
          this.service.db.hands.put(hand),
          this.service.db.actions.bulkPut(actions),
          this.service.db.phases.bulkPut(phases)
        ])
      })
      /** @todo reporting */
      callback(null, hand.seatUserIds)
    } catch (error: unknown) {
      if (error instanceof Dexie.DexieError) {
        callback({ name: error.name, message: error.message })
      } else if (error instanceof Error) {
        callback(error)
      } else {
        callback({ name: 'UNKNOWN_ERROR', message: JSON.stringify(error) })
      }
    }
  }
  private toHandState = (events: ApiHandEvent[]): HandState => {
    const positionUserIds = []
    const handState: HandState = {
      hand: {
        session: {
          id: this.service.session.id,
          battleType: this.service.session.battleType,
          name: this.service.session.name
        },
        id: NaN,
        approxTimestamp: NaN,
        seatUserIds: [],
        winningPlayerIds: [],
        bigBlind: NaN,
        smallBlind: NaN,
        results: []
      },
      actions: [],
      phases: [],
    }
    let cBetter: number | undefined
    let progress: Progress | undefined
    for (const event of events) {
      switch (event.ApiTypeId) {
        case ApiType.EVT_DEAL:
          handState.hand.seatUserIds = event.SeatUserIds
          /** [SB, BB, UTG, HJ, CO, BTN] */
          positionUserIds.push(...PokerChaseService.rotateElementFromIndex(event.SeatUserIds, event.Game.BigBlindSeat + 1).reverse())
          handState.phases.push({
            phase: event.Progress.Phase,
            seatUserIds: event.SeatUserIds,
            communityCards: [],
          })
          handState.hand.bigBlind = event.Game.BigBlind
          handState.hand.smallBlind = event.Game.SmallBlind
          progress = event.Progress
          break
        case ApiType.EVT_DEAL_ROUND:
          handState.phases.push({
            phase: event.Progress.Phase,
            seatUserIds: (event.Player ? [event.Player, ...event.OtherPlayers] : event.OtherPlayers)
              .filter(({ BetStatus }) => BetStatus === BetStatusType.BET_ABLE)
              .sort((a, b) => a.SeatIndex - b.SeatIndex)
              .map(({ SeatIndex }) => handState.hand.seatUserIds.at(SeatIndex)!),
            communityCards: [...handState.phases.at(-1)!.communityCards, ...event.CommunityCards],
          })
          progress = event.Progress
          break
        case ApiType.EVT_ACTION:
          const actionDetails: ActionDetail[] = []
          /** `ALL_IN` to `BET`,`RAISE`,`CALL`変換 */
          const actionType: Exclude<ActionType, ActionType.ALL_IN> = (({ ActionType: actionType }: typeof event) => {
            if (actionType === ActionType.ALL_IN) {
              actionDetails.push(ActionDetail.ALL_IN)
              if (progress?.NextActionTypes.includes(ActionType.BET)) {
                return ActionType.BET
              } else if (progress?.NextActionTypes.includes(ActionType.CALL)) {
                return ActionType.RAISE
              } else {
                return ActionType.CALL
              }
            } else {
              return actionType
            }
          })(event)
          const playerId = handState.hand.seatUserIds[event.SeatIndex]
          const phase = handState.phases.at(-1)!.phase /** `event.Progress.Phase`: 不正確 */
          const phaseActions = handState.actions.filter(action => action.phase === phase)
          const phasePlayerActionIndex = phaseActions.filter(action => action.playerId === playerId).length
          const phasePrevBetCount = phaseActions.filter(action => [ActionType.BET, ActionType.RAISE].includes(action.actionType)).length + Number(phase === PhaseType.PREFLOP)
          /** VPIP 判定 */
          if (phase === PhaseType.PREFLOP && phasePlayerActionIndex === 0 && [ActionType.RAISE, ActionType.CALL].includes(actionType))
            actionDetails.push(ActionDetail.VPIP)
          /** 3BET 判定 */
          if (phasePrevBetCount === 2) {
            actionDetails.push(ActionDetail.$3BET_CHANCE)
            if (ActionType.RAISE === actionType) {
              actionDetails.push(ActionDetail.$3BET)
            }
          }
          /** 3BETFOLD 判定 */
          if (phasePrevBetCount === 3) {
            actionDetails.push(ActionDetail.$3BET_FOLD_CHANCE)
            if (ActionType.FOLD === actionType) {
              actionDetails.push(ActionDetail.$3BET_FOLD)
            }
          }
          /**
           * CBet, CBetFOLD 判定
           *
           * CBet: A continuation bet is opening the betting on a street when you made the last bet or raise on the previous street.
           * Normally this means being the preflop raiser and opening the betting on the flop, but is extended to the turn and river while you retain the initiative.
           * You can only make a continuation bet on the turn if you made one on the flop; and on the river if you made one on the turn.
           *
           * You can only make a continuation bet if you made a continuation bet on all previous streets.
           * (FLOP CBetしない限り、TURN CBetの機会はない)
           * (TURN CBetしない限り、RIVER CBetの機会はない)
           */
          if (PhaseType.PREFLOP === phase) {
            if (ActionType.RAISE === actionType) {
              cBetter = playerId /** PREFLOPで最後にRAISEしたプレイヤー */
            }
          } else if (cBetter) {
            if (phasePrevBetCount === 0) {
              if (cBetter === playerId) {
                actionDetails.push(ActionDetail.CBET_CHANCE)
                if (ActionType.BET === actionType) {
                  actionDetails.push(ActionDetail.CBET)
                } else {
                  cBetter = undefined
                }
              } else {
                if (ActionType.BET === actionType) {
                  cBetter = undefined
                }
              }
            } else if (phasePrevBetCount === 1) {
              actionDetails.push(ActionDetail.CBET_FOLD_CHANCE)
              if (ActionType.FOLD === actionType) {
                actionDetails.push(ActionDetail.CBET_FOLD)
              }
            }
          }
          handState.actions.push({
            playerId,
            phase,
            index: handState.actions.length,
            actionType,
            bet: event.BetChip,
            pot: event.Progress.Pot,
            sidePot: event.Progress.SidePot,
            position: positionUserIds.indexOf(playerId) - 2, /** @see Position */
            actionDetails,
          })
          progress = event.Progress
          break
        case ApiType.EVT_HAND_RESULTS:
          if (event.Results.length > 1) {
            handState.phases.push({
              phase: PhaseType.SHOWDOWN,
              communityCards: [...handState.phases.at(-1)!.communityCards, ...event.CommunityCards],
              seatUserIds: event.Results.map(({ UserId }) => UserId),
            })
          }
          handState.hand.id = event.HandId
          handState.hand.winningPlayerIds = event.Results.filter(({ HandRanking }) => HandRanking === 1).map(({ UserId }) => UserId)
          handState.hand.approxTimestamp = event.timestamp
          handState.hand.results = event.Results
          handState.actions = handState.actions.map(action => ({ ...action, handId: event.HandId }))
          handState.phases = handState.phases.map(phase => ({ ...phase, handId: event.HandId }))
          break
      }
    }
    return handState
  }
}

class ReadEntityStream extends Transform {
  private service: PokerChaseService
  constructor(service: PokerChaseService) {
    super({ objectMode: true })
    this.service = service
  }
  async _transform(seatUserIds: number[], _: string, callback: TransformCallback<PlayerStats[]>) {
    try {
      /**
       * `rw!`, `rw?` は Service Worker で機能しない??
       * @see https://dexie.org/docs/Dexie/Dexie.transaction()
       */
      const stats = await this.service.db.transaction('r', this.service.db.hands, this.service.db.phases, this.service.db.actions, async tx => {
        return this.service.playerId
          /** 表示位置のため、自身を起点にSort */
          ? await this.calcStats(PokerChaseService.rotateElementFromIndex(seatUserIds, seatUserIds.indexOf(this.service.playerId)))
          : await this.calcStats(seatUserIds)
      })
      callback(null, stats)
    } catch (error: unknown) {
      if (error instanceof Dexie.DexieError) {
        callback({ name: error.name, message: error.message })
      } else if (error instanceof Error) {
        callback(error)
      } else {
        callback({ name: 'UNKNOWN_ERROR', message: JSON.stringify(error) })
      }
    }
  }
  /** @see https://www.pokertracker.com/guides/PT3/general/statistical-reference-guide */
  private calcStats = async (seatUserIds: number[]): Promise<PlayerStats[]> => {
    return await Promise.all(seatUserIds.map(async playerId => {
      if (playerId === -1)
        return { playerId: -1 }
      const [
        handsCount,
        voluntarilyHandsCount,
        pfrHandsCount,
        flopCBChanceHandsCount,
        flopCBHandsCount,
        $3BetChanceHandsCount,
        $3BetHandsCount,
        $3BetFoldChanceHandsCount,
        $3BetFoldHandsCount,
        betRaiseActionsCount,
        callActionsCount,
        exceptCheckActionsCount,
        flopPhases,
        showdownPhases,
      ] = await Promise.all([
        this.service.db.hands.where({ seatUserIds: playerId }).count(),
        this.service.db.actions.where({ playerId, phase: PhaseType.PREFLOP, actionDetails: ActionDetail.VPIP }).count(),
        this.service.db.actions.where({ playerId, phase: PhaseType.PREFLOP, actionType: ActionType.RAISE }).toArray().then(actions => [...new Set(actions.map(({ handId }) => handId))].length),
        this.service.db.actions.where({ playerId, phase: PhaseType.FLOP, actionDetails: ActionDetail.CBET_CHANCE }).count(),
        this.service.db.actions.where({ playerId, phase: PhaseType.FLOP, actionDetails: ActionDetail.CBET }).count(),
        this.service.db.actions.where({ playerId, actionDetails: ActionDetail.$3BET_CHANCE }).count(),
        this.service.db.actions.where({ playerId, actionDetails: ActionDetail.$3BET }).count(),
        this.service.db.actions.where({ playerId, actionDetails: ActionDetail.$3BET_FOLD_CHANCE }).count(),
        this.service.db.actions.where({ playerId, actionDetails: ActionDetail.$3BET_FOLD }).count(),
        this.service.db.actions.where({ playerId }).and(({ actionType }) => [ActionType.BET, ActionType.RAISE].includes(actionType)).count(),
        this.service.db.actions.where({ playerId }).and(({ actionType }) => actionType === ActionType.CALL).count(),
        this.service.db.actions.where({ playerId }).and(({ actionType }) => actionType !== ActionType.CHECK).count(),
        this.service.db.phases.where({ seatUserIds: playerId, phase: PhaseType.FLOP }).toArray(),
        this.service.db.phases.where({ seatUserIds: playerId, phase: PhaseType.SHOWDOWN }).toArray(),
      ])
      const [
        wonMoneyAfterSeeingFlopHandsCount,
        wonMoneyAtShowdownHandsCount
      ] = await Promise.all([
        this.service.db.hands.where('id').anyOf(flopPhases.map(({ handId }) => handId!)).and(hand => hand.winningPlayerIds.includes(playerId)).count(),
        this.service.db.hands.where('id').anyOf(showdownPhases.map(({ handId }) => handId!)).and(hand => hand.winningPlayerIds.includes(playerId)).count()
      ])
      return {
        hands: handsCount,
        vpip: [voluntarilyHandsCount, handsCount],
        pfr: [pfrHandsCount, handsCount],
        flopCB: [flopCBHandsCount, flopCBChanceHandsCount],
        $3Bet: [$3BetHandsCount, $3BetChanceHandsCount],
        $3BetFold: [$3BetFoldHandsCount, $3BetFoldChanceHandsCount],
        af: [betRaiseActionsCount, callActionsCount],
        afq: [betRaiseActionsCount, exceptCheckActionsCount],
        wtsd: [showdownPhases.length, [...new Set([...flopPhases, ...showdownPhases].map(({ handId }) => handId!))].length],
        wwsf: [wonMoneyAfterSeeingFlopHandsCount, flopPhases.length],
        w$sd: [wonMoneyAtShowdownHandsCount, showdownPhases.length],
        playerId,
      }
    }))
  }
}

interface Session {
  id?: string
  battleType?: BattleType
  name?: string
  reset: () => void
}

class PokerChaseService {
  playerId?: number
  static readonly POKER_CHASE_SERVICE_EVENT = 'PokerChaseServiceEvent'
  static readonly POKER_CHASE_ORIGIN = new URL(content_scripts[0].matches[0]).origin
  readonly session: Session = {
    id: undefined,
    battleType: undefined,
    name: undefined,
    reset: function () {
      this.id = undefined
      this.battleType = undefined
      this.name = undefined
    }
  }
  readonly db
  readonly inputStream = new AggregateEventsStream(this)
  readonly stream = new ReadEntityStream(this)
  constructor({ db, playerId }: { db: PokerChaseDB, playerId?: number }) {
    this.playerId = playerId
    this.db = db
    this.inputStream
      .pipe<WriteEntityStream>(new WriteEntityStream(this))
      .pipe<ReadEntityStream>(this.stream)
  }
  readonly queueEvent = (event: ApiEvent) => {
    switch (event.ApiTypeId) {
      case ApiType.EVT_SESSION_RESULTS:
      case ApiType.RES_LEAVE_COMPLETED:
        this.stream.pause() /** HUD非表示 */
        break
      case ApiType.EVT_PLAYER_SEAT_ASSIGNED:
      case ApiType.EVT_DEAL:
        this.playerId = event.Player?.SeatIndex ? event.SeatUserIds[event.Player.SeatIndex] : undefined
        this.stream.resume() /** HUD表示 */
        this.stream.write(event.SeatUserIds)
        break
    }
    this.inputStream.write(event)
    /** レコード再構築用生ログ: 同期的に利用しないため Promise 投げっぱなし */
    this.db.apiEvents.add(event)
      .catch(console.error)
      .finally(() => this.eventLogger(event))
  }
  readonly refreshDatabase = () => {
    // this.db.apiEvents.each(event => ...) /** Anti-Pattern: Cannot enter a sub-transaction with READWRITE mode when parent transaction is READONLY */
    const input = new AggregateEventsStream(this)
    input.pipe(new WriteEntityStream(this)).on('data', () => { }) /** /dev/null consumer */
    this.db.apiEvents.count()
      .then(async count => {
        let offset = 0
        while (offset < count) {
          const apiEvents = await this.db.apiEvents.offset(offset).limit(1000).toArray()
          apiEvents.forEach(event => input.write(event))
          offset += apiEvents.length
        }
      })
      .catch(console.error)
  }
  private eventLogger = (event: ApiEvent) => {
    const timestamp = event.timestamp
      ? new Date(event.timestamp).toISOString().slice(11, 22)
      : new Date().toISOString().slice(11, 22)
    ApiType[event.ApiTypeId]
      ? console.debug(`[${timestamp}]`, event.ApiTypeId, ApiType[event.ApiTypeId], event)
      : console.warn(`[${timestamp}]`, event.ApiTypeId, ApiType[event.ApiTypeId], event)
  }
  static readonly rotateElementFromIndex = <T>(elements: T[], index: number): T[] => {
    return [
      ...elements.slice(index, Infinity),
      ...elements.slice(0, index)
    ]
  }
  static readonly toCardStr = (cards: number[]) => {
    const suits = ['s', 'h', 'd', 'c']
    const numbers = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']
    return cards.map(card => `${numbers.at(Math.floor(card / 4))}${suits.at(card % 4)}`)
  }
}

export default PokerChaseService
