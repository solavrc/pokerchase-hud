import Dexie from 'dexie'
import type {
  PokerChaseDB,
  StatAggregateBucket,
  StatHandContributionRecord,
  StatPlayerAggregateRecord,
} from '../db/poker-chase-db'
import type { EntityBundle } from '../entity-converter'
import type { MetaRecord } from '../types/entities'
import { ApiType } from '../types/api'
import type { StatValue } from '../types/stats'
import type { TableSizeLayer } from '../utils/table-size'
import {
  MAX_STATS_LATEST_HANDS,
  normalizeStatsLatestHands,
} from '../utils/stats-hand-limit'
import { BattleType } from '../types/game'
import {
  getApiEventKey,
  getApiEventSequence,
  type ApiEventKey,
  type RawApiEvent,
} from '../utils/api-event-key'
import {
  HAND_STAT_CONTRIBUTION_VERSION,
  HAND_STAT_COUNTER_VECTOR_LENGTH,
  NUMERIC_STAT_IDS,
  addHandStatCounterVectors,
  createEmptyHandStatCounterVector,
  derivePlayerHandStatContribution,
  derivePlayerHandStatContributions,
  getStatCounter,
  statValueFromCounterVector,
  subtractHandStatCounterVectors,
  type HandPosition,
  type HandStatCounterVector,
  type NumericStatId,
  type PlayerHandStatContribution,
} from './hand-contribution'

export const STATS_LEDGER_HEAD_META_ID = 'statsLedgerHead' as const
export const STATS_LEDGER_STAGING_META_ID = 'statsLedgerStaging' as const
export const STATS_CANONICAL_REVISION_META_ID = 'statsCanonicalRevision' as const
export const STATS_CANONICAL_REBUILD_META_ID = 'statsCanonicalRebuild' as const
export const STATS_PENDING_HAND_DERIVATION_META_PREFIX = 'statsPendingHandDerivation:v1:' as const

// 同一Service Worker内のStatsLedger instanceはこのownerを共有する。SW再起動後に
// 残ったstaging markerへライブ書込みを鏡写ししてはならない（MUST NOT）。
const STATS_LEDGER_BOOT_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`
const MAX_LINEUP_READ_ATTEMPTS = 4
// current handのcommitとcold baselineが数回重なってもhard errorにしない。
// per-cell 500行上限により1 attemptのwrite量は履歴全件数に依存しない。
const MAX_BASELINE_BUILD_ATTEMPTS = 12
const BASELINE_WRITE_CHUNK_SIZE = 250
const BASELINE_CPU_SCAN_CHUNK_SIZE = 2048
const BASELINE_DERIVE_CHUNK_SIZE = 500
const LEDGER_GC_CHUNK_SIZE = 250
const LEDGER_GC_START_DELAY_MS = 1000
const KNOWN_BATTLE_TYPES: readonly number[] = [
  BattleType.SIT_AND_GO,
  BattleType.TOURNAMENT,
  BattleType.FRIEND_SIT_AND_GO,
  BattleType.RING_GAME,
  BattleType.FRIEND_RING_GAME,
  BattleType.CLUB_MATCH,
]
const KNOWN_BATTLE_TYPE_SET = new Set(KNOWN_BATTLE_TYPES)

export interface StatsLedgerHead {
  generation: number
  version: typeof HAND_STAT_CONTRIBUTION_VERSION
}

interface StatsLedgerStagingMarker extends StatsLedgerHead {
  ownerId: string
}

interface PendingHandDerivationFence {
  version: 1
  ownerId: string
  handId: number
  rawKey: ApiEventKey
  failed?: true
}

type PendingHandDerivationEvent = {
  timestamp?: unknown
  ApiTypeId?: unknown
  sequence?: unknown
  HandId?: unknown
}

export interface StatsLedgerFilters {
  /** 未指定はunknownを含む全対戦種別。配列指定時はunknownを除外する。 */
  battleTypes?: readonly number[]
  /** 未指定はunknownを含む全卓人数層。配列指定時はunknownを除外する。 */
  tableSizeLayers?: readonly TableSizeLayer[]
  /** 正の有限値だけが有効。0<値<1は旧slice互換で0件、上限は500。0以下は全履歴。 */
  latestHands?: number
}

export interface StatsLedgerDiagnostics {
  source: 'aggregate' | 'contributions'
  contributionRowsRead: number
  indexQueries: string[]
  baselineBuilt: boolean
  canonicalRowsRead: number
  baselineMs: number
}

export type StatsLedgerSelection =
  | { kind: 'aggregate', buckets: StatAggregateBucket[] }
  | { kind: 'rows', rows: StatHandContributionRecord[] }

export interface PositionCounterPrimitive {
  position: HandPosition
  handsN: number
  counters: HandStatCounterVector
}

export interface PlayerStatCounterSnapshot {
  generation: number
  version: typeof HAND_STAT_CONTRIBUTION_VERSION
  playerId: number
  counters: HandStatCounterVector
  totalHands: number
  /** battle/table filter後、latestHands適用前の完了ハンド数。 */
  matchedHandsBeforeLimit: number
  selectedHands: number
  positions: PositionCounterPrimitive[]
  selection: StatsLedgerSelection
  diagnostics: StatsLedgerDiagnostics
}

export type NumericStatSnapshot = Record<NumericStatId, StatValue>

export interface BuiltStatsGeneration {
  generation: number
  version: typeof HAND_STAT_CONTRIBUTION_VERSION
  contributions: StatHandContributionRecord[]
  aggregates: StatPlayerAggregateRecord[]
}

export interface ReplaceGenerationOptions {
  generation?: number
  activate?: boolean
}

interface BaselineDiagnostics {
  built: boolean
  canonicalRowsRead: number
  elapsedMs: number
}

interface NormalizedStatsLedgerFilters {
  battleTypes?: number[]
  tableSizeLayers?: TableSizeLayer[]
  latestHands?: number
}

class BaselineRequiredError extends Error {
  constructor(readonly playerId: number, readonly force: boolean) {
    super('Statistics ledger baseline is required')
  }
}

class CanonicalBaselineUnavailableError extends Error {
  constructor() {
    super('Canonical entities are being rebuilt or are not known complete')
  }
}

class BaselineBuildSupersededError extends Error {
  constructor() {
    super('Statistics-ledger baseline build was superseded')
  }
}

function isValidCounterVector(value: unknown): value is HandStatCounterVector {
  return Array.isArray(value) &&
    value.length === HAND_STAT_COUNTER_VECTOR_LENGTH &&
    value.every(counter => typeof counter === 'number' && Number.isFinite(counter) && counter >= 0)
}

function assertCounterVector(value: unknown): asserts value is HandStatCounterVector {
  if (!isValidCounterVector(value)) {
    throw new RangeError('Invalid statistics-ledger counter vector')
  }
}

function battleBucket(battleType: number | null): string {
  return battleType === null ? 'unknown' : `battle:${battleType}`
}

function tableBucket(tableSizeLayer: TableSizeLayer | null): string {
  return tableSizeLayer === null ? 'unknown' : `table:${tableSizeLayer}`
}

function positionBucket(position: HandPosition): string {
  return position === 'unknown' ? 'unknown' : `position:${position}`
}

function recordFromContribution(
  generation: number,
  contribution: PlayerHandStatContribution
): StatHandContributionRecord {
  const hasTimestamp = contribution.approxTimestamp === null ? 0 : 1
  return {
    generation,
    playerId: contribution.playerId,
    handId: contribution.handId,
    hasKnownBattle: contribution.battleType !== null &&
      KNOWN_BATTLE_TYPE_SET.has(contribution.battleType) ? 1 : 0,
    hasTimestamp,
    sortTimestamp: contribution.approxTimestamp ?? 0,
    battleBucket: battleBucket(contribution.battleType),
    tableBucket: tableBucket(contribution.tableSizeLayer),
    positionBucket: positionBucket(contribution.position),
    version: contribution.version,
    approxTimestamp: contribution.approxTimestamp,
    battleType: contribution.battleType,
    tableSizeLayer: contribution.tableSizeLayer,
    position: contribution.position,
    counters: [...contribution.counters],
  }
}

function createAggregate(
  generation: number,
  playerId: number,
  ready: boolean,
  updatedAt: number
): StatPlayerAggregateRecord {
  return {
    generation,
    playerId,
    version: HAND_STAT_CONTRIBUTION_VERSION,
    ready,
    totals: createEmptyHandStatCounterVector(),
    buckets: [],
    updatedAt,
  }
}

function cloneAggregate(record: StatPlayerAggregateRecord): StatPlayerAggregateRecord {
  return {
    ...record,
    totals: [...record.totals],
    buckets: record.buckets.map(bucket => ({
      ...bucket,
      counters: [...bucket.counters],
    })),
  }
}

function hasValidAggregateShape(
  record: StatPlayerAggregateRecord | undefined,
  generation: number,
  playerId: number
): record is StatPlayerAggregateRecord {
  return record !== undefined &&
    record.generation === generation &&
    record.playerId === playerId &&
    record.version === HAND_STAT_CONTRIBUTION_VERSION &&
    typeof record.ready === 'boolean' &&
    isValidCounterVector(record.totals) &&
    Array.isArray(record.buckets) &&
    record.buckets.every(bucket =>
      typeof bucket.battleBucket === 'string' &&
      typeof bucket.tableBucket === 'string' &&
      typeof bucket.positionBucket === 'string' &&
      Number.isSafeInteger(bucket.handsN) &&
      bucket.handsN >= 0 &&
      isValidCounterVector(bucket.counters)
    )
}

function isValidAggregate(
  record: StatPlayerAggregateRecord | undefined,
  generation: number,
  playerId: number
): record is StatPlayerAggregateRecord {
  return hasValidAggregateShape(record, generation, playerId) &&
    record.ready === true &&
    record.buildId === undefined
}

function bucketKey(record: Pick<StatHandContributionRecord, 'battleBucket' | 'tableBucket' | 'positionBucket'>): string {
  return `${record.battleBucket}\u0000${record.tableBucket}\u0000${record.positionBucket}`
}

function applyContributionToAggregate(
  aggregate: StatPlayerAggregateRecord,
  contribution: StatHandContributionRecord,
  direction: 1 | -1
): void {
  assertCounterVector(contribution.counters)
  aggregate.totals = direction === 1
    ? addHandStatCounterVectors(aggregate.totals, contribution.counters)
    : subtractHandStatCounterVectors(aggregate.totals, contribution.counters)

  const key = bucketKey(contribution)
  const existingIndex = aggregate.buckets.findIndex(bucket => bucketKey(bucket) === key)
  if (direction === 1) {
    if (existingIndex === -1) {
      aggregate.buckets.push({
        battleBucket: contribution.battleBucket,
        tableBucket: contribution.tableBucket,
        positionBucket: contribution.positionBucket,
        counters: [...contribution.counters],
        handsN: 1,
      })
    } else {
      const existing = aggregate.buckets[existingIndex]!
      existing.counters = addHandStatCounterVectors(existing.counters, contribution.counters)
      existing.handsN++
    }
  } else if (existingIndex !== -1) {
    const existing = aggregate.buckets[existingIndex]!
    existing.counters = subtractHandStatCounterVectors(existing.counters, contribution.counters)
    existing.handsN--
    if (existing.handsN === 0) aggregate.buckets.splice(existingIndex, 1)
  }
  aggregate.updatedAt = Date.now()
}

function latestCellKey(record: Pick<StatHandContributionRecord, 'playerId' | 'battleBucket' | 'tableBucket'>): string {
  return `${record.playerId}\u0000${record.battleBucket}\u0000${record.tableBucket}`
}

/**
 * 各battle×table cellの最新500件の和集合は、任意のfilter後の最新500件を
 * 必ず含む。全履歴の集計値はaggregateに残し、per-hand行だけを有界化する。
 */
function trimRecordsToLatestCells(
  records: readonly StatHandContributionRecord[]
): StatHandContributionRecord[] {
  const cells = new Map<string, StatHandContributionRecord[]>()
  for (const record of records) {
    const key = latestCellKey(record)
    const rows = cells.get(key) ?? []
    rows.push(record)
    cells.set(key, rows)
  }
  return [...cells.values()].flatMap(rows =>
    rows.sort(compareContributionRowsNewestFirst).slice(0, MAX_STATS_LATEST_HANDS)
  )
}

/** counter vectorをUI非依存の統計値recordへ射影する。 */
export function buildStatSnapshot(counters: readonly number[]): NumericStatSnapshot {
  assertCounterVector(counters)
  return Object.fromEntries(
    NUMERIC_STAT_IDS.map(statId => [statId, statValueFromCounterVector(counters, statId)])
  ) as NumericStatSnapshot
}

/** 完成済みentity集合を、指定世代の永続行へ純粋変換する。 */
export function buildGenerationFromEntityBundle(
  generation: number,
  bundle: EntityBundle,
  options: { ready?: boolean, updatedAt?: number } = {}
): BuiltStatsGeneration {
  const updatedAt = options.updatedAt ?? Date.now()
  const ready = options.ready ?? true
  const actionsByHand = new Map<number, typeof bundle.actions>()
  const phasesByHand = new Map<number, typeof bundle.phases>()
  for (const action of bundle.actions) {
    if (action.handId === undefined) continue
    const rows = actionsByHand.get(action.handId) ?? []
    rows.push(action)
    actionsByHand.set(action.handId, rows)
  }
  for (const phase of bundle.phases) {
    if (phase.handId === undefined) continue
    const rows = phasesByHand.get(phase.handId) ?? []
    rows.push(phase)
    phasesByHand.set(phase.handId, rows)
  }

  const contributions: StatHandContributionRecord[] = []
  const aggregates = new Map<number, StatPlayerAggregateRecord>()
  const uniqueHands = new Map(bundle.hands.map(hand => [hand.id, hand] as const))
  for (const hand of uniqueHands.values()) {
    const handContributions = derivePlayerHandStatContributions(
      hand,
      actionsByHand.get(hand.id) ?? [],
      phasesByHand.get(hand.id) ?? []
    )
    for (const contribution of handContributions) {
      const record = recordFromContribution(generation, contribution)
      contributions.push(record)
      const aggregate = aggregates.get(record.playerId) ??
        createAggregate(generation, record.playerId, ready, updatedAt)
      applyContributionToAggregate(aggregate, record, 1)
      aggregate.ready = ready
      aggregate.updatedAt = updatedAt
      aggregates.set(record.playerId, aggregate)
    }
  }

  const retainedContributions = trimRecordsToLatestCells(contributions)
  retainedContributions.sort((left, right) =>
    left.playerId - right.playerId || left.handId - right.handId
  )
  return {
    generation,
    version: HAND_STAT_CONTRIBUTION_VERSION,
    contributions: retainedContributions,
    aggregates: [...aggregates.values()].sort((left, right) => left.playerId - right.playerId),
  }
}

function parseHead(value: unknown): StatsLedgerHead | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<StatsLedgerHead>
  if (!Number.isSafeInteger(candidate.generation) || (candidate.generation ?? -1) < 0) return null
  if (candidate.version !== HAND_STAT_CONTRIBUTION_VERSION) return null
  return {
    generation: candidate.generation!,
    version: HAND_STAT_CONTRIBUTION_VERSION,
  }
}

function parseStagingMarker(value: unknown): StatsLedgerStagingMarker | null {
  const head = parseHead(value)
  if (!head || typeof (value as Partial<StatsLedgerStagingMarker>).ownerId !== 'string') return null
  return { ...head, ownerId: (value as StatsLedgerStagingMarker).ownerId }
}

function parseCanonicalRevision(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0
}

const getPendingHandDerivationMetaId = (
  event: PendingHandDerivationEvent
): string | undefined => {
  if (
    event.ApiTypeId !== ApiType.EVT_HAND_RESULTS ||
    !Number.isSafeInteger(event.HandId) ||
    (event.HandId as number) < 0 ||
    !Number.isSafeInteger(event.timestamp) ||
    !Number.isSafeInteger(getApiEventSequence(event))
  ) return
  return `${STATS_PENDING_HAND_DERIVATION_META_PREFIX}${event.HandId}:${event.timestamp}:${getApiEventSequence(event)}`
}

const parsePendingHandDerivationFence = (value: unknown): PendingHandDerivationFence | null => {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<PendingHandDerivationFence>
  if (
    candidate.version !== 1 ||
    typeof candidate.ownerId !== 'string' ||
    !Number.isSafeInteger(candidate.handId) ||
    (candidate.handId ?? -1) < 0 ||
    !Array.isArray(candidate.rawKey) ||
    candidate.rawKey.length !== 3 ||
    !candidate.rawKey.every(value => Number.isSafeInteger(value)) ||
    candidate.rawKey[1] !== ApiType.EVT_HAND_RESULTS ||
    (candidate.rawKey[2] ?? -1) < 0
  ) return null
  return {
    version: 1,
    ownerId: candidate.ownerId,
    handId: candidate.handId!,
    rawKey: candidate.rawKey as ApiEventKey,
    ...(candidate.failed === true ? { failed: true as const } : {}),
  }
}

function addBaselineDiagnostics(left: BaselineDiagnostics, right: BaselineDiagnostics): BaselineDiagnostics {
  return {
    built: left.built || right.built,
    canonicalRowsRead: left.canonicalRowsRead + right.canonicalRowsRead,
    elapsedMs: left.elapsedMs + right.elapsedMs,
  }
}

function emptyBaselineDiagnostics(): BaselineDiagnostics {
  return { built: false, canonicalRowsRead: 0, elapsedMs: 0 }
}

function normalizedFilters(filters: StatsLedgerFilters): NormalizedStatsLedgerFilters {
  const battleTypes = filters.battleTypes === undefined
    ? undefined
    : [...new Set(filters.battleTypes.filter(value => Number.isSafeInteger(value)))]
  const tableSizeLayers = filters.tableSizeLayers === undefined
    ? undefined
    : [...new Set(filters.tableSizeLayers)]
  const boundedLatestHands = normalizeStatsLatestHands(filters.latestHands)
  const latestHands = boundedLatestHands === undefined
    ? undefined
    : Math.trunc(boundedLatestHands)
  return { battleTypes, tableSizeLayers, latestHands }
}

function compareContributionRowsNewestFirst(
  left: StatHandContributionRecord,
  right: StatHandContributionRecord
): number {
  if (left.hasTimestamp !== right.hasTimestamp) return right.hasTimestamp - left.hasTimestamp
  if (left.sortTimestamp !== right.sortTimestamp) return right.sortTimestamp - left.sortTimestamp
  return right.handId - left.handId
}

function selectsEveryKnownBattleType(battleTypes: readonly number[] | undefined): boolean {
  return battleTypes !== undefined &&
    battleTypes.length === KNOWN_BATTLE_TYPES.length &&
    KNOWN_BATTLE_TYPES.every(battleType => battleTypes.includes(battleType))
}

/** 世代ヘッド・ハンド寄与・player aggregateを所有する永続統計台帳。 */
export class StatsLedger {
  private readonly baselineInFlight = new Map<number, Promise<BaselineDiagnostics>>()
  private readonly knownReadyGeneration = new Map<number, number>()
  private cleanupScheduled = false

  constructor(readonly db: PokerChaseDB) {}

  async getActiveHead(): Promise<StatsLedgerHead | null> {
    return parseHead((await this.db.meta.get(STATS_LEDGER_HEAD_META_ID))?.value)
  }

  private async getStagingMarker(): Promise<StatsLedgerStagingMarker | null> {
    return parseStagingMarker((await this.db.meta.get(STATS_LEDGER_STAGING_META_ID))?.value)
  }

  private async getCanonicalRebuildMarker(): Promise<StatsLedgerStagingMarker | null> {
    return parseStagingMarker((await this.db.meta.get(STATS_CANONICAL_REBUILD_META_ID))?.value)
  }

  /**
   * malformed/旧versionの固定markerと、中断されたhand派生がcanonicalを
   * dirtyにする。current workerが現在処理中のhandだけは除く。
   */
  private async hasCanonicalRebuildMarker(): Promise<boolean> {
    const [canonical, staging] = await Promise.all([
      this.db.meta.get(STATS_CANONICAL_REBUILD_META_ID),
      this.db.meta.get(STATS_LEDGER_STAGING_META_ID),
    ])
    if (canonical !== undefined || staging !== undefined) return true
    return (await this.listInterruptedPendingHandDerivationFenceIds()).length > 0
  }

  /** SW起動時のRaw Lake再生が必要な中断markerの有無。 */
  async needsCanonicalRebuildRecovery(): Promise<boolean> {
    return await this.hasCanonicalRebuildMarker()
  }

  /**
   * actual-added EVT_HAND_RESULTSにraw primary key単位の派生保留を付ける。
   * `mergeApiEvents()`のsequence割当後callbackからのみ呼ぶ（MUST）。
   */
  createPendingHandDerivationFenceRecords(
    added: readonly RawApiEvent[]
  ): MetaRecord[] {
    const now = Date.now()
    const records: MetaRecord[] = []
    for (const event of added) {
      const id = getPendingHandDerivationMetaId(event)
      if (!id) continue
      records.push({
        id,
        value: {
          version: 1,
          ownerId: STATS_LEDGER_BOOT_ID,
          handId: event.HandId as number,
          rawKey: getApiEventKey(event),
        } satisfies PendingHandDerivationFence,
        updatedAt: now,
      })
    }
    return records
  }

  /** canonical成功または意図的棄却が確定したraw-resultだけを消す。 */
  async acknowledgePendingHandDerivation(
    event: PendingHandDerivationEvent
  ): Promise<boolean> {
    const id = getPendingHandDerivationMetaId(event)
    if (!id) return false
    const existing = await this.db.meta.get(id)
    if (!existing) return false
    await this.db.meta.delete(id)
    return true
  }

  /**
   * canonical transaction失敗を同一SW内でも復旧対象にする。raw別markerは
   * 残し、fixed global markerやcloud staging ownerを壊さない（MUST NOT）。
   */
  async markPendingHandDerivationFailed(
    event: PendingHandDerivationEvent
  ): Promise<boolean> {
    const id = getPendingHandDerivationMetaId(event)
    if (!id) return false
    return await this.db.transaction('rw', this.db.meta, async () => {
      const existing = await this.db.meta.get(id)
      if (!existing) return false
      const parsed = parsePendingHandDerivationFence(existing.value)
      const fallbackRecord = this.createPendingHandDerivationFenceRecords([event as RawApiEvent])[0]
      await this.db.meta.put({
        ...existing,
        value: {
          ...(parsed ?? fallbackRecord?.value),
          failed: true,
        },
        updatedAt: Date.now(),
      })
      return true
    })
  }

  /** foreign worker・明示失敗・malformedはcrash残留としてfail closedに回収する。 */
  async listInterruptedPendingHandDerivationFenceIds(): Promise<string[]> {
    const rows = await this.db.meta
      .where('id')
      .startsWith(STATS_PENDING_HAND_DERIVATION_META_PREFIX)
      .toArray()
    return rows
      .filter(row => {
        const fence = parsePendingHandDerivationFence(row.value)
        return !fence || fence.failed === true || fence.ownerId !== STATS_LEDGER_BOOT_ID
      })
      .map(row => row.id)
  }

  /**現在のRaw Lakeスナップショット全体を再生したtransaction内専用。 */
  async clearAllPendingHandDerivationFences(): Promise<void> {
    await this.db.meta
      .where('id')
      .startsWith(STATS_PENDING_HAND_DERIVATION_META_PREFIX)
      .delete()
  }

  /** chunked replay開始時に控えた完全一致IDだけを完了commitで消す。 */
  private async clearPendingHandDerivationFenceIds(ids: readonly string[]): Promise<void> {
    const safeIds = [...new Set(ids.filter(id =>
      id.startsWith(STATS_PENDING_HAND_DERIVATION_META_PREFIX)
    ))]
    if (safeIds.length > 0) await this.db.meta.bulkDelete(safeIds)
  }

  /**
   * import/cloud mergeがraw rowと同じcommitへ置くdirty fence。
   * generationはcanonical再生開始時にprepareStagingGeneration()が確定するため、
   * この段階では意図的に持たない。rowの存在自体を復旧要求として扱う（MUST）。
   */
  createCanonicalRebuildFenceRecord(
    source: 'import' | 'cloud-download' | 'live-write-failure'
  ): MetaRecord {
    return {
      id: STATS_CANONICAL_REBUILD_META_ID,
      value: {
        source,
        ownerId: STATS_LEDGER_BOOT_ID,
        version: HAND_STAT_CONTRIBUTION_VERSION,
      },
      updatedAt: Date.now(),
    }
  }

  /**
   * exact raw-result fenceを持たないlegacy/internal write失敗用の
   * best-effort fallback。元の失敗を隠さないよう呼出元が
   * 例外を個別に扱う（MUST）。
   */
  async markCanonicalRebuildRequired(
    source: 'live-write-failure',
    options: { preserveOwnedStaging?: boolean } = {}
  ): Promise<boolean> {
    const record = this.createCanonicalRebuildFenceRecord(source)
    return await this.db.transaction('rw', this.db.meta, async () => {
      if (options.preserveOwnedStaging) {
        const [staging, canonical] = await Promise.all([
          this.getStagingMarker(),
          this.getCanonicalRebuildMarker(),
        ])
        if (
          staging?.ownerId === STATS_LEDGER_BOOT_ID &&
          canonical?.ownerId === STATS_LEDGER_BOOT_ID &&
          staging.generation === canonical.generation
        ) {
          // productionのexact-result fenceが無い内部呼出しの失敗で、進行中
          // cloud stagingのownerをgeneration無しmarkerで壊さない（MUST NOT）。
          return false
        }
      }
      // legacy/internalのunfenced write failureは、デフォルトで固定dirty
      // markerへ変換する。cloud staging ownerを保持すべき呼出元は
      // preserveOwnedStagingを指定し、現行のlive 306はexact-result fenceを使う。
      await this.db.meta.put(record)
      return true
    })
  }

  private async getCanonicalRevision(): Promise<number> {
    return parseCanonicalRevision((await this.db.meta.get(STATS_CANONICAL_REVISION_META_ID))?.value)
  }

  /** canonical entityを変更したtransaction内で必ず呼ぶ（MUST）。 */
  private async bumpCanonicalRevision(): Promise<number> {
    const current = await this.getCanonicalRevision()
    const next = current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1
    await this.db.meta.put({
      id: STATS_CANONICAL_REVISION_META_ID,
      value: next,
      updatedAt: Date.now(),
    })
    return next
  }

  private async runLedgerWrite<T>(operation: () => Promise<T>): Promise<T> {
    const tables = [
      this.db.meta,
      this.db.statHandContributions,
      this.db.statPlayerAggregates,
    ] as const
    const current = Dexie.currentTransaction
    const canReuse = current?.mode === 'readwrite' &&
      tables.every(table => current.storeNames.includes(table.name))
    if (canReuse) return await operation()
    if (current?.mode === 'readwrite') {
      throw new Error('Parent transaction does not include all statistics-ledger stores')
    }
    // callerのreadonly snapshotから並行発火したlive WESは、そのreadonly txへ
    // 入ろうとしてはならない。DexieのPSDを切って独立txとして待機させる。
    if (current) {
      return await Dexie.ignoreTransaction(async () =>
        await this.db.transaction('rw', [...tables], operation)
      )
    }
    return await this.db.transaction('rw', [...tables], operation)
  }

  private async nextGeneration(...candidates: Array<number | undefined>): Promise<number> {
    const [lastContribution, lastAggregate] = await Promise.all([
      this.db.statHandContributions.orderBy('generation').last(),
      this.db.statPlayerAggregates.orderBy('generation').last(),
    ])
    const maximum = Math.max(
      Date.now(),
      ...candidates.filter((value): value is number => value !== undefined),
      lastContribution?.generation ?? -1,
      lastAggregate?.generation ?? -1
    )
    return maximum + 1
  }

  private async putHead(head: StatsLedgerHead): Promise<void> {
    await this.db.meta.put({
      id: STATS_LEDGER_HEAD_META_ID,
      value: head,
      updatedAt: Date.now(),
    })
  }

  private async ensureActiveHead(): Promise<StatsLedgerHead> {
    const existing = await this.getActiveHead()
    if (existing) return existing
    const staging = await this.getStagingMarker()
    const generation = await this.nextGeneration(staging?.generation)
    const head: StatsLedgerHead = {
      generation,
      version: HAND_STAT_CONTRIBUTION_VERSION,
    }
    await this.putHead(head)
    return head
  }

  private async deleteGeneration(generation: number): Promise<void> {
    await Promise.all([
      this.db.statHandContributions.where('generation').equals(generation).delete(),
      this.db.statPlayerAggregates.where('generation').equals(generation).delete(),
    ])
  }

  private scheduleInactiveGenerationCleanup(): void {
    if (this.cleanupScheduled) return
    this.cleanupScheduled = true
    setTimeout(() => {
      if (!this.db.isOpen()) {
        this.cleanupScheduled = false
        return
      }
      void this.cleanupInactiveGenerationsInChunks()
    }, LEDGER_GC_START_DELAY_MS)
  }

  /** MV3再起動前に残った非active世代の分割GCを再開する。 */
  resumeMaintenance(): void {
    this.scheduleInactiveGenerationCleanup()
  }

  private async cleanupInactiveGenerationsInChunks(): Promise<void> {
    try {
      while (await this.deleteOneInactiveGenerationChunk()) {
        // 1 transactionで全履歴を消してWESを塞がない（MUST NOT）。短いchunk間で
        // event loopとIndexedDB schedulerへ制御を戻す。
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
    } catch {
      // cleanupはbest-effort。headから参照されない孤児世代は次回操作でも回収する。
      console.warn('[StatsLedger] Inactive generation cleanup failed')
    } finally {
      this.cleanupScheduled = false
    }
  }

  private async deleteOneInactiveGenerationChunk(): Promise<boolean> {
    return await this.runLedgerWrite(async () => {
      const active = await this.getActiveHead()
      const staging = await this.getStagingMarker()
      const keep = new Set<number>()
      if (active) keep.add(active.generation)
      if (staging) keep.add(staging.generation)
      const [contributionGenerations, aggregateGenerations] = await Promise.all([
        this.db.statHandContributions.orderBy('generation').uniqueKeys(),
        this.db.statPlayerAggregates.orderBy('generation').uniqueKeys(),
      ])
      const generation = [...new Set<number>([
        ...contributionGenerations.filter((value): value is number => typeof value === 'number'),
        ...aggregateGenerations.filter((value): value is number => typeof value === 'number'),
      ])].find(candidate => !keep.has(candidate))
      if (generation === undefined) return false

      const contributionKeys = await this.db.statHandContributions
        .where('generation').equals(generation)
        .limit(LEDGER_GC_CHUNK_SIZE)
        .primaryKeys()
      if (contributionKeys.length > 0) {
        await this.db.statHandContributions.bulkDelete(contributionKeys)
        return true
      }
      const aggregateKeys = await this.db.statPlayerAggregates
        .where('generation').equals(generation)
        .limit(LEDGER_GC_CHUNK_SIZE)
        .primaryKeys()
      if (aggregateKeys.length > 0) {
        await this.db.statPlayerAggregates.bulkDelete(aggregateKeys)
        return true
      }
      return false
    })
  }

  async ensurePlayerBaseline(playerId: number): Promise<void> {
    await this.ensurePlayerBaselines([playerId])
  }

  /** 313/301/303先読み用。複数playerのcanonical scanを1組へまとめる。 */
  async ensurePlayerBaselines(playerIds: readonly number[]): Promise<void> {
    await this.ensurePlayerBaselinesWithDiagnostics(playerIds, false)
  }

  private async ensurePlayerBaselinesWithDiagnostics(
    playerIds: readonly number[],
    force: boolean
  ): Promise<Map<number, BaselineDiagnostics>> {
    const unique = [...new Set(
      playerIds.filter(playerId => Number.isSafeInteger(playerId) && playerId > 0)
    )]
    if (force) return await this.startBaselineBatch(unique, true)

    const result = new Map<number, BaselineDiagnostics>()
    const waits: Array<Promise<void>> = []
    const missing: number[] = []
    const head = await this.getActiveHead()
    for (const playerId of unique) {
      const existing = this.baselineInFlight.get(playerId)
      if (existing) {
        waits.push(existing.then(diagnostics => { result.set(playerId, diagnostics) }))
      } else if (head && this.knownReadyGeneration.get(playerId) === head.generation) {
        result.set(playerId, emptyBaselineDiagnostics())
      } else {
        missing.push(playerId)
      }
    }

    if (missing.length > 0) {
      const batch = this.startBaselineBatch(missing, false)
      for (const playerId of missing) {
        const perPlayer = batch.then(diagnostics =>
          diagnostics.get(playerId) ?? emptyBaselineDiagnostics()
        )
        this.baselineInFlight.set(playerId, perPlayer)
        waits.push((async () => {
          try {
            result.set(playerId, await perPlayer)
          } finally {
            if (this.baselineInFlight.get(playerId) === perPlayer) {
              this.baselineInFlight.delete(playerId)
            }
          }
        })())
      }
    }
    await Promise.all(waits)
    return result
  }

  private async startBaselineBatch(
    playerIds: readonly number[],
    force: boolean
  ): Promise<Map<number, BaselineDiagnostics>> {
    const accumulated = new Map<number, BaselineDiagnostics>(
      playerIds.map(playerId => [playerId, emptyBaselineDiagnostics()])
    )
    for (let attempt = 0; attempt < MAX_BASELINE_BUILD_ATTEMPTS; attempt++) {
      try {
        const built = await this.buildPlayerBaselineBatch(playerIds, force)
        for (const [playerId, diagnostics] of built) {
          accumulated.set(
            playerId,
            addBaselineDiagnostics(accumulated.get(playerId)!, diagnostics)
          )
        }
        return accumulated
      } catch (error) {
        if (!(error instanceof BaselineBuildSupersededError)) throw error
      }
    }
    throw new Error('Canonical entities changed repeatedly during statistics baseline build')
  }

  private async buildPlayerBaselineBatch(
    playerIds: readonly number[],
    force: boolean
  ): Promise<Map<number, BaselineDiagnostics>> {
    const startedAt = performance.now()
    // 定常303/HUD読取りはready確認のためにRW transactionを開かない。headが
    // 本当に無いv8初回だけ短いwriteで作る。
    const head = await this.getActiveHead() ??
      await this.runLedgerWrite(async () => await this.ensureActiveHead())
    const initial = await this.db.transaction('r', [
      this.db.meta,
      this.db.statPlayerAggregates,
    ], async () => ({
      revision: await this.getCanonicalRevision(),
      dirty: await this.hasCanonicalRebuildMarker(),
      aggregates: await this.db.statPlayerAggregates.bulkGet(
        playerIds.map(playerId => [head.generation, playerId])
      ),
    }))
    const required = playerIds.filter((playerId, index) =>
      force || !isValidAggregate(initial.aggregates[index], head.generation, playerId)
    )
    for (const [index, playerId] of playerIds.entries()) {
      if (isValidAggregate(initial.aggregates[index], head.generation, playerId)) {
        this.knownReadyGeneration.set(playerId, head.generation)
      }
    }
    const diagnostics = new Map<number, BaselineDiagnostics>(
      playerIds.map(playerId => [playerId, emptyBaselineDiagnostics()])
    )
    if (required.length === 0) return diagnostics
    if (initial.dirty) throw new CanonicalBaselineUnavailableError()

    // 明示transactionを張らず、各indexed queryの間にWESを進められるようにする。
    // 途中更新はcanonical revisionの最終CASで検出して全体を再試行する。
    const [hands, actions, phases] = await Promise.all(required.length === 1
      ? [
          this.db.hands.where('seatUserIds').equals(required[0]!).toArray(),
          this.db.actions.where('playerId').equals(required[0]!).toArray(),
          this.db.phases.where('seatUserIds').equals(required[0]!).toArray(),
        ]
      : [
          this.db.hands.where('seatUserIds').anyOf(required).distinct().toArray(),
          this.db.actions.where('playerId').anyOf(required).toArray(),
          this.db.phases.where('seatUserIds').anyOf(required).distinct().toArray(),
        ])
    const requiredSet = new Set(required)
    const handsByPlayer = new Map(required.map(playerId => [playerId, [] as typeof hands]))
    const actionsByPlayerHand = new Map(required.map(playerId => [
      playerId,
      new Map<number, typeof actions>(),
    ] as const))
    const phasesByPlayerHand = new Map(required.map(playerId => [
      playerId,
      new Map<number, typeof phases>(),
    ] as const))
    const actionCounts = new Map(required.map(playerId => [playerId, 0]))
    const phaseCounts = new Map(required.map(playerId => [playerId, 0]))

    for (let offset = 0; offset < hands.length; offset += BASELINE_CPU_SCAN_CHUNK_SIZE) {
      for (const hand of hands.slice(offset, offset + BASELINE_CPU_SCAN_CHUNK_SIZE)) {
        for (const playerId of new Set(hand.seatUserIds)) {
          if (requiredSet.has(playerId)) handsByPlayer.get(playerId)!.push(hand)
        }
      }
      if (offset + BASELINE_CPU_SCAN_CHUNK_SIZE < hands.length) {
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
    }
    for (let offset = 0; offset < actions.length; offset += BASELINE_CPU_SCAN_CHUNK_SIZE) {
      for (const action of actions.slice(offset, offset + BASELINE_CPU_SCAN_CHUNK_SIZE)) {
        if (action.handId === undefined || !requiredSet.has(action.playerId)) continue
        const byHand = actionsByPlayerHand.get(action.playerId)!
        const rows = byHand.get(action.handId) ?? []
        rows.push(action)
        byHand.set(action.handId, rows)
        actionCounts.set(action.playerId, actionCounts.get(action.playerId)! + 1)
      }
      if (offset + BASELINE_CPU_SCAN_CHUNK_SIZE < actions.length) {
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
    }
    for (let offset = 0; offset < phases.length; offset += BASELINE_CPU_SCAN_CHUNK_SIZE) {
      for (const phase of phases.slice(offset, offset + BASELINE_CPU_SCAN_CHUNK_SIZE)) {
        if (phase.handId === undefined) continue
        for (const playerId of new Set(phase.seatUserIds)) {
          if (!requiredSet.has(playerId)) continue
          const byHand = phasesByPlayerHand.get(playerId)!
          const rows = byHand.get(phase.handId) ?? []
          rows.push(phase)
          byHand.set(phase.handId, rows)
          phaseCounts.set(playerId, phaseCounts.get(playerId)! + 1)
        }
      }
      if (offset + BASELINE_CPU_SCAN_CHUNK_SIZE < phases.length) {
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
    }

    const recordsByPlayer = new Map<number, StatHandContributionRecord[]>()
    const aggregatesByPlayer = new Map<number, StatPlayerAggregateRecord>()
    for (const playerId of required) {
      const playerHands = handsByPlayer.get(playerId)!
      const actionsByHand = actionsByPlayerHand.get(playerId)!
      const phasesByHand = phasesByPlayerHand.get(playerId)!

      const records: StatHandContributionRecord[] = []
      const aggregate = createAggregate(head.generation, playerId, true, Date.now())
      for (let offset = 0; offset < playerHands.length; offset += BASELINE_DERIVE_CHUNK_SIZE) {
        for (const hand of playerHands.slice(offset, offset + BASELINE_DERIVE_CHUNK_SIZE)) {
          const contribution = derivePlayerHandStatContribution(
            hand,
            actionsByHand.get(hand.id) ?? [],
            phasesByHand.get(hand.id) ?? [],
            playerId
          )
          if (contribution) {
            const record = recordFromContribution(head.generation, contribution)
            records.push(record)
            // final commitで全履歴を再ループしない。導出chunkごとの既存yield境界で
            // aggregateも同時に作り、publish txは1 row putだけに保つ。
            applyContributionToAggregate(aggregate, record, 1)
          }
        }
        // 41k hand級のheroでもSW event loopを同期計算で占有し続けない（MUST NOT）。
        if (offset + BASELINE_DERIVE_CHUNK_SIZE < playerHands.length) {
          await new Promise<void>(resolve => setTimeout(resolve, 0))
        }
      }
      recordsByPlayer.set(playerId, trimRecordsToLatestCells(records))
      aggregatesByPlayer.set(playerId, aggregate)
      diagnostics.set(playerId, {
        built: true,
        canonicalRowsRead: playerHands.length + actionCounts.get(playerId)! + phaseCounts.get(playerId)!,
        elapsedMs: performance.now() - startedAt,
      })
    }

    for (const playerId of required) {
      await this.publishPlayerBaseline(
        head,
        initial.revision,
        playerId,
        recordsByPlayer.get(playerId)!,
        aggregatesByPlayer.get(playerId)!,
        force
      )
    }
    return diagnostics
  }

  private async assertBaselineFence(
    head: StatsLedgerHead,
    revision: number,
    playerId?: number,
    buildId?: string
  ): Promise<void> {
    const [currentHead, currentRevision, dirty] = await Promise.all([
      this.getActiveHead(),
      this.getCanonicalRevision(),
      this.hasCanonicalRebuildMarker(),
    ])
    if (
      !currentHead || currentHead.generation !== head.generation ||
      currentRevision !== revision || dirty
    ) {
      throw new BaselineBuildSupersededError()
    }
    if (playerId !== undefined && buildId !== undefined) {
      const aggregate = await this.db.statPlayerAggregates.get([head.generation, playerId])
      if (aggregate?.ready !== false || aggregate.buildId !== buildId) {
        throw new BaselineBuildSupersededError()
      }
    }
  }

  private async publishPlayerBaseline(
    head: StatsLedgerHead,
    revision: number,
    playerId: number,
    records: readonly StatHandContributionRecord[],
    aggregate: StatPlayerAggregateRecord,
    force: boolean
  ): Promise<void> {
    const buildId = `${STATS_LEDGER_BOOT_ID}-${playerId}-${Date.now()}-${Math.random()}`
    const initialized = await this.runLedgerWrite(async () => {
      await this.assertBaselineFence(head, revision)
      const current = await this.db.statPlayerAggregates.get([head.generation, playerId])
      if (!force && isValidAggregate(current, head.generation, playerId)) return false
      this.knownReadyGeneration.delete(playerId)
      await this.db.statPlayerAggregates.put({
        ...createAggregate(head.generation, playerId, false, Date.now()),
        buildId,
      })
      return true
    })
    if (!initialized) return

    while (true) {
      const deleted = await this.runLedgerWrite(async () => {
        await this.assertBaselineFence(head, revision, playerId, buildId)
        const keys = await this.db.statHandContributions
          .where('[generation+playerId]')
          .equals([head.generation, playerId])
          .limit(BASELINE_WRITE_CHUNK_SIZE)
          .primaryKeys()
        if (keys.length > 0) await this.db.statHandContributions.bulkDelete(keys)
        return keys.length
      })
      if (deleted === 0) break
      if (deleted < BASELINE_WRITE_CHUNK_SIZE) break
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }

    for (let offset = 0; offset < records.length; offset += BASELINE_WRITE_CHUNK_SIZE) {
      const chunk = records.slice(offset, offset + BASELINE_WRITE_CHUNK_SIZE)
      await this.runLedgerWrite(async () => {
        await this.assertBaselineFence(head, revision, playerId, buildId)
        await this.db.statHandContributions.bulkPut(chunk)
      })
      if (offset + BASELINE_WRITE_CHUNK_SIZE < records.length) {
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
    }

    await this.runLedgerWrite(async () => {
      await this.assertBaselineFence(head, revision, playerId, buildId)
      await this.db.statPlayerAggregates.put({ ...aggregate, updatedAt: Date.now() })
    })
    this.knownReadyGeneration.set(playerId, head.generation)
  }

  async readPlayerSnapshot(
    playerId: number,
    filters: StatsLedgerFilters = {}
  ): Promise<PlayerStatCounterSnapshot> {
    const [snapshot] = await this.readLineupSnapshots([playerId], filters)
    if (!snapshot) throw new Error('Statistics ledger did not return the requested player')
    return snapshot
  }

  /** baseline後の全playerを同じIndexedDB readonly snapshotから読む（MUST）。 */
  async readLineupSnapshots(
    playerIds: readonly number[],
    filters: StatsLedgerFilters = {}
  ): Promise<PlayerStatCounterSnapshot[]> {
    const normalized = normalizedFilters(filters)
    const uniquePlayerIds = [...new Set(
      playerIds.filter(playerId => Number.isSafeInteger(playerId) && playerId > 0)
    )]
    if (uniquePlayerIds.length === 0) return []
    const accumulated = new Map<number, BaselineDiagnostics>(
      uniquePlayerIds.map(playerId => [playerId, emptyBaselineDiagnostics()])
    )

    for (let attempt = 0; attempt < MAX_LINEUP_READ_ATTEMPTS; attempt++) {
      try {
        // steady stateは最初のawaitより前に単一readonly transactionを開始する。
        // WES commit直後にenqueueされたHUD読取りが、次のhand commit後のaggregateを
        // 誤って読むことを防ぎ、そのcommit時点のlineup snapshotを固定する（MUST）。
        // baselineが必要なplayerだけcatch側で構築して再試行する。
        const snapshots = await this.db.transaction('r', [
          this.db.meta,
          this.db.statHandContributions,
          this.db.statPlayerAggregates,
        ], async () => {
          const head = await this.getActiveHead()
          if (!head) throw new BaselineRequiredError(uniquePlayerIds[0] ?? -1, false)
          return await Promise.all(uniquePlayerIds.map(playerId =>
            this.readPlayerAtHead(head, playerId, normalized, accumulated.get(playerId)!)
          ))
        })
        const byPlayer = new Map(snapshots.map(snapshot => [snapshot.playerId, snapshot]))
        return playerIds.map(playerId => {
          const snapshot = byPlayer.get(playerId)
          if (!snapshot) throw new Error('Invalid player id in statistics lineup')
          return snapshot
        })
      } catch (error) {
        if (!(error instanceof BaselineRequiredError) || error.playerId <= 0) throw error
        if (error.force) {
          // readonly transactionは最初の破損playerで中断されるため、1人ずつ直すと
          // lineup人数がread再試行上限を超え得る。破損検出時はlineup全員を同じ
          // canonical scanで強制再構築し、再試行回数を人数へ依存させない（MUST）。
          const diagnosticsByPlayer = await this.ensurePlayerBaselinesWithDiagnostics(
            uniquePlayerIds,
            true
          )
          for (const [playerId, diagnostics] of diagnosticsByPlayer) {
            accumulated.set(
              playerId,
              addBaselineDiagnostics(accumulated.get(playerId)!, diagnostics)
            )
          }
        } else {
          // head無し・未baseline lineupはplayerごとに再走査せず1 batchで作る。
          // direct snapshotを先に試すsteady-state fast pathを維持しつつ、cold pathの
          // query回数とMAX_LINEUP_READ_ATTEMPTSをlineup人数へ依存させない。
          const diagnosticsByPlayer = await this.ensurePlayerBaselinesWithDiagnostics(
            uniquePlayerIds,
            false
          )
          for (const [playerId, diagnostics] of diagnosticsByPlayer) {
            accumulated.set(
              playerId,
              addBaselineDiagnostics(accumulated.get(playerId)!, diagnostics)
            )
          }
        }
      }
    }
    throw new Error('Statistics ledger head changed repeatedly during one lineup read')
  }

  private async readPlayerAtHead(
    head: StatsLedgerHead,
    playerId: number,
    filters: NormalizedStatsLedgerFilters,
    baseline: BaselineDiagnostics
  ): Promise<PlayerStatCounterSnapshot> {
    const aggregate = await this.db.statPlayerAggregates.get([head.generation, playerId])
    if (!aggregate || !aggregate.ready) {
      this.knownReadyGeneration.delete(playerId)
      throw new BaselineRequiredError(playerId, false)
    }
    if (!isValidAggregate(aggregate, head.generation, playerId)) {
      this.knownReadyGeneration.delete(playerId)
      throw new BaselineRequiredError(playerId, true)
    }
    this.knownReadyGeneration.set(playerId, head.generation)

    const totalHands = getStatCounter(aggregate.totals, 'hands')[0]
    const selectedBuckets = aggregate.buckets.filter(bucket =>
      (filters.battleTypes === undefined || filters.battleTypes.some(value => battleBucket(value) === bucket.battleBucket)) &&
      (filters.tableSizeLayers === undefined || filters.tableSizeLayers.some(value => tableBucket(value) === bucket.tableBucket))
    )
    const matchedHandsBeforeLimit = filters.battleTypes === undefined && filters.tableSizeLayers === undefined
      ? totalHands
      : selectedBuckets.reduce((sum, bucket) => sum + bucket.handsN, 0)
    if (filters.latestHands !== undefined) {
      const { rows, rowsRead, indexQueries } = await this.readLatestRows(
        head.generation,
        playerId,
        filters,
        filters.latestHands
      )
      if (rows.some(row =>
        row.version !== HAND_STAT_CONTRIBUTION_VERSION || !isValidCounterVector(row.counters)
      )) {
        throw new BaselineRequiredError(playerId, true)
      }
      const counters = rows.reduce(
        (sum, row) => addHandStatCounterVectors(sum, row.counters),
        createEmptyHandStatCounterVector()
      )
      return {
        generation: head.generation,
        version: head.version,
        playerId,
        counters,
        totalHands,
        matchedHandsBeforeLimit,
        selectedHands: rows.length,
        positions: this.positionsFromContributionRows(rows),
        selection: { kind: 'rows', rows },
        diagnostics: {
          source: 'contributions',
          contributionRowsRead: rowsRead,
          indexQueries,
          baselineBuilt: baseline.built,
          canonicalRowsRead: baseline.canonicalRowsRead,
          baselineMs: baseline.elapsedMs,
        },
      }
    }

    const counters = filters.battleTypes === undefined && filters.tableSizeLayers === undefined
      ? [...aggregate.totals]
      : selectedBuckets.reduce(
          (sum, bucket) => addHandStatCounterVectors(sum, bucket.counters),
          createEmptyHandStatCounterVector()
        )
    const selectedHands = filters.battleTypes === undefined && filters.tableSizeLayers === undefined
      ? totalHands
      : selectedBuckets.reduce((sum, bucket) => sum + bucket.handsN, 0)
    return {
      generation: head.generation,
      version: head.version,
      playerId,
      counters,
      totalHands,
      matchedHandsBeforeLimit,
      selectedHands,
      positions: this.positionsFromAggregateBuckets(selectedBuckets),
      selection: { kind: 'aggregate', buckets: selectedBuckets.map(bucket => ({
        ...bucket,
        counters: [...bucket.counters],
      })) },
      diagnostics: {
        source: 'aggregate',
        contributionRowsRead: 0,
        indexQueries: [],
        baselineBuilt: baseline.built,
        canonicalRowsRead: baseline.canonicalRowsRead,
        baselineMs: baseline.elapsedMs,
      },
    }
  }

  private async readLatestRows(
    generation: number,
    playerId: number,
    filters: NormalizedStatsLedgerFilters,
    limit: number
  ): Promise<{ rows: StatHandContributionRecord[], rowsRead: number, indexQueries: string[] }> {
    const queries: Array<{ index: string, prefix: Array<string | number> }> = []
    const battles = filters.battleTypes
    const tables = filters.tableSizeLayers
    const allKnownBattles = selectsEveryKnownBattleType(battles)
    if (battles === undefined && tables === undefined) {
      queries.push({
        index: '[generation+playerId+hasTimestamp+sortTimestamp+handId]',
        prefix: [generation, playerId],
      })
    } else if (allKnownBattles && tables === undefined) {
      queries.push({
        index: '[generation+playerId+hasKnownBattle+hasTimestamp+sortTimestamp+handId]',
        prefix: [generation, playerId, 1],
      })
    } else if (allKnownBattles && tables !== undefined) {
      for (const layer of tables) {
        queries.push({
          index: '[generation+playerId+hasKnownBattle+tableBucket+hasTimestamp+sortTimestamp+handId]',
          prefix: [generation, playerId, 1, tableBucket(layer)],
        })
      }
    } else if (battles !== undefined && tables === undefined) {
      for (const battleType of battles) {
        queries.push({
          index: '[generation+playerId+battleBucket+hasTimestamp+sortTimestamp+handId]',
          prefix: [generation, playerId, battleBucket(battleType)],
        })
      }
    } else if (battles === undefined && tables !== undefined) {
      for (const layer of tables) {
        queries.push({
          index: '[generation+playerId+tableBucket+hasTimestamp+sortTimestamp+handId]',
          prefix: [generation, playerId, tableBucket(layer)],
        })
      }
    } else {
      for (const battleType of battles!) {
        for (const layer of tables!) {
          queries.push({
            index: '[generation+playerId+battleBucket+tableBucket+hasTimestamp+sortTimestamp+handId]',
            prefix: [generation, playerId, battleBucket(battleType), tableBucket(layer)],
          })
        }
      }
    }

    const chunks = await Promise.all(queries.map(async ({ index, prefix }) =>
      await this.db.statHandContributions
        .where(index)
        .between(
          [...prefix, 0, Dexie.minKey, Dexie.minKey],
          [...prefix, 1, Dexie.maxKey, Dexie.maxKey],
          true,
          true
        )
        .reverse()
        .limit(limit)
        .toArray()
    ))
    const deduped = new Map<number, StatHandContributionRecord>()
    for (const row of chunks.flat()) deduped.set(row.handId, row)
    const rows = [...deduped.values()]
      .sort(compareContributionRowsNewestFirst)
      .slice(0, limit)
    return {
      rows,
      rowsRead: chunks.reduce((total, chunk) => total + chunk.length, 0),
      indexQueries: queries.map(query => query.index),
    }
  }

  private positionsFromContributionRows(
    rows: readonly StatHandContributionRecord[]
  ): PositionCounterPrimitive[] {
    const positions = new Map<HandPosition, PositionCounterPrimitive>()
    for (const row of rows) {
      const existing = positions.get(row.position) ?? {
        position: row.position,
        handsN: 0,
        counters: createEmptyHandStatCounterVector(),
      }
      existing.handsN++
      existing.counters = addHandStatCounterVectors(existing.counters, row.counters)
      positions.set(row.position, existing)
    }
    return [...positions.values()]
  }

  private positionsFromAggregateBuckets(
    buckets: readonly StatAggregateBucket[]
  ): PositionCounterPrimitive[] {
    const positions = new Map<HandPosition, PositionCounterPrimitive>()
    for (const bucket of buckets) {
      const position: HandPosition = bucket.positionBucket === 'unknown'
        ? 'unknown'
        : Number(bucket.positionBucket.slice('position:'.length)) as HandPosition
      const existing = positions.get(position) ?? {
        position,
        handsN: 0,
        counters: createEmptyHandStatCounterVector(),
      }
      existing.handsN += bucket.handsN
      existing.counters = addHandStatCounterVectors(existing.counters, bucket.counters)
      positions.set(position, existing)
    }
    return [...positions.values()]
  }

  /** 呼出元のDexie rw transaction内で、完成ハンドの寄与を冪等置換する。 */
  async replaceCompletedHandContributions(
    bundle: EntityBundle,
    previousBundle?: EntityBundle
  ): Promise<void> {
    if (bundle.hands.length === 0) return
    await this.runLedgerWrite(async () => {
      // 呼出元が同じtransactionでcanonical entityを保存済み。revisionも同じ
      // commitで進め、lock-free baseline scanが途中更新を検出できるようにする。
      await this.bumpCanonicalRevision()
      const existingHead = await this.getActiveHead()
      const currentTransaction = Dexie.currentTransaction
      const uniqueBundleHandCount = new Set(bundle.hands.map(hand => hand.id)).size
      const initializesCompleteFreshHead = existingHead === null &&
        currentTransaction?.storeNames.includes(this.db.hands.name) === true &&
        await this.db.hands.count() === uniqueBundleHandCount
      const active = existingHead ?? await this.ensureActiveHead()
      const contributionsByHand = this.contributionsByHand(bundle)
      const previousByHand = previousBundle
        ? this.contributionsByHand(previousBundle)
        : undefined
      await this.replaceHandsInGeneration(
        active.generation,
        contributionsByHand,
        previousByHand,
        initializesCompleteFreshHead
      )
    })
  }

  private contributionsByHand(bundle: EntityBundle): Map<number, PlayerHandStatContribution[]> {
    const actionsByHand = new Map<number, typeof bundle.actions>()
    const phasesByHand = new Map<number, typeof bundle.phases>()
    for (const action of bundle.actions) {
      if (action.handId === undefined) continue
      const rows = actionsByHand.get(action.handId) ?? []
      rows.push(action)
      actionsByHand.set(action.handId, rows)
    }
    for (const phase of bundle.phases) {
      if (phase.handId === undefined) continue
      const rows = phasesByHand.get(phase.handId) ?? []
      rows.push(phase)
      phasesByHand.set(phase.handId, rows)
    }
    return new Map(bundle.hands.map(hand => [
      hand.id,
      derivePlayerHandStatContributions(
        hand,
        actionsByHand.get(hand.id) ?? [],
        phasesByHand.get(hand.id) ?? []
      ),
    ] as const))
  }

  private async replaceHandsInGeneration(
    generation: number,
    contributionsByHand: ReadonlyMap<number, readonly PlayerHandStatContribution[]>,
    previousContributionsByHand?: ReadonlyMap<number, readonly PlayerHandStatContribution[]>,
    initializesCompleteFreshHead = false
  ): Promise<void> {
    const handIds = [...contributionsByHand.keys()]
    if (handIds.length === 0) return
    const oldRecords = await this.db.statHandContributions
      .where('[generation+handId]')
      .anyOf(handIds.map(handId => [generation, handId]))
      .toArray()
    const newRecords = [...contributionsByHand.values()]
      .flatMap(contributions => contributions.map(contribution =>
        recordFromContribution(generation, contribution)
      ))
    const aggregateOldRecords = previousContributionsByHand
      ? [...previousContributionsByHand.values()].flatMap(contributions =>
          contributions.map(contribution => recordFromContribution(generation, contribution))
        )
      : oldRecords
    const invalidWindowPlayerIds = new Set<number>()
    for (const oldRecord of oldRecords) {
      const replacement = newRecords.find(record =>
        record.playerId === oldRecord.playerId && record.handId === oldRecord.handId
      )
      if (
        !replacement ||
        replacement.battleBucket !== oldRecord.battleBucket ||
        replacement.tableBucket !== oldRecord.tableBucket ||
        replacement.hasTimestamp !== oldRecord.hasTimestamp ||
        replacement.sortTimestamp !== oldRecord.sortTimestamp
      ) {
        // top-500 cellから行が抜けた場合、501番目の復元はcanonical
        // baselineが必要。不完全なwindowをreadyとして公開しない（MUST NOT）。
        invalidWindowPlayerIds.add(oldRecord.playerId)
      }
    }
    const affectedPlayerIds = [...new Set([
      ...aggregateOldRecords.map(record => record.playerId),
      ...newRecords.map(record => record.playerId),
    ])]

    if (oldRecords.length > 0) {
      await this.db.statHandContributions.bulkDelete(
        oldRecords.map(record => [record.generation, record.playerId, record.handId])
      )
    }
    if (newRecords.length > 0) await this.db.statHandContributions.bulkPut(newRecords)

    // latestHandsのUI上限500に対し、各battle×table cellの最新500行だけを
    // 保持する。任意のfilter unionの最新500はこの和集合内に必ずある。
    const cells = new Map<string, StatHandContributionRecord>()
    for (const record of newRecords) cells.set(latestCellKey(record), record)
    for (const record of cells.values()) {
      const staleKeys = await this.db.statHandContributions
        .where('[generation+playerId+battleBucket+tableBucket+hasTimestamp+sortTimestamp+handId]')
        .between(
          [generation, record.playerId, record.battleBucket, record.tableBucket, 0, Dexie.minKey, Dexie.minKey],
          [generation, record.playerId, record.battleBucket, record.tableBucket, 1, Dexie.maxKey, Dexie.maxKey],
          true,
          true
        )
        .reverse()
        .offset(MAX_STATS_LATEST_HANDS)
        .primaryKeys()
      if (staleKeys.length > 0) await this.db.statHandContributions.bulkDelete(staleKeys)
    }

    const existingAggregates = await this.db.statPlayerAggregates.bulkGet(
      affectedPlayerIds.map(playerId => [generation, playerId])
    )
    const updatedAggregates: StatPlayerAggregateRecord[] = []
    for (const [index, playerId] of affectedPlayerIds.entries()) {
      const existing = existingAggregates[index]
      if (
        !invalidWindowPlayerIds.has(playerId) &&
        hasValidAggregateShape(existing, generation, playerId) &&
        existing.buildId === undefined
      ) {
        const aggregate = cloneAggregate(existing)
        for (const record of aggregateOldRecords.filter(row => row.playerId === playerId)) {
          applyContributionToAggregate(aggregate, record, -1)
        }
        for (const record of newRecords.filter(row => row.playerId === playerId)) {
          applyContributionToAggregate(aggregate, record, 1)
        }
        updatedAggregates.push(aggregate)
      } else {
        // baseline build tokenがあればこのlive commitで失効させる。ready=falseは
        // HUDへ出ないため、全寄与の再走査はせず今回のlive差分だけを保持する。
        // canonical revisionを見たbaseline側が後で全体を再構築する。
        // v8台帳の初回commit時にcanonical表も今回のbundleだけなら、この差分は
        // そのplayerの全履歴そのもの。cold baselineを挟まずreadyとして公開できる。
        // 既存canonicalが1件でもある移行DBではMUST NOT適用しない。
        const ready = initializesCompleteFreshHead && existing === undefined
        const aggregate = createAggregate(generation, playerId, ready, Date.now())
        if (ready) this.knownReadyGeneration.set(playerId, generation)
        else this.knownReadyGeneration.delete(playerId)
        for (const record of newRecords.filter(row => row.playerId === playerId)) {
          applyContributionToAggregate(aggregate, record, 1)
        }
        updatedAggregates.push(aggregate)
      }
    }
    if (updatedAggregates.length > 0) {
      await this.db.statPlayerAggregates.bulkPut(updatedAggregates)
    }
  }

  async prepareStagingGeneration(generation?: number): Promise<StatsLedgerHead> {
    const head = await this.runLedgerWrite(async () => {
      const active = await this.ensureActiveHead()
      const previousStaging = await this.getStagingMarker()
      const next = generation ?? await this.nextGeneration(
        active.generation,
        previousStaging?.generation
      )
      if (!Number.isSafeInteger(next) || next < 0 || next === active.generation) {
        throw new RangeError('Invalid statistics-ledger staging generation')
      }
      const [contributionCount, aggregateCount] = await Promise.all([
        this.db.statHandContributions.where('generation').equals(next).count(),
        this.db.statPlayerAggregates.where('generation').equals(next).count(),
      ])
      if (contributionCount > 0 || aggregateCount > 0) {
        throw new Error('Statistics-ledger staging generation already exists')
      }
      const marker: StatsLedgerStagingMarker = {
        generation: next,
        version: HAND_STAT_CONTRIBUTION_VERSION,
        ownerId: STATS_LEDGER_BOOT_ID,
      }
      await this.db.meta.put({
        id: STATS_LEDGER_STAGING_META_ID,
        value: marker,
        updatedAt: Date.now(),
      })
      // cloud replayはcanonical表をchunk置換する。成功commitまでlazy baselineが
      // hybrid表を完全値として公開してはならない（MUST NOT）。
      await this.db.meta.put({
        id: STATS_CANONICAL_REBUILD_META_ID,
        value: marker,
        updatedAt: Date.now(),
      })
      return { generation: next, version: HAND_STAT_CONTRIBUTION_VERSION }
    })
    // markerのowner更新を先にcommitして旧SW/旧試行への鏡写しをfenceする。
    // 孤児世代の全件削除はライブ書込みを長時間止めない、分割した
    // best-effort別transactionで行う。
    this.scheduleInactiveGenerationCleanup()
    return head
  }

  async appendStagingEntityBundle(generation: number, _bundle: EntityBundle): Promise<void> {
    await this.runLedgerWrite(async () => {
      const marker = await this.getStagingMarker()
      if (marker?.generation !== generation || marker.ownerId !== STATS_LEDGER_BOOT_ID) {
        throw new Error('Statistics-ledger staging generation is not owned by this worker')
      }
      const canonicalMarker = await this.getCanonicalRebuildMarker()
      if (
        canonicalMarker?.generation !== generation ||
        canonicalMarker.ownerId !== STATS_LEDGER_BOOT_ID
      ) {
        throw new Error('Canonical rebuild marker is not owned by this worker')
      }
      // 呼出元は同じtransactionでcanonical chunkを置換済み。
      // staging台帳は全player分を二重保持せず空のままとし、
      // 成功時にheadを切り替えた後、表示lineupだけをlazy baselineする。
      await this.bumpCanonicalRevision()
    })
  }

  async activateStagingGeneration(
    generation: number,
    recoveredPendingFenceIds: readonly string[] = []
  ): Promise<StatsLedgerHead> {
    const head = await this.runLedgerWrite(async () => {
      const marker = await this.getStagingMarker()
      if (marker?.generation !== generation || marker.ownerId !== STATS_LEDGER_BOOT_ID) {
        throw new Error('Statistics-ledger staging generation is not owned by this worker')
      }
      const canonicalMarker = await this.getCanonicalRebuildMarker()
      if (
        canonicalMarker?.generation !== generation ||
        canonicalMarker.ownerId !== STATS_LEDGER_BOOT_ID
      ) {
        throw new Error('Canonical rebuild marker is not owned by this worker')
      }
      const [contributionCount, aggregateCount] = await Promise.all([
        this.db.statHandContributions.where('generation').equals(generation).count(),
        this.db.statPlayerAggregates.where('generation').equals(generation).count(),
      ])
      if (contributionCount > 0 || aggregateCount > 0) {
        throw new Error('Statistics-ledger staging generation must be empty at activation')
      }
      // 最終stale canonical削除もこの外側transaction内で行われるため、head
      // flipと同じcommitでrevisionを進めdirty fenceを外す。
      await this.bumpCanonicalRevision()
      const head: StatsLedgerHead = {
        generation,
        version: HAND_STAT_CONTRIBUTION_VERSION,
      }
      await this.putHead(head)
      // scan開始後のライブraw markerをprefix全削除で巻き込んでは
      // ならない（MUST NOT）。再生対象と確定したexact IDのみ消す。
      await this.clearPendingHandDerivationFenceIds(recoveredPendingFenceIds)
      await this.db.meta.delete(STATS_LEDGER_STAGING_META_ID)
      await this.db.meta.delete(STATS_CANONICAL_REBUILD_META_ID)
      return head
    })
    // head flip自体はO(1)でcommitする（MUST）。旧全履歴世代の削除を同じ
    // transactionへ入れると、再構築完了時にライブWESを再び長時間止める。
    this.scheduleInactiveGenerationCleanup()
    return head
  }

  /**
   * manual full rebuild用。canonical全置換と同じtransactionで空の
   * active世代を公開し、次のHUD読みが対象playerだけを復元する。
   */
  async activateEmptyGenerationAfterCanonicalRebuild(): Promise<StatsLedgerHead> {
    const head = await this.runLedgerWrite(async () => {
      const active = await this.getActiveHead()
      const staging = await this.getStagingMarker()
      const generation = await this.nextGeneration(active?.generation, staging?.generation)
      await this.bumpCanonicalRevision()
      const next: StatsLedgerHead = {
        generation,
        version: HAND_STAT_CONTRIBUTION_VERSION,
      }
      await this.putHead(next)
      // 呼出元はapiEventsも含むRW transaction内でLakeの一致スナップ
      // ショットを全再生済み。ここでは全pendingを消してよい。
      await this.clearAllPendingHandDerivationFences()
      await this.db.meta.delete(STATS_LEDGER_STAGING_META_ID)
      await this.db.meta.delete(STATS_CANONICAL_REBUILD_META_ID)
      return next
    })
    this.scheduleInactiveGenerationCleanup()
    return head
  }

  async abandonStagingGeneration(generation: number): Promise<void> {
    const abandoned = await this.runLedgerWrite(async () => {
      const active = await this.getActiveHead()
      if (active?.generation === generation) return false
      const marker = await this.getStagingMarker()
      if (marker?.generation !== generation || marker.ownerId !== STATS_LEDGER_BOOT_ID) return false
      // まずmarkerを短いcommitで消し、WESのstaging二重書込みを止める（MUST）。
      await this.db.meta.delete(STATS_LEDGER_STAGING_META_ID)
      // canonical表は既に一部置換済みか判別できない。dirty fenceは成功した
      // manual/cloud rebuildまでMUST保持し、hybrid baselineの確定を拒否する。
      return true
    })
    if (abandoned) this.scheduleInactiveGenerationCleanup()
  }

  async replaceGenerationFromEntityBundle(
    bundle: EntityBundle,
    options: ReplaceGenerationOptions = {}
  ): Promise<StatsLedgerHead> {
    return await this.runLedgerWrite(async () => {
      const active = await this.getActiveHead()
      const staging = await this.getStagingMarker()
      const generation = options.generation ?? await this.nextGeneration(
        active?.generation,
        staging?.generation
      )
      if (!Number.isSafeInteger(generation) || generation < 0) {
        throw new RangeError('Invalid statistics-ledger generation')
      }
      const built = buildGenerationFromEntityBundle(generation, bundle)
      await this.bumpCanonicalRevision()
      await this.deleteGeneration(generation)
      if (built.contributions.length > 0) {
        await this.db.statHandContributions.bulkPut(built.contributions)
      }
      if (built.aggregates.length > 0) {
        await this.db.statPlayerAggregates.bulkPut(built.aggregates)
      }

      const head: StatsLedgerHead = {
        generation,
        version: HAND_STAT_CONTRIBUTION_VERSION,
      }
      if (options.activate !== false) {
        await this.putHead(head)
        await this.db.meta.delete(STATS_LEDGER_STAGING_META_ID)
        await this.db.meta.delete(STATS_CANONICAL_REBUILD_META_ID)
      }
      return head
    })
      .then(head => {
        if (options.activate !== false) this.scheduleInactiveGenerationCleanup()
        return head
      })
  }
}
