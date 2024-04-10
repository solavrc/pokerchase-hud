/** @todo ハンドログ集計 */
export enum ApiType {
    REQ_ENTRY = 201, /** 参加申込: { "ApiTypeId": 201, "Code": 0, "BattleType": 0, "Id": "new_stage007_010" } */
    RES_ACTION_COMPLETED = 202, /** アクション完了: { "ApiTypeId": 202, "Code": 0 } */
    REQ_CANCEL_ENTRY = 203, /** 参加取消: { "ApiTypeId": 203, "Code": 0 } */
    EVT_HAND_STARTED = 204, /** ハンド開始: { "ApiTypeId": 204, "Code": 0 } */
    EVT_TIME_REMAIN = 205, /** タイムバンク: { "ApiTypeId": 205, "Code": 0, "RestLimitSeconds": 8, "RestExtraLimitSeconds": 12 } */
    RES_STAMP_ACCEPTED = 206, /** スタンプ送信完了: { "ApiTypeId": 206, "Code": 0 } */
    REQ_FOLD_OPEN = 210, /** Muckハンド公開: { "ApiTypeId": 210, "Code": 0, "HoleCardIndex": 0, "IsFoldOpen": true } */
    RES_ENTRY_CANCEL = 213, /** 参加取消結果: { "ApiTypeId": 213, "Code": 0, "IsCancel": false } */
    EVT_DEAL = 303, /** Preflopカード: { "ApiTypeId": 303, "SeatUserIds": [583654032, 619317634, 561384657, 575402650, 750532695, 172432670], "Game": { "CurrentBlindLv": 1, "NextBlindUnixSeconds": 1712648642, "Ante": 50, "SmallBlind": 100, "BigBlind": 200, "ButtonSeat": 5, "SmallBlindSeat": 0, "BigBlindSeat": 1 }, "Player": { "SeatIndex": 2, "BetStatus": 1, "HoleCards": [37, 51], "Chip": 19950, "BetChip": 0 }, "OtherPlayers": [{ "SeatIndex": 0, "Status": 0, "BetStatus": 1, "Chip": 19850, "BetChip": 100 }, { "SeatIndex": 1, "Status": 0, "BetStatus": 1, "Chip": 19750, "BetChip": 200 }, { "SeatIndex": 3, "Status": 0, "BetStatus": 1, "Chip": 19950, "BetChip": 0 }, { "SeatIndex": 4, "Status": 0, "BetStatus": 1, "Chip": 19950, "BetChip": 0 }, { "SeatIndex": 5, "Status": 0, "BetStatus": 1, "Chip": 19950, "BetChip": 0 }], "Progress": { "Phase": 0, "NextActionSeat": 2, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 1, "MinRaise": 400, "Pot": 600, "SidePot": [] } } */
    EVT_ACTION = 304, /** アクション結果: { "ApiTypeId": 304, "SeatIndex": 2, "ActionType": 4, "Chip": 19350, "BetChip": 600, "Progress": { "Phase": 0, "NextActionSeat": 3, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 1, "MinRaise": 1000, "Pot": 1200, "SidePot": [] } } */
    EVT_DEAL_ROUND = 305, /** Flop,Turn,Riverカード: { "ApiTypeId": 305, "CommunityCards": [1, 21, 44], "Player": { "SeatIndex": 2, "BetStatus": 2, "HoleCards": [35, 3], "Chip": 42550, "BetChip": 0 }, "OtherPlayers": [{ "SeatIndex": 0, "Status": 0, "BetStatus": 2, "Chip": 19800, "BetChip": 0 }, { "SeatIndex": 3, "Status": 0, "BetStatus": 1, "Chip": 19300, "BetChip": 0 }, { "SeatIndex": 4, "Status": 0, "BetStatus": 2, "Chip": 19900, "BetChip": 0 }, { "SeatIndex": 5, "Status": 0, "BetStatus": 1, "Chip": 16900, "BetChip": 0 }], "Progress": { "Phase": 1, "NextActionSeat": 3, "NextActionTypes": [0, 5, 1], "NextExtraLimitSeconds": 3, "MinRaise": 0, "Pot": 1550, "SidePot": [] } } */
    EVT_HAND_RESULT = 306, /** ハンド終了: { "ApiTypeId": 306, "CommunityCards": [29, 22, 7, 32, 39], "Pot": 42700, "SidePot": [], "ResultType": 0, "DefeatStatus": 0, "HandId": 175859516, "Results": [{ "UserId": 561384657, "HoleCards": [37, 51], "RankType": 8, "Hands": [39, 37, 51, 32, 29], "HandRanking": 1, "Ranking": -2, "RewardChip": 42700 }, { "UserId": 619317634, "HoleCards": [1, 0], "RankType": 8, "Hands": [1, 0, 39, 32, 29], "HandRanking": -1, "Ranking": 6, "RewardChip": 0 }], "Player": { "SeatIndex": 2, "BetStatus": -1, "Chip": 42700, "BetChip": 0 }, "OtherPlayers": [{ "SeatIndex": 0, "Status": 0, "BetStatus": -1, "Chip": 19850, "BetChip": 0 }, { "SeatIndex": 1, "Status": 5, "BetStatus": -1, "Chip": 0, "BetChip": 0 }, { "SeatIndex": 3, "Status": 0, "BetStatus": -1, "Chip": 19950, "BetChip": 0 }, { "SeatIndex": 4, "Status": 0, "BetStatus": -1, "Chip": 19950, "BetChip": 0 }, { "SeatIndex": 5, "Status": 0, "BetStatus": -1, "Chip": 17550, "BetChip": 0 }] } */
    EVT_MATCH_STARTED = 307, /** マッチ開始: { "ApiTypeId": 307 } */
    EVT_DETAILS = 308, /** マッチ概要: { "ApiTypeId": 308, "CoinNum": -1, "Items": [{ "ItemId": "season10_point", "Num": 9 }], "Name": "シーズンマッチ", "Name2": "6人対戦【シーズン10】", "DefaultChip": 20000, "LimitSeconds": 8, "IsReplay": true, "BlindStructures": [{ "Lv": 1, "ActiveMinutes": 4, "BigBlind": 200, "Ante": 50 }, { "Lv": 2, "ActiveMinutes": 4, "BigBlind": 280, "Ante": 70 }, { "Lv": 3, "ActiveMinutes": 4, "BigBlind": 400, "Ante": 100 }, { "Lv": 4, "ActiveMinutes": 4, "BigBlind": 560, "Ante": 140 }, { "Lv": 5, "ActiveMinutes": 4, "BigBlind": 780, "Ante": 200 }, { "Lv": 6, "ActiveMinutes": 4, "BigBlind": 1100, "Ante": 280 }, { "Lv": 7, "ActiveMinutes": 4, "BigBlind": 1640, "Ante": 410 }, { "Lv": 8, "ActiveMinutes": 4, "BigBlind": 2500, "Ante": 630 }, { "Lv": 9, "ActiveMinutes": 4, "BigBlind": 3800, "Ante": 950 }, { "Lv": 10, "ActiveMinutes": 4, "BigBlind": 5700, "Ante": 1400 }, { "Lv": 11, "ActiveMinutes": 4, "BigBlind": 8600, "Ante": 2200 }, { "Lv": 12, "ActiveMinutes": 4, "BigBlind": 13000, "Ante": 3200 }, { "Lv": 13, "ActiveMinutes": 4, "BigBlind": 19600, "Ante": 4900 }, { "Lv": 14, "ActiveMinutes": 4, "BigBlind": 29500, "Ante": 7400 }, { "Lv": 15, "ActiveMinutes": 4, "BigBlind": 44300, "Ante": 11000 }, { "Lv": 16, "ActiveMinutes": -1, "BigBlind": 60000, "Ante": 15000 }] }, */
    EVT_RESULT = 309, /** マッチ結果: { "ApiTypeId": 309, "Ranking": 3, "IsLeave": false, "IsRebuy": false, "TotalMatch": 285, "RankReward": { "IsSeasonal": true, "RankPoint": 11, "RankPointDiff": 2, "Rank": { "RankId": "diamond", "RankName": "ダイヤモンド", "RankLvId": "diamond", "RankLvName": "ダイヤモンド" }, "SeasonalRanking": 1458 }, "Rewards": [{ "Category": 8, "TargetId": "", "Num": 70 }, { "Category": 3, "TargetId": "item0002", "Num": 450 }, { "Category": 3, "TargetId": "item0028", "Num": 2 }], "EventRewards": [], "Charas": [{ "CharaId": "chara0010", "CostumeId": "costume00101", "Favorite": 29605, "Rank": 3, "TodayUpNum": 0, "Evolution": false, "Stamps": [{ "StampId": "stamp1001", "IsRelease": true }, { "StampId": "stamp1002", "IsRelease": true }, { "StampId": "stamp1003", "IsRelease": true }, { "StampId": "stamp1004", "IsRelease": true }, { "StampId": "stamp1005", "IsRelease": true }, { "StampId": "stamp1006", "IsRelease": true }, { "StampId": "stamp1007", "IsRelease": true }, { "StampId": "stamp1008", "IsRelease": false }, { "StampId": "stamp1009", "IsRelease": false }, { "StampId": "stamp1010", "IsRelease": false }, { "StampId": "stamp1011", "IsRelease": false }, { "StampId": "stamp1012", "IsRelease": false }] }], "Costumes": [], "Decos": [], "Items": [{ "ItemId": "item0002", "Num": 28900 }, { "ItemId": "item0028", "Num": 452 }, { "ItemId": "season10_point", "Num": 11 }], "Money": { "FreeMoney": -1, "PaidMoney": -1 }, "Emblems": [] } */
    EVT_STAMP = 310, /** スタンプ送信: { "ApiTypeId": 310, "SeatIndex": 5, "StampId": "stamp0102" } */
    EVT_HAND_COMPLETED = 311, /** ハンド終了: { "ApiTypeId": 311, "EVTCode": 1 } */
    EVT_PLAYER_SEATED = 313, /** プレイヤー着席: { "ApiTypeId": 313, "ProcessType": 0, "TableUsers": [{ "UserId": 583654032, "UserName": "シュレディンガー", "FavoriteCharaId": "nj_chara0002", "CostumeId": "nj_costume00022", "EmblemId": "emblem0003", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0001", "fn_ta_deco0007", "fn_t_deco0005", "b_deco0001", "f_deco0001", "eal_deco0002", "esw_deco0007"] }, { "UserId": 561384657, "UserName": "sola", "FavoriteCharaId": "chara0010", "CostumeId": "costume00101", "EmblemId": "emblem0001", "Rank": { "RankId": "diamond", "RankName": "ダイヤモンド", "RankLvId": "diamond", "RankLvName": "ダイヤモンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0001", "ta_deco0001", "t_deco0009", "b_deco0001", "f_deco0001", "eal_deco0001", "esw_deco0001"] }, { "UserId": 750532695, "UserName": "ちいまう", "FavoriteCharaId": "chara0022", "CostumeId": "costume00221", "EmblemId": "emblem0001", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0014", "ta_deco0001", "t_deco0012", "b_deco0001", "f_deco0001", "eal_deco0001", "esw_deco0006"] }, { "UserId": 172432670, "UserName": "ラロムジ", "FavoriteCharaId": "chara0001", "CostumeId": "costume00012", "EmblemId": "emblem0001", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0001", "ta_deco0001", "t_deco0001", "b_deco0001", "f_deco0001", "eal_deco0001", "esw_deco0001"] }, { "UserId": 575402650, "UserName": "夜菊0721", "FavoriteCharaId": "chara0021", "CostumeId": "costume00212", "EmblemId": "emblem0001", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0069", "ta_deco0055", "t_deco0069", "bg_deco0006", "f_deco0001", "eal_deco0007", "esw_deco0001"] }, { "UserId": 619317634, "UserName": "ぽちこん", "FavoriteCharaId": "chara0009", "CostumeId": "costume00092", "EmblemId": "emblem0001", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0062", "ta_deco0018", "t_deco0058", "b_deco0001", "f_deco0001", "eal_deco0002", "esw_deco0001"] }], "SeatUserIds": [583654032, 619317634, 561384657, 575402650, 750532695, 172432670] } */
    EVT_BLIND_RAISED = 317, /** ブラインドレベル上昇: { "ApiTypeId": 317, "CurrentBlindLv": 2, "NextBlindUnixSeconds": 1712648882, "Ante": 70, "SmallBlind": 140, "BigBlind": 280 } */
    RES_ENTRY_COMPLETED = 319, /** 参加申込結果: { "ApiTypeId": 319, "MatchUserNum": 6 } */
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
  
  interface Game {
    CurrentBlindLv: number
    NextBlindUnixSeconds: number
    Ante: number
    SmallBlind: number
    BigBlind: number
    ButtonSeat: number
    SmallBlindSeat: number
    BigBlindSeat: number
  }
  
  interface OtherPlayer extends Player {
    Status: number
  }
  
  interface Player {
    SeatIndex: number
    BetStatus: number
    HoleCards?: number[]
    Chip: number
    BetChip: number
  }
  
  interface Progress {
    Phase: number
    NextActionSeat: number
    NextActionTypes: number[]
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
  
  interface Reward {
    Category: number
    TargetId: string
    Num: number
  }
  
  interface Result {
    UserId: number
    HoleCards: number[]
    RankType: number
    Hands: number[]
    HandRanking: number
    Ranking: number
    RewardChip: number
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
      RankId: string
      RankName: string
      RankLvId: string
      RankLvName: string
    }
    IsOfficial: boolean
    IsCpu: boolean
    SettingDecoIds: string[]
  }
  
  interface EventDetail {
    ItemId: string
    Num: number
  }
  
  interface BlindStructure {
    Lv: number
    ActiveMinutes: number
    BigBlind: number
    Ante: number
  }
  
  interface ApiResponseBase<ApiTypeId extends ApiType> {
    ApiTypeId: ApiTypeId
    Code?: number
  }
  
  interface ReqEntryResponse extends ApiResponseBase<ApiType.REQ_ENTRY> {
    BattleType: number
    Id: string
  }
  
  interface ResActionCompletedResponse extends ApiResponseBase<ApiType.RES_ACTION_COMPLETED> { }
  
  interface ReqCancelEntryResponse extends ApiResponseBase<ApiType.REQ_CANCEL_ENTRY> { }
  
  interface EvtHandStartedResponse extends ApiResponseBase<ApiType.EVT_HAND_STARTED> { }
  
  interface EvtTimeRemainResponse extends ApiResponseBase<ApiType.EVT_TIME_REMAIN> {
    RestLimitSeconds: number
    RestExtraLimitSeconds: number
  }
  
  interface ResStampAcceptedResponse extends ApiResponseBase<ApiType.RES_STAMP_ACCEPTED> { }
  
  interface ReqFoldOpenResponse extends ApiResponseBase<ApiType.REQ_FOLD_OPEN> {
    HoleCardIndex: number
    IsFoldOpen: boolean
  }
  
  interface ResEntryCancelResponse extends ApiResponseBase<ApiType.RES_ENTRY_CANCEL> {
    IsCancel: boolean
  }
  
  interface EvtDealResponse extends ApiResponseBase<ApiType.EVT_DEAL> {
    SeatUserIds: number[]
    Game: Game
    Player?: Player
    OtherPlayers: OtherPlayer[]
    Progress: Progress
  }
  
  interface EvtActionResponse extends ApiResponseBase<ApiType.EVT_ACTION> {
    SeatIndex: number
    ActionType: number
    Chip: number
    BetChip: number
    Progress: Progress
  }
  
  interface EvtDealRoundResponse extends ApiResponseBase<ApiType.EVT_DEAL_ROUND> {
    CommunityCards: number[]
    Player: Player
    OtherPlayers: OtherPlayer[]
    Progress: Progress
  }
  
  interface EvtHandResultResponse extends ApiResponseBase<ApiType.EVT_HAND_RESULT> {
    CommunityCards: number[]
    Pot: number
    SidePot: number[]
    ResultType: number
    DefeatStatus: number
    HandId: number
    Results: Result[]
    Player: Player
    OtherPlayers: OtherPlayer[]
  }
  
  interface EvtMatchStartedResponse extends ApiResponseBase<ApiType.EVT_MATCH_STARTED> { }
  
  interface EvtDetailsResponse extends ApiResponseBase<ApiType.EVT_DETAILS> {
    CoinNum: number
    Items: EventDetail[]
    Name: string
    Name2: string
    DefaultChip: number
    LimitSeconds: number
    IsReplay: boolean
    BlindStructures: BlindStructure[]
  }
  
  interface EvtResultResponse extends ApiResponseBase<ApiType.EVT_RESULT> {
    Ranking: number
    IsLeave: boolean
    IsRebuy: boolean
    TotalMatch: number
    RankReward: RankReward
    Rewards: Reward[]
    EventRewards: any[]
    Charas: Chara[]
    Costumes: any[]
    Decos: any[]
    Items: any[]
    Money: {
      FreeMoney: number
      PaidMoney: number
    }
    Emblems: any[]
  }
  
  interface EvtStampResponse extends ApiResponseBase<ApiType.EVT_STAMP> {
    SeatIndex: number
    StampId: string
  }
  
  interface EvtHandCompletedResponse extends ApiResponseBase<ApiType.EVT_HAND_COMPLETED> {
    EVTCode?: number
    NotifyCode: number
  }
  
  interface EvtPlayerSeatedResponse extends ApiResponseBase<ApiType.EVT_PLAYER_SEATED> {
    ProcessType: number
    TableUsers: TableUser[]
    SeatUserIds: number[]
  }
  
  interface EvtBlindRaisedResponse extends ApiResponseBase<ApiType.EVT_BLIND_RAISED> {
    CurrentBlindLv: number
    NextBlindUnixSeconds: number
    Ante: number
    SmallBlind: number
    BigBlind: number
  }
  
  interface ResEntryCompletedResponse extends ApiResponseBase<ApiType.RES_ENTRY_COMPLETED> {
    MatchUserNum: number
  }
  
  export type ApiResponse =
    ReqEntryResponse |
    ResActionCompletedResponse |
    ReqCancelEntryResponse |
    EvtHandStartedResponse |
    EvtTimeRemainResponse |
    ResStampAcceptedResponse |
    ReqFoldOpenResponse |
    ResEntryCancelResponse |
    EvtDealResponse |
    EvtActionResponse |
    EvtDealRoundResponse |
    EvtHandResultResponse |
    EvtMatchStartedResponse |
    EvtDetailsResponse |
    EvtResultResponse |
    EvtStampResponse |
    EvtHandCompletedResponse |
    EvtPlayerSeatedResponse |
    EvtBlindRaisedResponse |
    ResEntryCompletedResponse
  