/**
 * Data Model Types and Entities
 */

import type { BattleType, PhaseType, ActionType, Position, ActionDetail, RankType, BetStatusType } from './game'

// Base entities
export interface BlindStructure {
  Lv: number
  ActiveMinutes: number
  BigBlind: number
  Ante: number
}

export interface Chara {
  CharaId: string
  CostumeId: string
  Favorite: number
  Bond: number
  Rank: number
  TodayUpNum: number
  Evolution: boolean
  Stamps: Stamp[]
}

export interface EventDetail {
  ItemId: string
  Num: number
}

export interface Game {
  CurrentBlindLv: number
  NextBlindUnixSeconds: number
  Ante: number
  SmallBlind: number
  BigBlind: number
  ButtonSeat: 0 | 1 | 2 | 3 | 4 | 5
  SmallBlindSeat: 0 | 1 | 2 | 3 | 4 | 5
  BigBlindSeat: 0 | 1 | 2 | 3 | 4 | 5
}

export interface Item {
  ItemId: string
  Num: number
}

export interface OtherPlayer extends Omit<Player, 'HoleCards'> {
  Status: 0 | 5
}

export interface Player {
  SeatIndex: 0 | 1 | 2 | 3 | 4 | 5
  BetStatus: BetStatusType
  Chip: number
  BetChip: number
  HoleCards: [number, number] | []
  IsSafeLeave?: boolean
}

export interface JoinPlayer extends Omit<Player, 'HoleCards'> {
  Status: 0
}

export interface Progress {
  Phase: PhaseType
  NextActionSeat: -2 | -1 | 0 | 1 | 2 | 3 | 4 | 5
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

export interface RankingReward {
  HighRanking: number
  LowRanking: number
  Rewards: Reward[]
}

export interface ResultBase {
  UserId: number
  HandRanking: -1 | 1 | 2 | 3 | 4 | 5 | 6
  Ranking: -2 | -1 | 1 | 2 | 3 | 4 | 5 | 6
  RewardChip: number
}

export interface ShowDownResult extends ResultBase {
  RankType: RankType.ROYAL_FLUSH | RankType.STRAIGHT_FLUSH | RankType.FOUR_OF_A_KIND | RankType.FULL_HOUSE | RankType.FLUSH | RankType.STRAIGHT | RankType.THREE_OF_A_KIND | RankType.TWO_PAIR | RankType.ONE_PAIR | RankType.HIGH_CARD
  Hands: [number, number, number, number, number]
  HoleCards: [number, number]
}

export interface NoCallOrShowDownMuckResult extends ResultBase {
  RankType: RankType.NO_CALL | RankType.SHOWDOWN_MUCK
  Hands: never[]
  HoleCards: never[]
}

export interface FoldOpenResult extends ResultBase {
  RankType: RankType.FOLD_OPEN
  Hands: never[]
  HoleCards: [number, number]
}

export type Result =
  | ShowDownResult
  | NoCallOrShowDownMuckResult
  | FoldOpenResult

export interface Reward {
  Category: number
  TargetId: string
  Num: number
  BuffNum: number
}

export interface RingReward {
  ResultNum: number
  Ranking: number
  Score: number
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
    RankId: 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond' | 'legend'
    RankName: 'ブロンズ' | 'シルバー' | 'ゴールド' | 'プラチナ' | 'ダイヤモンド' | 'レジェンド' | 'text_rank_name_bronze' | 'text_rank_name_silver' | 'text_rank_name_gold' | 'text_rank_name_platinum' | 'text_rank_name_diamond' | 'text_rank_name_legend'
    RankLvId: 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond' | 'legend'
    RankLvName: 'ブロンズ' | 'シルバー' | 'ゴールド' | 'プラチナ' | 'ダイヤモンド' | 'レジェンド' | 'text_rank_lv_name_bronze' | 'text_rank_lv_name_silver' | 'text_rank_lv_name_gold' | 'text_rank_lv_name_platinum' | 'text_rank_lv_name_diamond' | 'text_rank_lv_name_legend'
  }
  ClassLvId?: ""
  IsOfficial: boolean
  IsCpu: boolean
  SettingDecoIds: string[]
}

// Session types
export interface Session {
  id?: string
  battleType?: BattleType
  name?: string
  players: Map<number, { name: string, rank: string }>  // Session-based player information
  reset: () => void
}

// Data model entities
export interface Hand {
  /** `EVT_HAND_RESULTS`まで未確定 */
  id: number
  approxTimestamp?: number
  seatUserIds: number[]
  winningPlayerIds: number[]
  smallBlind: number
  bigBlind: number
  session: Omit<Session, 'reset' | 'players'>
  results: Result[]
}

export interface Phase {
  handId?: number
  phase: PhaseType
  seatUserIds: number[]
  communityCards: number[]
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

// User entity for database storage - normalized from TableUser
export interface User {
  id: number                    // Player ID (primary key)
  name: string                  // Player name
  favoriteCharaId: string       // Favorite character ID
  rank: string                  // Rank ID (e.g., 'diamond', 'legend')
  isOfficial: boolean           // Official account flag
  isCpu: boolean                // CPU player flag
}


// Player statistics
export interface ExistPlayerStats {
  playerId: number
  statResults: import('./stats').StatResult[]
}

export type PlayerStats = ExistPlayerStats | { playerId: -1, statResults?: [] }

// Stream state
export interface HandState {
  hand: Hand
  actions: Action[]
  phases: Phase[]
  // State tracking for statistics
  cBetter?: number  // Player who made the last raise preflop
  lastAggressor?: number  // Player who made the last bet/raise in previous street
  currentStreetAggressor?: number  // Player who made the first bet in current street
}

// Import metadata for incremental processing
export interface ImportMeta {
  id: string                      // Unique identifier (e.g., 'lastProcessed')
  lastProcessedTimestamp: number  // Timestamp of last processed event
  lastProcessedEventCount: number // Number of events processed in last import
  lastImportDate: Date           // Date of last import
}
