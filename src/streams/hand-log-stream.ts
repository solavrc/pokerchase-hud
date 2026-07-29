/**
 * ハンドログストリーム
 * APIイベントを処理し、フォーマットされたハンドログエントリをリアルタイムで出力
 * 共有フォーマットロジックにHandLogProcessorを使用
 */

import { SimpleTransform } from './simple-transform'
import type PokerChaseService from '../app'
import type { ApiEvent } from '../types/api'
import { ApiType, isApiEventType } from '../types/api'
import type { ErrorContext } from '../types/errors'
import {
  HandLogEntry,
  HandLogEvent,
  DEFAULT_HAND_LOG_CONFIG
} from '../types/hand-log'
import { ErrorHandler } from '../utils/error-handler'
import { HandLogContext, HandLogProcessor } from '../utils/hand-log-processor'
import {
  getEventSessionScope,
  type EventSessionScope,
} from '../utils/session-event-scope'

type HandLogScopeState = {
  context: HandLogContext
  players: Map<number, { name: string; rank: string }>
  processor: HandLogProcessor
}

// セッション終了をトリガーするイベントタイプ
const SESSION_END_EVENTS = [ApiType.EVT_SESSION_RESULTS] as const

/**
 * HandLogStream - リアルタイムハンドログ用の並列ストリーム
 *
 * AggregateEventsStreamからAPIイベントを受け取り、
 * PokerStarsスタイルのハンド履歴エントリとしてリアルタイムでフォーマット。
 *
 * 機能:
 * - イベント到着時にリアルタイムフォーマット
 * - ハンド完了までHandIdのプレースホルダー
 * - 設定可能なハンド数制限でメモリ効率的
 * - 並列処理（メインパイプラインに影響しない）
 * - 共有フォーマットロジックにHandLogProcessorを使用
 */
export class HandLogStream extends SimpleTransform<ApiEvent, HandLogEvent> {
  private service: PokerChaseService
  private processor: HandLogProcessor
  private completedHands: HandLogEntry[][] = []
  private readonly scopedStates = new Map<string, HandLogScopeState>()

  constructor(service: PokerChaseService) {
    super()
    this.service = service

    this.processor = new HandLogProcessor(this.createContext())
  }

  private scopeKey(scope: EventSessionScope): string {
    return scope.originId
      ? `${scope.originId}\u0000${scope.scopeKey ?? `${scope.id}@${scope.startedAt}`}`
      : scope.scopeKey ?? `${scope.id}@${scope.startedAt}`
  }

  discardSessionScope(
    scope: EventSessionScope,
    emitLiveCleanup = this.service.isAuthoritativeSessionScope(scope)
  ): void {
    const key = this.scopeKey(scope)
    const state = this.scopedStates.get(key)
    if (!state) return
    this.handleSessionEnd(state, emitLiveCleanup)
    this.scopedStates.delete(key)
  }

  protected async transform(event: ApiEvent): Promise<void> {
    // バッチモード中はハンドログ処理をスキップ
    if (this.service.batchMode) {
      return
    }
    try {
      const scoped = this.scopedStateFor(event)
      const isAuthoritative =
        this.service.isAuthoritativeSessionScope(getEventSessionScope(event))
      const processor = scoped?.state.processor ?? this.processor
      const newEntries = processor.processSingleEvent(event)
      if (SESSION_END_EVENTS.includes(event.ApiTypeId as any)) {
        this.handleSessionEnd(scoped?.state, isAuthoritative)
        if (scoped) this.scopedStates.delete(scoped.key)
      } else {
        switch (event.ApiTypeId) {
          case ApiType.EVT_DEAL:
          case ApiType.EVT_ACTION:
          case ApiType.EVT_DEAL_ROUND:
            if (isAuthoritative && newEntries.length > 0) {
              this.emitHandLogEvent('add', newEntries)
            }
            break
          case ApiType.EVT_HAND_RESULTS: {
            if (processor.isHandComplete() && isApiEventType(event, ApiType.EVT_HAND_RESULTS)) {
              const allEntries = processor.getCurrentHandEntries()
              if (isAuthoritative) {
                this.completedHands.push(allEntries)
                const maxHands = this.service.handLogConfig?.maxHands || DEFAULT_HAND_LOG_CONFIG.maxHands
                if (this.completedHands.length > maxHands) {
                  this.completedHands = this.completedHands.slice(-maxHands)
                }
                this.emitHandLogEvent('update', allEntries, event.HandId)
              }
              // Reset only hand-specific state, preserving session state
              processor.resetHandState()
            }
            break
          }
        }
      }
    } catch (error: unknown) {
      this.handleError(error)
    }
  }

  private scopedStateFor(
    event: ApiEvent
  ): { key: string; state: HandLogScopeState } | undefined {
    const scope = getEventSessionScope(event)
    if (!scope) return undefined
    const key = this.scopeKey(scope)
    let state = this.scopedStates.get(key)
    if (!state) {
      const players = new Map<number, { name: string; rank: string }>()
      const context: HandLogContext = {
        session: {
          scopeKey: scope.scopeKey,
          id: scope.id,
          battleType: scope.battleType,
          name: scope.name,
          players,
          reset: () => players.clear(),
        },
        handLogConfig: this.service.handLogConfig,
        playerId: this.service.playerId,
      }
      state = {
        context,
        players,
        processor: new HandLogProcessor(context),
      }
      this.scopedStates.set(key, state)
    }

    if (scope.name !== undefined) state.context.session.name = scope.name
    if (event.ApiTypeId === ApiType.EVT_SESSION_DETAILS) {
      state.context.session.name = event.Name
    } else if (event.ApiTypeId === ApiType.EVT_PLAYER_SEAT_ASSIGNED) {
      for (const player of event.TableUsers ?? []) {
        state.players.set(player.UserId, {
          name: player.UserName,
          rank: player.Rank.RankId,
        })
      }
    } else if (event.ApiTypeId === ApiType.EVT_PLAYER_JOIN && event.JoinUser) {
      state.players.set(event.JoinUser.UserId, {
        name: event.JoinUser.UserName,
        rank: event.JoinUser.Rank.RankId,
      })
    } else if (event.ApiTypeId === ApiType.EVT_DEAL && event.Player) {
      state.context.playerId = event.SeatUserIds[event.Player.SeatIndex]
    }
    return { key, state }
  }

  /**
   * HandLogProcessor用のコンテキストを作成
   */
  private createContext(): HandLogContext {
    return {
      session: this.service.session,
      handLogConfig: this.service.handLogConfig,
      playerId: this.service.playerId
    }
  }


  /**
   * セッション終了を処理
   */
  private handleSessionEnd(
    state: HandLogScopeState | undefined,
    emitLive: boolean
  ) {
    const processor = state?.processor ?? this.processor
    // セッションが終了した場合、未完了のハンドのみクリア
    if (!processor.isHandComplete()) {
      const incompleteEntries = processor.getCurrentHandEntries()
      
      // 未完了のハンドがある場合
      if (incompleteEntries.length > 0) {
        // プロセッサーをリセット
        if (state) {
          state.processor = new HandLogProcessor(state.context)
        } else {
          this.processor = new HandLogProcessor(this.createContext())
        }
        
        // 未完了のハンドのみを削除するイベントを発行
        // handIdがundefinedのエントリを削除するように指示
        if (emitLive) {
          this.emitHandLogEvent('removeIncomplete')
        }
      }
    }
  }

  /**
   * ハンドログイベントを出力
   */
  private emitHandLogEvent(type: 'add' | 'update' | 'clear' | 'removeIncomplete', entries?: HandLogEntry[], handId?: number) {
    const event: HandLogEvent = {
      type,
      ...(entries && { entries }),
      ...(handId && { handId })
    }
    this.push(event)
  }

  /**
   * エラーを処理
   */
  protected override handleError(error: unknown): void {
    const context: ErrorContext = {
      streamName: 'HandLogStream',
      currentHandId: this.processor.isHandComplete() ? undefined : 'incomplete',
      entriesCount: this.processor.getCurrentHandEntries().length || 0
    }

    const appError = ErrorHandler.handleStreamError(error, 'HandLogStream', context)
    if (this.listenerCount('error') > 0) {
      this.emit('error', appError)
    }
  }
}
