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

const ACTIVE_REPLAY_SESSION_META_PREFIX = 'experimentalReplayActiveSession:'

interface ActiveReplaySession {
  key: string
  id?: string
  battleType?: BattleType
  name?: string
  detailsSeen: boolean
}

interface InFlightReplayRequest {
  handIds: Set<number>
  port: chrome.runtime.Port
  sourceKey: string
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
  private readonly activeSessions = new Map<string, ActiveReplaySession>()
  private readonly defaultSource = 'default'
  private readonly ports = new Set<chrome.runtime.Port>()
  private readonly portSources = new WeakMap<chrome.runtime.Port, string>()
  private readonly ephemeralPortSources = new WeakMap<chrome.runtime.Port, string>()
  private ephemeralPortSequence = 0
  private readonly inFlight = new Map<string, InFlightReplayRequest>()
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
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
      else {
        this.inFlight.clear()
        for (const timer of this.retryTimers.values()) clearTimeout(timer)
        this.retryTimers.clear()
      }
    })
  }

  attachPort(port: chrome.runtime.Port): void {
    this.ports.add(port)
    this.portSources.set(port, this.sourceKeyForPort(port))
    this.ready
      .then(() => this.flushReady(port))
      .catch(this.logError('flush after port connect'))
  }

  detachPort(port: chrome.runtime.Port): void {
    this.ports.delete(port)
    const sourceKey = this.portSources.get(port)
    for (const [requestId, request] of this.inFlight) {
      if (request.port === port) this.inFlight.delete(requestId)
    }
    if (sourceKey) {
      const timer = this.retryTimers.get(sourceKey)
      if (timer) clearTimeout(timer)
      this.retryTimers.delete(sourceKey)
    }
  }

  /** Test/diagnostic drain point for the importer's own serialized queue. */
  async whenIdle(): Promise<void> {
    await this.operationQueue
    await this.flushQueue
  }

  /** Enqueue lifecycle work immediately so event arrival order is preserved. */
  observePortEvent(message: ApiLikeMessage, port: chrome.runtime.Port): Promise<void> {
    return this.observeApiEvent(message, this.sourceKeyForPort(port), port)
  }

  observeApiEvent(
    message: ApiLikeMessage,
    sourceKey: string = this.defaultSource,
    preferredPort?: chrome.runtime.Port
  ): Promise<void> {
    const task = this.operationQueue.then(async () => {
      await this.ready
      if (!this.enabled) return

      switch (message.ApiTypeId) {
        case ApiType.EVT_ENTRY_QUEUED:
          await this.startSession(message, sourceKey, preferredPort)
          break
        case ApiType.EVT_HAND_RESULTS:
          await this.queueHand(message, sourceKey)
          break
        case ApiType.EVT_SESSION_DETAILS:
          await this.updateSessionDetails(message, sourceKey, preferredPort)
          break
        case ApiType.EVT_SESSION_RESULTS:
          await this.finishActiveSession(sourceKey, preferredPort)
          break
      }
    })
    this.operationQueue = task.catch(this.logError('lifecycle event'))
    return task
  }

  /** Returns true when the message belongs to this experimental protocol. */
  handlePortMessage(message: unknown, port: chrome.runtime.Port): boolean {
    if (!this.isReplayResult(message)) return false
    const task = this.operationQueue.then(async () => {
      await this.ready
      if (!this.enabled) return
      await this.storeResults(message, port)
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

  private async startSession(
    message: ApiLikeMessage,
    sourceKey: string,
    preferredPort?: chrome.runtime.Port
  ): Promise<void> {
    const id = typeof message.Id === 'string' ? message.Id : undefined
    const battleType = typeof message.BattleType === 'number' ? message.BattleType as BattleType : undefined

    // MTT table moves issue another 201 with the same tournament id. They do
    // not end the tournament session and must not release a partial batch.
    const activeSession = await this.activeSessionFor(sourceKey)
    const sameMtt = activeSession?.battleType === BattleType.TOURNAMENT &&
      battleType === BattleType.TOURNAMENT && activeSession.id === id
    if (sameMtt) return

    // A new non-MTT 201 is also the fallback boundary for durable pending rows
    // left behind by a service-worker restart.
    await this.finishActiveSession(sourceKey, preferredPort)
    const timestamp = typeof message.timestamp === 'number' ? message.timestamp : Date.now()
    await this.persistActiveSession(sourceKey, {
      key: `${sourceKey}:${timestamp}:${id ?? 'unknown'}`,
      id,
      battleType,
      detailsSeen: false
    })
  }

  private async updateSessionDetails(
    message: ApiLikeMessage,
    sourceKey: string,
    preferredPort?: chrome.runtime.Port
  ): Promise<void> {
    let session = await this.activeSessionFor(sourceKey)
    const name = typeof message.Name === 'string' ? message.Name : undefined
    if (session?.detailsSeen && session.battleType !== BattleType.TOURNAMENT) {
      await this.finishActiveSession(sourceKey, preferredPort)
      session = undefined
    }
    if (!session) {
      const timestamp = typeof message.timestamp === 'number' ? message.timestamp : Date.now()
      session = {
        key: `${sourceKey}:${timestamp}:${this.service.session.id ?? 'recovered'}`,
        id: this.service.session.id,
        battleType: this.service.session.battleType,
        name,
        detailsSeen: true
      }
      await this.persistActiveSession(sourceKey, session)
    } else {
      session = { ...session, detailsSeen: true }
      if (name) session.name = name
      await this.persistActiveSession(sourceKey, session)
    }
  }

  private async ensureActiveSession(message: ApiLikeMessage, sourceKey: string): Promise<ActiveReplaySession> {
    const activeSession = await this.activeSessionFor(sourceKey)
    if (activeSession) return activeSession
    const timestamp = typeof message.timestamp === 'number' ? message.timestamp : Date.now()
    const recovered = {
      key: `${sourceKey}:${timestamp}:${this.service.session.id ?? 'recovered'}`,
      id: this.service.session.id,
      battleType: this.service.session.battleType,
      name: this.service.session.name,
      detailsSeen: false
    }
    await this.persistActiveSession(sourceKey, recovered)
    return recovered
  }

  private async queueHand(message: ApiLikeMessage, sourceKey: string): Promise<void> {
    if (!isPositiveHandId(message.HandId)) return
    const session = await this.ensureActiveSession(message, sourceKey)
    const now = Date.now()
    const existing = await this.db.experimentalReplayHands.get(message.HandId)
    if (existing?.status === 'complete') return

    const record: ExperimentalReplayRecord = {
      handId: message.HandId,
      sourceKey,
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

  private async finishActiveSession(sourceKey: string, preferredPort?: chrome.runtime.Port): Promise<void> {
    // Pending rows are the durable source of truth. Querying by source also
    // recovers a session whose in-memory coordinator was lost in an MV3
    // service-worker restart before its boundary arrived.
    const rows = await this.db.experimentalReplayHands
      .where('[status+sourceKey]')
      .equals(['pending', sourceKey])
      .toArray()
    const now = Date.now()
    await this.db.experimentalReplayHands.bulkPut(rows
      .map(row => ({ ...row, status: 'ready' as const, updatedAt: now })))
    this.activeSessions.delete(sourceKey)
    await this.db.meta.delete(this.activeSessionMetaKey(sourceKey))
    const connectedPort = preferredPort && this.ports.has(preferredPort) &&
      this.sourceKeyForPort(preferredPort) === sourceKey
      ? preferredPort
      : this.connectedPortForSource(sourceKey)
    await this.flushReady(connectedPort)
  }

  private activeSessionMetaKey(sourceKey: string): string {
    return `${ACTIVE_REPLAY_SESSION_META_PREFIX}${sourceKey}`
  }

  private async activeSessionFor(sourceKey: string): Promise<ActiveReplaySession | undefined> {
    const cached = this.activeSessions.get(sourceKey)
    if (cached) return cached
    const value = (await this.db.meta.get(this.activeSessionMetaKey(sourceKey)))?.value
    if (typeof value !== 'object' || value === null) return undefined
    const candidate = value as Partial<ActiveReplaySession>
    if (typeof candidate.key !== 'string' || typeof candidate.detailsSeen !== 'boolean') return undefined
    const session: ActiveReplaySession = {
      key: candidate.key,
      detailsSeen: candidate.detailsSeen,
      ...(typeof candidate.id === 'string' ? { id: candidate.id } : {}),
      ...(typeof candidate.battleType === 'number' ? { battleType: candidate.battleType } : {}),
      ...(typeof candidate.name === 'string' ? { name: candidate.name } : {})
    }
    this.activeSessions.set(sourceKey, session)
    return session
  }

  private async persistActiveSession(sourceKey: string, session: ActiveReplaySession): Promise<void> {
    await this.db.meta.put({
      id: this.activeSessionMetaKey(sourceKey),
      value: session,
      updatedAt: Date.now()
    })
    this.activeSessions.set(sourceKey, session)
  }

  private flushReady(preferredPort?: chrome.runtime.Port, excludedHandIds = new Set<number>()): Promise<void> {
    const task = this.flushQueue.then(async () => {
      if (preferredPort) {
        await this.performFlush(preferredPort, excludedHandIds)
        return
      }
      for (const port of this.ports) await this.performFlush(port, excludedHandIds)
    })
    this.flushQueue = task.catch(this.logError('ready queue flush'))
    return task
  }

  private async performFlush(preferredPort?: chrome.runtime.Port, excludedHandIds = new Set<number>()): Promise<void> {
    await this.ready
    if (!this.enabled || !preferredPort || !this.ports.has(preferredPort)) return
    const port = preferredPort
    const sourceKey = this.sourceKeyForPort(port)

    const alreadyInFlight = new Set(Array.from(this.inFlight.values()).flatMap(request => Array.from(request.handIds)))
    const readyRows = await this.db.experimentalReplayHands
      .where('[status+sourceKey]')
      .equals(['ready', sourceKey])
      .toArray()
    const handIds = readyRows
      .map(row => row.handId)
      .filter(id => !alreadyInFlight.has(id) && !excludedHandIds.has(id))
      .slice(0, REPLAY_FETCH_BATCH_LIMIT)
    if (handIds.length === 0) return

    const requestId = crypto.randomUUID()
    this.inFlight.set(requestId, { handIds: new Set(handIds), port, sourceKey })
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

  private async storeResults(message: ReplayFetchResult, port: chrome.runtime.Port): Promise<void> {
    const expected = this.inFlight.get(message.requestId)
    if (!expected || expected.port !== port) return
    this.inFlight.delete(message.requestId)
    const now = Date.now()
    let successes = 0
    const failedHandIds = new Set<number>()
    const retryableHandIds = new Set<number>()
    const seenHandIds = new Set<number>()

    for (const result of message.results) {
      if (!expected.handIds.has(result.handId)) continue
      // A successful item without a payload is not a success. Leave it unseen
      // so the missing-result recovery below returns the durable row to ready.
      if (result.ok && (!('detail' in result) || result.detail === undefined)) continue
      seenHandIds.add(result.handId)
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
        if (result.retryable) retryableHandIds.add(result.handId)
        await this.db.experimentalReplayHands.put({
          ...row,
          status: result.retryable ? 'ready' : 'failed',
          updatedAt: now,
          lastError: result.error
        })
      }
    }
    for (const handId of expected.handIds) {
      if (seenHandIds.has(handId)) continue
      const row = await this.db.experimentalReplayHands.get(handId)
      if (!row || row.status === 'complete') continue
      failedHandIds.add(handId)
      retryableHandIds.add(handId)
      await this.db.experimentalReplayHands.put({
        ...row,
        status: 'ready',
        updatedAt: now,
        lastError: 'missing-result'
      })
    }
    // Continue draining sessions larger than one batch, but do not create a
    // tight loop when the page lacks an auth envelope or the server is down.
    if (successes > 0) await this.flushReady(expected.port, failedHandIds)
    if (retryableHandIds.size > 0) await this.scheduleRetry(expected.sourceKey, expected.port, retryableHandIds)
  }

  private async scheduleRetry(
    sourceKey: string,
    port: chrome.runtime.Port,
    handIds: Set<number>
  ): Promise<void> {
    if (this.retryTimers.has(sourceKey) || !this.ports.has(port)) return
    const rows = await this.db.experimentalReplayHands.bulkGet(Array.from(handIds))
    const maxAttempts = Math.max(1, ...rows.map(row => row?.attempts ?? 1))
    const delayMs = Math.min(60_000, 1000 * (2 ** Math.min(maxAttempts, 6)))
    const timer = setTimeout(() => {
      this.retryTimers.delete(sourceKey)
      this.flushReady(port).catch(this.logError('retry flush'))
    }, delayMs)
    this.retryTimers.set(sourceKey, timer)
  }

  private connectedPortForSource(sourceKey: string): chrome.runtime.Port | undefined {
    for (const port of this.ports) {
      if (this.sourceKeyForPort(port) === sourceKey) return port
    }
    return undefined
  }

  private sourceKeyForPort(port: chrome.runtime.Port): string {
    const cached = this.portSources.get(port)
    if (cached) return cached
    const tabId = port.sender?.tab?.id
    if (typeof tabId === 'number') {
      const sourceKey = `tab:${tabId}:frame:${port.sender?.frameId ?? 0}`
      this.portSources.set(port, sourceKey)
      return sourceKey
    }
    let sourceKey = this.ephemeralPortSources.get(port)
    if (!sourceKey) {
      sourceKey = `ephemeral:${++this.ephemeralPortSequence}`
      this.ephemeralPortSources.set(port, sourceKey)
    }
    this.portSources.set(port, sourceKey)
    return sourceKey
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
