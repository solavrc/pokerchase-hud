/**
 * Invoke a Chrome UI API without allowing either a synchronous exception or
 * its callback-free Promise rejection to escape the Service Worker.
 *
 * Only use this for advisory UI (badges/notifications). Storage, messaging,
 * downloads, and other commit-bearing operations must keep propagating their
 * failures to their callers.
 */
export const runBestEffortChromeUi = (
  context: string,
  invoke: () => unknown,
): void => {
  try {
    void Promise.resolve(invoke()).catch(error => {
      console.warn(`[${context}] Best-effort Chrome UI call failed:`, error)
    })
  } catch (error) {
    console.warn(`[${context}] Best-effort Chrome UI call failed:`, error)
  }
}
