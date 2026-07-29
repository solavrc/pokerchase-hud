import { SimpleTransform } from './simple-transform'
import type PokerChaseService from '../services/poker-chase-service'
import {
  PhaseType
} from '../types'
import type {
  ExistPlayerStats,
  Hand,
  PlayerStats,
  StatCalculationContext
} from '../types'
import { ErrorHandler } from '../utils/error-handler'
import { defaultRegistry, defaultStatDisplayConfigs } from '../stats'
import { COMPACT_REQUIRED_STAT_IDS, CLASSIFIER_REQUIRED_STAT_IDS } from '../stats/compactStats'
import { matchesTableSizeFilter } from '../utils/table-size'
import type { TableSizeLayer } from '../utils/table-size'
import { compareHandsNewestFirst } from '../utils/hand-order'
import type { ErrorContext } from '../types/errors'

/**
 * 統計計算Stream（パイプライン第3段階）
 *
 * プレイヤーの統計情報を計算してHUDに送信する：
 * - バトルタイプフィルター（SNG/MTT/Ring）による絞り込み
 * - ハンド数制限フィルター（最新N手のみ）の適用
 * - 大量データに対応した効率的なDB クエリ（単一クエリで全データ取得）
 * - 統計モジュールシステムによる計算（VPIP、PFR、CBet等）
 * - 5秒間の統計計算結果キャッシュによる高速化
 * - 最大50エントリまでのキャッシュサイズ制御
 *
 * 入力: プレイヤーIDの配列（seatUserIds）
 * 出力: PlayerStats配列 → HUD（background.ts経由）
 */

/**
 * Union of every stat id some HUD surface always needs regardless of the
 * user's statDisplayConfigs.enabled flag -- compact mode's fixed classic
 * line (COMPACT_REQUIRED_STAT_IDS) and the HUD-header player-type
 * classifier (CLASSIFIER_REQUIRED_STAT_IDS, notably `vpipF` for the whale
 * override). See compactStats.ts for the rationale behind each list.
 */
const FORCED_ENABLED_STAT_IDS: ReadonlySet<string> = new Set([
  ...COMPACT_REQUIRED_STAT_IDS,
  ...CLASSIFIER_REQUIRED_STAT_IDS,
])

type StatsFilterSnapshot = {
  battleTypeFilter?: number[]
  tableSizeFilter?: TableSizeLayer[]
  handLimitFilter?: number
}

export class ReadEntityStream extends SimpleTransform<number[], PlayerStats[]> {
  private service: PokerChaseService
  private statsCache: Map<string, { stats: PlayerStats[], timestamp: number }> = new Map()
  private readonly CACHE_DURATION_MS = 5000 // 5秒のキャッシュ
  private readonly MAX_CACHE_SIZE = 50 // キャッシュエントリの最大数

  constructor(service: PokerChaseService) {
    super()
    this.service = service
  }

  /** Drop results derived from an older hands/phases/actions snapshot. */
  public invalidateCache(): void {
    this.statsCache.clear()
  }

  /** Serialize an explicit empty HUD state behind all older calculations. */
  public async clearStats(): Promise<void> {
    this.invalidateCache()
    await this.enqueueSerialized(async () => {
      this.push([])
    })
  }

  private captureFilterSnapshot(): StatsFilterSnapshot {
    const battleTypeFilter = this.service.getEffectiveBattleTypeFilter()
    return {
      battleTypeFilter: battleTypeFilter ? [...battleTypeFilter] : undefined,
      tableSizeFilter: this.service.tableSizeFilter ? [...this.service.tableSizeFilter] : undefined,
      handLimitFilter: this.service.handLimitFilter,
    }
  }

  private filterSnapshotKey(snapshot: StatsFilterSnapshot): string {
    return [
      snapshot.battleTypeFilter?.join(',') ?? 'all',
      snapshot.tableSizeFilter?.join(',') ?? 'all',
      snapshot.handLimitFilter ?? 'all',
    ].join('_')
  }

  public async recalculateStats(): Promise<void> {
    // 新しい計算を保証するためキャッシュをクリア
    this.invalidateCache()

    // 自動選択中に現在セッションが終了済みなら、永続化された前セッションの
    // latestEvtDealを使って古いlineupを再表示しない。
    if (
      this.service.autoBattleTypeFilter &&
      this.service.session.battleType === undefined
    ) {
      await this.enqueueSerialized(async () => {
        // A new session may have started while this clear waited behind an
        // older calculation. A newer terminal boundary still needs the same
        // clear, so the final auto/no-session state is the complete guard.
        if (
          this.service.autoBattleTypeFilter &&
          this.service.session.battleType === undefined
        ) {
          this.push([])
        }
      })
      return
    }

    // 必要なデータの存在チェック
    if (!this.service.playerId || !this.service.latestEvtDeal) {
      console.warn('[ReadEntityStream] playerId or latestEvtDeal not available, skipping stats calculation')
      return
    }

    // latestEvtDealから直接seatUserIdsを取得（DBアクセス不要）。これは常に
    // ヒーロー在籍時点のSeatUserIds（永続化対象・latestEvtDealの意味論）。
    const seatUserIds = this.service.latestEvtDeal.SeatUserIds

    // 計算対象と同じヒーロー在籍dealを、このキュー項目固有の座席文脈として捕捉する。
    // キュー投入前にliveEvtDealを変更すると、先行中の旧transformがその座標で
    // broadcastされる。反対にキュー待ち中の新しいlive dealをそのまま使うと、
    // この再計算結果が別lineupでbroadcastされる。push直前に捕捉値へ再アンカーする。
    const evtDeal = this.service.latestEvtDeal
    const sessionId = this.service.session.id
    const statsOutputContextRevision = this.service.statsOutputContextRevision
    const filterSnapshot = this.captureFilterSnapshot()
    const statsContextKey = `${sessionId ?? 'no-session'}_${this.filterSnapshotKey(filterSnapshot)}`
    const isCurrentStatsContext = () =>
      this.service.latestEvtDeal === evtDeal &&
      this.service.statsOutputContextRevision === statsOutputContextRevision &&
      `${this.service.session.id ?? 'no-session'}_${this.filterSnapshotKey(this.captureFilterSnapshot())}` === statsContextKey

    // 直接calcStats()すると、既に走っている旧フィルターのtransformより先に
    // 完了し、その後に旧結果がHUDを上書きし得る。通常writeと同じ直列キューの
    // 末尾へ載せ、最終ブロードキャストが必ず現在のフィルターになるようにする。
    await this.enqueueSerialized(async () => {
      try {
        // 待機中に新しいヒーロー在籍dealが到着した場合、この項目のseatUserIdsと
        // evtDealは既に古い。ここでliveEvtDealを巻き戻したり結果をpushせず、
        // 後ろに積まれた新dealの通常transformへ最終表示を任せる。
        if (!isCurrentStatsContext()) {
          return
        }
        const stats = await this.calcStats(seatUserIds, filterSnapshot)
        if (!isCurrentStatsContext()) {
          return
        }
        this.service.liveEvtDeal = evtDeal
        this.push(stats)
      } catch (error) {
        const context: ErrorContext = {
          streamName: 'ReadEntityStream',
          operation: 'recalculateStats',
          playerId: this.service.playerId
        }
        const appError = ErrorHandler.handleStreamError(
          error,
          'ReadEntityStream',
          context
        )
        ErrorHandler.logError(appError, 'ReadEntityStream')
      }
    })
  }

  /**
   * Capture the session-output epoch when the chunk enters the serialized
   * queue, not when transform execution eventually begins. A 309 can advance
   * the epoch while this write waits behind an older calculation.
   */
  override write(seatUserIds: number[]): void {
    const statsOutputContextRevision = this.service.statsOutputContextRevision
    void this.enqueueSerialized(() =>
      this.transformForContext(seatUserIds, statsOutputContextRevision)
    )
  }

  protected async transform(seatUserIds: number[]): Promise<void> {
    await this.transformForContext(
      seatUserIds,
      this.service.statsOutputContextRevision
    )
  }

  private async transformForContext(
    seatUserIds: number[],
    statsOutputContextRevision: number
  ): Promise<void> {
    try {
      // バッチモード中は統計計算をスキップ
      if (this.service.batchMode) {
        return
      }
      if (
        this.service.statsOutputContextRevision !==
        statsOutputContextRevision
      ) {
        return
      }
      if (
        this.service.autoBattleTypeFilter &&
        this.service.session.battleType === undefined
      ) {
        this.push([])
        return
      }

      // seatUserIdsとフィルター設定に基づいてキャッシュキーを作成
      const filterSnapshot = this.captureFilterSnapshot()
      const cacheKey = `${seatUserIds.join(',')}_${this.filterSnapshotKey(filterSnapshot)}`
      const sessionId = this.service.session.id
      const liveEvtDeal = this.service.liveEvtDeal
      const statsContextKey = `${sessionId ?? 'no-session'}_${this.filterSnapshotKey(filterSnapshot)}`
      const isCurrentStatsContext = () =>
        this.service.liveEvtDeal === liveEvtDeal &&
        this.service.statsOutputContextRevision === statsOutputContextRevision &&
        `${this.service.session.id ?? 'no-session'}_${this.filterSnapshotKey(this.captureFilterSnapshot())}` === statsContextKey
      const now = Date.now()

      // テスト環境（NODE_ENV=test）またはデバッグモードではキャッシュを無効化
      const useCache = process.env.NODE_ENV !== 'test' && !process.env.DEBUG_NO_CACHE

      // まずキャッシュをチェック（キャッシュが有効な場合のみ）
      if (useCache) {
        const cached = this.statsCache.get(cacheKey)
        if (cached && (now - cached.timestamp) < this.CACHE_DURATION_MS) {
          this.push(cached.stats)
          return
        }
      }

      /**
       * `rw!`, `rw?` は Service Worker で機能しない??
       * @see https://dexie.org/docs/Dexie/Dexie.transaction()
       */
      const stats = await this.service.db.transaction('r', [this.service.db.hands, this.service.db.phases, this.service.db.actions], async () => {
        // 生のseatUserIds順序で統計を計算（フロントエンドで表示位置を調整）
        return await this.calcStats(seatUserIds, filterSnapshot)
      })

      // 計算中にsession/filter/deal文脈が変わった結果は、古いcache keyへ保存せず
      // broadcastもしない。新しいdeal/filter側の後続writeが現行文脈を計算する。
      if (!isCurrentStatsContext()) return

      // キャッシュを更新
      this.statsCache.set(cacheKey, { stats, timestamp: now })

      // 古いキャッシュエントリをクリーンアップ
      if (this.statsCache.size > this.MAX_CACHE_SIZE) {
        const entriesToDelete: string[] = []
        for (const [key, value] of this.statsCache.entries()) {
          if (now - value.timestamp > this.CACHE_DURATION_MS) {
            entriesToDelete.push(key)
          }
        }
        entriesToDelete.forEach(key => this.statsCache.delete(key))
      }

      this.push(stats)
    } catch (error: unknown) {
      const context: ErrorContext = {
        streamName: 'ReadEntityStream',
        playerIds: seatUserIds,
        cacheKey: `${seatUserIds.join(',')}_${this.service.getEffectiveBattleTypeFilter()?.join(',') ?? 'all'}_${this.service.tableSizeFilter?.join(',') || 'all'}`,
        battleTypeFilter: this.service.battleTypeFilter,
        tableSizeFilter: this.service.tableSizeFilter,
        handLimitFilter: this.service.handLimitFilter
      }
      const appError = ErrorHandler.handleStreamError(error, 'ReadEntityStream', context)
      if (this.listenerCount('error') > 0) {
        this.emit('error', appError)
      }
    }
  }
  /**
   * モジュラーレジストリシステムを使用して統計を計算
   *
   * Public: `transform()`/`recalculateStats()`（このクラス内部のライブパイプライン）
   * だけでなく、`background/import-export.ts`の`getLatestSessionStats()`
   * （プリゲーム・ヒーロースタッツのフォールバック）からも直接呼び出される。
   * 統計計算式を再実装せず、同じ`calcStats`を使い回すための公開エントリポイント
   * -- ただし`push()`しないため、`statsOutputStream`の'data'購読（ports.ts）を
   * 経由したブロードキャストは発生しない（呼び出し元が結果を自分で届ける）。
   */
  calcStats = async (
    seatUserIds: number[],
    filterSnapshot: StatsFilterSnapshot = this.captureFilterSnapshot()
  ): Promise<PlayerStats[]> => {
    const {
      battleTypeFilter: effectiveBattleTypeFilter,
      tableSizeFilter,
      handLimitFilter,
    } = filterSnapshot

    return await Promise.all(seatUserIds.map(async playerId => {
      if (playerId === -1)
        return { playerId: -1 }

      // battleTypeフィルターとハンド制限に基づいてフィルタリングされたhandIdsを取得
      let filteredHandIds: number[] | undefined = undefined
      let filteredHandIdSet: Set<number> | undefined = undefined

      // まず、プレイヤーのすべてのハンドを取得
      let allPlayerHands = await this.service.db.hands
        .where('seatUserIds').equals(playerId)
        .toArray()

      // 指定されている場合、まずbattleTypeフィルターを適用
      if (effectiveBattleTypeFilter) {
        const originalHandsCount = allPlayerHands.length
        allPlayerHands = allPlayerHands.filter((hand: Hand) =>
          effectiveBattleTypeFilter.includes(hand.session.battleType!)
        )

        // battleTypeフィルターに一致するハンドがない場合、このプレイヤーの空の統計を返す
        // ただし新規プレイヤー（originalHandsCount === 0）は0ハンドで表示を許可
        if (allPlayerHands.length === 0 && originalHandsCount > 0) {
          return {
            playerId,
            statResults: [] // 空の統計、プレースホルダーではない
          }
        }
      }

      // 次に指定されていれば卓人数（配られた人数）フィルターを適用（C案）。
      // battleTypeフィルターと同じ適用点・同じ早期returnの考え方。
      if (tableSizeFilter) {
        const originalHandsCount = allPlayerHands.length
        allPlayerHands = allPlayerHands.filter((hand: Hand) =>
          matchesTableSizeFilter(hand, tableSizeFilter)
        )

        if (allPlayerHands.length === 0 && originalHandsCount > 0) {
          return {
            playerId,
            statResults: []
          }
        }
      }

      // 最後にハンド制限フィルターを適用（フィルタ後にlimit、既存の順序を維持）
      if (handLimitFilter !== undefined && handLimitFilter > 0) {
        // MTTのテーブル移動ではHandIdが局所逆転するため、受信時刻で最新順にする。
        allPlayerHands.sort(compareHandsNewestFirst)
        allPlayerHands = allPlayerHands.slice(0, handLimitFilter)
      }

      // アクションフィルタリング用のフィルタリングされたハンドIDを作成
      if (effectiveBattleTypeFilter || tableSizeFilter || handLimitFilter !== undefined) {
        filteredHandIds = allPlayerHands.map((h: Hand) => h.id)
        filteredHandIdSet = new Set(filteredHandIds)
      }

      // プレイヤーのすべてのアクションを1回のクエリで取得 - 大幅なパフォーマンス向上
      const allPlayerActions = await this.service.db.actions
        .where({ playerId })
        .toArray()

      // 必要に応じてhandIdでアクションをフィルタリング
      const relevantActions = filteredHandIdSet
        ? allPlayerActions.filter(a => filteredHandIdSet.has(a.handId!))
        : allPlayerActions

      // プレイヤーのすべてのフェーズを1回のクエリで取得
      const allPlayerPhases = await this.service.db.phases
        .where('seatUserIds').equals(playerId)
        .toArray()

      // 必要に応じてhandIdでフェーズをフィルタリング
      const relevantPhases = filteredHandIdSet
        ? allPlayerPhases.filter(p => p.handId !== undefined && filteredHandIdSet.has(p.handId))
        : allPlayerPhases

      // Get winning hands for WWSF and W$SD calculations
      const flopPhases = relevantPhases.filter(p => p.phase === PhaseType.FLOP)
      const showdownPhases = relevantPhases.filter(p => p.phase === PhaseType.SHOWDOWN)
      const phaseHandIds = [...new Set([...flopPhases, ...showdownPhases].map(p => p.handId!))]
      let winningHands: Hand[] = []

      if (phaseHandIds.length > 0) {
        winningHands = await this.service.db.hands
          .where('id')
          .anyOf(phaseHandIds)
          .and((hand: Hand) => hand.winningPlayerIds.includes(playerId))
          .toArray()
      }

      const winningHandIds = new Set(winningHands.map(h => h.id))

      // Create calculation context
      const context: StatCalculationContext = {
        playerId,
        actions: relevantActions,
        phases: relevantPhases,
        hands: allPlayerHands,
        allPlayerActions,
        allPlayerPhases,
        winningHandIds,
        session: this.service.session
      }

      // Compact HUD mode (#143) has a fixed classic-line format (VPIP/PFR/3B
      // (HAND) + AF/CB/STL) that must always be populated, even when the
      // user has hidden one of those stats from the full 16-stat grid via
      // statDisplayConfigs. The player-type classifier (HM-style auto-rate
      // icon) has the same requirement for vpip/af/vpipF -- notably vpipF,
      // which is opt-in (enabled: false by default) and would otherwise
      // never reach the classifier for users who haven't turned its row on.
      // Force every id in FORCED_ENABLED_STAT_IDS into the calculation
      // regardless of its configured `enabled` flag -- Hud.tsx re-applies
      // the user's actual enabled flag when building the full grid's
      // displayStats, so this only widens what's calculated here, not what's
      // shown in the grid (PR #143 review).
      //
      // service.statDisplayConfigs is undefined until background.ts's
      // onInstalled handler observes a saved `options.filterOptions` (see
      // background.ts's default branch) -- i.e. on a fresh install, or for
      // any user who hasn't opened the popup/saved filters yet.
      // calculateWithConfig(context, undefined) falls back to calculateAll(),
      // which only computes registry-enabled stats and excludes opt-in ones
      // like vpipF entirely -- the forcing above would never even run since
      // there'd be no configs array to map over. Fall back to
      // defaultStatDisplayConfigs (same base background.ts merges saved
      // configs onto) so a configs array -- and therefore the forcing -- is
      // always in play, fresh install or not (PR #146 review).
      const configsForCalculation = (this.service.statDisplayConfigs ?? defaultStatDisplayConfigs).map(config =>
        !config.enabled && FORCED_ENABLED_STAT_IDS.has(config.id)
          ? { ...config, enabled: true }
          : config
      )

      // Calculate stats using the registry with custom configuration
      const statResults = await defaultRegistry.calculateWithConfig(context, configsForCalculation)

      // Return simple stat results format
      const stats: ExistPlayerStats = {
        playerId,
        statResults
      }

      return stats
    }))
  }
}
