/**
 * Renders the Chrome Web Store promotional tiles from the static HTML
 * sources in `docs/store-assets/src/` and writes the exact-pixel PNGs the
 * store requires:
 *
 *   npx tsx e2e/tools/capture-promo-tiles.ts
 *
 *   docs/store-assets/promo-small-440x280.png    (440x280)
 *   docs/store-assets/promo-marquee-1400x560.png (1400x560)
 *
 * Both HTML sources are self-contained pages (no extension, no fixture
 * server, no replay) that reference already-committed imagery directly by
 * relative path -- the extension icon (`icons/icon_128px.png`) and the
 * freshly regenerated HUD-over-backdrop store screenshot
 * (`docs/store-assets/store-5-handlog.png`, produced by
 * `capture-store-imagery.ts`). This tool just loads each HTML file at its
 * target viewport with the pinned Chrome for Testing build (shared with the
 * rest of e2e/ via `ensureChromeForTesting`/`CHROME_BUILD_ID`) and takes one
 * viewport-sized screenshot -- reproducible and independent of any live
 * PokerChase/extension state.
 *
 * Both outputs are flattened onto an opaque background (the HTML pages have
 * no transparent regions and JPEG-quality screenshot encoding is not used),
 * so the resulting PNGs have no alpha channel, matching the Chrome Web
 * Store's "24-bit PNG (no alpha)" requirement.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'
import { ensureChromeForTesting, ensureCompositorKeepalive } from '../harness.ts'
import { REPO_ROOT } from '../config.ts'

const SRC_DIR = join(REPO_ROOT, 'docs', 'store-assets', 'src')
const OUT_DIR = join(REPO_ROOT, 'docs', 'store-assets')

interface TileSpec {
  html: string
  out: string
  width: number
  height: number
}

const TILES: TileSpec[] = [
  { html: 'promo-small.html', out: 'promo-small-440x280.png', width: 440, height: 280 },
  { html: 'promo-marquee.html', out: 'promo-marquee-1400x560.png', width: 1400, height: 560 },
]

const main = async (): Promise<void> => {
  const executablePath = await ensureChromeForTesting()
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check'],
  })
  try {
    for (const tile of TILES) {
      const page = await browser.newPage()
      await page.setViewport({ width: tile.width, height: tile.height, deviceScaleFactor: 1 })
      const htmlPath = join(SRC_DIR, tile.html)
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' })
      // Wait for the referenced <img> elements (icon + screenshot) to finish
      // decoding -- goto's "load" event already implies this for same-origin
      // file:// resources, but assert it explicitly so a broken relative
      // path fails loudly here instead of silently baking a blank image.
      const missing: string[] = await page.evaluate(() =>
        Array.from(document.images)
          .filter((img) => !img.complete || img.naturalWidth === 0)
          .map((img) => img.getAttribute('src') || '(no src)')
      )
      if (missing.length > 0) {
        throw new Error(`${tile.html}: image(s) failed to load: ${missing.join(', ')}`)
      }
      await ensureCompositorKeepalive(page)
      const outPath = join(OUT_DIR, tile.out)
      await page.screenshot({ path: outPath as `${string}.png`, type: 'png' })
      await page.close()
      console.log(`[capture-promo-tiles] wrote ${outPath} (${tile.width}x${tile.height})`)
    }
  } finally {
    await browser.close()
  }
}

// Guard so this module can be imported without also kicking off the full
// launch-Chrome-and-screenshot pipeline as an import side effect -- same
// pattern as capture-store-imagery.ts/build-e2e.ts/generate-e2e-manifest.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[capture-promo-tiles] FAILED:', err)
    process.exitCode = 1
  })
}
