import type PokerChaseService from '../services/poker-chase-service'
import type { PokerChaseDB } from '../db/poker-chase-db'
import { ApiType, BattleType } from '../types'
import {
  EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY,
  REPLAY_FETCH_BATCH_LIMIT,
  REPLAY_PORT_FETCH,
  REPLAY_PORT_RESULT,
  errorMessage,
  isPositiveHandId,
  sanitizeReplayDetail,
  type ExperimentalReplayRecord,
  type ReplayFetchResult
} from '../replay/protocol'

type ApiLikeMessage = Record<string, unknown> & { ApiTypeId?: unknown, timestamp?: unknown }

interface ActiveReplaySession {
  key: string
  id?: string
  battleType?: BattleType
  name?: string
}

/**
 * Experimental, opt-in replay acquisition coordinator.
 *
 * EVT_HAND_RESULTS contributes only HandId while a game is active. The
 * matching replay/detail requests are released after the session boundary so
 * normal gameplay traffic is never delayed by HTTP acquisition.
 */
export class ExperimentalReplayImporter {
  private enabled = false
  private readonly activeSessions = new Map<object, ActiveReplaySession>()
  private readonly defaultSource = {}
  private readonly ports = new Set<chrome.runtime.Port>()
  private readonly inFlight = new Map<string, Set<number>>()
  private operationQueue: Promise<void> = Promise.resolve()
  private flushQueue: Promise<void> = Promise.resolve()
  readonly ready: Promise<void>

  constructor(private readonly db: PokerChaseDB, private readonly service: PokerChaseService) {
    this.ready = this.restoreEnabled()
    chrome.storage?.onChanged?.addListener((changes, areaName) => {
      const change = changes[EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY]
      if (areaName !== 'local' || !change) return
      this.enabled = change.newValue === true
      if (this.enabled) this.flushReady().catch(this.logError('flush after enable'))
    })
  }

  attachPort(port: chrome.runtime.Port): void {
    this.ports.add(port)
    this.ready
      .then(() => this.flushReady(port))
      .catch(this.logError('flush after port connect'))
  }

  detachPort(port: chrome.runtime.Port): void {
    this.ports.delete(port)
  }

  /** Test/diagnostic drain point for the importer's own serialized queue. */
  async whenIdle(): Promise<void> {
    await this.operationQueue
    await this.flushQueue
  }

  /** Enqueue lifecycle work immediately so event arrival order is preserved. */
  observeApiEvent(message: ApiLikeMessage, source: object = this.defaultSource): Promise<void> {
    const task = this.operationQueue.then(async () => {
      await this.ready
      if (!this.enabled) return

      switch (message.ApiTypeId) {
        case ApiType.EVT_ENTRY_QUEUED:
          await this.startSession(message, source)
          break
        case ApiType.EVT_HAND_RESULTS:
          await this.queueHand(message, source)
          break
        case ApiType.EVT_SESSION_DETAILS:
          this.updateSessionName(message, source)
          break
        case ApiType.EVT_SESSION_RESULTS:
          await this.finishActiveSession(source, source as chrome.runtime.Port)
          break
      }
    })
    this.operationQueue = task.catch(this.logError('lifecycle event'))
    return task
  }

  /** Returns true when the message belongs to this experimental protocol. */
  handlePortMessage(message: unknown): boolean {
    if (!this.isReplayResult(message)) return false
    const task = this.operationQueue.then(async () => {
      await this.ready
      if (!this.enabled) return
      await this.storeResults(message)
    })
    this.operationQueue = task.catch(this.logError('replay result'))
    return true
  }

  private async restoreEnabled(): Promise<void> {
    try {
      const stored = await chrome.storage.local.get(EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY)
      this.enabled = stored[EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY] === true
    } catch (error) {
      console.warn('[experimental-replay] Failed to read feature flag; keeping disabled:', error)
      this.enabled = false
    }
  }

  private async startSession(message: ApiLikeMessage, source: object): Promise<void> {
    const id = typeof message.Id === 'string' ? message.Id : undefined
    const battleType = typeof message.BattleType === 'number' ? message.BattleType as BattleType : undefined

    // MTT table moves issue another 201 with the same tournament id. They do
    // not end the tournament session and must not release a partial batch.
    const activeSession = this.activeSessions.get(source)
    const sameMtt = activeSession?.battleType === BattleType.TOURNAMENT &&
      battleType === BattleType.TOURNAMENT && activeSession.id === id
    if (sameMtt) return

    if (activeSession) await this.finishActiveSession(source, source as chrome.runtime.Port)
    const timestamp = typeof message.timestamp === 'number' ? message.timestamp : Date.now()
    this.activeSessions.set(source, {
      key: `${timestamp}:${id ?? 'unknown'}`,
      id,
      battleType
    })
  }

  private updateSessionName(message: ApiLikeMessage, source: object): void {
    const session = this.activeSessions.get(source)
    if (session && typeof message.Name === 'string') session.name = message.Name
  }

  private ensureActiveSession(message: ApiLikeMessage, source: object): ActiveReplaySession {
    const activeSession = this.activeSessions.get(source)
    if (activeSession) return activeSession
    const timestamp = typeof message.timestamp === 'number' ? message.timestamp : Date.now()
    const recovered = {
      key: `${timestamp}:${this.service.session.id ?? 'recovered'}`,
      id: this.service.session.id,
      battleType: this.service.session.battleType,
      name: this.service.session.name
    }
    this.activeSessions.set(source, recovered)
    return recovered
  }

  private async queueHand(message: ApiLikeMessage, source: object): Promise<void> {
    if (!isPositiveHandId(message.HandId)) return
    const session = this.ensureActiveSession(message, source)
    const now = Date.now()
    const existing = await this.db.experimentalReplayHands.get(message.HandId)
    if (existing?.status === 'complete') return

    const record: ExperimentalReplayRecord = {
      handId: message.HandId,
      sessionKey: session.key,
      sessionId: session.id,
      battleType: session.battleType,
      sessionName: session.name ?? this.service.session.name,
      status: 'pending',
      queuedAt: existing?.queuedAt ?? now,
      updatedAt: now,
      attempts: existing?.attempts ?? 0,
      lastAttemptAt: existing?.lastAttemptAt,
      lastError: existing?.lastError
    }
    await this.db.experimentalReplayHands.put(record)
  }

  private async finishActiveSession(source: object, preferredPort?: chrome.runtime.Port): Promise<void> {
    const session = this.activeSessions.get(source)
    if (!session) return
    const rows = await this.db.experimentalReplayHands.where('sessionKey').equals(session.key).toArray()
    const now = Date.now()
    await this.db.experimentalReplayHands.bulkPut(rows
      .filter(row => row.status === 'pending')
      .map(row => ({ ...row, status: 'ready' as const, updatedAt: now })))
    this.activeSessions.delete(source)
    await this.flushReady(this.ports.has(preferredPort!) ? preferredPort : undefined)
  }

  private flushReady(preferredPort?: chrome.runtime.Port, excludedHandIds = new Set<number>()): Promise<void> {
    const task = this.flushQueue.then(() => this.performFlush(preferredPort, excludedHandIds))
    this.flushQueue = task.catch(this.logError('ready queue flush'))
    return task
  }

  private async performFlush(preferredPort?: chrome.runtime.Port, excludedHandIds = new Set<number>()): Promise<void> {
    await this.ready
    if (!this.enabled || this.ports.size === 0) return
    const port = preferredPort && this.ports.has(preferredPort)
      ? preferredPort
      : this.ports.values().next().value as chrome.runtime.Port | undefined
    if (!port) return

    const alreadyInFlight = new Set(Array.from(this.inFlight.values()).flatMap(ids => Array.from(ids)))
    const readyRows = await this.db.experimentalReplayHands.where('status').equals('ready').toArray()
    const handIds = readyRows
      .map(row => row.handId)
      .filter(id => !alreadyInFlight.has(id) && !excludedHandIds.has(id))
      .slice(0, REPLAY_FETCH_BATCH_LIMIT)
    if (handIds.length === 0) return

    const requestId = crypto.randomUUID()
    this.inFlight.set(requestId, new Set(handIds))
    const now = Date.now()
    await this.db.experimentalReplayHands.bulkPut(readyRows
      .filter(row => handIds.includes(row.handId))
      .map(row => ({ ...row, attempts: row.attempts + 1, lastAttemptAt: now, updatedAt: now })))
    try {
      port.postMessage({ type: REPLAY_PORT_FETCH, requestId, handIds })
    } catch (error) {
      this.inFlight.delete(requestId)
      console.warn('[experimental-replay] Failed to dispatch replay request:', error)
    }
  }

  private async storeResults(message: ReplayFetchResult): Promise<void> {
    const expected = this.inFlight.get(message.requestId)
    if (!expected) return
    this.inFlight.delete(message.requestId)
    const now = Date.now()
    let successes = 0
    const failedHandIds = new Set<number>()

    for (const result of message.results) {
      if (!expected.has(result.handId)) continue
      const row = await this.db.experimentalReplayHands.get(result.handId)
      if (!row || row.status === 'complete') continue
      if (result.ok) {
        successes += 1
        await this.db.experimentalReplayHands.put({
          ...row,
          status: 'complete',
          detail: sanitizeReplayDetail(result.detail),
          capturedAt: now,
          updatedAt: now,
          lastError: undefined
        })
      } else {
        failedHandIds.add(result.handId)
        await this.db.experimentalReplayHands.put({
          ...row,
          status: result.retryable ? 'ready' : 'failed',
          updatedAt: now,
          lastError: result.error
        })
      }
    }
    // Continue draining sessions larger than one batch, but do not create a
    // tight loop when the page lacks an auth envelope or the server is down.
    if (successes > 0) await this.flushReady(undefined, failedHandIds)
  }

  private isReplayResult(message: unknown): message is ReplayFetchResult {
    if (typeof message !== 'object' || message === null) return false
    const candidate = message as Partial<ReplayFetchResult>
    return candidate.type === REPLAY_PORT_RESULT &&
      typeof candidate.requestId === 'string' &&
      Array.isArray(candidate.results) &&
      candidate.results.length <= REPLAY_FETCH_BATCH_LIMIT &&
      candidate.results.every(result => {
        if (typeof result !== 'object' || result === null || !isPositiveHandId(result.handId) ||
          typeof result.ok !== 'boolean') return false
        return result.ok || (typeof result.error === 'string' && typeof result.retryable === 'boolean')
      })
  }

  private logError(context: string): (error: unknown) => void {
    return error => console.error(`[experimental-replay] ${context} failed: ${errorMessage(error)}`)
  }
}
