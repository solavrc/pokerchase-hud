interface RuntimePortManagerOptions {
  connect: () => chrome.runtime.Port
  reconnectDelayMs: number
  onConnected?: (port: chrome.runtime.Port) => void
  onDisconnected?: () => void
  onMessage?: (message: unknown) => void
  onSendError?: (error: unknown) => void
}

/**
 * Owns a runtime Port across service-worker restarts.
 *
 * The manager, rather than a caller-local callback, stores every replacement
 * Port so future messages never keep targeting a disconnected instance.
 */
export class RuntimePortManager {
  private activePort: chrome.runtime.Port | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: RuntimePortManagerOptions) {}

  get port(): chrome.runtime.Port | null {
    return this.activePort
  }

  connect(): chrome.runtime.Port | null {
    if (this.activePort) return this.activePort

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    try {
      const port = this.options.connect()
      this.activePort = port

      port.onMessage.addListener(message => this.options.onMessage?.(message))
      port.onDisconnect.addListener(() => this.handleDisconnect(port))
      this.options.onConnected?.(port)
      return port
    } catch {
      this.scheduleReconnect()
      return null
    }
  }

  send(message: unknown): boolean {
    const port = this.activePort ?? this.connect()
    if (!port) return false

    try {
      port.postMessage(message)
      return true
    } catch (error) {
      this.handleDisconnect(port)
      this.options.onSendError?.(error)
      return false
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    const port = this.activePort
    this.activePort = null
    if (port) port.disconnect()
  }

  private handleDisconnect(port: chrome.runtime.Port): void {
    if (this.activePort !== port) return

    this.activePort = null
    this.options.onDisconnected?.()
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, this.options.reconnectDelayMs)
  }
}
