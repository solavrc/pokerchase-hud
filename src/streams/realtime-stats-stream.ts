/**
 * Real-time Statistics Stream
 * 
 * Dedicated stream for calculating real-time statistics (equity, pot odds, outs)
 * Operates only on the current hand and only for the hero player
 */

import { Transform } from 'stream'
import type { ApiHandEvent } from '../types'
import { ApiType, PhaseType } from '../types'
import { RealTimeStatsService } from '../realtime-stats/realtime-stats-service'
import type { RealTimeStats, AllPlayersRealTimeStats } from '../realtime-stats/realtime-stats-service'
import { setHandImprovementHeroHoleCards } from '../realtime-stats'


/**
 * Stream that processes hand events and outputs real-time statistics
 * Only processes data when:
 * 1. Hero is in the hand (has hole cards)
 * 2. Community cards are present (flop or later)
 * 3. Session is active (not ended)
 */
export class RealTimeStatsStream extends Transform {
  private heroPlayerId?: number
  private heroHoleCards?: number[]
  private currentHandId?: number
  private communityCards: number[] = []
  private currentPhase: PhaseType = PhaseType.PREFLOP
  private isSessionActive = true
  private currentHandEvents: ApiHandEvent[] = []  // Store events for current hand
  private activePlayerCount = 0  // Track active players (not folded)
  private currentProgress?: any  // Store latest Progress data for pot odds
  private heroSeatIndex?: number  // Store hero's seat index
  private seatBetAmounts: number[] = []  // Track bet amounts for each seat
  private seatChips: number[] = []  // Track chip stacks for each seat
  private seatUserIds: number[] = []  // Track user IDs for each seat

  constructor() {
    super({ objectMode: true })
  }

  _transform(events: ApiHandEvent[], _encoding: string, callback: Function) {
    try {
      // Process events to extract current state
      for (const event of events) {
        // Handle session events separately due to TypeScript limitations
        const eventType = (event as any).ApiTypeId
        
        if (eventType === ApiType.EVT_SESSION_DETAILS) {
          this.isSessionActive = true
        }
        
        if (eventType === ApiType.EVT_SESSION_RESULTS) {
          this.isSessionActive = false
        }
        
        switch (event.ApiTypeId) {

          case ApiType.EVT_DEAL:
            // Reset for new hand
            this.currentHandId = undefined
            this.communityCards = []
            this.currentPhase = PhaseType.PREFLOP
            this.currentHandEvents = []  // Clear previous hand events
            this.activePlayerCount = 0
            this.currentProgress = undefined
            this.heroSeatIndex = undefined
            this.seatBetAmounts = [0, 0, 0, 0, 0, 0]  // Reset bet amounts
            this.seatChips = [0, 0, 0, 0, 0, 0]  // Reset chip stacks
            this.seatUserIds = [-1, -1, -1, -1, -1, -1]  // Reset user IDs
            
            // Emit empty stats to clear previous hand's display
            const clearStats: { handId?: number; stats: AllPlayersRealTimeStats; timestamp: number } = {
              handId: undefined,
              stats: {
                heroStats: {} as RealTimeStats,
                playerStats: {}
              },
              timestamp: Date.now()
            }
            this.push(clearStats)
            
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
              // Other players' bets and chips
              for (const player of event.OtherPlayers) {
                this.seatBetAmounts[player.SeatIndex] = player.BetChip || 0
                this.seatChips[player.SeatIndex] = player.Chip || 0
              }
            }
            
            // Store event for current hand
            this.currentHandEvents.push(event)
            
            // Calculate stats for preflop if we have hero hole cards
            if (this.heroPlayerId && this.heroHoleCards) {
              this.calculateAndEmitStats()
            }
            break

          case ApiType.EVT_DEAL_ROUND:
            // Update community cards and phase
            if (event.CommunityCards && event.CommunityCards.length > 0) {
              // EVT_DEAL_ROUND may send only new cards, not all community cards
              // Append new cards to existing community cards
              if (this.currentPhase === PhaseType.PREFLOP) {
                // Flop: should receive 3 cards
                this.communityCards = event.CommunityCards
                this.currentPhase = PhaseType.FLOP
              } else if (this.currentPhase === PhaseType.FLOP) {
                // Turn: append the new card
                if (event.CommunityCards.length === 1) {
                  this.communityCards = [...this.communityCards, ...event.CommunityCards]
                } else {
                  // Sometimes all cards are sent
                  this.communityCards = event.CommunityCards
                }
                this.currentPhase = PhaseType.TURN
              } else if (this.currentPhase === PhaseType.TURN) {
                // River: append the new card
                if (event.CommunityCards.length === 1) {
                  this.communityCards = [...this.communityCards, ...event.CommunityCards]
                } else {
                  // Sometimes all cards are sent
                  this.communityCards = event.CommunityCards
                }
                this.currentPhase = PhaseType.RIVER
              }
              
              // Update active player count based on BetStatus
              // BetStatus: 1 = active, 2 = folded, 3 = all-in
              if (event.Player && event.OtherPlayers) {
                let activeCount = 0
                
                // Check hero's status
                if (event.Player.BetStatus === 1 || event.Player.BetStatus === 3) {
                  activeCount++
                }
                
                // Check other players' status
                for (const player of event.OtherPlayers) {
                  if (player.BetStatus === 1 || player.BetStatus === 3) {
                    activeCount++
                  }
                }
                
                this.activePlayerCount = activeCount
              }
              
              
              // Update Progress data if available
              if (event.Progress) {
                this.currentProgress = event.Progress
                // Update phase from Progress if it changed (important for all-in situations)
                if (event.Progress.Phase !== undefined && event.Progress.Phase !== this.currentPhase) {
                  this.currentPhase = event.Progress.Phase
                }
              }
              
              // Store event and immediately calculate stats when community cards are revealed
              this.currentHandEvents.push(event)
              this.calculateAndEmitStats()
            }
            break

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
            break
            
          case ApiType.EVT_ACTION:
            // Store action
            this.currentHandEvents.push(event)
            
            // Update Progress data if available
            if (event.Progress) {
              this.currentProgress = event.Progress
              // Update phase from Progress if it changed (important for all-in situations)
              if (event.Progress.Phase !== undefined && event.Progress.Phase !== this.currentPhase) {
                this.currentPhase = event.Progress.Phase
              }
            }
            
            // Update bet amount for this seat
            if (event.BetChip !== undefined) {
              this.seatBetAmounts[event.SeatIndex] = event.BetChip
            }
            
            
            // Update active player count on fold
            if (event.ActionType === 2) { // FOLD
              this.activePlayerCount = Math.max(1, this.activePlayerCount - 1)
            }
            
            // Recalculate if we have hero hole cards
            if (this.heroPlayerId && this.heroHoleCards) {
              this.calculateAndEmitStats()
            }
            break
        }
      }
      
      callback()
    } catch (error) {
      callback(error as Error)
    }
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
    
    // Calculate stats using the service with activePlayerCount and progress
    const stats = RealTimeStatsService.calculateStats(
      this.heroPlayerId!,
      mockActions,
      [mockPhase],
      [mockHand],
      new Set(),
      this.heroHoleCards,
      this.activePlayerCount - 1,  // Subtract 1 for hero
      this.communityCards,
      this.getPhaseDisplayName(),
      this.currentProgress,
      this.heroSeatIndex,
      this.seatBetAmounts,
      this.seatChips
    )
    
    
    // Calculate all players stats if we have necessary data
    if (Object.keys(stats).length > 0 && this.seatUserIds.length > 0) {
      const allPlayersStats = RealTimeStatsService.calculateAllPlayersStats(
        this.seatUserIds,
        this.currentProgress,
        this.seatBetAmounts,
        this.seatChips,
        stats  // Hero stats
      )
      
      const output: { handId?: number; stats: AllPlayersRealTimeStats; timestamp: number } = {
        handId: this.currentHandId,
        stats: allPlayersStats,
        timestamp: Date.now()
      }
      this.push(output)
    }
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
    this.currentPhase = PhaseType.PREFLOP
    this.isSessionActive = true
    this.currentHandEvents = []
    this.currentProgress = undefined
    this.heroSeatIndex = undefined
    this.seatBetAmounts = []
    this.seatChips = []
    this.seatUserIds = []
  }
}