/**
 * Wraps chrome.runtime.sendMessage with a timeout so popup UI never hangs
 * forever waiting on a busy/unresponsive MV3 service worker.
 *
 * Background: before #124, a multi-second synchronous JSON.parse in the
 * legacy sync path re-ran on every service-worker wake, so popup widgets
 * that awaited a plain callback-style sendMessage() could hang indefinitely
 * with no feedback ("popup won't open / frozen" reports). This helper
 * bounds that wait and always resolves.
 *
 * Resolves `undefined` if the service worker never responds within
 * `timeoutMs`, or if chrome.runtime.lastError is set (e.g. extension
 * context invalidated / no receiving end). Callers MUST treat `undefined`
 * as "unknown state" and fail open to a sensible default rather than
 * blocking the UI — never render an indefinite spinner while waiting on
 * this call.
 */
export function sendMessageWithTimeout<T = unknown>(
  message: unknown,
  timeoutMs = 8000
): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false

    const finish = (value: T | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    const timer = setTimeout(() => finish(undefined), timeoutMs)

    try {
      chrome.runtime.sendMessage(message, (response: T) => {
        // Reading lastError acknowledges it so Chrome doesn't log an
        // "Unchecked runtime.lastError" warning to the console.
        if (chrome.runtime.lastError) {
          finish(undefined)
          return
        }
        finish(response)
      })
    } catch {
      // Synchronous throw (e.g. extension context invalidated)
      finish(undefined)
    }
  })
}
