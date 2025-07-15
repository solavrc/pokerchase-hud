/**
 * Real-time Statistics Service
 * 
 * Manages real-time statistics calculations for the hero player
 * These stats update per phase/action and are displayed above the hero's HUD
 */

import type { StatResult } from '../types/stats'
import type { Action, Phase, Hand } from '../types/entities'
import { potOddsStat, handImprovementStat } from './index'

export interface RealTimeStats {
  holeCards?: number[]  // Hero's hole cards for display
  communityCards?: number[]  // Community cards for display
  currentPhase?: string  // Current phase for display (Preflop, Flop, Turn, River)
  potOdds?: StatResult
  handImprovement?: StatResult
  seatBetAmounts?: number[]  // Bet amounts for each seat
}

export class RealTimeStatsService {
  /**
   * Calculate real-time statistics for the hero player
   * Returns only the stats that have valid values (not '-')
   */
  static calculateStats(
    playerId: number,
    actions: Action[],
    phases: Phase[],
    hands: Hand[],
    winningHandIds: Set<number>,
    holeCards?: number[],
    activeOpponents?: number,
    communityCards?: number[],
    currentPhase?: string,
    progress?: any,
    heroSeatIndex?: number,
    seatBetAmounts?: number[],
    seatChips?: number[]
  ): RealTimeStats {
    const context = {
      playerId,
      actions,
      phases,
      hands,
      allPlayerActions: actions,
      allPlayerPhases: phases,
      winningHandIds,
      session: {
        id: undefined,
        battleType: undefined,
        name: undefined,
        players: new Map(),
        reset: () => {}
      },
      activeOpponents,  // Pass through for equity calculation
      progress,  // Progress data from WebSocket events
      heroSeatIndex,  // Hero's seat index
      seatBetAmounts,  // Bet amounts for each seat
      seatChips  // Chip stacks for each seat
    }

    const stats: RealTimeStats = {}
    
    // Include hole cards if provided
    if (holeCards) {
      stats.holeCards = holeCards
    }
    
    // Include community cards if provided
    if (communityCards) {
      stats.communityCards = communityCards
    }
    
    // Include current phase if provided
    if (currentPhase) {
      stats.currentPhase = currentPhase
    }
    
    // Include seat bet amounts if provided
    if (seatBetAmounts) {
      stats.seatBetAmounts = seatBetAmounts
    }

    // Calculate pot odds
    const potOddsValue = potOddsStat.calculate(context)
    if (potOddsValue !== '-' && !(potOddsValue instanceof Promise)) {
      stats.potOdds = {
        id: potOddsStat.id,
        name: potOddsStat.name,
        value: potOddsValue,
        formatted: potOddsStat.format ? potOddsStat.format(potOddsValue) : String(potOddsValue)
      }
    }

    // Calculate hand improvement probabilities
    const handImprovementValue = handImprovementStat.calculate(context)
    if (handImprovementValue !== '-' && !(handImprovementValue instanceof Promise)) {
      stats.handImprovement = {
        id: handImprovementStat.id,
        name: handImprovementStat.name,
        value: handImprovementValue,
        formatted: handImprovementStat.format ? handImprovementStat.format(handImprovementValue) : String(handImprovementValue)
      }
    }

    return stats
  }
}