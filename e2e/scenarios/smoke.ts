/**
 * Smoke scenario: build the e2e extension, launch it against the anonymized
 * 3-hand fixture, and assert the HUD + popup actually work end to end.
 *
 *   npm run e2e:smoke
 *   tsx e2e/scenarios/smoke.ts [--headed] [--screenshot-dir <dir>] [--fixture <path>] [--viewport <WxH>]
 *
 * On any failure this dumps a screenshot + DOM snapshot before exiting
 * non-zero, so a failed CI/local run always leaves evidence behind.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildE2E } from '../tools/build-e2e.ts'
import { launchHarness, type Harness } from '../harness.ts'
import { DEFAULT_OUTPUT_DIR, DEFAULT_FIXTURE, DEFAULT_VIEWPORT, parseViewport } from '../config.ts'

interface CheckResult {
  name: string
  pass: boolean
  detail?: string
}

const parseArgs = (argv: string[]) => ({
  headed: argv.includes('--headed'),
  screenshotDir: argv.includes('--screenshot-dir')
    ? argv[argv.indexOf('--screenshot-dir') + 1]!
    : DEFAULT_OUTPUT_DIR,
  fixturePath: argv.includes('--fixture')
    ? argv[argv.indexOf('--fixture') + 1]!
    : DEFAULT_FIXTURE,
  viewport: argv.includes('--viewport')
    ? parseViewport(argv[argv.indexOf('--viewport') + 1]!)
    : DEFAULT_VIEWPORT,
})

/**
 * Races `promise` against a timeout so a scenario step that depends on
 * something that may never happen (e.g. the fixture page never opening its
 * WebSocket) fails cleanly with a diagnosable error instead of hanging the
 * whole `npm run e2e:smoke` run forever.
 */
const withTimeout = <T,>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> =>
  new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    )
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value) },
      (err) => { clearTimeout(timer); reject(err) }
    )
  })

const dumpFailureEvidence = async (harness: Harness, screenshotDir: string, label: string): Promise<void> => {
  mkdirSync(screenshotDir, { recursive: true })
  try {
    await harness.screenshot(join(screenshotDir, `smoke-failure-${label}.png`))
  } catch (e) {
    console.error(`[smoke] could not capture failure screenshot: ${(e as Error).message}`)
  }
  try {
    const html = await harness.domSnapshotHtml()
    writeFileSync(join(screenshotDir, `smoke-failure-${label}.html`), html)
  } catch { /* best effort */ }
}

const run = async (): Promise<void> => {
  const { headed, screenshotDir, fixturePath, viewport } = parseArgs(process.argv.slice(2))
  mkdirSync(screenshotDir, { recursive: true })

  console.log('[smoke] building e2e extension (npm run build:e2e logic)...')
  const extensionDir = buildE2E()
  console.log(`[smoke] extension built at ${extensionDir}`)

  console.log(`[smoke] launching harness (viewport ${viewport.width}x${viewport.height}) and replaying fixture...`)
  let harness: Harness | undefined
  const checks: CheckResult[] = []
  const check = (name: string, pass: boolean, detail?: string) => {
    checks.push({ name, pass, detail })
    console.log(`[smoke] ${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`)
  }

  try {
    harness = await launchHarness({ headed, fixturePath, extensionDir, viewport })
    // 1. HUD appears (at least one player panel mounted).
    try {
      await harness.waitForHudMount(20000)
      check('HUD mounts at least one player panel', true)
    } catch (e) {
      check('HUD mounts at least one player panel', false, (e as Error).message)
    }

    try {
      // Bounded: if the fixture page never opens its WebSocket (extension
      // failed to inject, page crashed, etc.) `replayDone` would otherwise
      // never resolve and this script would hang forever instead of
      // dumping evidence and exiting non-zero.
      await withTimeout(harness.waitForReplayDone(), 20000, 'fixture replay')
      check('fixture replay completes', true)
    } catch (e) {
      check('fixture replay completes', false, (e as Error).message)
      await dumpFailureEvidence(harness, screenshotDir, 'replay-timeout')
      console.error(`\n[smoke] FAILED: ${checks.filter((c) => !c.pass).length}/${checks.length} checks failed`)
      process.exitCode = 1
      return
    }
    // Give the background service worker a moment to finish processing the
    // last hand's events and push updated stats down to the content script.
    await new Promise((resolve) => setTimeout(resolve, 1500))

    // Success screenshots are exploratory evidence, not gate assertions.
    // Hosted-runner Xvfb can leave a fully responsive page unable to produce
    // a compositor frame until Puppeteer's 3-minute protocol timeout, so CI
    // keeps only best-effort failure captures while local QA retains both.
    if (!process.env.CI) {
      await harness.screenshot(join(screenshotDir, 'smoke-hud.png'))
    }

    // 2. At least one player panel shows a HAND count > 0. Selects on the
    // stable `data-stat-id="hands"` marker (StatDisplay.tsx / #143's
    // CompactStatDisplay.tsx) rather than the `title` attribute -- #143
    // made `title` a composed tooltip (name + value + helpText, and in
    // compact mode a bare "(n)" text node) instead of a plain "HAND"
    // string, so it's no longer a stable value-extraction target. Full
    // mode's `[data-stat-id="hands"]` is a `div` wrapping "HAND:" + value
    // spans (text like "HAND:67"); compact mode's is a single `span`
    // rendering "(67)". `parseInt` on either textContent skips the
    // non-numeric prefix and finds the count.
    const handCount = await harness.evaluate(() => {
      const cells = Array.from(document.querySelectorAll('[data-stat-id="hands"]'))
      let max = 0
      for (const cell of cells) {
        const match = (cell.textContent || '').match(/\d+/)
        const value = match ? parseInt(match[0], 10) : NaN
        if (!Number.isNaN(value)) max = Math.max(max, value)
      }
      return max
    })
    check('at least one player panel shows HAND > 0', handCount > 0, `max HAND seen = ${handCount}`)

    // 3. Positional drill-down chevron exists.
    const chevronCount = await harness.evaluate(
      () => document.querySelectorAll('button[title="ポジション別スタッツ"]').length
    )
    check('positional drill-down chevron exists', chevronCount > 0, `${chevronCount} chevron(s) found`)

    // 4. Popup opens and renders (no error boundary / blank page).
    // Attach the `pageerror` listener via the pre-navigation hook so it
    // catches errors thrown during the popup's *initial* render, not just
    // ones thrown after `openPopup()` already resolved.
    let popupError: Error | undefined
    const popup = await harness.openPopup((page) => {
      page.on('pageerror', (err) => { popupError = err })
    })
    await new Promise((resolve) => setTimeout(resolve, 1000))
    if (!process.env.CI) {
      // Route through the harness so its just-in-time compositor keepalive is
      // reasserted immediately before capture.
      await harness.screenshot(join(screenshotDir, 'smoke-popup.png'), popup)
    }
    const popupHasContent = await popup.evaluate(() => {
      const root = document.getElementById('popup-root')
      return !!root && root.children.length > 0 && (root.textContent?.trim().length ?? 0) > 0
    })
    check('popup renders content', popupHasContent)
    check('popup has no uncaught render error', !popupError, popupError?.message)

    // Chromeのextension popupは約600pxで高さが頭打ちになる。更新情報が長くても、
    // 最初のHUD設定カードがその初期viewport内に入り、設定操作を始めるために
    // 更新履歴全体をスクロールしなくてよいことを実レイアウトで確認する。
    const firstConfigTop = await popup.evaluate(() => {
      const displayMode = document.querySelector('[aria-label="HUD表示モード"]')
      return displayMode?.closest('.MuiPaper-root')?.getBoundingClientRect().top
    })
    check(
      'first HUD config stays within the initial popup viewport',
      // 600pxぎりぎりでは操作部が数pxしか見えないため、少なくとも50pxの
      // 余裕を確保する。
      typeof firstConfigTop === 'number' && firstConfigTop < 550,
      `top = ${String(firstConfigTop)}px`
    )

    const failures = checks.filter((c) => !c.pass)
    if (failures.length > 0) {
      await dumpFailureEvidence(harness, screenshotDir, 'summary')
      console.error(`\n[smoke] FAILED: ${failures.length}/${checks.length} checks failed`)
      failures.forEach((f) => console.error(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`))
      process.exitCode = 1
      return
    }

    console.log(`\n[smoke] PASSED: all ${checks.length} checks passed`)
    if (process.env.CI) {
      console.log('[smoke] success screenshots skipped in CI; failure evidence remains enabled')
    } else {
      console.log(
        `[smoke] screenshots (viewport ${viewport.width}x${viewport.height}): ` +
        `${join(screenshotDir, 'smoke-hud.png')}, ${join(screenshotDir, 'smoke-popup.png')}`
      )
    }
  } catch (err) {
    console.error('[smoke] unexpected error:', err)
    if (harness) await dumpFailureEvidence(harness, screenshotDir, 'unexpected')
    process.exitCode = 1
  } finally {
    await harness?.close()
  }
}

run()
