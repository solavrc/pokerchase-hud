/**
 * Data Model Types and Entities
 */

import * as z from 'zod'
import { BattleType, PhaseType, ActionType, Position, ActionDetail, RankType } from './game'
import type { ApiEvent, ApiType } from './api'

// ===============================
// Entity Types from API Schemas
// ===============================

// 各イベント型から必要な部分型を抽出
type SessionDetailsEvent = ApiEvent<ApiType.EVT_SESSION_DETAILS>
type DealEvent = ApiEvent<ApiType.EVT_DEAL>
type ActionEvent = ApiEvent<ApiType.EVT_ACTION>
type DealRoundEvent = ApiEvent<ApiType.EVT_DEAL_ROUND>
type HandResultsEvent = ApiEvent<ApiType.EVT_HAND_RESULTS>
type SessionResultsEvent = ApiEvent<ApiType.EVT_SESSION_RESULTS>
type PlayerSeatAssignedEvent = ApiEvent<ApiType.EVT_PLAYER_SEAT_ASSIGNED>
type PlayerJoinEvent = ApiEvent<ApiType.EVT_PLAYER_JOIN>

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

// ===============================
// Zod Schemas for Entities
// ===============================

// Session type - kept as interface for better type inference
export interface Session {
  id?: string
  battleType?: BattleType
  name?: string
  players: Map<number, { name: string, rank: string }>  // Session-based player information
  reset: () => void
}

// Hand result schema (embedded in Hand)
const handResultSchema = z.object({
  UserId: z.number(),
  HandRanking: z.union([z.literal(-1), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
  Ranking: z.union([z.literal(-2), z.literal(-1), z.number().nonnegative()]),
  RewardChip: z.number(),
  RankType: z.nativeEnum(RankType),
  Hands: z.array(z.number()).max(5),      // 5枚または空配列
  HoleCards: z.array(z.number()).max(2)   // 2枚、[-1,-1]、または空配列
})

// Hand schema
export const handSchema = z.object({
  /** `EVT_HAND_RESULTS`まで未確定 */
  id: z.number(),
  approxTimestamp: z.number().optional(),
  seatUserIds: z.array(z.number()),
  winningPlayerIds: z.array(z.number()),
  smallBlind: z.number(),
  bigBlind: z.number(),
  session: z.object({
    id: z.string().optional(),
    battleType: z.nativeEnum(BattleType).optional(),
    name: z.string().optional()
  }),
  results: z.array(handResultSchema)
})

export type Hand = z.infer<typeof handSchema>

// Phase schema
export const phaseSchema = z.object({
  handId: z.number().optional(),
  phase: z.nativeEnum(PhaseType),
  seatUserIds: z.array(z.number()),
  communityCards: z.array(z.number())
})

export type Phase = z.infer<typeof phaseSchema>

// Action schema
export const actionSchema = z.object({
  handId: z.number().optional(),
  index: z.number(),
  playerId: z.number(),
  phase: z.nativeEnum(PhaseType),
  actionType: z.nativeEnum(ActionType).refine(
    (val): val is Exclude<ActionType, ActionType.ALL_IN> => val !== ActionType.ALL_IN,
    { message: 'ALL_IN action type is not allowed' }
  ),
  bet: z.number(),
  pot: z.number(),
  sidePot: z.array(z.number()),
  position: z.nativeEnum(Position),
  actionDetails: z.array(z.nativeEnum(ActionDetail))
})

export type Action = z.infer<typeof actionSchema>

// User schema - normalized from TableUser
export const userSchema = z.object({
  id: z.number(),                    // Player ID (primary key)
  name: z.string(),                  // Player name
  favoriteCharaId: z.string(),       // Favorite character ID
  rank: z.string(),                  // Rank ID (e.g., 'diamond', 'legend')
  isOfficial: z.boolean(),           // Official account flag
  isCpu: z.boolean()                 // CPU player flag
})

export type User = z.infer<typeof userSchema>


// Player statistics schemas
export const existPlayerStatsSchema = z.object({
  playerId: z.number(),
  statResults: z.array(z.any()) // Will be refined when stats.ts is migrated to Zod
})

export type ExistPlayerStats = z.infer<typeof existPlayerStatsSchema>

export const playerStatsSchema = z.union([
  existPlayerStatsSchema,
  z.object({
    playerId: z.literal(-1),
    statResults: z.array(z.never()).optional()
  })
])

export type PlayerStats = z.infer<typeof playerStatsSchema>

// HandState schema
export const handStateSchema = z.object({
  hand: handSchema,
  actions: z.array(actionSchema),
  phases: z.array(phaseSchema),
  // State tracking for statistics
  cBetter: z.number().optional(),  // Player who made the last raise preflop
  lastAggressor: z.number().optional(),  // Player who made the last bet/raise in previous street
  currentStreetAggressor: z.number().optional()  // Player who made the first bet in current street
})

export type HandState = z.infer<typeof handStateSchema>

// Import metadata schema - legacy interface kept for backward compatibility
export interface ImportMeta {
  id: string                      // Unique identifier (e.g., 'lastProcessed')
  lastProcessedTimestamp: number  // Timestamp of last processed event
  lastProcessedEventCount: number // Number of events processed in last import
  lastImportDate: Date           // Date of last import
}

// Base metadata record schema
export const metaRecordBaseSchema = z.object({
  id: z.string(),                      // Unique identifier
  updatedAt: z.number().optional(),     // Timestamp of last update (milliseconds since epoch)
  expiresAt: z.number().optional()      // Optional expiration timestamp for cache entries
})

// Generic metadata record interface (for backward compatibility)
export interface MetaRecord {
  id: string
  value: any
  updatedAt?: number
  expiresAt?: number
}

// ImportMetaRecord schema
export const importMetaRecordSchema = metaRecordBaseSchema.extend({
  id: z.literal('importStatus'),
  value: z.object({
    lastProcessedTimestamp: z.number(),
    lastProcessedEventCount: z.number(),
    lastImportDate: z.string()       // ISO date string
  })
})

export type ImportMetaRecord = z.infer<typeof importMetaRecordSchema>

// StatisticsCacheRecord schema
export const statisticsCacheRecordSchema = metaRecordBaseSchema.extend({
  id: z.string().regex(/^statisticsCache:\d+$/), // e.g., 'statisticsCache:12345'
  value: z.object({
    playerId: z.number(),
    stats: z.array(z.any()), // Will be refined when stats.ts is migrated to Zod
    handCount: z.number()
  }),
  expiresAt: z.number()              // Cache expiration timestamp (required)
})

export type StatisticsCacheRecord = z.infer<typeof statisticsCacheRecordSchema>

// SyncStatusRecord schema
export const syncStatusRecordSchema = metaRecordBaseSchema.extend({
  id: z.literal('syncStatus'),
  value: z.object({
    lastSyncTimestamp: z.number(),
    lastSyncDirection: z.enum(['upload', 'download', 'bidirectional']),
    syncedEventCount: z.number(),
    nextSyncScheduled: z.number().optional()
  })
})

export type SyncStatusRecord = z.infer<typeof syncStatusRecordSchema>

// Discriminated union schema for all specific meta records
// Note: Cannot use discriminatedUnion due to statisticsCacheRecordSchema's regex pattern
export const specificMetaRecordSchema = z.union([
  importMetaRecordSchema,
  statisticsCacheRecordSchema,
  syncStatusRecordSchema
])

export type SpecificMetaRecord = z.infer<typeof specificMetaRecordSchema>

// ===============================
// Entity Validation Functions
// ===============================

/**
 * Validate and parse a Hand entity
 */
export function parseHand(data: unknown): Hand | null {
  const result = handSchema.safeParse(data)
  return result.success ? result.data : null
}

/**
 * Validate and parse a Phase entity
 */
export function parsePhase(data: unknown): Phase | null {
  const result = phaseSchema.safeParse(data)
  return result.success ? result.data : null
}

/**
 * Validate and parse an Action entity
 */
export function parseAction(data: unknown): Action | null {
  const result = actionSchema.safeParse(data)
  return result.success ? result.data : null
}

/**
 * Validate and parse a MetaRecord variant
 */
export function parseMetaRecord(data: unknown): SpecificMetaRecord | null {
  const result = specificMetaRecordSchema.safeParse(data)
  return result.success ? result.data : null
}
