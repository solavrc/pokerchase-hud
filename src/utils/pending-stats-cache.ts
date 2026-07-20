import type { StatsData } from '../content_script'

/**
 * Handoff cache for a `latestStats` delivery that arrives before App.tsx's
 * mount effect has registered its `POKER_CHASE_SERVICE_EVENT` window
 * listener.
 *
 * content_script.ts's `chrome.runtime.onMessage` listener is registered at
 * module load, before `mountApp()` even runs, so it always receives the
 * background's response -- but it can only hand that response to App by
 * dispatching a window `CustomEvent`, and `window.dispatchEvent` is
 * fire-and-forget: if App hasn't run its mount effect yet (React flushes
 * effects asynchronously after the initial commit), there is no listener
 * to catch it and the event is lost. This is most likely on a warm Service
 * Worker with a small local DB, where the pre-game hero stats fallback
 * (`requestLatestStats` with `preGame: true`, sent right after
 * `createRoot(...).render(...)` in `mountApp()`) can resolve and be
 * dispatched before that render has even committed.
 *
 * content_script.ts stores every `latestStats` delivery here (in addition
 * to dispatching the window event as before); App's mount effect consumes
 * (and clears) it once it has registered its listener, so a pre-mount
 * arrival is replayed instead of silently dropped. This lives in its own
 * module -- rather than being exported straight from content_script.ts --
 * so that importing it (a plain value import, needed for App to call
 * `consumePendingStats()`) never pulls in content_script.ts's top-level
 * side effects (port connection, WebSocket hook injection, `mountApp()`)
 * into contexts that only need the cache, e.g. App.tsx's unit tests.
 */

let pendingStats: StatsData | undefined

/** Called by content_script.ts every time it delivers a `latestStats` message. */
export const setPendingStats = (data: StatsData): void => {
  pendingStats = data
}

/**
 * Called once by App's mount effect, right after it registers its window
 * listener. Clears the cache on read so a later remount (e.g. React Strict
 * Mode's dev double-invoke, or a test re-rendering App) doesn't replay a
 * stale delivery.
 */
export const consumePendingStats = (): StatsData | undefined => {
  const data = pendingStats
  pendingStats = undefined
  return data
}
