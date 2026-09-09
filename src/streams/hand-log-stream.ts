/**
 * ハンドログストリーム
 * APIイベントを処理し、フォーマットされたハンドログエントリをリアルタイムで出力
 * 共有フォーマットロジックにHandLogProcessorを使用
 */

import { SimpleTransform } from './simple-transform'
import type PokerChaseService from '../app'
import type { ApiEvent } from '../types/api'
import { ApiType } from '../types/api'
import type { ErrorContext } from '../types/errors'
import type { Session } from '../types'
import {
  HandLogEntry,
  HandLogEvent,
  DEFAULT_HAND_LOG_CONFIG
} from '../types/hand-log'
import { ErrorHandler } from '../utils/error-handler'
import { HandLogContext, HandLogProcessor } from '../utils/hand-log-processor'
import {
  getHandRuntimeContext,
  type CompletedHandWork,
} from '../utils/hand-session-context'

// セッション終了をトリガーするイベントタイプ
const SESSION_END_EVENTS = [ApiType.EVT_SESSION_RESULTS] as const

/** Aggregateが境界判定を終えた後にだけ渡すlive表示入力。 */
export interface HandLogAuthorityInput {
  kind: 'aggregate-authority'
  event: ApiEvent
  completedHand?: CompletedHandWork
  correctedHands?: readonly CompletedHandWork[]
}

type HandLogInput = ApiEvent | HandLogAuthorityInput

const isAuthorityInput = (input: HandLogInput): input is HandLogAuthorityInput =>
  'kind' in input && input.kind === 'aggregate-authority'

/**
 * HandLogStream - リアルタイムハンドログ用の並列ストリーム
 *
 * live経路はAggregateEventsStreamのserialized callbackだけを入口とする。
 * 既存の単体入力契約としてApiEvent直接入力も残すが、本番ingestionは使わない。
 */
export class HandLogStream extends SimpleTransform<HandLogInput, HandLogEvent> {
  private service: PokerChaseService
  private processor: HandLogProcessor
  private completedHands: HandLogEntry[][] = []
  private firstHandId?: number

  constructor(service: PokerChaseService) {
    super()
    this.service = service
    this.processor = new HandLogProcessor(this.createContext())
  }

  protected async transform(input: HandLogInput): Promise<void> {
    // バッチモード中はハンドログ処理をスキップ
    if (this.service.batchMode) return

    try {
      if (!isAuthorityInput(input)) {
        this.processLegacyEvent(input)
        return
      }

      this.processAuthorityEvent(input)
    } catch (error: unknown) {
      this.handleError(error)
    }
  }

  private processAuthorityEvent(input: HandLogAuthorityInput): void {
    const { event, completedHand, correctedHands = [] } = input

    if (SESSION_END_EVENTS.includes(event.ApiTypeId as any)) {
      this.handleSessionEnd()
      return
    }

    switch (event.ApiTypeId) {
      case ApiType.EVT_DEAL:
      case ApiType.EVT_ACTION:
      case ApiType.EVT_DEAL_ROUND: {
        const newEntries = this.processor.processSingleEvent(event)
        if (newEntries.length > 0) this.emitHandLogEvent('add', newEntries)
        break
      }
      case ApiType.EVT_HAND_RESULTS:
        if (completedHand) {
          this.renderCompletedWork(completedHand, false)
          // 完了済みworkは独立processorで描画したため、表示中processorだけを
          // 次ハンド待ちへ戻す。補正用cacheやTournament #は保持する。
          this.processor = new HandLogProcessor(this.createContext())
        }
        break
      case ApiType.EVT_PLAYER_JOIN:
        // 現在の未完了ハンドへは301を通常どおり反映する。その後、Aggregateが
        // 選んだ完了候補だけを別processorで補正し、active processorは触らない。
        this.processor.processSingleEvent(event)
        for (const corrected of correctedHands) this.renderCompletedWork(corrected, true)
        break
      default:
        // 201/308/313をprivate session/名簿へ適用する。出力行は無い。
        this.processor.processSingleEvent(event)
        break
    }
  }

  /**
   * Aggregateが固定したevents+DEAL contextから完了ハンドを毎回作り直す。
   * late 301補正で表示中ハンドのprocessorをresetしないことが主目的。
   */
  private renderCompletedWork(work: CompletedHandWork, preserveIncomplete: boolean): void {
    const deal = work.events.find(event => event.ApiTypeId === ApiType.EVT_DEAL)
    const runtime = deal ? getHandRuntimeContext(deal) : undefined
    const session: Session = runtime
      ? {
          ...runtime.session,
          players: runtime.players,
          reset: () => {},
        }
      : this.snapshotServiceSession()
    const processor = new HandLogProcessor({
      session,
      handLogConfig: this.service.handLogConfig,
      playerId: this.service.playerId,
      firstHandId: this.firstHandId,
    })
    const entries = processor.processEvents([...work.events])
    this.firstHandId = processor.getFirstHandId() ?? this.firstHandId
    if (entries.length === 0) return

    const handId = entries[0]?.handId ?? work.handId
    const previous = this.completedHands.findIndex(item => item[0]?.handId === handId)
    if (previous >= 0) this.completedHands[previous] = entries
    else this.completedHands.push(entries)

    const maxHands = this.service.handLogConfig?.maxHands || DEFAULT_HAND_LOG_CONFIG.maxHands
    if (this.completedHands.length > maxHands) {
      this.completedHands = this.completedHands.slice(-maxHands)
    }
    this.emitHandLogEvent('update', entries, handId, preserveIncomplete)
  }

  /** ApiEvent直接入力の既存契約。live ingestionでは呼ばれない。 */
  private processLegacyEvent(event: ApiEvent): void {
    const newEntries = this.processor.processSingleEvent(event)
    if (SESSION_END_EVENTS.includes(event.ApiTypeId as any)) {
      this.handleSessionEnd()
      return
    }

    switch (event.ApiTypeId) {
      case ApiType.EVT_DEAL:
      case ApiType.EVT_ACTION:
      case ApiType.EVT_DEAL_ROUND:
        if (newEntries.length > 0) this.emitHandLogEvent('add', newEntries)
        break
      case ApiType.EVT_PLAYER_JOIN:
      case ApiType.EVT_HAND_RESULTS: {
        if (this.processor.isHandComplete() && newEntries.length > 0) {
          const allEntries = this.processor.getCurrentHandEntries()
          const handId = allEntries[0]?.handId
          const previous = this.completedHands.findIndex(entries => entries[0]?.handId === handId)
          if (previous >= 0) this.completedHands[previous] = allEntries
          else this.completedHands.push(allEntries)
          const maxHands = this.service.handLogConfig?.maxHands || DEFAULT_HAND_LOG_CONFIG.maxHands
          if (this.completedHands.length > maxHands) {
            this.completedHands = this.completedHands.slice(-maxHands)
          }
          this.firstHandId = this.processor.getFirstHandId() ?? this.firstHandId
          this.emitHandLogEvent('update', allEntries, handId)
        }
        break
      }
    }
  }

  private snapshotServiceSession(): Session {
    return {
      id: this.service.session.id,
      battleType: this.service.session.battleType,
      name: this.service.session.name,
      players: new Map(
        [...this.service.session.players].map(([userId, info]) => [userId, { ...info }])
      ),
      reset: () => {},
    }
  }

  /** HandLogProcessor用のprivate contextを作成。 */
  private createContext(): HandLogContext {
    return {
      session: this.snapshotServiceSession(),
      handLogConfig: this.service.handLogConfig,
      playerId: this.service.playerId,
      firstHandId: this.firstHandId,
    }
  }

  /** セッション終了時に未完了ハンドだけを破棄する。 */
  private handleSessionEnd(): void {
    if (!this.processor.isHandComplete()) {
      const incompleteEntries = this.processor.getCurrentHandEntries()
      if (incompleteEntries.length > 0) {
        this.processor = new HandLogProcessor(this.createContext())
        this.emitHandLogEvent('removeIncomplete')
      }
    }
  }

  private emitHandLogEvent(
    type: 'add' | 'update' | 'clear' | 'removeIncomplete',
    entries?: HandLogEntry[],
    handId?: number,
    preserveIncomplete?: boolean
  ): void {
    const event: HandLogEvent = {
      type,
      ...(entries && { entries }),
      ...(handId !== undefined && { handId }),
      ...(preserveIncomplete && { preserveIncomplete: true }),
    }
    this.push(event)
  }

  protected override handleError(error: unknown): void {
    const context: ErrorContext = {
      streamName: 'HandLogStream',
      currentHandId: this.processor.isHandComplete() ? undefined : 'incomplete',
      entriesCount: this.processor.getCurrentHandEntries().length || 0
    }

    const appError = ErrorHandler.handleStreamError(error, 'HandLogStream', context)
    if (this.listenerCount('error') > 0) this.emit('error', appError)
  }
}
