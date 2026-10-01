/**
 * Real-time Statistics Stream
 *
 * Dedicated stream for calculating real-time statistics (equity, pot odds, outs)
 * Operates only on the current hand and only for the hero player
 */

import { SimpleTransform } from './simple-transform'
import type { ApiEvent, ApiHandEvent } from '../types'
import { ActionType, ApiType, BetStatusType, PhaseType } from '../types'
import { RealTimeStatsService } from '../realtime-stats/realtime-stats-service'
import type { RealTimeStats, AllPlayersRealTimeStats } from '../realtime-stats/realtime-stats-service'
import { setHandImprovementHeroHoleCards } from '../realtime-stats'
import { resolveActionPhase } from '../utils/action-phase'
import { RealtimeCommunityCards, hasBoardForPhase } from '../utils/realtime-community-cards'


/**
 * Stream that processes hand events and outputs real-time statistics
 * Only processes data when:
 * 1. Hero is in the hand (has hole cards)
 * 2. Community cards are present (flop or later)
 * 3. Session is active (not ended)
 */
export class RealTimeStatsStream extends SimpleTransform<ApiEvent, { handId?: number; stats: AllPlayersRealTimeStats; timestamp: number }> {
  private heroPlayerId?: number
  private heroHoleCards?: number[]
  private currentHandId?: number
  private communityCards: number[] = []
  private readonly board = new RealtimeCommunityCards()
  private readonly actedSeatsInCurrentPhase = new Set<number>()
  private currentPhase: PhaseType = PhaseType.PREFLOP
  private isSessionActive = true
  private currentHandEvents: ApiHandEvent[] = []  // Store events for current hand
  private activePlayerCount = 0  // Track active players (not folded)
  private currentProgress?: any  // Store latest Progress data for pot odds
  private heroSeatIndex?: number  // Store hero's seat index
  private seatBetAmounts: number[] = []  // Track bet amounts for each seat
  private seatChips: number[] = []  // Track chip stacks for each seat
  private seatBetStatuses: Array<BetStatusType | undefined> = []  // Track whether each seat can still act
  private seatUserIds: number[] = []  // Track user IDs for each seat

  constructor() {
    super()
  }

  protected async transform(event: ApiEvent): Promise<void> {
    try {
      // Handle session events separately due to TypeScript limitations
      const eventType = (event as any).ApiTypeId

      // EVT_SESSION_DETAILS (308) is not guaranteed to arrive. Mirror the
      // ingestion/session-activity fallbacks so a completed session cannot
      // leave realtime stats disabled throughout the next one.
      if (eventType === ApiType.EVT_ENTRY_QUEUED || eventType === ApiType.EVT_SESSION_DETAILS) {
        this.isSessionActive = true
      }

      if (eventType === ApiType.EVT_SESSION_RESULTS) {
        this.isSessionActive = false
        // content_scriptがローカル終了イベントでACTIVEタブの表示を消すため、
        // ここでは内部状態だけをinactiveへ遷移させ、空更新はpushしない。
      }

      switch (event.ApiTypeId) {

        case ApiType.EVT_DEAL:
          // Player is absent for spectator deals. Only a hero-present deal is
          // strong enough to reactivate calculations when 201/308 were missed.
          if (event.Player != null) {
            this.isSessionActive = true
          }

          // Reset for new hand
          this.currentHandId = undefined
          this.communityCards = []
          this.board.reset()
          this.actedSeatsInCurrentPhase.clear()
          this.currentPhase = PhaseType.PREFLOP
          this.currentHandEvents = []  // Clear previous hand events
          this.activePlayerCount = 0
          this.currentProgress = undefined
          this.heroPlayerId = undefined
          this.heroHoleCards = undefined
          this.heroSeatIndex = undefined
          this.seatBetAmounts = [0, 0, 0, 0, 0, 0]  // Reset bet amounts
          this.seatChips = [0, 0, 0, 0, 0, 0]  // Reset chip stacks
          this.seatBetStatuses = [undefined, undefined, undefined, undefined, undefined, undefined]
          this.seatUserIds = [-1, -1, -1, -1, -1, -1]  // Reset user IDs

          // Emit empty stats to clear previous hand's display
          this.emitClearStats()

          // Extract hero information
          if (event.Player && event.Player.HoleCards?.length === 2 && event.SeatUserIds) {
            const heroSeatIndex = event.Player.SeatIndex
            this.heroSeatIndex = heroSeatIndex
            const playerId = event.SeatUserIds[heroSeatIndex]
            if (playerId !== undefined) {
              this.heroPlayerId = playerId
              this.heroHoleCards = event.Player.HoleCards

              // Cache hole cards for stat calculations
              const tempHandId = `temp_${Date.now()}`
              setHandImprovementHeroHoleCards(tempHandId, playerId.toString(), this.heroHoleCards)
            }

            // Count initial active players (all players are active at the start)
            this.activePlayerCount = event.SeatUserIds.filter(id => id !== -1).length

            // Store seat user IDs
            this.seatUserIds = [...event.SeatUserIds]
          }
          // Store Progress data for pot odds
          if (event.Progress) {
            this.currentProgress = event.Progress
            // Set initial phase from Progress
            if (event.Progress.Phase !== undefined) {
              this.currentPhase = event.Progress.Phase
            }
          }

          // Initialize bet amounts and chip stacks from blinds
          if (event.Player && event.OtherPlayers) {
            // Hero's bet and chips
            this.seatBetAmounts[event.Player.SeatIndex] = event.Player.BetChip || 0
            this.seatChips[event.Player.SeatIndex] = event.Player.Chip || 0
            this.seatBetStatuses[event.Player.SeatIndex] = event.Player.BetStatus
            // Other players' bets and chips
            for (const player of event.OtherPlayers) {
              this.seatBetAmounts[player.SeatIndex] = player.BetChip || 0
              this.seatChips[player.SeatIndex] = player.Chip || 0
              this.seatBetStatuses[player.SeatIndex] = player.BetStatus
            }
          }

          // Store event for current hand
          this.currentHandEvents.push(event)

          // Calculate stats for preflop if we have hero hole cards
          if (this.heroPlayerId && this.heroHoleCards) {
            this.calculateAndEmitStats()
          }
          break

        case ApiType.EVT_DEAL_ROUND: {
          if (!event.CommunityCards?.length) break
          const roundPhase = event.Progress.Phase
          this.communityCards = this.board.apply(roundPhase, event.CommunityCards)

          // カードの補完と金融snapshotの採用を分ける。旧streetのROUNDは
          // 盤面だけを補い、現在のベット・stack・手番を巻き戻さない（MUST NOT）。
          if (roundPhase >= this.currentPhase) {
            this.advancePhase(roundPhase)
            for (let seat = 0; seat < this.seatBetAmounts.length; seat++) {
              if (this.actedSeatsInCurrentPhase.has(seat)) continue
              this.seatBetAmounts[seat] = 0
              this.seatBetStatuses[seat] = BetStatusType.FOLDED
            }

            const players = event.Player
              ? [event.Player, ...event.OtherPlayers]
              : event.OtherPlayers
            for (const player of players) {
              // 同streetのACTIONを既に適用した席は、開始時snapshotで上書きしない。
              if (this.actedSeatsInCurrentPhase.has(player.SeatIndex)) continue
              this.seatBetAmounts[player.SeatIndex] = player.BetChip ?? 0
              this.seatChips[player.SeatIndex] = player.Chip ?? 0
              this.seatBetStatuses[player.SeatIndex] = player.BetStatus
            }
            if (this.actedSeatsInCurrentPhase.size === 0) {
              this.currentProgress = event.Progress
            }
            this.activePlayerCount = this.seatBetStatuses.filter(status =>
              status === BetStatusType.BET_ABLE || status === BetStatusType.ALL_IN
            ).length
          }

          this.currentHandEvents.push(event)
          this.calculateAndEmitStats()
          break
        }

        case ApiType.EVT_HAND_RESULTS:
          // Capture real hand ID
          if (event.HandId) {
            this.currentHandId = event.HandId
          }

          this.currentHandEvents.push(event)
          // Clear for next hand
          this.currentHandEvents = []
          this.heroPlayerId = undefined
          this.heroHoleCards = undefined
          this.emitClearStats()
          break

        case ApiType.EVT_ACTION: {
          this.currentHandEvents.push(event)
          // 終了行のPhase=3はリバー到達を意味しない。canonical writerと同じ解決を使う。
          const actionPhase = resolveActionPhase(event, this.currentPhase)
          if (actionPhase < this.currentPhase) break
          this.advancePhase(actionPhase)
          this.actedSeatsInCurrentPhase.add(event.SeatIndex)

          if (event.Progress) {
            this.currentProgress = event.Progress
          }
          if (event.BetChip !== undefined) {
            this.seatBetAmounts[event.SeatIndex] = event.BetChip
          }
          if (event.Chip !== undefined) {
            this.seatChips[event.SeatIndex] = event.Chip
          }

          if (event.ActionType === ActionType.FOLD) {
            this.seatBetStatuses[event.SeatIndex] = BetStatusType.FOLDED
          } else if (event.ActionType === ActionType.ALL_IN || event.Chip === 0) {
            this.seatBetStatuses[event.SeatIndex] = BetStatusType.ALL_IN
          } else {
            this.seatBetStatuses[event.SeatIndex] = BetStatusType.BET_ABLE
          }
          this.activePlayerCount = this.seatBetStatuses.filter(status =>
            status === BetStatusType.BET_ABLE || status === BetStatusType.ALL_IN
          ).length

          if (this.heroPlayerId && this.heroHoleCards) {
            this.calculateAndEmitStats()
          }
          break
        }
      }
    } catch (error) {
      this.handleError(error)
    }
  }

  private advancePhase(phase: PhaseType): void {
    if (phase <= this.currentPhase) return
    this.currentPhase = phase
    this.seatBetAmounts = this.seatBetAmounts.map(() => 0)
    this.actedSeatsInCurrentPhase.clear()
  }

  private calculateAndEmitStats() {
    if (!this.shouldCalculateStats()) {
      return
    }

    // Create minimal data structures for calculation
    const mockHand: any = {
      id: this.currentHandId || Date.now(), // Use timestamp as fallback ID
      seatUserIds: [this.heroPlayerId!],
      winningPlayerIds: [],
      smallBlind: 0,
      bigBlind: 0,
      session: {
        id: undefined,
        battleType: undefined,
        name: undefined
      },
      results: []
    }

    const mockPhase = {
      handId: mockHand.id,
      phase: this.currentPhase,
      seatUserIds: [this.heroPlayerId!],
      communityCards: this.communityCards
    }

    // Get latest action for pot odds calculation
    const lastAction = this.getLastAction()
    const mockActions = lastAction ? [lastAction] : []

    // 盤面待ちでも手札・pot oddsは更新する。役確率だけを未確定として外す。
    const phases = hasBoardForPhase(this.currentPhase, this.communityCards) ? [mockPhase] : []
    const stats = RealTimeStatsService.calculateStats(
      this.heroPlayerId!,
      mockActions,
      phases,
      [mockHand],
      new Set(),
      this.heroHoleCards,
      this.activePlayerCount - 1,  // Subtract 1 for hero
      this.communityCards,
      this.getPhaseDisplayName(),
      this.currentProgress,
      this.heroSeatIndex,
      this.seatBetAmounts,
      this.seatChips,
      this.seatBetStatuses
    )

    // Calculate all players stats if we have necessary data
    if (Object.keys(stats).length > 0 && this.seatUserIds.length > 0) {
      const allPlayersStats = RealTimeStatsService.calculateAllPlayersStats(
        this.seatUserIds,
        this.currentProgress,
        this.seatBetAmounts,
        this.seatChips,
        stats,  // Hero stats
        this.seatBetStatuses
      )

      const output: { handId?: number; stats: AllPlayersRealTimeStats; timestamp: number } = {
        handId: this.currentHandId,
        stats: allPlayersStats,
        timestamp: Date.now()
      }
      this.push(output)
    }
  }

  private emitClearStats(): void {
    this.push({
      handId: undefined,
      stats: {
        heroStats: {} as RealTimeStats,
        playerStats: {}
      },
      timestamp: Date.now()
    })
  }

  private shouldCalculateStats(): boolean {
    return Boolean(
      this.isSessionActive &&
      this.heroPlayerId &&
      this.heroHoleCards // Preflop or later (as long as we have hole cards)
    )
  }

  private getLastAction(): any | undefined {
    // Find the most recent EVT_ACTION to calculate pot odds from stored events
    for (let i = this.currentHandEvents.length - 1; i >= 0; i--) {
      const event = this.currentHandEvents[i]
      if (event?.ApiTypeId === ApiType.EVT_ACTION) {
        return {
          handId: this.currentHandId || -1,
          playerId: this.heroPlayerId!,
          phase: this.currentPhase,
          actionType: event.ActionType,
          index: i,
          actionDetails: [],
          progress: event.Progress
        }
      }
    }
    return undefined
  }

  private getPhaseDisplayName(): string {
    switch (this.currentPhase) {
      case PhaseType.PREFLOP:
        return 'Preflop'
      case PhaseType.FLOP:
        return 'Flop'
      case PhaseType.TURN:
        return 'Turn'
      case PhaseType.RIVER:
        return 'River'
      default:
        return 'Preflop'
    }
  }

  reset() {
    this.heroPlayerId = undefined
    this.heroHoleCards = undefined
    this.currentHandId = undefined
    this.communityCards = []
    this.board.reset()
    this.actedSeatsInCurrentPhase.clear()
    this.currentPhase = PhaseType.PREFLOP
    this.isSessionActive = true
    this.currentHandEvents = []
    this.activePlayerCount = 0
    this.currentProgress = undefined
    this.heroSeatIndex = undefined
    this.seatBetAmounts = []
    this.seatChips = []
    this.seatBetStatuses = []
    this.seatUserIds = []
  }
}
