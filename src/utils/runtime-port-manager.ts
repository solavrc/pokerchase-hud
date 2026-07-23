interface RuntimePortManagerOptions {
  connect: () => chrome.runtime.Port
  reconnectDelayMs: number
  maxQueueSize: number
  onConnected?: (port: chrome.runtime.Port) => void
  onDisconnected?: () => void
  onMessage?: (message: unknown) => void
  onSendError?: (error: unknown) => void
  onFatalError?: (error: unknown) => void
}

export class RuntimePortQueueOverflowError extends Error {
  constructor(readonly maxQueueSize: number) {
    super(`Runtime Port retry queue reached its limit of ${maxQueueSize} messages.`)
    this.name = 'RuntimePortQueueOverflowError'
  }
}

const isExtensionContextInvalidated = (error: unknown): boolean =>
  error instanceof Error && error.message === 'Extension context invalidated.'

/**
 * Owns a runtime Port across service-worker restarts.
 *
 * Captured events are queued in arrival order. A synchronous postMessage()
 * failure leaves the head event in place, reconnects, and retries that same
 * event before later arrivals. A disconnect observed during postMessage() is
 * ambiguous, so the head is retained and may be delivered twice; Raw Event
 * Lake identity deduplication makes that preferable to a permanent gap.
 */
export class RuntimePortManager {
  private activePort: chrome.runtime.Port | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly queue: unknown[] = []
  private isFlushing = false
  private fatal = false

  constructor(private readonly options: RuntimePortManagerOptions) {
    if (!Number.isInteger(options.maxQueueSize) || options.maxQueueSize <= 0) {
      throw new RangeError('maxQueueSize must be a positive integer.')
    }
  }

  get port(): chrome.runtime.Port | null {
    return this.activePort
  }

  connect(): chrome.runtime.Port | null {
    if (this.fatal) return null
    if (this.activePort) return this.activePort

    this.clearReconnectTimer()

    try {
      const port = this.options.connect()
      this.activePort = port

      port.onMessage.addListener(message => this.options.onMessage?.(message))
      port.onDisconnect.addListener(() => this.handleDisconnect(port))
      this.options.onConnected?.(port)
      this.flushQueue()
      return port
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        this.failPermanently(error)
      } else {
        this.scheduleReconnect()
      }
      return null
    }
  }

  /**
   * Returns true once the message has either been posted or accepted into the
   * bounded retry queue. False means the manager cannot preserve delivery and
   * the caller must take its fatal recovery path (normally a page reload).
   */
  send(message: unknown): boolean {
    if (this.fatal) return false

    if (this.queue.length >= this.options.maxQueueSize) {
      this.failPermanently(new RuntimePortQueueOverflowError(this.options.maxQueueSize))
      return false
    }

    this.queue.push(message)
    this.flushQueue()
    return !this.fatal
  }

  disconnect(): void {
    this.clearReconnectTimer()
    this.queue.length = 0

    const port = this.activePort
    this.activePort = null
    if (port) port.disconnect()
  }

  private flushQueue(): void {
    if (this.isFlushing || this.fatal) return

    this.isFlushing = true
    try {
      while (this.queue.length > 0) {
        if (!this.activePort) {
          // A failed attempt already owns the next retry. Further arrivals
          // append to the queue without turning a burst into a connect storm.
          if (this.reconnectTimer) return
          if (!this.connect()) return
        }

        const port = this.activePort
        if (!port) return

        try {
          port.postMessage(this.queue[0])

          // onDisconnect can race synchronously with postMessage in tests and
          // browser implementations. Delivery is then ambiguous: retain the
          // head for at-least-once retry instead of creating a silent gap.
          if (this.activePort !== port) return

          this.queue.shift()
        } catch (error) {
          this.handleDisconnect(port)
          this.options.onSendError?.(error)

          if (isExtensionContextInvalidated(error)) {
            this.failPermanently(error)
          }
          return
        }
      }
    } finally {
      this.isFlushing = false
    }
  }

  private handleDisconnect(port: chrome.runtime.Port): void {
    if (this.activePort !== port) return

    this.activePort = null
    this.options.onDisconnected?.()
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.fatal) return

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, this.options.reconnectDelayMs)
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private failPermanently(error: unknown): void {
    if (this.fatal) return

    this.fatal = true
    this.clearReconnectTimer()
    this.activePort = null
    this.queue.length = 0
    this.options.onFatalError?.(error)
  }
}
