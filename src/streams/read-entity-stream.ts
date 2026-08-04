import { SimpleTransform } from './simple-transform'
import type PokerChaseService from '../services/poker-chase-service'
import type { ExistPlayerStats, PlayerStats } from '../types'
import type { ErrorContext } from '../types/errors'
import { ErrorHandler } from '../utils/error-handler'
import {
  buildStatResultsFromCounters,
  getEffectiveStatDisplayConfigs,
} from '../stats/counter-stat-results'
import {
  getDefaultStatsContext,
  setStatsRequestContext,
  setStatsOutputContext,
  takeStatsRequestContext,
  type StatsOutputContext,
} from './stats-output-context'

const SLOW_STATS_REQUEST_MS = 50

interface StatsCalculationDiagnostics {
  generations: number[]
  aggregatePlayers: number
  contributionPlayers: number
  contributionRowsRead: number
  indexQueries: number
  baselinePlayers: number
  canonicalRowsRead: number
  baselineMs: number
}

interface QueuedRequestDiagnostics {
  enqueuedAt: number
  pendingAtEnqueue: number
}

/**
 * 統計表示Stream（パイプライン第3段階）。
 *
 * 完成ハンドごとに`hands/actions/phases`を全件読み直すのではなく、
 * `StatsLedger`のplayer単位の永続aggregateと、フィルタ後の最新N件だけを読む。
 * 旧DBで台帳が無いplayerのみ、初回表示時にそのplayerのbaselineを1回作る。
 */
export class ReadEntityStream extends SimpleTransform<number[], PlayerStats[]> {
  private readonly service: PokerChaseService
  private readonly queuedDiagnostics = new WeakMap<number[], QueuedRequestDiagnostics>()
  private readonly calculationDiagnostics = new WeakMap<PlayerStats[], StatsCalculationDiagnostics>()
  private pendingRequests = 0

  constructor(service: PokerChaseService) {
    super()
    this.service = service
  }

  /**
   * 旧ラインナップ5秒cacheの互換API。読取り先は世代管理された永続台帳なので、
   * メモリ上の全消去はもう必要ない。
   */
  public invalidateCache(): void {}

  /** write呼出し時点のACTIVE配信世代とqueue待ち計測を、配列identityに紐付ける。 */
  public override write(seatUserIds: number[]): void {
    const context = takeStatsRequestContext(seatUserIds) ?? getDefaultStatsContext()
    const queuedSeatUserIds = [...seatUserIds]
    if (context) setStatsRequestContext(queuedSeatUserIds, context)

    this.pendingRequests++
    this.queuedDiagnostics.set(queuedSeatUserIds, {
      enqueuedAt: performance.now(),
      pendingAtEnqueue: this.pendingRequests,
    })
    super.write(queuedSeatUserIds)
  }

  public async recalculateStats(context?: StatsOutputContext): Promise<void> {
    if (!this.service.playerId || !this.service.latestEvtDeal) {
      console.warn('[ReadEntityStream] playerId or latestEvtDeal not available, skipping stats calculation')
      return
    }

    const seatUserIds = this.service.latestEvtDeal.SeatUserIds

    // フィルタ再計算は、保存済みのヒーロー在席dealへ先に再アンカーする
    // （MUST）。観戦dealの席文脈とヒーロー統計を混ぜないため。
    this.service.liveEvtDeal = this.service.latestEvtDeal
    const resolvedContext = context ?? getDefaultStatsContext()

    try {
      const startedAt = performance.now()
      const stats = await this.calcStats(seatUserIds)
      const diagnostics = this.takeCalculationDiagnostics(stats)
      this.logSlowRequest(0, startedAt, diagnostics, seatUserIds.length, 1)
      setStatsOutputContext(stats, resolvedContext)
      this.push(stats)
    } catch (error) {
      const errorContext: ErrorContext = {
        streamName: 'ReadEntityStream',
        operation: 'recalculateStats',
        playerId: this.service.playerId,
      }
      const appError = ErrorHandler.handleStreamError(error, 'ReadEntityStream', errorContext)
      ErrorHandler.logError(appError, 'ReadEntityStream')
    }
  }

  protected async transform(seatUserIds: number[]): Promise<void> {
    const context = takeStatsRequestContext(seatUserIds)
    const queued = this.queuedDiagnostics.get(seatUserIds)
    const startedAt = performance.now()
    const queueWaitMs = queued ? startedAt - queued.enqueuedAt : 0

    try {
      if (this.service.batchMode) return

      // `calcStats`はテストとプリゲーム取得も共有する公開seamなので、ライブ経路も
      // MUSTこれを通す。private helperを直呼びするとhandover中計算を差し替える
      // 既存の世代locality検証が成立しなくなる。
      const stats = await this.calcStats(seatUserIds)
      const diagnostics = this.takeCalculationDiagnostics(stats)
      setStatsOutputContext(stats, context)
      this.push(stats)
      this.logSlowRequest(
        queueWaitMs,
        startedAt,
        diagnostics,
        seatUserIds.length,
        queued?.pendingAtEnqueue ?? 1
      )
    } catch (error: unknown) {
      const errorContext: ErrorContext = {
        streamName: 'ReadEntityStream',
        playerIds: seatUserIds,
        battleTypeFilter: this.service.battleTypeFilter,
        tableSizeFilter: this.service.tableSizeFilter,
        handLimitFilter: this.service.handLimitFilter,
      }
      const appError = ErrorHandler.handleStreamError(error, 'ReadEntityStream', errorContext)
      if (this.listenerCount('error') > 0) this.emit('error', appError)
    } finally {
      this.queuedDiagnostics.delete(seatUserIds)
      this.pendingRequests--
    }
  }

  private logSlowRequest(
    queueWaitMs: number,
    startedAt: number,
    diagnostics: StatsCalculationDiagnostics,
    seatCount: number,
    pendingAtEnqueue: number
  ): void {
    const calculationMs = performance.now() - startedAt
    if (queueWaitMs < SLOW_STATS_REQUEST_MS && calculationMs < SLOW_STATS_REQUEST_MS) return

    // playerId/HandIdや生payloadは出さず、詰まりの位置を分ける数値だけを出す。
    console.warn('[ReadEntityStream] Slow stats request', {
      queueWaitMs: Math.round(queueWaitMs),
      calculationMs: Math.round(calculationMs),
      pendingAtEnqueue,
      seatCount,
      aggregatePlayers: diagnostics.aggregatePlayers,
      contributionPlayers: diagnostics.contributionPlayers,
      contributionRowsRead: diagnostics.contributionRowsRead,
      indexQueries: diagnostics.indexQueries,
      baselinePlayers: diagnostics.baselinePlayers,
      canonicalRowsRead: diagnostics.canonicalRowsRead,
      baselineMs: Math.round(diagnostics.baselineMs),
    })
  }

  /**
   * ライブpipelineとプリゲームhero統計が共用する公開エントリポイント。
   * `push()`は行わない。
   */
  calcStats = async (seatUserIds: number[]): Promise<PlayerStats[]> =>
    this.calculateAndRecordDiagnostics(seatUserIds)

  private async calculateAndRecordDiagnostics(seatUserIds: number[]): Promise<PlayerStats[]> {
    const { stats, diagnostics } = await this.calculateStatsWithDiagnostics(seatUserIds)
    this.calculationDiagnostics.set(stats, diagnostics)
    return stats
  }

  private takeCalculationDiagnostics(stats: PlayerStats[]): StatsCalculationDiagnostics {
    const diagnostics = this.calculationDiagnostics.get(stats)
    this.calculationDiagnostics.delete(stats)
    return diagnostics ?? {
      generations: [],
      aggregatePlayers: 0,
      contributionPlayers: 0,
      contributionRowsRead: 0,
      indexQueries: 0,
      baselinePlayers: 0,
      canonicalRowsRead: 0,
      baselineMs: 0,
    }
  }

  private async calculateStatsWithDiagnostics(
    seatUserIds: number[]
  ): Promise<{ stats: PlayerStats[], diagnostics: StatsCalculationDiagnostics }> {
    const battleTypes = this.service.battleTypeFilter
      ? [...this.service.battleTypeFilter]
      : undefined
    const tableSizeLayers = this.service.tableSizeFilter
      ? [...this.service.tableSizeFilter]
      : undefined
    const latestHands = this.service.handLimitFilter !== undefined && this.service.handLimitFilter > 0
      ? this.service.handLimitFilter
      : undefined
    const configs = getEffectiveStatDisplayConfigs(this.service.statDisplayConfigs)

    const uniquePlayerIds = [...new Set(seatUserIds.filter(playerId => playerId !== -1))]
    const snapshots = uniquePlayerIds.length > 0
      ? await this.service.statsLedger.readLineupSnapshots(uniquePlayerIds, {
          battleTypes,
          tableSizeLayers,
          latestHands,
        })
      : []
    const snapshotByPlayer = new Map(snapshots.map(snapshot => [snapshot.playerId, snapshot]))
    const diagnostics: StatsCalculationDiagnostics = {
      generations: [...new Set(snapshots.map(snapshot => snapshot.generation))],
      aggregatePlayers: 0,
      contributionPlayers: 0,
      contributionRowsRead: 0,
      indexQueries: 0,
      baselinePlayers: 0,
      canonicalRowsRead: 0,
      baselineMs: 0,
    }

    for (const snapshot of snapshots) {
      if (snapshot.diagnostics.source === 'aggregate') diagnostics.aggregatePlayers++
      else diagnostics.contributionPlayers++
      diagnostics.contributionRowsRead += snapshot.diagnostics.contributionRowsRead
      diagnostics.indexQueries += snapshot.diagnostics.indexQueries.length
      if (snapshot.diagnostics.baselineBuilt) diagnostics.baselinePlayers++
      diagnostics.canonicalRowsRead += snapshot.diagnostics.canonicalRowsRead
      diagnostics.baselineMs = Math.max(diagnostics.baselineMs, snapshot.diagnostics.baselineMs)
    }

    const stats: PlayerStats[] = seatUserIds.map(playerId => {
      if (playerId === -1) return { playerId: -1 }
      const snapshot = snapshotByPlayer.get(playerId)
      if (!snapshot) throw new Error('Statistics ledger omitted a lineup player')

      // 旧表示契約: 履歴があるplayerに明示フィルタを掛けて全滅した場合は
      // 0値のグリッドではなく空statResultsを返す。
      if (
        (battleTypes || tableSizeLayers) &&
        snapshot.totalHands > 0 &&
        snapshot.matchedHandsBeforeLimit === 0
      ) {
        return { playerId, statResults: [] }
      }

      const result: ExistPlayerStats = {
        playerId,
        statResults: buildStatResultsFromCounters(
          snapshot.counters,
          playerId,
          this.service.session,
          configs
        ),
      }
      return result
    })

    return { stats, diagnostics }
  }
}
