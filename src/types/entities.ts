/**
 * Data Model Types and Entities
 */

import type { BattleType, PhaseType, ActionType, Position, ActionDetail, RankType } from './game'
import type { ApiEventType, ApiType } from './api'

// ===============================
// Entity Types from API Schemas
// ===============================

// 各イベント型から必要な部分型を抽出
type SessionDetailsEvent = ApiEventType<ApiType.EVT_SESSION_DETAILS>
type DealEvent = ApiEventType<ApiType.EVT_DEAL>
type ActionEvent = ApiEventType<ApiType.EVT_ACTION>
type DealRoundEvent = ApiEventType<ApiType.EVT_DEAL_ROUND>
type HandResultsEvent = ApiEventType<ApiType.EVT_HAND_RESULTS>
type SessionResultsEvent = ApiEventType<ApiType.EVT_SESSION_RESULTS>
type PlayerSeatAssignedEvent = ApiEventType<ApiType.EVT_PLAYER_SEAT_ASSIGNED>
type PlayerJoinEvent = ApiEventType<ApiType.EVT_PLAYER_JOIN>

// EVT_SESSION_DETAILS関連
export type BlindStructure = NonNullable<SessionDetailsEvent['BlindStructures']>[0]
export type RankingReward = NonNullable<SessionDetailsEvent['RankingRewards']>[0]
export type EventDetail = NonNullable<SessionDetailsEvent['Items']>[0]
export type Reward = RankingReward['Rewards'][0]

// EVT_DEAL関連
export type Game = DealEvent['Game']
export type Player = NonNullable<DealEvent['Player']>
export type OtherPlayer = DealEvent['OtherPlayers'][0]

// Progress関連 - 各イベントのProgress型をユニオンで統合
export type Progress = DealEvent['Progress'] | ActionEvent['Progress'] | DealRoundEvent['Progress']

// EVT_PLAYER_SEAT_ASSIGNED関連
export type TableUser = PlayerSeatAssignedEvent['TableUsers'][0]

// EVT_PLAYER_JOIN関連
export type JoinPlayer = PlayerJoinEvent['JoinPlayer']

// EVT_HAND_RESULTS関連
export type Result = HandResultsEvent['Results'][0]

// EVT_SESSION_RESULTS関連
export type RankReward = NonNullable<SessionResultsEvent['RankReward']>
export type RingReward = NonNullable<SessionResultsEvent['RingReward']>
export type Chara = SessionResultsEvent['Charas'][0]
export type Stamp = SessionResultsEvent['Charas'][0]['Stamps'][0]
export type Item = SessionResultsEvent['Items'][0]

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
  results: Array<{
    UserId: number
    HandRanking: number  // -1 | 1 | 2 | 3 | 4 | 5 | 6
    Ranking: number      // -2 | -1 | 正の数
    RewardChip: number
    RankType: RankType
    Hands: number[]      // 5枚または空配列
    HoleCards: number[]  // 2枚、[-1,-1]、または空配列
  }>
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

// Generic metadata record for various application data
export interface MetaRecord {
  id: string                      // Unique identifier (e.g., 'lastProcessed', 'statisticsCache', 'syncStatus')
  value: any                      // Flexible value storage (can be object, array, string, number, etc.)
  updatedAt?: number             // Timestamp of last update (milliseconds since epoch)
  expiresAt?: number             // Optional expiration timestamp for cache entries
}

// Specific meta record types for type safety
export interface ImportMetaRecord extends MetaRecord {
  id: 'importStatus'
  value: {
    lastProcessedTimestamp: number
    lastProcessedEventCount: number
    lastImportDate: string       // ISO date string
  }
}

export interface StatisticsCacheRecord extends MetaRecord {
  id: `statisticsCache:${number}` // e.g., 'statisticsCache:12345' for player 12345
  value: {
    playerId: number
    stats: import('./stats').StatResult[]
    handCount: number
  }
  expiresAt: number              // Cache expiration timestamp
}

export interface SyncStatusRecord extends MetaRecord {
  id: 'syncStatus'
  value: {
    lastSyncTimestamp: number
    lastSyncDirection: 'upload' | 'download' | 'bidirectional'
    syncedEventCount: number
    nextSyncScheduled?: number
  }
}

// Union type for all specific meta records
export type SpecificMetaRecord = ImportMetaRecord | StatisticsCacheRecord | SyncStatusRecord
