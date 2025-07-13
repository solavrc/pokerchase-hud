/**
 * ハンドログストリーム
 * APIイベントを処理し、フォーマットされたハンドログエントリをリアルタイムで出力
 * 共有フォーマットロジックにHandLogProcessorを使用
 */

import { Transform } from 'stream'
import type PokerChaseService from '../app'
import type { ApiEvent } from '../types/api'
import { ApiType } from '../types/api'
import type { ErrorContext } from '../types/errors'
import {
  HandLogEntry,
  HandLogEvent,
  DEFAULT_HAND_LOG_CONFIG
} from '../types/hand-log'
import { ErrorHandler } from '../utils/error-handler'
import { HandLogContext, HandLogProcessor } from '../utils/hand-log-processor'

type TransformCallback<T> = (error?: Error | null, data?: T) => void

// セッション終了をトリガーするイベントタイプ
const SESSION_END_EVENTS = [ApiType.EVT_SESSION_RESULTS, ApiType.RES_LEAVE_COMPLETED] as const

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
export class HandLogStream extends Transform {
  private service: PokerChaseService
  private processor: HandLogProcessor
  private completedHands: HandLogEntry[][] = []

  constructor(service: PokerChaseService) {
    super({ objectMode: true })
    this.service = service

    this.processor = new HandLogProcessor(this.createContext())
  }

  _transform(event: ApiEvent, _: string, callback: TransformCallback<HandLogEvent>) {
    // バッチモード中はハンドログ処理をスキップ
    if (this.service.batchMode) {
      callback()
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
            if (this.processor.isHandComplete()) {
              const allEntries = this.processor.getCurrentHandEntries()
              const handResultEvent = event as ApiEvent<ApiType.EVT_HAND_RESULTS>
              this.completedHands.push(allEntries)
              const maxHands = this.service.handLogConfig?.maxHands || DEFAULT_HAND_LOG_CONFIG.maxHands
              if (this.completedHands.length > maxHands) {
                this.completedHands = this.completedHands.slice(-maxHands)
              }
              this.emitHandLogEvent('update', allEntries, handResultEvent.HandId)
              // Reset only hand-specific state, preserving session state
              this.processor.resetHandState()
            }
            break
          }
        }
      }
      callback()
    } catch (error: unknown) {
      this.handleError(error, callback)
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
  private handleError(error: unknown, callback: TransformCallback<HandLogEvent>) {
    const context: ErrorContext = {
      streamName: 'HandLogStream',
      currentHandId: this.processor.isHandComplete() ? undefined : 'incomplete',
      entriesCount: this.processor.getCurrentHandEntries().length || 0
    }

    const errorCallback = ErrorHandler.createStreamErrorCallback(
      callback,
      'HandLogStream',
      context
    )
    errorCallback(error)
  }
}
