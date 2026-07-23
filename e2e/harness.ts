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
import { FIXTURE_PORT, EXTENSION_DIR, BROWSER_CACHE_DIR, CHROME_BUILD_ID, DEFAULT_FIXTURE, DEFAULT_VIEWPORT, type Viewport } from './config.ts'

export interface LaunchOptions {
  /** Path to the built e2e extension directory (must contain manifest.json + dist/). */
  extensionDir?: string
  /** Reuse a Chrome profile across launches (used by restart-persistence scenarios). */
  userDataDir?: string
  fixturePath?: string
  replayDelayMs?: number
  port?: number
  /** Show the Chrome window. Extensions are unreliable in headless Chrome, but headless has been verified to also work for this harness (see e2e/README.md) -- defaults to false (headless) for unattended/CI-style use. */
  headed?: boolean
  /** Browser viewport size. Defaults to {@link DEFAULT_VIEWPORT} (1920x1080, matching the real game's fullscreen Unity canvas -- see its doc comment for why this matters for HUD panel geometry). */
  viewport?: Viewport
  /**
   * Query string (no leading `?`) appended to the initial fixture page
   * navigation, e.g. `'backdrop=1'` to opt into the real-gameplay table
   * backdrop (off by default) -- see `table-backdrop.js`'s module doc
   * comment for the params it reads. Omit to navigate to the fixture
   * server's origin unchanged (served as fixture.html).
   */
  fixtureQuery?: string
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

export interface StoppedExtensionServiceWorker {
  extensionId: string
  scriptURL: string
  versionId: string
  targetId?: string
}

export interface StoppedExtensionServiceWorkerMonitor {
  /** Latest CDP runningStatus observed for the stopped version. */
  runningStatus: () => string | undefined
  /** Re-enables the CDP domain to force a fresh version inventory. */
  refreshRunningStatus: () => Promise<string | undefined>
  close: () => Promise<void>
}

interface ServiceWorkerVersion {
  versionId: string
  scriptURL: string
  runningStatus: string
  targetId?: string
}

const withTimeout = <T,>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> =>
  new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })

/**
 * Stops the currently-running extension Service Worker through CDP and waits
 * until Chrome confirms that exact worker version reached `stopped`.
 *
 * This is intentionally a browser-level failure injection: it does not add a
 * production-only message or test hook to the extension. A live content-script
 * Port will observe the real disconnect and must wake/reconnect to the worker
 * through the same path used after an MV3 idle eviction.
 */
export const stopExtensionServiceWorker = async (
  browser: Browser,
  timeoutMs = 10_000
): Promise<StoppedExtensionServiceWorker> => {
  const extensionTarget = await browser.waitForTarget(
    (candidate) =>
      candidate.type() === 'service_worker' &&
      candidate.url().startsWith('chrome-extension://'),
    { timeout: timeoutMs }
  )
  const extensionId = new URL(extensionTarget.url()).host
  // The ServiceWorker domain is exposed on renderer/page CDP sessions in
  // Chrome for Testing 151, not on Puppeteer's browser-target session.
  const pages = await browser.pages()
  const controlPage = pages[0]
  if (!controlPage) throw new Error('Could not find a page target for ServiceWorker CDP control')
  const session = await controlPage.createCDPSession()
  const versions = new Map<string, ServiceWorkerVersion>()
  let notifyVersionUpdate: (() => void) | undefined

  const onVersionUpdate = (event: { versions: ServiceWorkerVersion[] }): void => {
    for (const version of event.versions) versions.set(version.versionId, version)
    notifyVersionUpdate?.()
  }
  session.on('ServiceWorker.workerVersionUpdated', onVersionUpdate)

  const waitForVersion = async (
    predicate: (version: ServiceWorkerVersion) => boolean,
    label: string
  ): Promise<ServiceWorkerVersion> => {
    const findMatch = (): ServiceWorkerVersion | undefined =>
      Array.from(versions.values()).find(predicate)

    const existing = findMatch()
    if (existing) return existing

    return await withTimeout(
      new Promise<ServiceWorkerVersion>((resolveVersion) => {
        const check = (): void => {
          const match = findMatch()
          if (match) {
            notifyVersionUpdate = undefined
            resolveVersion(match)
          }
        }
        notifyVersionUpdate = check
        check()
      }),
      timeoutMs,
      label
    )
  }

  try {
    // Enabling the domain emits the current registration/version inventory.
    await session.send('ServiceWorker.enable')
    const running = await waitForVersion(
      (version) =>
        version.scriptURL.startsWith(`chrome-extension://${extensionId}/`) &&
        version.runningStatus === 'running',
      'extension Service Worker inventory'
    )

    const stoppedPromise = waitForVersion(
      (version) =>
        version.versionId === running.versionId &&
        version.runningStatus === 'stopped',
      'extension Service Worker stop'
    )
    await session.send('ServiceWorker.stopWorker', { versionId: running.versionId })
    await stoppedPromise

    return {
      extensionId,
      scriptURL: running.scriptURL,
      versionId: running.versionId,
      targetId: running.targetId
    }
  } finally {
    session.off('ServiceWorker.workerVersionUpdated', onVersionUpdate)
    await session.detach().catch(() => {})
  }
}

/**
 * Keeps a ServiceWorker-domain session open after a stop and tracks the exact
 * version's runningStatus. Callers can surround browser-side evidence with
 * this monitor and reject it if Chrome restarted the worker in the meantime.
 *
 * Attaching after {@link stopExtensionServiceWorker} is deliberate: if the
 * worker already restarted during that handoff, the initial inventory is no
 * longer `stopped` and this fails closed instead of accepting a stale stop.
 */
export const monitorStoppedExtensionServiceWorker = async (
  browser: Browser,
  stoppedWorker: StoppedExtensionServiceWorker,
  timeoutMs = 5_000
): Promise<StoppedExtensionServiceWorkerMonitor> => {
  const pages = await browser.pages()
  const controlPage = pages[0]
  if (!controlPage) throw new Error('Could not find a page target for ServiceWorker CDP monitoring')
  const session = await controlPage.createCDPSession()
  const versions = new Map<string, ServiceWorkerVersion>()
  let notifyVersionUpdate: (() => void) | undefined

  const onVersionUpdate = (event: { versions: ServiceWorkerVersion[] }): void => {
    for (const version of event.versions) versions.set(version.versionId, version)
    notifyVersionUpdate?.()
  }
  session.on('ServiceWorker.workerVersionUpdated', onVersionUpdate)

  const waitForVersion = async (label: string): Promise<ServiceWorkerVersion> =>
    versions.get(stoppedWorker.versionId) ?? await withTimeout(
      new Promise<ServiceWorkerVersion>((resolveVersion) => {
        const check = (): void => {
          const version = versions.get(stoppedWorker.versionId)
          if (version) {
            notifyVersionUpdate = undefined
            resolveVersion(version)
          }
        }
        notifyVersionUpdate = check
        check()
      }),
      timeoutMs,
      label
    )

  const close = async (): Promise<void> => {
    session.off('ServiceWorker.workerVersionUpdated', onVersionUpdate)
    await session.detach().catch(() => {})
  }

  try {
    await session.send('ServiceWorker.enable')
    const initial = await waitForVersion('stopped extension Service Worker inventory')

    if (
      initial.scriptURL !== stoppedWorker.scriptURL ||
      initial.runningStatus !== 'stopped'
    ) {
      throw new Error(
        `extension Service Worker restarted before stopped-window monitoring: ` +
        `${initial.versionId} is ${initial.runningStatus}`
      )
    }

    return {
      runningStatus: () => versions.get(stoppedWorker.versionId)?.runningStatus,
      refreshRunningStatus: async () => {
        // The page-receipt and ServiceWorker events arrive over separate CDP
        // sessions, so do not assume their delivery order reflects browser
        // time. Re-enabling forces Chrome to emit a fresh inventory after the
        // page-side evidence has resolved.
        versions.delete(stoppedWorker.versionId)
        await session.send('ServiceWorker.disable')
        await session.send('ServiceWorker.enable')
        return (await waitForVersion('refreshed extension Service Worker inventory'))
          .runningStatus
      },
      close
    }
  } catch (error) {
    await close()
    throw error
  }
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

/**
 * Workaround for a headless Chrome for Testing compositor stall (observed on
 * the pinned build, Chrome 151): once a page has been *idle* for a few
 * minutes, the compositor stops producing on-demand frames, and every
 * subsequent CDP `Page.captureScreenshot` hangs until protocol timeout --
 * while `evaluate` on the same page keeps working fine. `--disable-gpu` does
 * not help. An invisible, infinitely-running CSS animation keeps BeginFrames
 * flowing so the stall never happens, and injecting it also *recovers* an
 * already-stalled compositor (verified live: after injection, previously
 * hanging screenshots all succeed). Idempotent per page (keyed on element
 * id). Called on every harness-owned page at load time, and re-asserted
 * before each `screenshot()` so it self-heals across page reloads and
 * `attachHarness` sessions started by an older build. See e2e/README.md
 * "Flaky bits".
 *
 * Exported (not just used internally) because a `reload()` wipes the
 * injected style/div -- any caller that reloads a harness-owned page and
 * then screenshots it directly (bypassing `screenshot()`'s own re-assert,
 * e.g. `e2e/tools/capture-popup-themes.ts`, which needs `fullPage: true`
 * that `screenshot()` doesn't support) must re-call this after the reload
 * or risk a stale/truncated `fullPage` capture -- observed in practice as
 * a `fullPage` screenshot silently sized to the viewport instead of the
 * full scrollHeight, not just the documented hang.
 */
const COMPOSITOR_KEEPALIVE_ID = '__e2e-compositor-keepalive'

export const ensureCompositorKeepalive = async (page: Page): Promise<void> => {
  await page.evaluate((id: string) => {
    if (document.getElementById(id)) return
    const style = document.createElement('style')
    style.textContent =
      `@keyframes ${id}-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`
    const el = document.createElement('div')
    el.id = id
    // 1x1px at the viewport corner, near-zero opacity: effectively invisible
    // but NOT opacity:0 or offscreen -- the compositor may cull those,
    // defeating the whole point of forcing continuous frame production.
    el.style.cssText =
      'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.01;' +
      `pointer-events:none;animation:${id}-spin 1s linear infinite;`
    const parent = document.body ?? document.documentElement
    parent.appendChild(style)
    parent.appendChild(el)
  }, COMPOSITOR_KEEPALIVE_ID)
}

const buildHelpers = (browser: Browser, gamePage: Page): HarnessHelpers => {
  const withPage = (page?: Page): Page => page ?? gamePage

  const screenshot = async (path: string, page?: Page): Promise<string> => {
    const target = withPage(page)
    mkdirSync(dirname(path), { recursive: true })
    // Re-assert the anti-stall animation right before capturing (idempotent,
    // one cheap evaluate). This both prevents and *recovers from* the
    // idle-compositor stall -- see ensureCompositorKeepalive. Best-effort:
    // if the page is mid-navigation the screenshot below fails with its own,
    // more useful error.
    await ensureCompositorKeepalive(target).catch(() => {})
    await target.screenshot({ path: path as `${string}.png`, fullPage: false })
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
    // Popup tabs are screenshotted directly (popupPage.screenshot) by
    // smoke.ts / run.ts, bypassing the screenshot() helper's re-assert -- so
    // install the anti-stall keepalive here at open time.
    await ensureCompositorKeepalive(popupPage)
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
  const viewport = options.viewport ?? DEFAULT_VIEWPORT

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
      ...(options.userDataDir ? { userDataDir: options.userDataDir } : {}),
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        // GitHub-hosted Ubuntu disables the unprivileged-user-namespace
        // sandbox Chrome for Testing expects. The runner is disposable and
        // only opens our localhost fixture, so disable Chrome's sandbox in CI
        // while retaining the normal sandbox for every local/browser run.
        ...(process.env.CI ? ['--disable-dev-shm-usage', '--no-sandbox'] : []),
        // Window size in *headed* mode only affects the outer OS window
        // (Chrome adds its own title/tab/toolbar chrome on top of this);
        // it has no effect headless, where there's no window chrome to
        // account for. The actual page viewport -- what the HUD's
        // percentage-based panel positioning sees -- is controlled by
        // `defaultViewport` below via CDP, independent of this flag. Kept
        // equal to the viewport so a `--headed` run's window is at least
        // as large as the content it's showing.
        `--window-size=${viewport.width},${viewport.height}`,
      ],
      // Explicit (not `null`) so the viewport is game-realistic regardless
      // of window size/chrome -- see DEFAULT_VIEWPORT's doc comment in
      // e2e/config.ts for why 1920x1080 matters to HUD panel geometry.
      defaultViewport: { width: viewport.width, height: viewport.height, deviceScaleFactor: 1 },
    })
    launchedBrowser = browser

    // Chrome opens an initial about:blank tab; reuse it for the fixture page.
    const pages = await browser.pages()
    gamePage = pages[0] ?? await browser.newPage()
    gamePage.on('console', (msg) => {
      if (msg.type() === 'error') console.error(`[gamePage console.error] ${msg.text()}`)
    })
    gamePage.on('pageerror', (err) => console.error('[gamePage pageerror]', err))

    const gameUrl = options.fixtureQuery
      ? `${fixtureServer.origin}/fixture.html?${options.fixtureQuery}`
      : fixtureServer.origin
    await gamePage.goto(gameUrl, { waitUntil: 'domcontentloaded' })
    // Keep the compositor producing frames from the start so screenshots
    // still work after the page idles for minutes (agent think-time between
    // CLI commands) -- see ensureCompositorKeepalive.
    await ensureCompositorKeepalive(gamePage)
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
