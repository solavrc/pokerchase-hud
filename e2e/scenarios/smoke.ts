/**
 * Smoke scenario: build the e2e extension, launch it against the anonymized
 * 3-hand fixture, and assert the HUD + popup actually work end to end.
 *
 *   npm run e2e:smoke
 *   tsx e2e/scenarios/smoke.ts [--headed] [--screenshot-dir <dir>] [--fixture <path>]
 *
 * On any failure this dumps a screenshot + DOM snapshot before exiting
 * non-zero, so a failed CI/local run always leaves evidence behind.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildE2E } from '../tools/build-e2e.ts'
import { launchHarness, type Harness } from '../harness.ts'
import { DEFAULT_OUTPUT_DIR, DEFAULT_FIXTURE } from '../config.ts'

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
  const { headed, screenshotDir, fixturePath } = parseArgs(process.argv.slice(2))
  mkdirSync(screenshotDir, { recursive: true })

  console.log('[smoke] building e2e extension (npm run build:e2e logic)...')
  const extensionDir = buildE2E()
  console.log(`[smoke] extension built at ${extensionDir}`)

  console.log('[smoke] launching harness and replaying fixture...')
  let harness: Harness | undefined
  const checks: CheckResult[] = []
  const check = (name: string, pass: boolean, detail?: string) => {
    checks.push({ name, pass, detail })
    console.log(`[smoke] ${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`)
  }

  try {
    harness = await launchHarness({ headed, fixturePath, extensionDir })
    // 1. HUD appears (at least one player panel mounted).
    try {
      await harness.waitForHudMount(20000)
      check('HUD mounts at least one player panel', true)
    } catch (e) {
      check('HUD mounts at least one player panel', false, (e as Error).message)
    }

    await harness.waitForReplayDone()
    // Give the background service worker a moment to finish processing the
    // last hand's events and push updated stats down to the content script.
    await new Promise((resolve) => setTimeout(resolve, 1500))

    await harness.screenshot(join(screenshotDir, 'smoke-hud.png'))

    // 2. At least one player panel shows a HAND count > 0.
    const handCount = await harness.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('span[title="HAND"]'))
      let max = 0
      for (const label of labels) {
        const valueEl = label.nextElementSibling
        const value = valueEl ? parseInt(valueEl.textContent || '', 10) : NaN
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
    const popup = await harness.openPopup()
    let popupError: Error | undefined
    popup.on('pageerror', (err) => { popupError = err })
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await popup.screenshot({ path: join(screenshotDir, 'smoke-popup.png') as `${string}.png` })
    const popupHasContent = await popup.evaluate(() => {
      const root = document.getElementById('popup-root')
      return !!root && root.children.length > 0 && (root.textContent?.trim().length ?? 0) > 0
    })
    check('popup renders content', popupHasContent)
    check('popup has no uncaught render error', !popupError, popupError?.message)

    const failures = checks.filter((c) => !c.pass)
    if (failures.length > 0) {
      await dumpFailureEvidence(harness, screenshotDir, 'summary')
      console.error(`\n[smoke] FAILED: ${failures.length}/${checks.length} checks failed`)
      failures.forEach((f) => console.error(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`))
      process.exitCode = 1
      return
    }

    console.log(`\n[smoke] PASSED: all ${checks.length} checks passed`)
    console.log(`[smoke] screenshots: ${join(screenshotDir, 'smoke-hud.png')}, ${join(screenshotDir, 'smoke-popup.png')}`)
  } catch (err) {
    console.error('[smoke] unexpected error:', err)
    if (harness) await dumpFailureEvidence(harness, screenshotDir, 'unexpected')
    process.exitCode = 1
  } finally {
    await harness?.close()
  }
}

run()
