/**
 * Hand Log Exporter
 * Uses HandLogProcessor for batch export functionality - replaces PokerStarsFormatter
 */

import type { PokerChaseDB } from '../app'
import type { ApiEvent, Hand, Session } from '../types'
import { ApiType, isApiEventType } from '../types/api'
import { HandLogProcessor, HandLogContext } from './hand-log-processor'
import { DEFAULT_HAND_LOG_CONFIG } from '../types/hand-log'
import { DATABASE_CONSTANTS } from '../constants/database'
import { processInChunks } from '../utils/database-utils'

export class HandLogExporter {
  // Cache for player names across all exports
  private static playerNamesCache: Map<number, { name: string, rank: string }> | null = null
  private static lastProcessedTimestamp: number = 0
  
  // Time constants for event retrieval
  private static readonly TIME_BUFFER_MS = 300000 // 5 minutes buffer to catch player seat assignments
  private static readonly POST_HAND_BUFFER_MS = 30000 // 30 seconds after hand completion

  /**
   * Build a global player names map from all available events in the database
   */
  private static async buildPlayerNamesMap(db: PokerChaseDB): Promise<Map<number, { name: string, rank: string }>> {
    // Initialize cache if needed
    if (!this.playerNamesCache) {
      this.playerNamesCache = new Map()
      console.log('[HandLogExporter] Initializing player names cache')
    }

    const playerMap = this.playerNamesCache

    try {
      // Process events newer than last processed timestamp
      const newEventsQuery = db.apiEvents
        .where('timestamp')
        .above(this.lastProcessedTimestamp)
      
      const totalNew = await newEventsQuery.count()
      if (totalNew === 0) {
        console.log('[HandLogExporter] No new events since last cache update')
        return playerMap
      }
      
      console.log(`[HandLogExporter] Processing ${totalNew} new events for player names`)
      
      // Process in chunks to avoid memory issues
      let updatedPlayers = 0
      
      for await (const chunk of processInChunks(newEventsQuery, DATABASE_CONSTANTS.SYNC_CHUNK_SIZE)) {
        // Process chunk for player information
        for (const event of chunk) {
          // Update timestamp tracker
          if (event.timestamp && event.timestamp > this.lastProcessedTimestamp) {
            this.lastProcessedTimestamp = event.timestamp
          }
          
          // Process EVT_PLAYER_SEAT_ASSIGNED
          if (isApiEventType(event, ApiType.EVT_PLAYER_SEAT_ASSIGNED) && event.TableUsers) {
            event.TableUsers.forEach(tableUser => {
              playerMap.set(tableUser.UserId, {
                name: tableUser.UserName,
                rank: tableUser.Rank.RankId
              })
              updatedPlayers++
            })
          }
          
          // Process EVT_PLAYER_JOIN
          else if (isApiEventType(event, ApiType.EVT_PLAYER_JOIN) && event.JoinUser) {
            playerMap.set(event.JoinUser.UserId, {
              name: event.JoinUser.UserName,
              rank: event.JoinUser.Rank.RankId
            })
            updatedPlayers++
          }
        }
      }

      console.log(`[HandLogExporter] Updated ${updatedPlayers} player entries, cache now has ${playerMap.size} players`)
      return playerMap
      
    } catch (error) {
      console.error(`[HandLogExporter] Failed to build player names map:`, error)
      return playerMap
    }
  }

  /**
   * Clear the player names cache (useful when new data is imported)
   */
  static clearCache() {
    this.playerNamesCache = null
    this.lastProcessedTimestamp = 0
    console.log('[HandLogExporter] Player names cache cleared')
  }

  /**
   * Export a single hand as PokerStars format string
   */
  static async exportHand(db: PokerChaseDB, handId: number, _currentSession?: Session): Promise<string> {
    // Exporting hand

    // Get hand data
    const hand = await db.hands.where('id').equals(handId).first()
    if (!hand) {
      throw new Error(`Hand ${handId} not found`)
    }

    // Get API events for this hand (with buffer for timing)
    const events = await this.getHandApiEvents(db, hand)
    if (events.length === 0) {
      throw new Error(`No API events found for hand ${handId}`)
    }

    // Found API events for hand

    // Build or get global player names map
    const globalPlayerMap = await this.buildPlayerNamesMap(db)

    // Create session with player names from global map
    const session: Session = {
      id: hand.session.id,
      battleType: hand.session.battleType,
      name: hand.session.name,
      players: new Map(),
      reset: function () {
        this.id = undefined
        this.battleType = undefined
        this.name = undefined
        this.players.clear()
      }
    }

    // Populate session players from global map for this hand's players
    hand.seatUserIds.forEach(userId => {
      if (userId !== -1) {
        const playerInfo = globalPlayerMap.get(userId)
        if (playerInfo) {
          session.players.set(userId, playerInfo)
        } else {
          // Fallback for players not found in global map
          console.warn(`[HandLogExporter] Player ${userId} not found in global map`)
          session.players.set(userId, {
            name: `Player${userId}`,
            rank: 'Unknown'
          })
        }
      }
    })

    // Session has players for hand

    // Create context for processor with hand timestamp
    const context: HandLogContext = {
      session,
      handLogConfig: DEFAULT_HAND_LOG_CONFIG,
      handTimestamp: hand.approxTimestamp
    }

    // Process events using the same logic as HandLogStream
    const processor = new HandLogProcessor(context)
    const entries = processor.processEvents(events)

    // Convert entries to text format
    const handText = entries.map(entry => entry.text).join('\n')

    // Generated log entries for hand
    return handText
  }

  /**
   * Export multiple hands as PokerStars format string
   */
  static async exportMultipleHands(db: PokerChaseDB, handIds: number[]): Promise<string> {
    const results: string[] = []

    // Exporting hands
    console.log(`[HandLogExporter] Exporting ${handIds.length} hands`)

    // Build/update player map once for all hands
    await this.buildPlayerNamesMap(db)

    for (const handId of handIds) {
      try {
        const handText = await this.exportHand(db, handId)
        results.push(handText)
      } catch (error) {
        console.error(`[HandLogExporter] Error exporting hand ${handId}:`, error)
        // Continue with next hand instead of failing completely
      }
    }

    if (results.length === 0) {
      throw new Error('No hands could be exported successfully')
    }

    // Successfully exported hands
    return results.join('\n\n\n')
  }

  /**
   * Get API events for a specific hand
   */
  private static async getHandApiEvents(db: PokerChaseDB, hand: Hand): Promise<ApiEvent[]> {
    // Get events around the hand timestamp (with buffer for related events and player names)
    const startTime = hand.approxTimestamp! - this.TIME_BUFFER_MS
    const endTime = hand.approxTimestamp! + this.POST_HAND_BUFFER_MS

    const allEvents = await db.apiEvents
      .where('timestamp')
      .between(startTime, endTime)
      .toArray()

    // Time range for hand events
    // Found total events in time range

    // Log event type distribution
    const eventTypeCounts: Record<number, number> = {}
    allEvents.forEach(e => {
      eventTypeCounts[e.ApiTypeId] = (eventTypeCounts[e.ApiTypeId] || 0) + 1
    })
    // Event type distribution

    // Find the specific hand events by looking for EVT_HAND_RESULTS with matching HandId
    const resultEvent = allEvents.find((e: ApiEvent) =>
      isApiEventType(e, ApiType.EVT_HAND_RESULTS) && e.HandId === hand.id
    )

    if (!resultEvent) {
      throw new Error(`Could not find EVT_HAND_RESULTS for hand ${hand.id}`)
    }

    // Get all events from EVT_DEAL to EVT_HAND_RESULTS for this hand
    const handEvents: ApiEvent[] = []
    let foundDeal = false

    // Sort events by timestamp to ensure correct order
    allEvents.sort((a, b) => a.timestamp! - b.timestamp!)

    for (const event of allEvents) {
      // Start collecting from EVT_DEAL that matches our seat configuration
      if (isApiEventType(event, ApiType.EVT_DEAL)) {
        // Check if this deal event matches our hand's seat configuration
        if (this.arrayEquals(event.SeatUserIds, hand.seatUserIds)) {
          foundDeal = true
          handEvents.length = 0 // Clear any previous events
          handEvents.push(event)
        }
      } else if (foundDeal) {
        handEvents.push(event)

        // Stop when we reach the hand results for our specific hand
        if (isApiEventType(event, ApiType.EVT_HAND_RESULTS)) {
          if (event.HandId === hand.id) {
            break
          }
        }
      }
    }

    // Collected events for hand
    return handEvents
  }

  /**
   * Helper function to compare arrays
   */
  private static arrayEquals<T>(a: T[], b: T[]): boolean {
    return a.length === b.length && a.every((val, index) => val === b[index])
  }

  /**
   * Export recent hands from a session or database
   */
  static async exportRecentHands(db: PokerChaseDB, sessionId?: string, limit: number = 100): Promise<string> {
    let hands: Hand[]

    if (sessionId) {
      // Get hands from specific session
      hands = await db.hands
        .toArray()
        .then((allHands: Hand[]) =>
          allHands.filter((h: Hand) => h.session.id === sessionId)
            .sort((a, b) => b.id - a.id)
            .slice(0, limit)
        )
    } else {
      // Get most recent hands
      hands = await db.hands
        .orderBy('id')
        .reverse()
        .limit(limit)
        .toArray()
    }

    if (hands.length === 0) {
      throw new Error('No hands found to export')
    }

    const handIds = hands.map(h => h.id)
    return this.exportMultipleHands(db, handIds)
  }
}
