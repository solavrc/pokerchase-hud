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
 */
import { launchHarness } from '../harness.ts'

const OUT_DIR = process.argv[2] ?? '/private/tmp/claude-501/-Users-local--openclaw/c9e06c82-28ae-48a2-8eb1-17a3f8529191/scratchpad/popupprod-shots'

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
    // Give MUI a beat to finish its first paint/transition-free render.
    await new Promise((r) => setTimeout(r, 300))
    await popupPage.screenshot({ path: `${OUT_DIR}/${label}-full.png` as `${string}.png`, fullPage: true })
    console.log(`[capture] wrote ${OUT_DIR}/${label}-full.png`)
  } finally {
    await h.close()
  }
}

await capture('dark', 'dark')
await capture('light', 'light')
