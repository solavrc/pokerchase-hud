/**
 * Capture script for the popup redesign (feat/popup-redesign, production
 * port of proto/popup-redesign) -- screenshots both `popupTheme` variants
 * (dark / light) so a change can be reviewed visually without opening a
 * real browser. Not part of the permanent e2e suite (like the prototype's
 * original version, `openPopup()` + a reload is all this needs, but that
 * standard helper doesn't expose a way to seed `chrome.storage.sync` before
 * first paint, which is what's needed here).
 *
 *   tsx e2e/tools/capture-popup-themes.ts [outDir]
 *
 * Unlike the prototype (which toggled `?theme=dark|light` on the popup
 * URL), the shipped setting is `popupTheme: 'auto' | 'dark' | 'light'` in
 * `chrome.storage.sync` (see `src/components/popup/popup-theme-storage.ts`).
 * This drives it the same way a real user would end up in either state:
 * seed `chrome.storage.sync` via `chrome.storage.sync.set` evaluated in the
 * popup page's own context (it's a chrome-extension:// page, so it has
 * full extension API access), then reload so `popup.ts`'s pre-render fetch
 * picks up the new value.
 *
 * Default `outDir` is the repo-local `e2e/out/popup-themes/` (gitignored,
 * see `e2e/out/` in `.gitignore`) so the documented no-argument invocation
 * works on any checkout instead of only the workstation that authored this
 * script.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { ensureCompositorKeepalive, launchHarness } from '../harness.ts'
import type { Page } from 'puppeteer-core'

const OUT_DIR = process.argv[2] ?? new URL('../out/popup-themes/', import.meta.url).pathname
mkdirSync(OUT_DIR, { recursive: true })

const openPopupWithRetry = async (h: Awaited<ReturnType<typeof launchHarness>>) => {
  let lastErr: unknown
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await h.openPopup()
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw lastErr
}

/** Reads a PNG buffer's pixel height straight out of its IHDR chunk (bytes 20-23, big-endian). Avoids pulling in an image-decoding dependency just to sanity-check a screenshot. */
const pngHeight = (buf: Uint8Array): number =>
  (buf[20]! << 24) | (buf[21]! << 16) | (buf[22]! << 8) | buf[23]!

/**
 * `page.screenshot({ fullPage: true })` on this popup page has been observed
 * to intermittently return a frame sized to the *viewport* (900 CSS px tall)
 * instead of the full scrollable content (~1350px+) -- same symptom as the
 * documented compositor-stall class of flakiness (e2e/README.md "Flaky
 * bits"), just manifesting as a truncated frame instead of a hung capture.
 * Re-asserting the keepalive alone did not make it fully deterministic in
 * testing, so this additionally verifies the captured PNG's actual height
 * against the page's real content height (via CDP `Page.getLayoutMetrics`)
 * and retries (fresh keepalive re-assert + short wait) until they agree.
 */
const screenshotFullPageWithRetry = async (page: Page, maxAttempts = 5): Promise<Uint8Array> => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await ensureCompositorKeepalive(page)
    const metrics = await (page as any)._client().send('Page.getLayoutMetrics')
    const expectedHeightPx = Math.round(metrics.cssContentSize.height * (page.viewport()?.deviceScaleFactor ?? 1))
    const buf = await page.screenshot({ fullPage: true })
    const actualHeightPx = pngHeight(buf as Uint8Array)
    // Small tolerance for rounding; a truncated capture is off by hundreds
    // of px (an entire section's worth), not a rounding error.
    if (actualHeightPx >= expectedHeightPx - 4) return buf as Uint8Array
    console.log(`[capture] retry ${attempt}/${maxAttempts}: screenshot height ${actualHeightPx}px < expected ${expectedHeightPx}px (stale/truncated compositor frame)`)
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`screenshotFullPageWithRetry: gave up after ${maxAttempts} attempts`)
}

const capture = async (mode: 'dark' | 'light', label: string) => {
  const h = await launchHarness({ headed: false })
  try {
    const popupPage = await openPopupWithRetry(h)

    // Seed the setting the same way a user's earlier click would have
    // persisted it, then reload so popup.ts's pre-render fetch (the
    // flash-of-wrong-theme guard) resolves the new value before mounting.
    await popupPage.evaluate(
      (popupThemeMode) => new Promise<void>((resolve) => {
        chrome.storage.sync.set({ popupTheme: popupThemeMode }, () => resolve())
      }),
      mode
    )
    await popupPage.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 })
    await popupPage.reload({ waitUntil: 'networkidle0' })
    // reload() wipes the anti-stall keepalive that openPopup() injected
    // pre-reload -- screenshotFullPageWithRetry re-asserts it itself, but
    // give MUI a beat first to finish its first paint/transition-free render.
    await new Promise((r) => setTimeout(r, 300))
    const buf = await screenshotFullPageWithRetry(popupPage)
    writeFileSync(`${OUT_DIR}/${label}-full.png`, buf)
    console.log(`[capture] wrote ${OUT_DIR}/${label}-full.png`)
  } finally {
    await h.close()
  }
}

await capture('dark', 'dark')
await capture('light', 'light')
