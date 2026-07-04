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

  constructor(service: PokerChaseService) {
    super()
    this.service = service

    this.processor = new HandLogProcessor(this.createContext())
  }

  protected async transform(event: ApiEvent): Promise<void> {
    // バッチモード中はハンドログ処理をスキップ
    if (this.service.batchMode) {
      return
    }
    try {
      const newEntries = this.processor.processSingleEvent(event)
      if (SESSION_END_EVENTS.includes(event.ApiTypeId as any)) {
        this.handleSessionEnd()
      } else {
        switch (event.ApiTypeId) {
          case ApiType.EVT_DEAL:
          case ApiType.EVT_ACTION:
          case ApiType.EVT_DEAL_ROUND:
            if (newEntries.length > 0) {
              this.emitHandLogEvent('add', newEntries)
            }
            break
          case ApiType.EVT_HAND_RESULTS: {
            if (this.processor.isHandComplete() && isApiEventType(event, ApiType.EVT_HAND_RESULTS)) {
              const allEntries = this.processor.getCurrentHandEntries()
              this.completedHands.push(allEntries)
              const maxHands = this.service.handLogConfig?.maxHands || DEFAULT_HAND_LOG_CONFIG.maxHands
              if (this.completedHands.length > maxHands) {
                this.completedHands = this.completedHands.slice(-maxHands)
              }
              this.emitHandLogEvent('update', allEntries, event.HandId)
              // Reset only hand-specific state, preserving session state
              this.processor.resetHandState()
            }
            break
          }
        }
      }
    } catch (error: unknown) {
      this.handleError(error)
    }
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
  private handleSessionEnd() {
    // セッションが終了した場合、未完了のハンドのみクリア
    if (!this.processor.isHandComplete()) {
      const incompleteEntries = this.processor.getCurrentHandEntries()
      
      // 未完了のハンドがある場合
      if (incompleteEntries.length > 0) {
        // プロセッサーをリセット
        this.processor = new HandLogProcessor(this.createContext())
        
        // 未完了のハンドのみを削除するイベントを発行
        // handIdがundefinedのエントリを削除するように指示
        this.emitHandLogEvent('removeIncomplete')
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
