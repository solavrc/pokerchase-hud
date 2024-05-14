import Dexie, { type Table } from 'dexie'
import { Transform, TransformCallback } from 'stream'

/**
 * Event Lifecycle:
 *
 * PREFLOP
 * 303 EVT_DEAL
 * 304 EVT_ACTION[]
 *
 * FLOP
 * 305 EVT_DEAL_ROUND (Progress.Phase === 1)
 * 304 EVT_ACTION[]
 *
 * TURN
 * 305 EVT_DEAL_ROUND (Progress.Phase === 2)
 * 304 EVT_ACTION[]
 *
 * RIVER
 * 305 EVT_DEAL_ROUND (Progress.Phase === 3)
 * 304 EVT_ACTION[]
 *
 * SHOWDOWN (OR ALL OTHER PLAYERS FOLDED)
 * 306 EVT_HAND_RESULT
 */
export enum ApiType {
  /**
   * 参加申込:
   * - SitAndGo: { "ApiTypeId": 201, "Code": 0, "BattleType": 0, "Id": "new_stage007_010" }
   * - MTT: { "ApiTypeId": 201, "Code": 0, "BattleType": 1, "Id": "3164" }
   * - Ring: { "ApiTypeId": 201, "Code": 0, "BattleType": 4, "Id": "10_20_0001" }
   * - FriendRing: { "ApiTypeId": 201, "Code": 0, "BattleType": 5, "Id": "" }
   */
  REQ_ENTRY = 201,
  /** アクション完了: { "ApiTypeId": 202, "Code": 0 } */
  RES_ACTION_COMPLETED = 202,
  /** 参加取消: { "ApiTypeId": 203, "Code": 0 } */
  REQ_CANCEL_ENTRY = 203,
  /** ハンド開始: { "ApiTypeId": 204, "Code": 0 } */
  EVT_HAND_STARTED = 204,
  /** タイムバンク: { "ApiTypeId": 205, "Code": 0, "RestLimitSeconds": 8, "RestExtraLimitSeconds": 12 } */
  EVT_TIME_REMAIN = 205,
  /** スタンプ送信完了: { "ApiTypeId": 206, "Code": 0 } */
  RES_STAMP_ACCEPTED = 206,
  /** Muckハンド公開: { "ApiTypeId": 210, "Code": 0, "HoleCardIndex": 0, "IsFoldOpen": true } */
  REQ_FOLD_OPEN = 210,
  /** 退室完了: { "ApiTypeId": 212, "Code": 0 } */
  EVT_LEAVE_COMPLETED = 212,
  /** 参加取消結果: { "ApiTypeId": 213, "Code": 0, "IsCancel": false } */
  RES_ENTRY_CANCEL = 213,
  /** プレイヤー途中参加: { "ApiTypeId": 301, "JoinUser": { "UserId": 240573596, "UserName": "リネット", "FavoriteCharaId": "chara0035", "CostumeId": "costume00351", "EmblemId": "emblem0001", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0009", "ta_deco0006", "nj3_t_deco0003", "b_deco0001", "f_deco0001", "eal_deco0003", "esw_deco0001"] }, "JoinPlayer": { "SeatIndex": 3, "Status": 0, "BetStatus": 0, "Chip": 2000, "BetChip": 0 } } */
  EVT_PLAYER_JOIN = 301,
  /** Preflopカード: { "ApiTypeId": 303, "SeatUserIds": [583654032, 619317634, 561384657, 575402650, 750532695, 172432670], "Game": { "CurrentBlindLv": 1, "NextBlindUnixSeconds": 1712648642, "Ante": 50, "SmallBlind": 100, "BigBlind": 200, "ButtonSeat": 5, "SmallBlindSeat": 0, "BigBlindSeat": 1 }, "Player": { "SeatIndex": 2, "BetStatus": 1, "HoleCards": [37, 51], "Chip": 19950, "BetChip": 0 }, "OtherPlayers": [{ "SeatIndex": 0, "Status": 0, "BetStatus": 1, "Chip": 19850, "BetChip": 100 }, { "SeatIndex": 1, "Status": 0, "BetStatus": 1, "Chip": 19750, "BetChip": 200 }, { "SeatIndex": 3, "Status": 0, "BetStatus": 1, "Chip": 19950, "BetChip": 0 }, { "SeatIndex": 4, "Status": 0, "BetStatus": 1, "Chip": 19950, "BetChip": 0 }, { "SeatIndex": 5, "Status": 0, "BetStatus": 1, "Chip": 19950, "BetChip": 0 }], "Progress": { "Phase": 0, "NextActionSeat": 2, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 1, "MinRaise": 400, "Pot": 600, "SidePot": [] } } */
  EVT_DEAL = 303,
  /** アクション結果: { "ApiTypeId": 304, "SeatIndex": 2, "ActionType": 4, "Chip": 19350, "BetChip": 600, "Progress": { "Phase": 0, "NextActionSeat": 3, "NextActionTypes": [2, 3, 4, 5], "NextExtraLimitSeconds": 1, "MinRaise": 1000, "Pot": 1200, "SidePot": [] } } */
  EVT_ACTION = 304,
  /** Flop,Turn,Riverカード: { "ApiTypeId": 305, "CommunityCards": [1, 21, 44], "Player": { "SeatIndex": 2, "BetStatus": 2, "HoleCards": [35, 3], "Chip": 42550, "BetChip": 0 }, "OtherPlayers": [{ "SeatIndex": 0, "Status": 0, "BetStatus": 2, "Chip": 19800, "BetChip": 0 }, { "SeatIndex": 3, "Status": 0, "BetStatus": 1, "Chip": 19300, "BetChip": 0 }, { "SeatIndex": 4, "Status": 0, "BetStatus": 2, "Chip": 19900, "BetChip": 0 }, { "SeatIndex": 5, "Status": 0, "BetStatus": 1, "Chip": 16900, "BetChip": 0 }], "Progress": { "Phase": 1, "NextActionSeat": 3, "NextActionTypes": [0, 5, 1], "NextExtraLimitSeconds": 3, "MinRaise": 0, "Pot": 1550, "SidePot": [] } } */
  EVT_DEAL_ROUND = 305,
  /** ハンド終了: { "ApiTypeId": 306, "CommunityCards": [29, 22, 7, 32, 39], "Pot": 42700, "SidePot": [], "ResultType": 0, "DefeatStatus": 0, "HandId": 175859516, "Results": [{ "UserId": 561384657, "HoleCards": [37, 51], "RankType": 8, "Hands": [39, 37, 51, 32, 29], "HandRanking": 1, "Ranking": -2, "RewardChip": 42700 }, { "UserId": 619317634, "HoleCards": [1, 0], "RankType": 8, "Hands": [1, 0, 39, 32, 29], "HandRanking": -1, "Ranking": 6, "RewardChip": 0 }], "Player": { "SeatIndex": 2, "BetStatus": -1, "Chip": 42700, "BetChip": 0 }, "OtherPlayers": [{ "SeatIndex": 0, "Status": 0, "BetStatus": -1, "Chip": 19850, "BetChip": 0 }, { "SeatIndex": 1, "Status": 5, "BetStatus": -1, "Chip": 0, "BetChip": 0 }, { "SeatIndex": 3, "Status": 0, "BetStatus": -1, "Chip": 19950, "BetChip": 0 }, { "SeatIndex": 4, "Status": 0, "BetStatus": -1, "Chip": 19950, "BetChip": 0 }, { "SeatIndex": 5, "Status": 0, "BetStatus": -1, "Chip": 17550, "BetChip": 0 }] } */
  EVT_HAND_RESULT = 306,
  /** マッチ開始: { "ApiTypeId": 307 } */
  EVT_MATCH_STARTED = 307,
  /** マッチ概要: { "ApiTypeId": 308, "CoinNum": -1, "Items": [{ "ItemId": "season10_point", "Num": 9 }], "Name": "シーズンマッチ", "Name2": "6人対戦【シーズン10】", "DefaultChip": 20000, "LimitSeconds": 8, "IsReplay": true, "BlindStructures": [{ "Lv": 1, "ActiveMinutes": 4, "BigBlind": 200, "Ante": 50 }, { "Lv": 2, "ActiveMinutes": 4, "BigBlind": 280, "Ante": 70 }, { "Lv": 3, "ActiveMinutes": 4, "BigBlind": 400, "Ante": 100 }, { "Lv": 4, "ActiveMinutes": 4, "BigBlind": 560, "Ante": 140 }, { "Lv": 5, "ActiveMinutes": 4, "BigBlind": 780, "Ante": 200 }, { "Lv": 6, "ActiveMinutes": 4, "BigBlind": 1100, "Ante": 280 }, { "Lv": 7, "ActiveMinutes": 4, "BigBlind": 1640, "Ante": 410 }, { "Lv": 8, "ActiveMinutes": 4, "BigBlind": 2500, "Ante": 630 }, { "Lv": 9, "ActiveMinutes": 4, "BigBlind": 3800, "Ante": 950 }, { "Lv": 10, "ActiveMinutes": 4, "BigBlind": 5700, "Ante": 1400 }, { "Lv": 11, "ActiveMinutes": 4, "BigBlind": 8600, "Ante": 2200 }, { "Lv": 12, "ActiveMinutes": 4, "BigBlind": 13000, "Ante": 3200 }, { "Lv": 13, "ActiveMinutes": 4, "BigBlind": 19600, "Ante": 4900 }, { "Lv": 14, "ActiveMinutes": 4, "BigBlind": 29500, "Ante": 7400 }, { "Lv": 15, "ActiveMinutes": 4, "BigBlind": 44300, "Ante": 11000 }, { "Lv": 16, "ActiveMinutes": -1, "BigBlind": 60000, "Ante": 15000 }] }, */
  EVT_DETAILS = 308,
  /** マッチ結果: { "ApiTypeId": 309, "Ranking": 3, "IsLeave": false, "IsRebuy": false, "TotalMatch": 285, "RankReward": { "IsSeasonal": true, "RankPoint": 11, "RankPointDiff": 2, "Rank": { "RankId": "diamond", "RankName": "ダイヤモンド", "RankLvId": "diamond", "RankLvName": "ダイヤモンド" }, "SeasonalRanking": 1458 }, "Rewards": [{ "Category": 8, "TargetId": "", "Num": 70 }, { "Category": 3, "TargetId": "item0002", "Num": 450 }, { "Category": 3, "TargetId": "item0028", "Num": 2 }], "EventRewards": [], "Charas": [{ "CharaId": "chara0010", "CostumeId": "costume00101", "Favorite": 29605, "Rank": 3, "TodayUpNum": 0, "Evolution": false, "Stamps": [{ "StampId": "stamp1001", "IsRelease": true }, { "StampId": "stamp1002", "IsRelease": true }, { "StampId": "stamp1003", "IsRelease": true }, { "StampId": "stamp1004", "IsRelease": true }, { "StampId": "stamp1005", "IsRelease": true }, { "StampId": "stamp1006", "IsRelease": true }, { "StampId": "stamp1007", "IsRelease": true }, { "StampId": "stamp1008", "IsRelease": false }, { "StampId": "stamp1009", "IsRelease": false }, { "StampId": "stamp1010", "IsRelease": false }, { "StampId": "stamp1011", "IsRelease": false }, { "StampId": "stamp1012", "IsRelease": false }] }], "Costumes": [], "Decos": [], "Items": [{ "ItemId": "item0002", "Num": 28900 }, { "ItemId": "item0028", "Num": 452 }, { "ItemId": "season10_point", "Num": 11 }], "Money": { "FreeMoney": -1, "PaidMoney": -1 }, "Emblems": [] } */
  EVT_RESULT = 309,
  /** スタンプ送信: { "ApiTypeId": 310, "SeatIndex": 5, "StampId": "stamp0102" } */
  EVT_STAMP = 310,
  /** ハンド終了: { "ApiTypeId": 311, "EVTCode": 1 } */
  EVT_HAND_COMPLETED = 311,
  /** プレイヤー着席: { "ApiTypeId": 313, "ProcessType": 0, "TableUsers": [{ "UserId": 583654032, "UserName": "シュレディンガー", "FavoriteCharaId": "nj_chara0002", "CostumeId": "nj_costume00022", "EmblemId": "emblem0003", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0001", "fn_ta_deco0007", "fn_t_deco0005", "b_deco0001", "f_deco0001", "eal_deco0002", "esw_deco0007"] }, { "UserId": 561384657, "UserName": "sola", "FavoriteCharaId": "chara0010", "CostumeId": "costume00101", "EmblemId": "emblem0001", "Rank": { "RankId": "diamond", "RankName": "ダイヤモンド", "RankLvId": "diamond", "RankLvName": "ダイヤモンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0001", "ta_deco0001", "t_deco0009", "b_deco0001", "f_deco0001", "eal_deco0001", "esw_deco0001"] }, { "UserId": 750532695, "UserName": "ちいまう", "FavoriteCharaId": "chara0022", "CostumeId": "costume00221", "EmblemId": "emblem0001", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0014", "ta_deco0001", "t_deco0012", "b_deco0001", "f_deco0001", "eal_deco0001", "esw_deco0006"] }, { "UserId": 172432670, "UserName": "ラロムジ", "FavoriteCharaId": "chara0001", "CostumeId": "costume00012", "EmblemId": "emblem0001", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0001", "ta_deco0001", "t_deco0001", "b_deco0001", "f_deco0001", "eal_deco0001", "esw_deco0001"] }, { "UserId": 575402650, "UserName": "夜菊0721", "FavoriteCharaId": "chara0021", "CostumeId": "costume00212", "EmblemId": "emblem0001", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0069", "ta_deco0055", "t_deco0069", "bg_deco0006", "f_deco0001", "eal_deco0007", "esw_deco0001"] }, { "UserId": 619317634, "UserName": "ぽちこん", "FavoriteCharaId": "chara0009", "CostumeId": "costume00092", "EmblemId": "emblem0001", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0062", "ta_deco0018", "t_deco0058", "b_deco0001", "f_deco0001", "eal_deco0002", "esw_deco0001"] }], "SeatUserIds": [583654032, 619317634, 561384657, 575402650, 750532695, 172432670] } */
  EVT_PLAYER_SEATED = 313,
  /** ブラインドレベル上昇: { "ApiTypeId": 317, "CurrentBlindLv": 2, "NextBlindUnixSeconds": 1712648882, "Ante": 70, "SmallBlind": 140, "BigBlind": 280 } */
  EVT_BLIND_RAISED = 317,
  /** 参加申込結果: { "ApiTypeId": 319, "MatchUserNum": 6 } */
  RES_ENTRY_COMPLETED = 319,
}

export enum ActionType {
  CHECK = 0,
  BET = 1,
  FOLD = 2,
  CALL = 3,
  RAISE = 4,
  ALL_IN = 5,
}

export enum PhaseType {
  PREFLOP = 0,
  FLOP = 1,
  TURN = 2,
  RIVER = 3,
  /** 独自追加 */
  SHOWDOWN = 4,
}

export enum BattleType {
  SIT_AND_GO = 0,
  TOURNAMENT = 1,
  FRIEND_SIT_AND_GO = 2,
  RING_GAME = 4,
  FRIEND_RING_GAME = 5,
}

export enum BetStatusType {
  HAND_ENDED = -1,
  BATABLE = 1,
  FOLDED = 2,
  ALL_IN = 3
}

export interface Chara {
  CharaId: string
  CostumeId: string
  Favorite: number
  Rank: number
  TodayUpNum: number
  Evolution: boolean
  Stamps: Stamp[]
}

export interface Game {
  CurrentBlindLv: number
  NextBlindUnixSeconds: number
  Ante: number
  SmallBlind: number
  BigBlind: number
  ButtonSeat: number
  SmallBlindSeat: number
  BigBlindSeat: number
}

export interface OtherPlayer extends Player {
  Status: number
}

export interface Player {
  SeatIndex: number
  BetStatus: BetStatusType
  HoleCards?: number[]
  Chip: number
  BetChip: number
}

export interface Progress {
  Phase: PhaseType
  NextActionSeat: number
  NextActionTypes: ActionType[]
  NextExtraLimitSeconds: number
  MinRaise: number
  Pot: number
  SidePot: number[]
}

export interface RankReward {
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

export interface Reward {
  Category: number
  TargetId: string
  Num: number
}

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
  MUCK = 11
}

export interface Result {
  UserId: number
  HoleCards: [number, number] | []
  RankType: RankType
  Hands: [number, number, number, number, number] | []
  HandRanking: number
  Ranking: number
  RewardChip: number
}

export interface Stamp {
  StampId: string
  IsRelease: boolean
}

export interface TableUser {
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

export interface EventDetail {
  ItemId: string
  Num: number
}

export interface BlindStructure {
  Lv: number
  ActiveMinutes: number
  BigBlind: number
  Ante: number
}

interface ApiResponseBase<ApiTypeId extends ApiType> {
  ApiTypeId: ApiTypeId
  timestamp: number
}
/** 201 */
interface ReqEntryResponse extends ApiResponseBase<ApiType.REQ_ENTRY> {
  BattleType: BattleType
  Id: string
  Code: 0
}
/** 202 */
interface ResActionCompletedResponse extends ApiResponseBase<ApiType.RES_ACTION_COMPLETED> {
  Code: 0
}
/** 203 */
interface ReqCancelEntryResponse extends ApiResponseBase<ApiType.REQ_CANCEL_ENTRY> {
  Code: 0
}
/** 204 */
interface EvtHandStartedResponse extends ApiResponseBase<ApiType.EVT_HAND_STARTED> {
  Code: 0
}
/** 205 */
interface EvtTimeRemainResponse extends ApiResponseBase<ApiType.EVT_TIME_REMAIN> {
  Code: 0
  RestExtraLimitSeconds: number
  RestLimitSeconds: number
}
/** 206 */
interface ResStampAcceptedResponse extends ApiResponseBase<ApiType.RES_STAMP_ACCEPTED> {
  Code: 0
}
/** 210 */
interface ReqFoldOpenResponse extends ApiResponseBase<ApiType.REQ_FOLD_OPEN> {
  HoleCardIndex: number
  IsFoldOpen: boolean
}
/** 212 */
interface EvtLeaveCompletedResponse extends ApiResponseBase<ApiType.EVT_LEAVE_COMPLETED> {
  Code: 0
}
/** 213 */
interface ResEntryCancelResponse extends ApiResponseBase<ApiType.RES_ENTRY_CANCEL> {
  Code: 0
  IsCancel: boolean
}
/** 301 */
interface EvtPlayerJoinResponse extends ApiResponseBase<ApiType.EVT_PLAYER_JOIN> {
  JoinUser: TableUser
  JoinPlayer: Player
}
/** 303 */
interface EvtDealResponse extends ApiResponseBase<ApiType.EVT_DEAL> {
  Game: Game
  OtherPlayers: OtherPlayer[]
  /** 観戦時は存在しない */
  Player?: Player
  Progress: Progress
  SeatUserIds: number[]
}
/** 304 */
interface EvtActionResponse extends ApiResponseBase<ApiType.EVT_ACTION> {
  ActionType: ActionType
  BetChip: number
  Chip: number
  Progress: Progress
  SeatIndex: number
}
/** 305 */
interface EvtDealRoundResponse extends ApiResponseBase<ApiType.EVT_DEAL_ROUND> {
  CommunityCards: number[]
  OtherPlayers: OtherPlayer[]
  Player: Player
  Progress: Progress
}
/** 306 */
interface EvtHandResultResponse extends ApiResponseBase<ApiType.EVT_HAND_RESULT> {
  /** `ALL_IN`時のみ */
  CommunityCards: number[]
  DefeatStatus: number
  HandId: number
  OtherPlayers: OtherPlayer[]
  Player: Player
  Pot: number
  /** SHOWDOWN: `Results.length > 1` */
  Results: Result[]
  ResultType: number
  SidePot: number[]
}
/** 307 */
interface EvtMatchStartedResponse extends ApiResponseBase<ApiType.EVT_MATCH_STARTED> { }
/** 308 */
interface EvtDetailsResponse extends ApiResponseBase<ApiType.EVT_DETAILS> {
  BlindStructures: BlindStructure[]
  CoinNum: number
  DefaultChip: number
  IsReplay: boolean
  Items: EventDetail[]
  LimitSeconds: number
  Name: string
  Name2: string
}
/** 309 */
interface EvtResultResponse extends ApiResponseBase<ApiType.EVT_RESULT> {
  Charas: Chara[]
  Costumes: any[]
  Decos: any[]
  Emblems: any[]
  EventRewards: any[]
  IsLeave: boolean
  IsRebuy: boolean
  Items: any[]
  Money: {
    FreeMoney: number
    PaidMoney: number
  }
  Ranking: number
  RankReward: RankReward
  Rewards: Reward[]
  TotalMatch: number
}
/** 310 */
interface EvtStampResponse extends ApiResponseBase<ApiType.EVT_STAMP> {
  SeatIndex: number
  StampId: string
}
/** 311 */
interface EvtHandCompletedResponse extends ApiResponseBase<ApiType.EVT_HAND_COMPLETED> {
  EVTCode?: number
  NotifyCode: number
}
/** 313 */
interface EvtPlayerSeatedResponse extends ApiResponseBase<ApiType.EVT_PLAYER_SEATED> {
  /** トーナメント時存在しない */
  CommunityCards?: number[]
  /** トーナメント時存在しない */
  Game?: Game
  /** トーナメント時存在しない */
  OtherPlayers?: OtherPlayer[]
  /** トーナメント時存在しない */
  Player?: Player
  ProcessType: number
  /** トーナメント時存在しない */
  Progress?: Progress
  SeatUserIds: number[]
  TableUsers: TableUser[]
}
/** 317 */
interface EvtBlindRaisedResponse extends ApiResponseBase<ApiType.EVT_BLIND_RAISED> {
  Ante: number
  BigBlind: number
  CurrentBlindLv: number
  NextBlindUnixSeconds: number
  SmallBlind: number
}
/** 319 */
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
  EvtLeaveCompletedResponse |
  ResEntryCancelResponse |
  EvtPlayerJoinResponse |
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

interface Hand {
  /** `EVT_HAND_RESULT`まで未確定 */
  id: number
  approxTimestamp: number
  seatUserIds: number[]
  winningPlayerIds: number[]
  smallBlind: number
  bigBlind: number
  session: Omit<Session, 'reset'>
}

interface Phase {
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

interface Action {
  handId?: number
  index: number
  playerId: number
  phase: PhaseType
  actionType: ActionType
  bet: number
  pot: number
  sidePot: number[]
  position: Position
  phaseActionIndex: number,
  phasePlayerActionIndex: number,
  phasePrevBetCount: number,
}

export class PokerChaseDB extends Dexie {
  apiResponses!: Table<ApiResponse, number>
  hands!: Table<Hand, number>
  phases!: Table<Phase, number>
  actions!: Table<Action, number>
  constructor(indexedDB?: IDBFactory, iDBKeyRange?: typeof IDBKeyRange) {
    super('PokerChaseDB', { indexedDB, IDBKeyRange: iDBKeyRange })
    this.version(1).stores({
      /** @see https://dexie.org/docs/Version/Version.stores() */
      apiResponses: 'timestamp,ApiTypeId',
      hands: 'id,*seatUserIds,*winningPlayerIds',
      phases: '[handId+phase],handId,*seatUserIds,phase',
      actions: '[handId+index],handId,playerId,phase,actionType,phasePlayerActionIndex,phasePrevBetCount',
    })
  }
}

/** 同期的: ログをハンド単位に集約する */
export class AggregateEventsStream extends Transform {
  private handState: {
    /** 不定の起点に対し時計回り順 */
    seatUserIds: number[]
    /** [SB, BB, UTG, ... BTN] */
    positionUserIds: number[]
    actions: Action[]
    phases: Phase[]
    bigBlind: number
    smallBlind: number
    isValid: () => boolean
    reset: () => void
  } = {
      seatUserIds: [],
      positionUserIds: [],
      actions: [],
      phases: [],
      bigBlind: NaN,
      smallBlind: NaN,
      isValid: function () {
        return this.seatUserIds.length > 0
          && this.positionUserIds.length > 0
          && this.actions.length > 0
          && this.phases.at(0)?.phase === PhaseType.PREFLOP
          && this.bigBlind >= 0
          && this.smallBlind >= 0
      },
      reset: function () {
        this.seatUserIds = []
        this.positionUserIds = []
        this.actions = []
        this.phases = []
        this.bigBlind = NaN
        this.smallBlind = NaN
      }
    }
  private service: PokerChaseService
  constructor(service: PokerChaseService) {
    super({ objectMode: true })
    this.service = service
  }
  _transform(event: EvtDealResponse | EvtDealRoundResponse | EvtActionResponse | EvtHandResultResponse, _: string, callback: TransformCallback) {
    try {
      switch (event.ApiTypeId) {
        case ApiType.EVT_DEAL:
          this.handState.reset()
          this.handState.seatUserIds = event.SeatUserIds
          /** [SB, BB, UTG, HJ, CO, BTN] */
          this.handState.positionUserIds = PokerChaseService.rotateElementFromIndex(event.SeatUserIds, event.Game.BigBlindSeat + 1).reverse()
          this.handState.phases.push({
            phase: event.Progress.Phase,
            seatUserIds: event.SeatUserIds,
            communityCards: [],
          })
          this.handState.bigBlind = event.Game.BigBlind
          this.handState.smallBlind = event.Game.SmallBlind
          break
        case ApiType.EVT_DEAL_ROUND:
          this.handState.phases.push({
            phase: event.Progress.Phase,
            seatUserIds: [event.Player, ...event.OtherPlayers]
              .filter(({ BetStatus }) => BetStatus === BetStatusType.BATABLE)
              .sort((a, b) => a.SeatIndex - b.SeatIndex)
              .map(({ SeatIndex }) => this.handState.seatUserIds.at(SeatIndex)!),
            communityCards: [...this.handState.phases.at(-1)?.communityCards ?? [], ...event.CommunityCards],
          })
          break
        case ApiType.EVT_ACTION:
          /** `event.Progress.Phase`: 正しくない */
          const phase = this.handState.phases.at(-1)?.phase!
          const phaseActions = this.handState.actions.filter(action => action.phase === phase)
          const playerId = this.handState.seatUserIds[event.SeatIndex]
          this.handState.actions.push({
            playerId,
            phase: phase,
            index: this.handState.actions.length,
            actionType: event.ActionType,
            bet: event.BetChip,
            pot: event.Progress.Pot,
            sidePot: event.Progress.SidePot,
            /** @see Position */
            position: this.handState.positionUserIds.indexOf(playerId) - 2,
            phaseActionIndex: phaseActions.length,
            phasePlayerActionIndex: phaseActions.filter(action => action.playerId === playerId).length,
            phasePrevBetCount: phaseActions.filter(action => [ActionType.BET, ActionType.RAISE, ActionType.ALL_IN].includes(action.actionType)).length + Number(event.Progress.Phase === PhaseType.PREFLOP),
          })
          break
        case ApiType.EVT_HAND_RESULT:
          if (event.Results.length > 1) {
            this.handState.phases.push({
              phase: PhaseType.SHOWDOWN,
              communityCards: [...this.handState.phases.at(-1)?.communityCards ?? [], ...event.CommunityCards],
              seatUserIds: event.Results.map(({ UserId }) => UserId),
            })
          }
          if (this.handState.isValid()) {
            const hand: Hand = {
              id: event.HandId,
              approxTimestamp: event.timestamp,
              seatUserIds: this.handState.seatUserIds,
              winningPlayerIds: event.Results.filter(({ HandRanking }) => HandRanking === 1).map(({ UserId }) => UserId),
              smallBlind: this.handState.smallBlind,
              bigBlind: this.handState.bigBlind,
              session: {
                id: this.service.session.id,
                battleType: this.service.session.battleType,
                name: this.service.session.name,
              }
            }
            this.push({
              hand,
              actions: this.handState.actions.map(action => ({ ...action, handId: event.HandId })),
              phases: this.handState.phases.map(phase => ({ ...phase, handId: event.HandId })),
            })
          }
          break
      }
      callback()
    } catch (error: unknown) {
      callback(error as Error)
    }
  }
}

export interface PlayerStats {
  playerId: number
  hands?: number
  vpip?: [top: number, bottom: number]
  pfr?: [top: number, bottom: number]
  threeBet?: [top: number, bottom: number]
  threeBetFold?: [top: number, bottom: number]
  wtsd?: [top: number, bottom: number]
  wmsd?: [top: number, bottom: number]
  af?: [top: number, bottom: number]
  afq?: [top: number, bottom: number]
}

/** 非同期的: ハンドを保存し、各プレイヤーのStatsを計算する */
class ProcessHandAsyncStream extends Transform {
  private service: PokerChaseService
  constructor(service: PokerChaseService) {
    super({ objectMode: true })
    this.service = service
  }
  async _transform({ hand, actions, phases }: { hand: Hand, actions: Action[], phases: Phase[] }, _: string, callback: TransformCallback) {
    try {
      await this.service.db.transaction('rw', this.service.db.hands, this.service.db.phases, this.service.db.actions, async () => {
        await Promise.all([
          this.service.db.hands.add(hand),
          this.service.db.actions.bulkAdd(actions),
          this.service.db.phases.bulkAdd(phases)
        ])
        const stats = this.service.playerId
          ? await this.calcStats(PokerChaseService.rotateElementFromIndex(hand.seatUserIds, hand.seatUserIds.indexOf(this.service.playerId)))
          : await this.calcStats(hand.seatUserIds)
        callback(null, stats)
      })
    } catch (error: unknown) {
      callback(error as Error)
    }
  }
  /** @see https://www.pokertracker.com/guides/PT3/general/statistical-reference-guide */
  private calcStats = async (seatUserIds: number[]): Promise<PlayerStats[]> => {
    return await Promise.all(seatUserIds.map(async playerId => {
      if (playerId === -1)
        return { playerId: -1 }
      const [
        hands,
        voluntarilyHands,
        pfrHands,
        threeBetChanceHands,
        threeBetHands,
        threeBetFoldChanceHands,
        threeBetFoldHands,
        sawFlopHands,
        wentToShowdownHands,
        wonMoneyAtShowdownHands,
        betRaiseActions,
        callActions,
        exceptCheckActions
      ] = await Promise.all([
        this.service.db.hands.where({ seatUserIds: playerId }).count(),
        this.service.db.actions.where({ playerId, phase: PhaseType.PREFLOP, phasePlayerActionIndex: 0 }).and(action => [ActionType.ALL_IN, ActionType.RAISE, ActionType.CALL].includes(action.actionType)).count(),
        this.service.db.actions.where({ playerId, phase: PhaseType.PREFLOP }).and(action => [ActionType.ALL_IN, ActionType.RAISE].includes(action.actionType)).toArray().then(actions => [...new Set(actions.map(({ handId }) => handId))].length),
        this.service.db.actions.where({ playerId, phase: PhaseType.PREFLOP, phasePrevBetCount: 2 }).count(),
        this.service.db.actions.where({ playerId, phase: PhaseType.PREFLOP, phasePrevBetCount: 2 }).and(action => [ActionType.ALL_IN, ActionType.RAISE].includes(action.actionType)).count(),
        this.service.db.actions.where({ playerId, phase: PhaseType.PREFLOP, phasePrevBetCount: 3 }).count(),
        this.service.db.actions.where({ playerId, phase: PhaseType.PREFLOP, phasePrevBetCount: 3, actionType: ActionType.FOLD }).count(),
        this.service.db.phases.where({ seatUserIds: playerId, phase: PhaseType.FLOP }).count(),
        this.service.db.phases.where({ seatUserIds: playerId, phase: PhaseType.SHOWDOWN }).count(),
        this.service.db.hands.where({ winningPlayerIds: playerId }).count(),
        this.service.db.actions.where({ playerId }).and(({ actionType }) => [ActionType.BET, ActionType.RAISE, ActionType.ALL_IN].includes(actionType)).count(),
        this.service.db.actions.where({ playerId }).and(({ actionType }) => actionType === ActionType.CALL).count(),
        this.service.db.actions.where({ playerId }).and(({ actionType }) => actionType !== ActionType.CHECK).count()
      ])
      return {
        playerId,
        hands,
        vpip: [voluntarilyHands, hands],
        pfr: [pfrHands, hands],
        threeBet: [threeBetHands, threeBetChanceHands],
        threeBetFold: [threeBetFoldHands, threeBetFoldChanceHands],
        wmsd: [wonMoneyAtShowdownHands, wentToShowdownHands],
        wtsd: [wentToShowdownHands, sawFlopHands],
        af: [betRaiseActions, callActions],
        afq: [betRaiseActions, exceptCheckActions]
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

export class PokerChaseService {
  private readonly aggregateEventsStream: AggregateEventsStream
  private readonly processHandAsyncStream: ProcessHandAsyncStream
  static readonly POKER_CHASE_SERVICE_EVENT = 'PokerChaseServiceEvent'
  readonly db
  readonly stream
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
  playerId?: number
  constructor({ db, playerId }: { db: PokerChaseDB, playerId?: number }) {
    this.db = db
    this.playerId = playerId
    this.aggregateEventsStream = new AggregateEventsStream(this)
    this.processHandAsyncStream = new ProcessHandAsyncStream(this)
    this.stream = this.aggregateEventsStream.pipe<ProcessHandAsyncStream>(this.processHandAsyncStream)
  }
  readonly queueEvent = (event: ApiResponse) => {
    this.eventLogger(event)
    this.db.apiResponses.add(event)
    switch (event.ApiTypeId) {
      case ApiType.REQ_ENTRY:
        this.session.reset()
        this.session.id = event.Id
        this.session.battleType = event.BattleType
        /** HUD表示/非表示制御 */
        this.stream.pause()
        break
      case ApiType.EVT_DETAILS:
        this.session.name = event.Name
        this.stream.pause()
        break
      case ApiType.EVT_PLAYER_SEATED:
      case ApiType.EVT_RESULT:
      case ApiType.EVT_LEAVE_COMPLETED:
        this.stream.pause()
        break
      case ApiType.EVT_DEAL:
        if (event.Player?.SeatIndex)
          this.playerId = event.SeatUserIds.at(event.Player.SeatIndex)
      case ApiType.EVT_DEAL_ROUND:
      case ApiType.EVT_ACTION:
      case ApiType.EVT_HAND_RESULT:
        this.stream.resume()
        this.aggregateEventsStream.write(event)
        break
    }
  }
  private eventLogger = (event: ApiResponse) => {
    const timestamp = new Date().toISOString().slice(11, 19)
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
