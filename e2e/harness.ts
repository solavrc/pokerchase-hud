/**
 * Core E2E QA harness: launches Chrome for Testing with the built e2e
 * extension loaded, serves the fixture page + WS replay server, and exposes
 * a small set of primitives (screenshot, DOM snapshot, evaluate, open
 * popup) for both scripted assertions (see scenarios/smoke.ts) and
 * step-by-step exploratory driving from the CLI (see run.ts).
 *
 * Import this module directly for programmatic use:
 *
 *   import { launchHarness } from './e2e/harness.ts'
 *   const h = await launchHarness()
 *   await h.waitForHudMount()
 *   await h.screenshot('out/hud.png')
 *   await h.close()
 *
 * `attachHarness` is the counterpart used by `run.ts`'s CLI subcommands: it
 * connects to an *already running* browser (started by `run.ts launch`,
 * which keeps a detached daemon process alive) instead of launching a new
 * one, so a sequence of short-lived CLI invocations can all drive the same
 * live page.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { install, computeExecutablePath, Browser as BrowserId, detectBrowserPlatform } from '@puppeteer/browsers'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { startFixtureServer, type FixtureServerHandle } from './fixture-server.ts'
import { FIXTURE_PORT, EXTENSION_DIR, BROWSER_CACHE_DIR, CHROME_BUILD_ID, DEFAULT_FIXTURE } from './config.ts'

export interface LaunchOptions {
  /** Path to the built e2e extension directory (must contain manifest.json + dist/). */
  extensionDir?: string
  fixturePath?: string
  replayDelayMs?: number
  port?: number
  /** Show the Chrome window. Extensions are unreliable in headless Chrome, but headless has been verified to also work for this harness (see e2e/README.md) -- defaults to false (headless) for unattended/CI-style use. */
  headed?: boolean
}

export interface HarnessHelpers {
  /** The fixture page tab (where the extension's content_script + HUD run). */
  gamePage: Page
  /**
   * Opens the extension's popup/options page (dist/index.html) as a new tab.
   * `onPageCreated`, if given, runs synchronously right after the tab is
   * created but *before* navigation starts -- use it to attach listeners
   * (e.g. `page.on('pageerror', ...)`) that need to observe the initial
   * render, since anything attached after this resolves has already missed
   * errors thrown while `dist/index.html` first loaded.
   */
  openPopup: (onPageCreated?: (page: Page) => void) => Promise<Page>
  /** Evaluates `fn` in `gamePage`'s context and returns the result. */
  evaluate: <T>(fn: (...args: any[]) => T, ...args: any[]) => Promise<T>
  /** PNG screenshot of `gamePage` (or the given page) to `path`. Creates parent dirs. */
  screenshot: (path: string, page?: Page) => Promise<string>
  /** Returns a plain-text snapshot of `gamePage`'s (or the given page's) rendered body -- handy for text-based assertions/logging without a screenshot. */
  domSnapshotText: (page?: Page) => Promise<string>
  /** Returns the outerHTML of `gamePage`'s (or the given page's) <body> -- for structural inspection. */
  domSnapshotHtml: (page?: Page) => Promise<string>
  /** Polls until at least one HUD player panel (rendered by src/components/Hud.tsx) is present, or throws. */
  waitForHudMount: (timeoutMs?: number) => Promise<void>
}

export interface Harness extends HarnessHelpers {
  browser: Browser
  fixtureServer: FixtureServerHandle
  /** Resolves once the fixture server has sent every event in the fixture. */
  waitForReplayDone: () => Promise<void>
  /** Closes the browser AND the fixture server (full teardown). */
  close: () => Promise<void>
}

/** Downloads (if not already cached) and returns the path to the pinned Chrome for Testing binary. */
export const ensureChromeForTesting = async (): Promise<string> => {
  const platform = detectBrowserPlatform()
  if (!platform) throw new Error(`Unsupported platform for Chrome for Testing: ${process.platform}/${process.arch}`)

  const existing = computeExecutablePath({ browser: BrowserId.CHROME, buildId: CHROME_BUILD_ID, cacheDir: BROWSER_CACHE_DIR })
  if (existsSync(existing)) return existing

  console.log(`[harness] downloading Chrome for Testing ${CHROME_BUILD_ID} (${platform}) into ${BROWSER_CACHE_DIR} ...`)
  const installed = await install({ browser: BrowserId.CHROME, buildId: CHROME_BUILD_ID, cacheDir: BROWSER_CACHE_DIR })
  return installed.executablePath
}

/** Finds the fixture page tab among a browser's open pages/targets. */
const findGamePage = async (browser: Browser, fixtureOrigin: string): Promise<Page | undefined> => {
  const pages = await browser.pages()
  return pages.find((p) => p.url().startsWith(fixtureOrigin))
}

const buildHelpers = (browser: Browser, gamePage: Page): HarnessHelpers => {
  const withPage = (page?: Page): Page => page ?? gamePage

  const screenshot = async (path: string, page?: Page): Promise<string> => {
    mkdirSync(dirname(path), { recursive: true })
    await withPage(page).screenshot({ path: path as `${string}.png`, fullPage: false })
    return path
  }

  const domSnapshotText = async (page?: Page): Promise<string> =>
    withPage(page).evaluate(() => document.body.innerText)

  const domSnapshotHtml = async (page?: Page): Promise<string> =>
    withPage(page).evaluate(() => document.body.outerHTML)

  const evaluate = <T,>(fn: (...args: any[]) => T, ...args: any[]): Promise<T> =>
    gamePage.evaluate(fn as any, ...args)

  const openPopup = async (onPageCreated?: (page: Page) => void): Promise<Page> => {
    // Resolve the extension's id from its own runtime by reading it off the
    // service worker target rather than hardcoding it (the "key" in
    // manifest.json pins it, but re-deriving here keeps this robust if that
    // ever changes).
    const targets = browser.targets()
    const swTarget = targets.find((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'))
    if (!swTarget) throw new Error('Could not find the extension service worker target -- is the extension loaded?')
    const extensionId = new URL(swTarget.url()).host
    const popupPage = await browser.newPage()
    // Attach listeners *before* navigating so callers can observe errors
    // thrown during the popup's initial render, not just after.
    popupPage.on('pageerror', (err) => console.error('[popupPage pageerror]', err))
    onPageCreated?.(popupPage)
    await popupPage.goto(`chrome-extension://${extensionId}/dist/index.html`, { waitUntil: 'domcontentloaded' })
    return popupPage
  }

  const waitForHudMount = async (timeoutMs = 15000): Promise<void> => {
    await gamePage.waitForFunction(
      () => {
        const container = document.querySelector('#unity-container')
        // App.tsx mounts a <div> child into #unity-container, then renders
        // Hud.tsx panels inside it once stats arrive.
        return !!container && container.children.length > 0 && !!container.querySelector('[style*="position: fixed"]')
      },
      { timeout: timeoutMs }
    )
  }

  return { gamePage, openPopup, evaluate, screenshot, domSnapshotText, domSnapshotHtml, waitForHudMount }
}

export const launchHarness = async (options: LaunchOptions = {}): Promise<Harness> => {
  const extensionDir = options.extensionDir ?? EXTENSION_DIR
  const port = options.port ?? FIXTURE_PORT
  const headed = options.headed ?? false

  const fixtureServer = await startFixtureServer({
    fixturePath: options.fixturePath ?? DEFAULT_FIXTURE,
    replayDelayMs: options.replayDelayMs ?? 0,
    port,
  })

  // Everything below can fail (Chrome download, launch, or the initial
  // navigation) after the fixture server is already listening. Without a
  // teardown here, any such failure would leave the HTTP+WS server (and its
  // held port) running forever with no `harness` object for the caller to
  // close -- best case a leaked process, worst case a stuck port blocking
  // the next run. Tear the fixture server down on any failure and rethrow.
  let launchedBrowser: Browser | undefined
  let browser: Browser
  let gamePage: Page
  try {
    const executablePath = await ensureChromeForTesting()

    browser = await puppeteer.launch({
      executablePath,
      headless: !headed,
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1280,900',
      ],
      defaultViewport: null,
    })
    launchedBrowser = browser

    // Chrome opens an initial about:blank tab; reuse it for the fixture page.
    const pages = await browser.pages()
    gamePage = pages[0] ?? await browser.newPage()
    gamePage.on('console', (msg) => {
      if (msg.type() === 'error') console.error(`[gamePage console.error] ${msg.text()}`)
    })
    gamePage.on('pageerror', (err) => console.error('[gamePage pageerror]', err))

    await gamePage.goto(fixtureServer.origin, { waitUntil: 'domcontentloaded' })
  } catch (err) {
    await fixtureServer.close().catch(() => {})
    await launchedBrowser?.close().catch(() => {})
    throw err
  }

  const helpers = buildHelpers(browser, gamePage)

  const waitForReplayDone = (): Promise<void> => fixtureServer.replayDone

  const close = async (): Promise<void> => {
    await browser.close().catch(() => {})
    await fixtureServer.close().catch(() => {})
  }

  return { browser, fixtureServer, waitForReplayDone, close, ...helpers }
}

/**
 * Connects to a browser previously started by `launchHarness` (or the
 * `run.ts launch` daemon) via its CDP WebSocket endpoint, and rebuilds the
 * same helpers around its existing fixture page tab. Used by `run.ts`'s
 * per-command CLI invocations so each one doesn't have to launch its own
 * browser. Does NOT own the browser/fixture-server lifecycle -- callers
 * should call `browser.disconnect()` (not `.close()`) when done.
 */
export const attachHarness = async (
  browserWSEndpoint: string,
  fixtureOrigin: string
): Promise<HarnessHelpers & { browser: Browser }> => {
  const browser = await puppeteer.connect({ browserWSEndpoint, defaultViewport: null })
  const gamePage = await findGamePage(browser, fixtureOrigin)
  if (!gamePage) {
    throw new Error(`No open tab found at ${fixtureOrigin} -- is the harness session still running? (run.ts status)`)
  }
  return { browser, ...buildHelpers(browser, gamePage) }
}
