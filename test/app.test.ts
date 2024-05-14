import { ApiResponse, PlayerStats, PokerChaseDB, PokerChaseService } from '../src/app'
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'

const event_timeline: ApiResponse[] = [
  { "timestamp": 0, "ApiTypeId": 201, "Code": 0, "BattleType": 0, "Id": "new_stage007_010" },
  { "timestamp": 1, "ApiTypeId": 319, "MatchUserNum": 6 },
  { "timestamp": 2, "ApiTypeId": 307 },
  { "timestamp": 3, "ApiTypeId": 203, "Code": 0 },
  { "timestamp": 4, "ApiTypeId": 213, "Code": 0, "IsCancel": false },
  { "timestamp": 5, "ApiTypeId": 308, "CoinNum": -1, "Items": [{ "ItemId": "season10_point", "Num": 9 }], "Name": "シーズンマッチ", "Name2": "6人対戦【シーズン10】", "DefaultChip": 20000, "LimitSeconds": 8, "IsReplay": true, "BlindStructures": [{ "Lv": 1, "ActiveMinutes": 4, "BigBlind": 200, "Ante": 50 }, { "Lv": 2, "ActiveMinutes": 4, "BigBlind": 280, "Ante": 70 }, { "Lv": 3, "ActiveMinutes": 4, "BigBlind": 400, "Ante": 100 }, { "Lv": 4, "ActiveMinutes": 4, "BigBlind": 560, "Ante": 140 }, { "Lv": 5, "ActiveMinutes": 4, "BigBlind": 780, "Ante": 200 }, { "Lv": 6, "ActiveMinutes": 4, "BigBlind": 1100, "Ante": 280 }, { "Lv": 7, "ActiveMinutes": 4, "BigBlind": 1640, "Ante": 410 }, { "Lv": 8, "ActiveMinutes": 4, "BigBlind": 2500, "Ante": 630 }, { "Lv": 9, "ActiveMinutes": 4, "BigBlind": 3800, "Ante": 950 }, { "Lv": 10, "ActiveMinutes": 4, "BigBlind": 5700, "Ante": 1400 }, { "Lv": 11, "ActiveMinutes": 4, "BigBlind": 8600, "Ante": 2200 }, { "Lv": 12, "ActiveMinutes": 4, "BigBlind": 13000, "Ante": 3200 }, { "Lv": 13, "ActiveMinutes": 4, "BigBlind": 19600, "Ante": 4900 }, { "Lv": 14, "ActiveMinutes": 4, "BigBlind": 29500, "Ante": 7400 }, { "Lv": 15, "ActiveMinutes": 4, "BigBlind": 44300, "Ante": 11000 }, { "Lv": 16, "ActiveMinutes": -1, "BigBlind": 60000, "Ante": 15000 }] },
  { "timestamp": 6, "ApiTypeId": 313, "ProcessType": 0, "TableUsers": [{ "UserId": 583654032, "UserName": "シュレディンガー", "FavoriteCharaId": "nj_chara0002", "CostumeId": "nj_costume00022", "EmblemId": "emblem0003", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0001", "fn_ta_deco0007", "fn_t_deco0005", "b_deco0001", "f_deco0001", "eal_deco0002", "esw_deco0007"] }, { "UserId": 561384657, "UserName": "sola", "FavoriteCharaId": "chara0010", "CostumeId": "costume00101", "EmblemId": "emblem0001", "Rank": { "RankId": "diamond", "RankName": "ダイヤモンド", "RankLvId": "diamond", "RankLvName": "ダイヤモンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0001", "ta_deco0001", "t_deco0009", "b_deco0001", "f_deco0001", "eal_deco0001", "esw_deco0001"] }, { "UserId": 750532695, "UserName": "ちいまう", "FavoriteCharaId": "chara0022", "CostumeId": "costume00221", "EmblemId": "emblem0001", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0014", "ta_deco0001", "t_deco0012", "b_deco0001", "f_deco0001", "eal_deco0001", "esw_deco0006"] }, { "UserId": 172432670, "UserName": "ラロムジ", "FavoriteCharaId": "chara0001", "CostumeId": "costume00012", "EmblemId": "emblem0001", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0001", "ta_deco0001", "t_deco0001", "b_deco0001", "f_deco0001", "eal_deco0001", "esw_deco0001"] }, { "UserId": 575402650, "UserName": "夜菊0721", "FavoriteCharaId": "chara0021", "CostumeId": "costume00212", "EmblemId": "emblem0001", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0069", "ta_deco0055", "t_deco0069", "bg_deco0006", "f_deco0001", "eal_deco0007", "esw_deco0001"] }, { "UserId": 619317634, "UserName": "ぽちこん", "FavoriteCharaId": "chara0009", "CostumeId": "costume00092", "EmblemId": "emblem0001", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0062", "ta_deco0018", "t_deco0058", "b_deco0001", "f_deco0001", "eal_deco0002", "esw_deco0001"] }], "SeatUserIds": [583654032, 619317634, 561384657, 575402650, 750532695, 172432670] },
  { "timestamp": 7, "ApiTypeId": 204, "Code": 0 },
  // PokerChase Hand #175859516:  Hold'em No Limit (100/200)
  // Table '$Tournament_ID' 6-max Seat #6 is the button
  // Seat 1: id583654032 (15000 in chips)
  // Seat 2: id619317634 (15000 in chips)
  // Seat 3: id561384657 (15000 in chips)
  // Seat 4: id575402650 (15000 in chips)
  // Seat 5: id750532695 (15000 in chips)
  // Seat 6: id172432670 (15000 in chips)
  // id583654032: posts the ante 50
  // id619317634: posts the ante 50
  // id561384657: posts the ante 50
  // id575402650: posts the ante 50
  // id750532695: posts the ante 50
  // id172432670: posts the ante 50
  // id583654032: posts small blind 100
  // id619317634: posts big blind 200
  // *** HOLE CARDS ***
  // Dealt to id561384657 [Jh Ac]
  { "timestamp": 8, "ApiTypeId": 303, "SeatUserIds": [583654032, 619317634, 561384657, 575402650, 750532695, 172432670], "Game": { "CurrentBlindLv": 1, "NextBlindUnixSeconds": 1712648642, "Ante": 50, "SmallBlind": 100, "BigBlind": 200, "ButtonSeat": 5, "SmallBlindSeat": 0, "BigBlindSeat": 1 }, "Player": { "SeatIndex": 2, "BetStatus": 1, "HoleCards": [37, 51], "Chip": 19950, "BetChip": 0 }, "OtherPlayers": [{ "SeatIndex": 0, "Status": 0, "BetStatus": 1, "Chip": 19850, "BetChip": 100 }, { "SeatIndex": 1, "Status": 0, "BetStatus": 1, "Chip": 19750, "BetChip": 200 }, { "SeatIndex": 3, "Status": 0, "BetStatus": 1, "Chip": 19950, "BetChip": 0 }, { "SeatIndex": 4, "Status": 0, "BetStatus": 1, "Chip": 19950, "BetChip": 0 }, { "SeatIndex": 5, "Status": 0, "BetStatus": 1, "Chip": 19950, "BetChip": 0 }], "Progress": { "Phase": 0, "NextActionSeat": 2, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 1, "MinRaise": 400, "Pot": 600, "SidePot": [] } },
  { "timestamp": 9, "ApiTypeId": 205, "Code": 0, "RestLimitSeconds": 8, "RestExtraLimitSeconds": 1 },
  { "timestamp": 10, "ApiTypeId": 310, "SeatIndex": 5, "StampId": "stamp0102" },
  { "timestamp": 11, "ApiTypeId": 202, "Code": 0 },
  // id561384657: raises 200 to 600
  { "timestamp": 12, "ApiTypeId": 304, "SeatIndex": 2, "ActionType": 4, "Chip": 19350, "BetChip": 600, "Progress": { "Phase": 0, "NextActionSeat": 3, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 1, "MinRaise": 1000, "Pot": 1200, "SidePot": [] } },
  // id575402650: folds
  { "timestamp": 13, "ApiTypeId": 304, "SeatIndex": 3, "ActionType": 2, "Chip": 19950, "BetChip": 0, "Progress": { "Phase": 0, "NextActionSeat": 4, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 1, "MinRaise": 1000, "Pot": 1200, "SidePot": [] } },
  // id750532695: folds
  { "timestamp": 14, "ApiTypeId": 304, "SeatIndex": 4, "ActionType": 2, "Chip": 19950, "BetChip": 0, "Progress": { "Phase": 0, "NextActionSeat": 5, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 1, "MinRaise": 1000, "Pot": 1200, "SidePot": [] } },
  // id172432670: raises 600 to 2400
  { "timestamp": 15, "ApiTypeId": 304, "SeatIndex": 5, "ActionType": 4, "Chip": 17550, "BetChip": 2400, "Progress": { "Phase": 0, "NextActionSeat": 0, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 1, "MinRaise": 4200, "Pot": 3600, "SidePot": [] } },
  // id583654032: folds
  { "timestamp": 16, "ApiTypeId": 304, "SeatIndex": 0, "ActionType": 2, "Chip": 19850, "BetChip": 100, "Progress": { "Phase": 0, "NextActionSeat": 1, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 1, "MinRaise": 4200, "Pot": 3600, "SidePot": [] } },
  // id619317634: raises 600 to 19950 and is all-in
  { "timestamp": 17, "ApiTypeId": 304, "SeatIndex": 1, "ActionType": 5, "Chip": 0, "BetChip": 19950, "Progress": { "Phase": 0, "NextActionSeat": 2, "NextActionTypes": [2, 5], "NextExtraLimitSeconds": 2, "MinRaise": 0, "Pot": 23350, "SidePot": [] } },
  { "timestamp": 18, "ApiTypeId": 205, "Code": 0, "RestLimitSeconds": 8, "RestExtraLimitSeconds": 2 },
  { "timestamp": 19, "ApiTypeId": 310, "SeatIndex": 1, "StampId": "stamp0904" },
  { "timestamp": 20, "ApiTypeId": 202, "Code": 0 },
  // id561384657: calls 19950 and is all-in
  { "timestamp": 21, "ApiTypeId": 304, "SeatIndex": 2, "ActionType": 5, "Chip": 0, "BetChip": 19950, "Progress": { "Phase": 0, "NextActionSeat": 5, "NextActionTypes": [2, 5], "NextExtraLimitSeconds": 2, "MinRaise": 0, "Pot": 42700, "SidePot": [] } },
  { "timestamp": 22, "ApiTypeId": 310, "SeatIndex": 5, "StampId": "stamp0107" },
  // id172432670: folds
  { "timestamp": 23, "ApiTypeId": 304, "SeatIndex": 5, "ActionType": 2, "Chip": 17550, "BetChip": 2400, "Progress": { "Phase": 3, "NextActionSeat": -2, "NextActionTypes": [], "NextExtraLimitSeconds": 0, "MinRaise": 0, "Pot": 42700, "SidePot": [] } },
  { "timestamp": 24, "ApiTypeId": 310, "SeatIndex": 1, "StampId": "stamp0911" },
  // *** FLOP *** [9h 7d 3c]
  // *** TURN *** [Ts]
  // *** RIVER *** [Jc]
  // *** SHOW DOWN ***
  // id561384657: shows [Jh Ac] (a pair of Jacks)
  // id561384657 collected 42700
  // id619317634: mucks hand
  // *** SUMMARY ***
  // Total pot 42700 | Rake 0
  // Board [9h 7d 3c Ts Jc]
  // Seat 1: id583654032 (small blind) folded before Flop
  // Seat 2: id619317634 (big blind) mucked
  // Seat 3: id561384657 showed [Ac Qs] and won (42700) with a pair of Jacks
  // Seat 4: id575402650 folded before Flop (didn't bet)
  // Seat 5: id750532695 folded before Flop (didn't bet)
  // Seat 6: id172432670 (button) folded before Flop
  { "timestamp": 25, "ApiTypeId": 306, "CommunityCards": [29, 22, 7, 32, 39], "Pot": 42700, "SidePot": [], "ResultType": 0, "DefeatStatus": 0, "HandId": 175859516, "Results": [{ "UserId": 561384657, "HoleCards": [37, 51], "RankType": 8, "Hands": [39, 37, 51, 32, 29], "HandRanking": 1, "Ranking": -2, "RewardChip": 42700 }, { "UserId": 619317634, "HoleCards": [1, 0], "RankType": 8, "Hands": [1, 0, 39, 32, 29], "HandRanking": -1, "Ranking": 6, "RewardChip": 0 }], "Player": { "SeatIndex": 2, "BetStatus": -1, "Chip": 42700, "BetChip": 0 }, "OtherPlayers": [{ "SeatIndex": 0, "Status": 0, "BetStatus": -1, "Chip": 19850, "BetChip": 0 }, { "SeatIndex": 1, "Status": 5, "BetStatus": -1, "Chip": 0, "BetChip": 0 }, { "SeatIndex": 3, "Status": 0, "BetStatus": -1, "Chip": 19950, "BetChip": 0 }, { "SeatIndex": 4, "Status": 0, "BetStatus": -1, "Chip": 19950, "BetChip": 0 }, { "SeatIndex": 5, "Status": 0, "BetStatus": -1, "Chip": 17550, "BetChip": 0 }] },
  { "timestamp": 26, "ApiTypeId": 311, "NotifyCode": 1 },
  { "timestamp": 27, "ApiTypeId": 310, "SeatIndex": 5, "StampId": "stamp0107" },
  { "timestamp": 28, "ApiTypeId": 204, "Code": 0 },
  // PokerChase Hand #175859726:  Hold'em No Limit (100/200)
  // Table '$Tournament_ID' 6-max Seat #1 is the button
  // Seat 1: id583654032 (42700 in chips)
  // Seat 3: id561384657 (19850 in chips)
  // Seat 4: id575402650 (19950 in chips)
  // Seat 5: id750532695 (19950 in chips)
  // Seat 6: id172432670 (17550 in chips)
  // id583654032: posts the ante 50
  // id561384657: posts the ante 50
  // id575402650: posts the ante 50
  // id750532695: posts the ante 50
  // id172432670: posts the ante 50
  // id561384657: posts small blind 100
  // id575402650: posts big blind 200
  // *** HOLE CARDS ***
  // Dealt to id561384657 [Tc 2c]
  { "timestamp": 29, "ApiTypeId": 303, "SeatUserIds": [583654032, -1, 561384657, 575402650, 750532695, 172432670], "Game": { "CurrentBlindLv": 1, "NextBlindUnixSeconds": 1712648642, "Ante": 50, "SmallBlind": 100, "BigBlind": 200, "ButtonSeat": 0, "SmallBlindSeat": 2, "BigBlindSeat": 3 }, "Player": { "SeatIndex": 2, "BetStatus": 1, "HoleCards": [35, 3], "Chip": 42550, "BetChip": 100 }, "OtherPlayers": [{ "SeatIndex": 0, "Status": 0, "BetStatus": 1, "Chip": 19800, "BetChip": 0 }, { "SeatIndex": 3, "Status": 0, "BetStatus": 1, "Chip": 19700, "BetChip": 200 }, { "SeatIndex": 4, "Status": 0, "BetStatus": 1, "Chip": 19900, "BetChip": 0 }, { "SeatIndex": 5, "Status": 0, "BetStatus": 1, "Chip": 17500, "BetChip": 0 }], "Progress": { "Phase": 0, "NextActionSeat": 4, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 2, "MinRaise": 400, "Pot": 550, "SidePot": [] } },
  // id750532695: folds
  { "timestamp": 30, "ApiTypeId": 304, "SeatIndex": 4, "ActionType": 2, "Chip": 19900, "BetChip": 0, "Progress": { "Phase": 0, "NextActionSeat": 5, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 3, "MinRaise": 400, "Pot": 550, "SidePot": [] } },
  // id172432670: raises 200 to 600
  { "timestamp": 31, "ApiTypeId": 304, "SeatIndex": 5, "ActionType": 4, "Chip": 16900, "BetChip": 600, "Progress": { "Phase": 0, "NextActionSeat": 0, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 2, "MinRaise": 1000, "Pot": 1150, "SidePot": [] } },
  // id583654032: folds
  { "timestamp": 32, "ApiTypeId": 304, "SeatIndex": 0, "ActionType": 2, "Chip": 19800, "BetChip": 0, "Progress": { "Phase": 0, "NextActionSeat": 2, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 3, "MinRaise": 1000, "Pot": 1150, "SidePot": [] } },
  { "timestamp": 33, "ApiTypeId": 205, "Code": 0, "RestLimitSeconds": 8, "RestExtraLimitSeconds": 3 },
  { "timestamp": 34, "ApiTypeId": 202, "Code": 0 },
  // id561384657: folds
  { "timestamp": 35, "ApiTypeId": 304, "SeatIndex": 2, "ActionType": 2, "Chip": 42550, "BetChip": 100, "Progress": { "Phase": 0, "NextActionSeat": 3, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 2, "MinRaise": 1000, "Pot": 1150, "SidePot": [] } },
  // id575402650: calls 600
  { "timestamp": 36, "ApiTypeId": 304, "SeatIndex": 3, "ActionType": 3, "Chip": 19300, "BetChip": 600, "Progress": { "Phase": 0, "NextActionSeat": -1, "NextActionTypes": [], "NextExtraLimitSeconds": 0, "MinRaise": 0, "Pot": 1550, "SidePot": [] } },
  // *** FLOP *** [2h 7h Ks]
  { "timestamp": 37, "ApiTypeId": 305, "CommunityCards": [1, 21, 44], "Player": { "SeatIndex": 2, "BetStatus": 2, "HoleCards": [35, 3], "Chip": 42550, "BetChip": 0 }, "OtherPlayers": [{ "SeatIndex": 0, "Status": 0, "BetStatus": 2, "Chip": 19800, "BetChip": 0 }, { "SeatIndex": 3, "Status": 0, "BetStatus": 1, "Chip": 19300, "BetChip": 0 }, { "SeatIndex": 4, "Status": 0, "BetStatus": 2, "Chip": 19900, "BetChip": 0 }, { "SeatIndex": 5, "Status": 0, "BetStatus": 1, "Chip": 16900, "BetChip": 0 }], "Progress": { "Phase": 1, "NextActionSeat": 3, "NextActionTypes": [0, 5, 1], "NextExtraLimitSeconds": 3, "MinRaise": 0, "Pot": 1550, "SidePot": [] } },
  // id575402650: checks
  { "timestamp": 38, "ApiTypeId": 304, "SeatIndex": 3, "ActionType": 0, "Chip": 19300, "BetChip": 0, "Progress": { "Phase": 1, "NextActionSeat": 5, "NextActionTypes": [0, 5, 1], "NextExtraLimitSeconds": 4, "MinRaise": 0, "Pot": 1550, "SidePot": [] } },
  // id172432670: checks
  { "timestamp": 39, "ApiTypeId": 304, "SeatIndex": 5, "ActionType": 0, "Chip": 16900, "BetChip": 0, "Progress": { "Phase": 1, "NextActionSeat": -1, "NextActionTypes": [], "NextExtraLimitSeconds": 0, "MinRaise": 0, "Pot": 1550, "SidePot": [] } },
  // *** TURN *** [8s]
  { "timestamp": 40, "ApiTypeId": 305, "CommunityCards": [24], "Player": { "SeatIndex": 2, "BetStatus": 2, "HoleCards": [35, 3], "Chip": 42550, "BetChip": 0 }, "OtherPlayers": [{ "SeatIndex": 0, "Status": 0, "BetStatus": 2, "Chip": 19800, "BetChip": 0 }, { "SeatIndex": 3, "Status": 0, "BetStatus": 1, "Chip": 19300, "BetChip": 0 }, { "SeatIndex": 4, "Status": 0, "BetStatus": 2, "Chip": 19900, "BetChip": 0 }, { "SeatIndex": 5, "Status": 0, "BetStatus": 1, "Chip": 16900, "BetChip": 0 }], "Progress": { "Phase": 2, "NextActionSeat": 3, "NextActionTypes": [0, 5, 1], "NextExtraLimitSeconds": 4, "MinRaise": 0, "Pot": 1550, "SidePot": [] } },
  // id575402650: checks
  { "timestamp": 41, "ApiTypeId": 304, "SeatIndex": 3, "ActionType": 0, "Chip": 19300, "BetChip": 0, "Progress": { "Phase": 2, "NextActionSeat": 5, "NextActionTypes": [0, 5, 1], "NextExtraLimitSeconds": 5, "MinRaise": 0, "Pot": 1550, "SidePot": [] } },
  // id172432670: checks
  { "timestamp": 42, "ApiTypeId": 304, "SeatIndex": 5, "ActionType": 0, "Chip": 16900, "BetChip": 0, "Progress": { "Phase": 2, "NextActionSeat": -1, "NextActionTypes": [], "NextExtraLimitSeconds": 0, "MinRaise": 0, "Pot": 1550, "SidePot": [] } },
  // *** RIVER *** [7c]
  { "timestamp": 43, "ApiTypeId": 305, "CommunityCards": [23], "Player": { "SeatIndex": 2, "BetStatus": 2, "HoleCards": [35, 3], "Chip": 42550, "BetChip": 0 }, "OtherPlayers": [{ "SeatIndex": 0, "Status": 0, "BetStatus": 2, "Chip": 19800, "BetChip": 0 }, { "SeatIndex": 3, "Status": 0, "BetStatus": 1, "Chip": 19300, "BetChip": 0 }, { "SeatIndex": 4, "Status": 0, "BetStatus": 2, "Chip": 19900, "BetChip": 0 }, { "SeatIndex": 5, "Status": 0, "BetStatus": 1, "Chip": 16900, "BetChip": 0 }], "Progress": { "Phase": 3, "NextActionSeat": 3, "NextActionTypes": [0, 5, 1], "NextExtraLimitSeconds": 5, "MinRaise": 0, "Pot": 1550, "SidePot": [] } },
  // id575402650: checks
  { "timestamp": 44, "ApiTypeId": 304, "SeatIndex": 3, "ActionType": 0, "Chip": 19300, "BetChip": 0, "Progress": { "Phase": 3, "NextActionSeat": 5, "NextActionTypes": [0, 5, 1], "NextExtraLimitSeconds": 6, "MinRaise": 0, "Pot": 1550, "SidePot": [] } },
  // id172432670: checks
  { "timestamp": 45, "ApiTypeId": 304, "SeatIndex": 5, "ActionType": 0, "Chip": 16900, "BetChip": 0, "Progress": { "Phase": 3, "NextActionSeat": -2, "NextActionTypes": [], "NextExtraLimitSeconds": 0, "MinRaise": 0, "Pot": 1550, "SidePot": [] } },
  // *** SHOW DOWN ***
  // id575402650: shows [2s 3s] (a pair of Jacks)
  // id575402650 collected 1550
  // id172432670: mucks hand
  // *** SUMMARY ***
  // Total pot 1550 | Rake 0
  // Board [2h 7h Ks 8s 7c]
  // Seat 1: id583654032 (button) folded before Flop (didn't bet)
  // Seat 3: id561384657 (small blind) folded before Flop (didn't bet)
  // Seat 4: id575402650 (big blind) showed [2s 3s] and won (1550) with two pair, Sevens and Dueces
  // Seat 5: id750532695 folded before Flop (didn't bet)
  // Seat 6: id172432670 mucked
  { "timestamp": 46, "ApiTypeId": 306, "CommunityCards": [], "Pot": 1550, "SidePot": [], "ResultType": 0, "DefeatStatus": 0, "HandId": 175859726, "Results": [{ "UserId": 575402650, "HoleCards": [0, 4], "RankType": 7, "Hands": [23, 21, 1, 0, 44], "HandRanking": 1, "Ranking": -2, "RewardChip": 1550 }, { "UserId": 172432670, "HoleCards": [], "RankType": 11, "Hands": [], "HandRanking": -1, "Ranking": -2, "RewardChip": 0 }], "Player": { "SeatIndex": 2, "BetStatus": -1, "Chip": 42550, "BetChip": 0 }, "OtherPlayers": [{ "SeatIndex": 0, "Status": 0, "BetStatus": -1, "Chip": 19800, "BetChip": 0 }, { "SeatIndex": 3, "Status": 0, "BetStatus": -1, "Chip": 20850, "BetChip": 0 }, { "SeatIndex": 4, "Status": 0, "BetStatus": -1, "Chip": 19900, "BetChip": 0 }, { "SeatIndex": 5, "Status": 0, "BetStatus": -1, "Chip": 16900, "BetChip": 0 }] },
  { "timestamp": 47, "ApiTypeId": 311, "NotifyCode": 1 },
  { "timestamp": 48, "ApiTypeId": 310, "SeatIndex": 5, "StampId": "stamp0107" },
]

const expected: PlayerStats[][] = [
  [
    { playerId: 561384657, hands: 1, vpip: 1, pfr: 1, threeBet: NaN, threeBetFold: NaN, wmsd: 1, wtsd: Infinity, af: Infinity, afq: 1 },
    { playerId: 575402650, hands: 1, vpip: 0, pfr: 0, threeBet: 0, threeBetFold: NaN, wmsd: NaN, wtsd: NaN, af: NaN, afq: 0 },
    { playerId: 750532695, hands: 1, vpip: 0, pfr: 0, threeBet: 0, threeBetFold: NaN, wmsd: NaN, wtsd: NaN, af: NaN, afq: 0 },
    { playerId: 172432670, hands: 1, vpip: 1, pfr: 1, threeBet: 1, threeBetFold: NaN, wmsd: NaN, wtsd: NaN, af: Infinity, afq: 0.5 },
    { playerId: 583654032, hands: 1, vpip: 0, pfr: 0, threeBet: NaN, threeBetFold: 1, wmsd: NaN, wtsd: NaN, af: NaN, afq: 0 },
    { playerId: 619317634, hands: 1, vpip: 1, pfr: 1, threeBet: NaN, threeBetFold: 0, wmsd: 0, wtsd: Infinity, af: Infinity, afq: 1 },
  ],
  [
    { playerId: 561384657, hands: 2, vpip: 0.5, pfr: 0.5, threeBet: 0, threeBetFold: NaN, wmsd: 1, wtsd: Infinity, af: Infinity, afq: 0.6666666666666666 },
    { playerId: 575402650, hands: 2, vpip: 0.5, pfr: 0, threeBet: 0, threeBetFold: NaN, wmsd: 1, wtsd: 1, af: 0, afq: 0 },
    { playerId: 750532695, hands: 2, vpip: 0, pfr: 0, threeBet: 0, threeBetFold: NaN, wmsd: NaN, wtsd: NaN, af: NaN, afq: 0 },
    { playerId: 172432670, hands: 2, vpip: 1, pfr: 1, threeBet: 1, threeBetFold: NaN, wmsd: 0, wtsd: 1, af: Infinity, afq: 0.6666666666666666 },
    { playerId: 583654032, hands: 2, vpip: 0, pfr: 0, threeBet: 0, threeBetFold: 1, wmsd: NaN, wtsd: NaN, af: NaN, afq: 0 },
    { playerId: -1, hands: 0, vpip: NaN, pfr: NaN, threeBet: NaN, threeBetFold: NaN, wmsd: NaN, wtsd: NaN, af: NaN, afq: NaN },
  ]
]

test('Stats can be calculated from event logs.', (done) => {
  const dbMock = new PokerChaseDB(indexedDB, IDBKeyRange)
  const service = new PokerChaseService({ db: dbMock })
  const actual: PlayerStats[][] = []
  service.stream.on('data', (hand: PlayerStats[]) => {
    actual.push(hand)
  })
  service.stream.on('end', async () => {
    expect(actual).toStrictEqual(expected)
    done()
  })
  event_timeline.forEach(action => service.queueEvent(action))
  service.stream.end()
})

test('Players can be sorted in order of display.', () => {
  const seatUserIds = [583654032, 619317634, 561384657, 575402650, 750532695, 172432670]
  const playerSeatIndex = seatUserIds.findIndex(id => id === 561384657)
  expect(PokerChaseService.rotateElementFromIndex(seatUserIds, playerSeatIndex)).toStrictEqual([561384657, 575402650, 750532695, 172432670, 583654032, 619317634])
})
