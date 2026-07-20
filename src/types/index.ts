/**
 * Central export point for all type definitions
 */

// API types
export {
  ApiType,
  type ApiEvent,
  type ApiHandEvent,
  type ApiSessionEvent,
  type ApiPlayerEvent,
  type ApiMessage,
  // Validation functions
  isApplicationApiEvent,
  validateApiEvent,
  validateMessage,
  isApiEventType,
  parseApiEvent,
  parseApiEventType,
  getValidationError,
  ApiTypeValues,
  // Zod schemas
  apiEventSchemas,
  // Schema access functions
  getEventSchema,
  getAvailableEventTypes,
  getEventFields,
  parseEventWithSchema
} from './api'

// Game mechanics types
export {
  ActionType,
  BattleType,
  BetStatusType,
  PhaseType,
  RankType,
  Position,
  ActionDetail,
  BATTLE_TYPE_FILTERS,
  isShowdownParticipant,
  hasResultsOutsideDealtLineup
} from './game'

// Entity types
export type {
  BlindStructure,
  Chara,
  EventDetail,
  Game,
  Item,
  OtherPlayer,
  Player,
  JoinPlayer,
  Progress,
  RankReward,
  RankingReward,
  Result,
  Reward,
  RingReward,
  Stamp,
  TableUser,
  Session,
  Hand,
  Phase,
  Action,
  ImportMeta,
  MetaRecord,
  ImportMetaRecord,
  StatisticsCacheRecord,
  SyncStatusRecord,
  SpecificMetaRecord,
  User,
  ExistPlayerStats,
  PlayerStats,
  HandState
} from './entities'

// Entity Zod schemas
export {
  // Schemas
  handSchema,
  phaseSchema,
  actionSchema,
  userSchema,
  existPlayerStatsSchema,
  playerStatsSchema,
  handStateSchema,
  metaRecordBaseSchema,
  importMetaRecordSchema,
  statisticsCacheRecordSchema,
  syncStatusRecordSchema,
  specificMetaRecordSchema,
  // Parsing functions
  parseHand,
  parsePhase,
  parseAction,
  parseMetaRecord
} from './entities'

// Filter types
export type {
  GameTypeFilter,
  FilterOptions,
  StatDisplayConfig,
  TableSizeFilter
} from './filters'

// Table-size layer classification/filtering (shared by vpipF and the table-size filter)
export {
  classifyTableSizeLayer,
  matchesTableSizeFilter,
  selectedTableSizeLayers,
  ALL_TABLE_SIZE_LAYERS,
  DEFAULT_TABLE_SIZE_FILTER,
  type TableSizeLayer
} from '../utils/table-size'

// Statistics types
export type {
  StatDefinition,
  StatCalculationContext,
  StatValue,
  StatResult,
  ActionDetailContext,
  PositionalStatsBucketId,
  PositionalStatId,
  PositionalStatsBucket,
  PositionalStatsResult,
  PreflopLine,
  RecentHandEntry,
  RecentHandsResult
} from './stats'

// Error handling types
export {
  ErrorType,
  ErrorSeverity,
  type AppError,
  type ErrorContext
} from './errors'

// Hand log types
export {
  HandLogEntryType,
  DEFAULT_HAND_LOG_CONFIG,
  type HandLogEntry,
  type HandLogState,
  type HandLogConfig,
  type HandLogEvent
} from './hand-log'
