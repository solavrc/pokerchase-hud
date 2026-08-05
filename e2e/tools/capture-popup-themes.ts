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
import { buildE2E } from './build-e2e.ts'
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

/**
 * Chrome Web Store screenshot geometry. The store wants exactly 1280x800
 * with no device frame and no rounded corners, and the popup is a 420px-wide
 * column -- so the popup is captured at its natural width and composited
 * 1:1 (never rescaled: a resampled 9-11px UI label is the difference between
 * readable and mush at the size the store actually shows these).
 */
const STORE_SHOT = { width: 1280, height: 800 } as const
/**
 * The popup document is a fixed 380px column (`body { width: 380px }` in
 * dist/index.html); capturing at the 420px extension-popup viewport instead
 * bakes a 40px strip of bare `html` background -- which the boot theme keeps
 * dark in BOTH themes -- down the side of the shot. Captured at the column's
 * own width, there is nothing to trim.
 */
const STORE_POPUP = { width: 380, height: 760 } as const

/**
 * Backgrounds carried over from the previously published store-3/store-4
 * (sampled off those PNGs) so the pair still reads as one set: the dark
 * variant on the deep felt green, the light variant on warm paper.
 */
const STORE_BACKGROUND = {
  dark: 'linear-gradient(135deg, #0c3a1c 0%, #14512a 55%, #0a2f17 100%)',
  light: 'linear-gradient(135deg, #efece6 0%, #e2ded6 55%, #d8d4cb 100%)',
} as const

/**
 * Turns the opt-in replay import on with a verified entitlement, so the
 * store shot shows the section in the state the listing text describes
 * (`ReplayImportSection`'s `severity="success"` alert) rather than its
 * default-off state. Mirrors what a real popup toggle plus one successful
 * `/replay/list` check leaves behind -- see src/background/replay-access.ts.
 */
const seedReplayImportVerified = (page: Page): Promise<void> =>
  page.evaluate((cardOpenEndDate: number) => Promise.all([
    new Promise<void>((res) => chrome.storage.sync.set({ replayImportEnabled: true }, () => res())),
    new Promise<void>((res) => chrome.storage.local.set({
      replayImportAccess: { phase: 'verified', cardOpenEndDate, checkedAt: Date.now() }
    }, () => res())),
  ]).then(() => undefined), Math.floor(Date.now() / 1000) + 6 * 24 * 3600)

/**
 * Composites one already-captured popup PNG onto the exact-pixel store
 * canvas by rendering a one-off HTML page in the same pinned Chrome and
 * screenshotting it -- the same "static HTML at a fixed viewport" trick
 * `capture-promo-tiles.ts` uses for the promo tiles, so no image-processing
 * dependency is pulled in just to place one rectangle. The embedded PNG is
 * shown at its own pixel size (`STORE_POPUP`), so the composite step does
 * not resample it.
 */
const compositeStoreShot = async (
  browser: Awaited<ReturnType<typeof launchHarness>>['browser'],
  popupPng: Uint8Array,
  mode: 'dark' | 'light',
  outPath: string
): Promise<void> => {
  const page = await browser.newPage()
  try {
    await page.setViewport({ ...STORE_SHOT, deviceScaleFactor: 1 })
    const dataUri = `data:image/png;base64,${Buffer.from(popupPng).toString('base64')}`
    await page.setContent(
      `<style>
         html, body { margin: 0; padding: 0; }
         body {
           width: ${STORE_SHOT.width}px; height: ${STORE_SHOT.height}px;
           background: ${STORE_BACKGROUND[mode]};
           display: flex; align-items: center; justify-content: center;
         }
         /* No rounded corners and no device frame -- Chrome Web Store
            screenshot rules. A plain drop shadow is all that separates the
            popup from the backdrop. */
         img {
           width: ${STORE_POPUP.width}px; height: ${STORE_POPUP.height}px;
           display: block;
           box-shadow: 0 18px 48px rgba(0, 0, 0, ${mode === 'dark' ? 0.55 : 0.28});
         }
       </style>
       <img src="${dataUri}">`,
      { waitUntil: 'load' }
    )
    await ensureCompositorKeepalive(page)
    await page.screenshot({ path: outPath as `${string}.png`, type: 'png' })
    console.log(`[capture] wrote ${outPath} (${STORE_SHOT.width}x${STORE_SHOT.height})`)
  } finally {
    await page.close()
  }
}

const capture = async (mode: 'dark' | 'light', label: string, storeShot: {
  out: string
  /** Scrolls this section to the top of the popup viewport before capturing. */
  scrollTo?: 'replay-import'
}) => {
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
    await seedReplayImportVerified(popupPage)
    await popupPage.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 })
    await popupPage.reload({ waitUntil: 'networkidle0' })
    // reload() wipes the anti-stall keepalive that openPopup() injected
    // pre-reload -- screenshotFullPageWithRetry re-asserts it itself, but
    // give MUI a beat first to finish its first paint/transition-free render.
    await new Promise((r) => setTimeout(r, 300))
    const buf = await screenshotFullPageWithRetry(popupPage)
    writeFileSync(`${OUT_DIR}/${label}-full.png`, buf)
    console.log(`[capture] wrote ${OUT_DIR}/${label}-full.png`)

    // Store variant: natural width, deviceScaleFactor 1, viewport-sized (not
    // fullPage) so the PNG's pixels map 1:1 onto the composite below.
    await popupPage.setViewport({ ...STORE_POPUP, deviceScaleFactor: 1 })
    await new Promise((r) => setTimeout(r, 400))
    if (storeShot.scrollTo === 'replay-import') {
      const scrolled: boolean = await popupPage.evaluate(() => {
        const heading = Array.from(document.querySelectorAll('*'))
          .find((el) => el.children.length === 0 && el.textContent?.trim() === 'リプレイ取り込み')
        const card = heading?.closest('.MuiPaper-root') ?? heading
        if (!card) return false
        // Centred, not 'start': the section is short enough that pinning it
        // to the top edge leaves the shot opening on a half-cropped control
        // from the card above it.
        card.scrollIntoView({ block: 'center' })
        return true
      })
      if (!scrolled) throw new Error('could not find the リプレイ取り込み section to scroll to')
    }
    await ensureCompositorKeepalive(popupPage)
    await new Promise((r) => setTimeout(r, 400))
    const storeBuf = await popupPage.screenshot({ type: 'png' }) as Uint8Array
    // IHDR width (bytes 16-19, big-endian) -- a capture that came back at
    // some other width would be silently rescaled by the composite below.
    const capturedWidth = (storeBuf[16]! << 24) | (storeBuf[17]! << 16) | (storeBuf[18]! << 8) | storeBuf[19]!
    if (capturedWidth !== STORE_POPUP.width) {
      throw new Error(`popup capture is ${capturedWidth}px wide, expected ${STORE_POPUP.width}px`)
    }
    await compositeStoreShot(h.browser, storeBuf, mode, storeShot.out)
  } finally {
    await h.close()
  }
}

const STORE_DIR = new URL('../../docs/store-assets/', import.meta.url).pathname

// Build the e2e extension first, exactly like capture-store-imagery.ts does:
// launchHarness() loads e2e/.build/extension/ whether or not it exists, and a
// stale one silently prints the previous release's version number into the
// popup header -- which is the one string in these shots nobody reviewing a
// screenshot double-checks.
console.log('[capture] building e2e extension (npm run build:e2e logic)...')
buildE2E()

await capture('dark', 'dark', { out: `${STORE_DIR}store-3-popup-dark.png`, scrollTo: 'replay-import' })
await capture('light', 'light', { out: `${STORE_DIR}store-4-popup-light.png` })
