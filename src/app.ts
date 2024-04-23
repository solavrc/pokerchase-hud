import Dexie, { Table } from 'dexie'
import { Transform } from 'stream'

/** ハンドログを解析する */
export enum ApiType {
  REQ_ENTRY = 201, /** 参加申込: { "ApiTypeId": 201, "Code": 0, "BattleType": 0, "Id": "new_stage007_010" } */
  RES_ACTION_COMPLETED = 202, /** アクション完了: { "ApiTypeId": 202, "Code": 0 } */
  REQ_CANCEL_ENTRY = 203, /** 参加取消: { "ApiTypeId": 203, "Code": 0 } */
  EVT_HAND_STARTED = 204, /** ハンド開始: { "ApiTypeId": 204, "Code": 0 } */
  EVT_TIME_REMAIN = 205, /** タイムバンク: { "ApiTypeId": 205, "Code": 0, "RestLimitSeconds": 8, "RestExtraLimitSeconds": 12 } */
  RES_STAMP_ACCEPTED = 206, /** スタンプ送信完了: { "ApiTypeId": 206, "Code": 0 } */
  REQ_FOLD_OPEN = 210, /** Muckハンド公開: { "ApiTypeId": 210, "Code": 0, "HoleCardIndex": 0, "IsFoldOpen": true } */
  EVT_LEAVE_COMPLETED = 212, /** 退室完了: { "ApiTypeId": 212, "Code": 0 } */
  RES_ENTRY_CANCEL = 213, /** 参加取消結果: { "ApiTypeId": 213, "Code": 0, "IsCancel": false } */
  EVT_PLAYER_JOIN = 301, /** プレイヤー途中参加: { "ApiTypeId": 301, "JoinUser": { "UserId": 240573596, "UserName": "リネット", "FavoriteCharaId": "chara0035", "CostumeId": "costume00351", "EmblemId": "emblem0001", "Rank": { "RankId": "legend", "RankName": "レジェンド", "RankLvId": "legend", "RankLvName": "レジェンド" }, "IsOfficial": false, "IsCpu": false, "SettingDecoIds": ["k_deco0009", "ta_deco0006", "nj3_t_deco0003", "b_deco0001", "f_deco0001", "eal_deco0003", "esw_deco0001"] }, "JoinPlayer": { "SeatIndex": 3, "Status": 0, "BetStatus": 0, "Chip": 2000, "BetChip": 0 } } */
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
  BetStatus: number
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

export interface Result {
  UserId: number
  HoleCards: number[]
  RankType: number
  Hands: number[]
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
  Code?: number
}
/** 201 */
interface ReqEntryResponse extends ApiResponseBase<ApiType.REQ_ENTRY> {
  BattleType: number
  Id: string
}
/** 202 */
interface ResActionCompletedResponse extends ApiResponseBase<ApiType.RES_ACTION_COMPLETED> { }
/** 203 */
interface ReqCancelEntryResponse extends ApiResponseBase<ApiType.REQ_CANCEL_ENTRY> { }
/** 204 */
interface EvtHandStartedResponse extends ApiResponseBase<ApiType.EVT_HAND_STARTED> { }
/** 205 */
interface EvtTimeRemainResponse extends ApiResponseBase<ApiType.EVT_TIME_REMAIN> {
  RestExtraLimitSeconds: number
  RestLimitSeconds: number
}
/** 206 */
interface ResStampAcceptedResponse extends ApiResponseBase<ApiType.RES_STAMP_ACCEPTED> { }
/** 210 */
interface ReqFoldOpenResponse extends ApiResponseBase<ApiType.REQ_FOLD_OPEN> {
  HoleCardIndex: number
  IsFoldOpen: boolean
}
/** 212 */
interface EvtLeaveCompletedResponse extends ApiResponseBase<ApiType.EVT_LEAVE_COMPLETED> { }
/** 213 */
interface ResEntryCancelResponse extends ApiResponseBase<ApiType.RES_ENTRY_CANCEL> {
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
  Player?: Player /** 観戦時は存在しない */
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
  CommunityCards: number[]
  DefeatStatus: number
  HandId: number
  OtherPlayers: OtherPlayer[]
  Player: Player
  Pot: number
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
  CommunityCards?: number[] /** exist in ring */
  Game?: Game /** exist in ring */
  OtherPlayers?: OtherPlayer[] /** exist in ring */
  Player?: Player /** exist in ring */
  ProcessType: number
  Progress?: Progress /** exist in ring */
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

interface Action {
  handId: number
  playerId: number
  seatIndex: number
  phase: PhaseType
  countPlayerActionsOnPhase: number
  countPrevBetsOnPhase: number
  actionType: ActionType
  amount: number
}

export class PokerChaseDB extends Dexie {
  public apiResponses!: Table<ApiResponse, number>
  public actions!: Table<Action, number>
  public hands!: Table<{ handId: number, communityCards: number[], resultType: number, playerWon: number }, number>
  public constructor(indexedDB?: IDBFactory, iDBKeyRange?: typeof IDBKeyRange) {
    super('PokerChaseDB', { indexedDB, IDBKeyRange: iDBKeyRange })
    this.version(1).stores({
      apiResponses: '++id,ApiTypeId',
      actions: '++actionId,handId,playerId,phase',
      hands: '++handId'
    })
  }
}

/** (同期) イベントをハンド単位に集約 */
class PokerChaseEventStream extends Transform {
  private events: ApiResponse[] = []
  constructor() {
    super({ objectMode: true })
  }
  _transform(event: ApiResponse, _encoding: string, callback: Function) {
    switch (event.ApiTypeId) {
      case ApiType.EVT_RESULT:
        this.events = []
        this.push([event])
        break
      case ApiType.EVT_DEAL:
        this.events = []
        this.events.push(event)
        break
      case ApiType.EVT_HAND_RESULT:
        this.events.push(event)
        this.push(this.events)
        break
      case ApiType.EVT_ACTION:
      case ApiType.EVT_DEAL_ROUND:
      default:
        this.events.push(event)
        break
    }
    callback()
  }
}

/** (非同期) ハンドを保存, stats変換 */
class PokerChaseHandStream extends Transform {
  private db: PokerChaseDB
  private playerSeatIndex: number = 0
  private seatUserIds: number[] = []
  private actions: Omit<Action, 'handId'>[] = []
  constructor(db: PokerChaseDB) {
    super({ objectMode: true })
    this.db = db
  }
  async _transform(events: ApiResponse[], _encoding: string, callback: Function) {
    try {
      await this.db.apiResponses.bulkAdd(events)
      for await (const event of events) {
        switch (event.ApiTypeId) {
          case ApiType.EVT_RESULT:
            callback(null, []) /** HUD非表示 */
            return
          case ApiType.EVT_DEAL:
            this.seatUserIds = []
            this.actions = []
            this.playerSeatIndex = event.Player?.SeatIndex ?? event.SeatUserIds.findIndex(userId => userId === -1)
            this.seatUserIds = event.SeatUserIds
            break
          case ApiType.EVT_ACTION:
            const phaseActions = this.actions.filter(({ phase }) => phase === event.Progress.Phase)
            const countPlayerActionsOnPhase = phaseActions.filter(({ seatIndex }) => seatIndex === event.SeatIndex).length + 1
            const countPrevBetsOnPhase = phaseActions.filter(({ actionType }) => [ActionType.BET, ActionType.RAISE, ActionType.ALL_IN].includes(actionType)).length + (event.Progress.Phase === PhaseType.PREFLOP ? 1 : 0)
            this.actions.push({
              actionType: event.ActionType,
              amount: event.BetChip,
              playerId: this.seatUserIds[event.SeatIndex],
              seatIndex: event.SeatIndex,
              phase: event.Progress.Phase,
              countPlayerActionsOnPhase,
              countPrevBetsOnPhase,
            })
            break
          case ApiType.EVT_HAND_RESULT:
            const actions: Action[] = this.actions.map(action => ({ handId: event.HandId, ...action }))
            await this.db.actions.bulkAdd(actions)
            break
        }
      }
      const allActions = await this.db.actions.where('playerId').anyOf(this.seatUserIds).toArray()
      const stats: HUDStat[] = PokerChaseService.sortUserIdOnDisplay(this.playerSeatIndex, this.seatUserIds).map(playerId => {
        const actions = allActions.filter(action => playerId === action.playerId)
        const hands = actions.filter(({ phase, countPlayerActionsOnPhase }) =>
          phase === PhaseType.PREFLOP
          && countPlayerActionsOnPhase === 1
        ).length
        const vpip = actions.filter(({ phase, actionType, countPlayerActionsOnPhase }) =>
          phase === PhaseType.PREFLOP
          && ![ActionType.FOLD, ActionType.CHECK].includes(actionType)
          && countPlayerActionsOnPhase === 1
        ).length / hands
        const pfr = [...new Set(actions.filter(({ phase, actionType }) =>
          phase === PhaseType.PREFLOP
          && [ActionType.RAISE, ActionType.ALL_IN].includes(actionType)
        ).map(({ handId }) => handId))].length / hands
        const threeBetChance = actions.filter(({ phase, countPrevBetsOnPhase }) =>
          phase === PhaseType.PREFLOP
          && countPrevBetsOnPhase === 2
        )
        const threeBet = threeBetChance.filter(({ actionType }) => [ActionType.RAISE, ActionType.ALL_IN].includes(actionType)).length / threeBetChance.length
        const threeBetFoldChance = actions.filter(({ phase, countPrevBetsOnPhase }) =>
          phase === PhaseType.PREFLOP
          && countPrevBetsOnPhase === 3
        )
        const threeBetFold = threeBetFoldChance.filter(({ actionType }) => actionType === ActionType.FOLD).length / threeBetFoldChance.length
        /** @todo AF, CB, CBF ... */
        return {
          playerId,
          hands,
          vpip,
          pfr,
          threeBet,
          threeBetFold,
        }
      })
      callback(null, stats)
    } catch (error) {
      console.log(error)
      callback(error)
    }
  }
}

export interface HUDStat {
  playerId: number
  hands: number
  vpip: number
  pfr: number
  threeBet: number
  threeBetFold: number
}

/** @see https://www.pokertracker.com/guides/PT3/general/statistical-reference-guide */
export class PokerChaseService {
  static readonly POKER_CHASE_SERVICE_EVENT = 'PokerChaseServiceEvent'
  private eventStream = new PokerChaseEventStream()
  readonly handStream: PokerChaseHandStream
  constructor({ db }: { db: PokerChaseDB }) {
    this.handStream = new PokerChaseHandStream(db)
    this.eventStream.pipe(this.handStream)
  }
  readonly eventHandler = (event: ApiResponse) => {
    this.logger(event)
    this.eventStream.write(event)
  }
  private logger = (event: ApiResponse) => {
    const timestamp = new Date().toISOString().slice(11, 19)
    ApiType[event.ApiTypeId]
      ? console.debug(`[${timestamp}]`, event.ApiTypeId, ApiType[event.ApiTypeId], event)
      : console.warn(`[${timestamp}]`, event.ApiTypeId, ApiType[event.ApiTypeId], event)
  }
  static readonly sortUserIdOnDisplay = (playerSeatIndex: number, seatUserIds: number[]) => {
    return [
      ...seatUserIds.slice(playerSeatIndex, Infinity),
      ...seatUserIds.slice(0, playerSeatIndex)
    ]
  }
}
