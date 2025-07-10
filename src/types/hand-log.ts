/**
 * Hand Log Types
 * Types for real-time hand log display feature
 */

/**
 * Hand log entry representing a single line in the log
 */
export interface HandLogEntry {
  id: string                    // Unique identifier for the entry
  handId: number | undefined    // Hand ID (undefined until hand completes)
  timestamp: number             // Event timestamp
  text: string                  // Formatted text line
  type: HandLogEntryType       // Type of log entry
  phase?: number               // Current game phase
}

/**
 * Types of hand log entries for styling/filtering
 */
export enum HandLogEntryType {
  HEADER = 'header',           // Hand header with game info
  SEAT = 'seat',              // Seat assignment
  CARDS = 'cards',            // Hole cards dealt
  ACTION = 'action',          // Player action (bet, raise, fold, etc.)
  STREET = 'street',          // New street (flop, turn, river)
  SHOWDOWN = 'showdown',      // Showdown results
  SUMMARY = 'summary',        // Hand summary
  SYSTEM = 'system'           // System messages
}

/**
 * Hand log state for a single hand
 */
export interface HandLogState {
  entries: HandLogEntry[]      // All log entries for this hand
  handId?: number             // Hand ID when available
  startTime: number           // Hand start timestamp
  isComplete: boolean         // Whether hand is complete
  playerNames: Map<number, string>  // Player ID to name mapping
  seatUserIds: number[]       // Seat to user ID mapping
}

/**
 * Configuration for hand log display
 */
export interface HandLogConfig {
  enabled: boolean            // Whether hand log is enabled
  maxHands: number           // Maximum number of hands to keep
  opacity: number            // Overlay opacity (0-1)
  fontSize: number           // Font size in pixels
  position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
  width: number              // Width in pixels
  height: number             // Height in pixels
  autoScroll: boolean        // Auto-scroll to latest entry
  showTimestamps: boolean    // Show timestamps in log
}

/**
 * Global UI configuration for HUD and Log display
 */
export interface UIConfig {
  displayEnabled: boolean     // Master ON/OFF for all UI elements (HUD + Log)
  scale: number              // UI scale factor (0.5 - 2.0)
}

/**
 * Hand log event emitted by HandLogStream
 */
export interface HandLogEvent {
  type: 'add' | 'update' | 'clear' | 'removeIncomplete'
  handId?: number
  entries?: HandLogEntry[]
  config?: Partial<HandLogConfig>
}

/**
 * Default hand log configuration
 */
export const DEFAULT_HAND_LOG_CONFIG: HandLogConfig = {
  enabled: true,
  maxHands: 5,
  opacity: 0.8,
  fontSize: 8,
  position: 'bottom-right',
  width: 250,
  height: 200,
  autoScroll: true,
  showTimestamps: false
}

/**
 * Default UI configuration
 */
export const DEFAULT_UI_CONFIG: UIConfig = {
  displayEnabled: true,  // UI is visible by default
  scale: 1.0            // Normal size
}
