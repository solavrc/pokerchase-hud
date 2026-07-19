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
import { defaultRegistry } from '../stats'
import { COMPACT_REQUIRED_STAT_IDS } from '../stats/compactStats'
import { matchesTableSizeFilter } from '../utils/table-size'
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
export class ReadEntityStream extends SimpleTransform<number[], PlayerStats[]> {
  private service: PokerChaseService
  private statsCache: Map<string, { stats: PlayerStats[], timestamp: number }> = new Map()
  private readonly CACHE_DURATION_MS = 5000 // 5秒のキャッシュ
  private readonly MAX_CACHE_SIZE = 50 // キャッシュエントリの最大数

  constructor(service: PokerChaseService) {
    super()
    this.service = service
  }

  public async recalculateStats(): Promise<void> {
    // 新しい計算を保証するためキャッシュをクリア
    this.statsCache.clear()

    // 必要なデータの存在チェック
    if (!this.service.playerId || !this.service.latestEvtDeal) {
      console.warn('[ReadEntityStream] playerId or latestEvtDeal not available, skipping stats calculation')
      return
    }

    // latestEvtDealから直接seatUserIdsを取得（DBアクセス不要）
    const seatUserIds = this.service.latestEvtDeal.SeatUserIds

    try {
      // すべてのプレイヤーの統計を計算
      const stats = await this.calcStats(seatUserIds)
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
      // バックグラウンド操作なのでエラーを投げずにログだけ
      ErrorHandler.logError(appError, 'ReadEntityStream')
    }
  }

  protected async transform(seatUserIds: number[]): Promise<void> {
    try {
      // バッチモード中は統計計算をスキップ
      if (this.service.batchMode) {
        return
      }

      // seatUserIdsとフィルター設定に基づいてキャッシュキーを作成
      const cacheKey = `${seatUserIds.join(',')}_${this.service.battleTypeFilter?.join(',') || 'all'}_${this.service.tableSizeFilter?.join(',') || 'all'}`
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
        return await this.calcStats(seatUserIds)
      })

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
        cacheKey: `${seatUserIds.join(',')}_${this.service.battleTypeFilter?.join(',') || 'all'}_${this.service.tableSizeFilter?.join(',') || 'all'}`,
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
  /** モジュラーレジストリシステムを使用して統計を計算 */
  private calcStats = async (seatUserIds: number[]): Promise<PlayerStats[]> => {
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
      if (this.service.battleTypeFilter) {
        const originalHandsCount = allPlayerHands.length
        allPlayerHands = allPlayerHands.filter((hand: Hand) =>
          this.service.battleTypeFilter!.includes(hand.session.battleType!)
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
      if (this.service.tableSizeFilter) {
        const originalHandsCount = allPlayerHands.length
        allPlayerHands = allPlayerHands.filter((hand: Hand) =>
          matchesTableSizeFilter(hand, this.service.tableSizeFilter)
        )

        if (allPlayerHands.length === 0 && originalHandsCount > 0) {
          return {
            playerId,
            statResults: []
          }
        }
      }

      // 最後にハンド制限フィルターを適用（フィルタ後にlimit、既存の順序を維持）
      if (this.service.handLimitFilter !== undefined && this.service.handLimitFilter > 0) {
        // 最新のハンドを取得するためハンドIDでソート（降順）
        allPlayerHands.sort((a, b) => b.id - a.id)
        allPlayerHands = allPlayerHands.slice(0, this.service.handLimitFilter)
      }

      // アクションフィルタリング用のフィルタリングされたハンドIDを作成
      if (this.service.battleTypeFilter || this.service.tableSizeFilter || this.service.handLimitFilter !== undefined) {
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
      // statDisplayConfigs. Force those ids into the calculation regardless
      // of their configured `enabled` flag -- Hud.tsx re-applies the user's
      // actual enabled flag when building the full grid's displayStats, so
      // this only widens what's calculated here, not what's shown in the
      // grid (PR #143 review).
      const configsForCalculation = this.service.statDisplayConfigs?.map(config =>
        !config.enabled && COMPACT_REQUIRED_STAT_IDS.includes(config.id)
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