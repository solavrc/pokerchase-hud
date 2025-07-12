/**
 * Real-time Statistics Module
 * 
 * These statistics are calculated in real-time for the hero player only
 * and are not stored or aggregated like regular statistics.
 * They update per phase/action rather than per hand.
 */

export { potOddsStat } from './pot-odds'
export { handImprovementStat } from './hand-improvement'

// Export helper functions for hole card management
export { setHandImprovementHeroHoleCards, setHandImprovementBatchMode } from './hand-improvement'