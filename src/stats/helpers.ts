/**
 * Helper functions for statistic implementations
 * 統計実装のためのヘルパー関数
 */

import type { ActionDetailContext } from '../types/stats'
import { ActionType, PhaseType } from '../types/game'

/**
 * Check if this is NOT the first preflop action
 * プリフロップでの2回目以降のアクションかどうかをチェック
 * 
 * 注: この関数名は誤解を招く可能性があります。
 * 実際には「最初のアクションではない」ことをチェックしています。
 * BB/SBの区別はActionDetailContextでは不可能なため、
 * より正確な判定にはポジション情報が必要です。
 */
export function isVoluntaryAction(context: ActionDetailContext): boolean {
  return context.phase === PhaseType.PREFLOP && context.phasePlayerActionIndex > 0
}

/**
 * Check if player is facing a 2-bet (first raise)
 * 2ベット（最初のレイズ）に直面しているかチェック
 */
export function isFacing2Bet(context: ActionDetailContext): boolean {
  return context.phase === PhaseType.PREFLOP && context.phasePrevBetCount === 2
}

/**
 * Check if player is facing a 3-bet
 * 3ベットに直面しているかチェック
 */
export function isFacing3Bet(context: ActionDetailContext): boolean {
  return context.phase === PhaseType.PREFLOP && context.phasePrevBetCount === 3
}

/**
 * Check if player is facing a 4-bet
 * 4ベットに直面しているかチェック
 */
export function isFacing4Bet(context: ActionDetailContext): boolean {
  return context.phase === PhaseType.PREFLOP && context.phasePrevBetCount === 4
}

/**
 * Check if this is an aggressive action (bet or raise)
 * アグレッシブなアクション（ベットまたはレイズ）かチェック
 */
export function isAggressiveAction(actionType: ActionType): boolean {
  return actionType === ActionType.BET || actionType === ActionType.RAISE
}

/**
 * Check if this is a passive action (call or check)
 * パッシブなアクション（コールまたはチェック）かチェック
 */
export function isPassiveAction(actionType: ActionType): boolean {
  return actionType === ActionType.CALL || actionType === ActionType.CHECK
}

/**
 * Check if player was the preflop raiser (PFR)
 * プリフロップレイザーだったかチェック
 */
export function wasPreflopRaiser(context: ActionDetailContext): boolean {
  return context.handState?.lastAggressor === context.playerId
}

/**
 * Check if this is a continuation bet opportunity
 * コンティニュエーションベットの機会かチェック
 */
export function isCBetOpportunity(context: ActionDetailContext): boolean {
  return (
    context.phase !== PhaseType.PREFLOP &&
    context.phasePlayerActionIndex === 0 &&
    wasPreflopRaiser(context)
  )
}

/**
 * Get the street name for display
 * 表示用のストリート名を取得
 */
export function getStreetName(phase: PhaseType): string {
  switch (phase) {
    case PhaseType.PREFLOP: return 'Preflop'
    case PhaseType.FLOP: return 'Flop'
    case PhaseType.TURN: return 'Turn'
    case PhaseType.RIVER: return 'River'
    case PhaseType.SHOWDOWN: return 'Showdown'
  }
}

/**
 * Check if this is the first action on a street
 * ストリートでの最初のアクションかチェック
 */
export function isFirstActionOnStreet(context: ActionDetailContext): boolean {
  return context.phasePlayerActionIndex === 0
}

/**
 * Check if player has position (acting after opponent postflop)
 * ポジションを持っているか（ポストフロップで相手の後にアクション）チェック
 * Note: This is simplified - real position calculation would need seat info
 */
export function hasPosition(context: ActionDetailContext): boolean {
  return context.phase !== PhaseType.PREFLOP && context.phasePlayerActionIndex > 0
}

/**
 * Calculate bet level (2-bet, 3-bet, etc.)
 * ベットレベル（2ベット、3ベットなど）を計算
 */
export function getBetLevel(phasePrevBetCount: number): number {
  return phasePrevBetCount + 1
}

/**
 * Common action detail patterns
 * 共通のアクションディテールパターン
 */
export const ActionPatterns = {
  /**
   * Create opportunity/occurrence pattern
   * 機会/発生のパターンを作成
   */
  createOpportunityPattern: (
    baseName: string,
    checkOpportunity: (context: ActionDetailContext) => boolean,
    checkOccurrence: (context: ActionDetailContext) => boolean
  ) => {
    return (context: ActionDetailContext): string[] => {
      const details: string[] = []
      
      if (checkOpportunity(context)) {
        details.push(`${baseName}_OPPORTUNITY`)
        
        if (checkOccurrence(context)) {
          details.push(baseName)
        }
      }
      
      return details
    }
  },

  /**
   * Create facing/response pattern (e.g., facing 3-bet and folding)
   * 対面/応答パターンを作成（例：3ベットに直面してフォールド）
   */
  createFacingPattern: (
    baseName: string,
    checkFacing: (context: ActionDetailContext) => boolean,
    responseAction: ActionType
  ) => {
    return (context: ActionDetailContext): string[] => {
      const details: string[] = []
      
      if (checkFacing(context)) {
        details.push(`${baseName}_FACING`)
        
        if (context.actionType === responseAction) {
          details.push(`${baseName}_${ActionType[responseAction]}`)
        }
      }
      
      return details
    }
  }
}