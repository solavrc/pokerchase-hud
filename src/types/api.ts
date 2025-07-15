/**
 * API Event Types and Related Definitions
 */

import type { BattleType } from './game'
import type { Game, Player, OtherPlayer, JoinPlayer, Progress, BlindStructure, Item, EventDetail, Result, Reward, RankingReward, RankReward, RingReward, Chara, TableUser } from './entities'

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
   * - SitAndGo(ランク戦): { "ApiTypeId": 201, "Code": 0, "BattleType": 0, "Id": "new_stage007_010" }
   * - MTT: { "ApiTypeId": 201, "Code": 0, "BattleType": 1, "Id": "3164" }
   * - Ring: { "ApiTypeId": 201, "Code": 0, "BattleType": 4, "Id": "10_20_0001" }
   * - PrivateTable: { "ApiTypeId": 201, "Code": 0, "BattleType": 5, "Id": "" }
   * - ClubMatch: { "ApiTypeId": 201, "Code": 0, "BattleType": 6, "Id": "club_match_xxx" }
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

export interface ApiEventBase<T extends ApiType> {
  ApiTypeId: T
  timestamp?: number
}

export type ApiEvent<T extends ApiType = ApiType> =
  T extends ApiType.RES_ENTRY_QUEUED ? ApiEventBase<ApiType.RES_ENTRY_QUEUED> & { Code: 0, BattleType: BattleType, Id: string, IsRetire?: boolean } :
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
  T extends ApiType.EVT_HAND_RESULTS ? ApiEventBase<ApiType.EVT_HAND_RESULTS> & { CommunityCards: number[], DefeatStatus: number, HandId: number, HandLog?: string, OtherPlayers: OtherPlayer[], Player?: Omit<Player, 'HoleCards'>, Pot: number, Results: Result[], ResultType: number, SidePot: number[] } :
  T extends ApiType.EVT_SESSION_STARTED ? ApiEventBase<ApiType.EVT_SESSION_STARTED> :
  T extends ApiType.EVT_SESSION_DETAILS ? ApiEventBase<ApiType.EVT_SESSION_DETAILS> & { BlindStructures: BlindStructure[], CoinNum: number, DefaultChip: number, IsReplay: boolean, Items: EventDetail[], LimitSeconds: number, Name: string, Name2: string, MoneyList?: unknown[], RingRule?: { MinBuyin: number, MaxBuyin: number }, TournamentRule?: { RebuyLimit: number, RebuyCostCoinNum: number, RebuyCostTicket: { ItemId: string, Num: number }, RebuyChip: number, RebuyFinishUnixSeconds: number, NextBreakUnixSeconds: number }, RankingRewards?: RankingReward[] } :
  T extends ApiType.EVT_SESSION_RESULTS ? ApiEventBase<ApiType.EVT_SESSION_RESULTS> & { Charas: Chara[], Costumes: unknown[], Decos: unknown[], Emblems: unknown[], EventRewards: unknown[], IsLeave: boolean, IsRebuy: boolean, Items: Item[], Money: { FreeMoney: number, PaidMoney: number }, Ranking: number, RankReward?: RankReward, Rewards: Reward[], RingReward?: RingReward, TotalMatch: number, IsSeasonOver: boolean, BattleFinishTime: number, IsCountOverRingMedal: boolean, TargetBlindLv?: number, ResultChip?: number, PopupTitleTextKey?: string, PopupMessageTextKey?: string } :
  T extends ApiType.EVT_STAMP_RECEIVED ? ApiEventBase<ApiType.EVT_STAMP_RECEIVED> & { SeatIndex: number, StampId: string } :
  T extends ApiType.EVT_HAND_COMPLETED ? ApiEventBase<ApiType.EVT_HAND_COMPLETED> & { NotifyCode: number } :
  T extends ApiType.EVT_PLAYER_SEAT_ASSIGNED ? ApiEventBase<ApiType.EVT_PLAYER_SEAT_ASSIGNED> & { ProcessType: number, TableUsers: TableUser[], SeatUserIds: number[], CommunityCards?: number[], Player?: Player, OtherPlayers?: OtherPlayer[], Game?: Game, Progress?: Progress, IsLeave?: boolean, IsSafeLeave?: boolean, IsRetire?: boolean, BreakFinishUnixSeconds?: number } :
  T extends ApiType.EVT_REWARD_CHANGED ? ApiEventBase<ApiType.EVT_REWARD_CHANGED> & { RankingRewards: RankingReward[] } :
  T extends ApiType.EVT_BLIND_RAISED ? ApiEventBase<ApiType.EVT_BLIND_RAISED> & { Ante: number, BigBlind: number, CurrentBlindLv: number, NextBlindUnixSeconds: number, SmallBlind: number, TargetBlindLv?: number } :
  T extends ApiType.EVT_ENTRY_COMPLETED ? ApiEventBase<ApiType.EVT_ENTRY_COMPLETED> & { MatchUserNum: number } :
  never

export type ApiHandEvent = ApiEvent<ApiType.EVT_DEAL | ApiType.EVT_ACTION | ApiType.EVT_DEAL_ROUND | ApiType.EVT_HAND_RESULTS>

// Import ActionType from game types
import type { ActionType } from './game'
