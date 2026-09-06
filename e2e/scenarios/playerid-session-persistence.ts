/**
 * セッション終了後にheroのplayerIdが失われる不具合の回帰シナリオ。
 * （現地報告: sola, 2026-07-20。src/AGENTS.md「実行環境と表示側への境界」と
 * src/streams/aggregate-events-stream.tsのEVT_DEAL caseにある修正コメントを参照。）
 *
 * 実際にbuildした拡張機能を実Chromiumで動かし、現地で起きた順序をend-to-endに
 * 再現する。テストから状態を手作業で加工したり、`chrome.storage.local`や
 * `service.playerId`を直接変更したりしてはならない（MUST NOT）。
 *
 *   1. 通常のハンドを進めた後、「観戦モード」のEVT_DEAL（`Player` fieldがない
 *      303。heroはbust済みで、clientは別tableを観戦中）、最後にセッション終了の
 *      EVT_SESSION_RESULTS（309）を含むfixtureをreplayする。
 *      e2e/fixtures/session-3hands-spectator-end.ndjson参照。
 *   2. 同じbrowser tabをno-replay.htmlへ遷移させる。live eventが0件の新しいHUD
 *      mountでも、background service workerとそのchrome.storage.local / IndexedDB
 *      stateは遷移を越えて残る（MUST）。これはセッション終了後にsolaがbrowserをreloadした
 *      現地手順と同じである。
 *   3. 他の入力がない状態でhero自身のpanel（seat 0）に実career stats
 *      （HAND > 0）が表示されることを確認する。これはpregame hero statsのfallback
 *      （`#158`、`getLatestSessionStats({ preGame: true })`、
 *      background/import-export.ts）であり、手順1〜2を通して`service.playerId`が
 *      保持された場合だけ動作する。
 *
 *   npm run e2e:playerid
 *   tsx e2e/scenarios/playerid-session-persistence.ts [--headed] [--screenshot-dir <dir>]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildE2E } from '../tools/build-e2e.ts'
import { launchHarness, type Harness } from '../harness.ts'
import { DEFAULT_OUTPUT_DIR, DEFAULT_VIEWPORT, E2E_DIR, parseViewport } from '../config.ts'

const FIXTURE_PATH = join(E2E_DIR, 'fixtures', 'session-3hands-spectator-end.ndjson')

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
  viewport: argv.includes('--viewport')
    ? parseViewport(argv[argv.indexOf('--viewport') + 1]!)
    : DEFAULT_VIEWPORT,
})

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
    await harness.screenshot(join(screenshotDir, `playerid-failure-${label}.png`))
  } catch (e) {
    console.error(`[playerid] could not capture failure screenshot: ${(e as Error).message}`)
  }
  try {
    const html = await harness.domSnapshotHtml()
    writeFileSync(join(screenshotDir, `playerid-failure-${label}.html`), html)
  } catch { /* best effort */ }
}

const maxHandCount = (harness: Harness) => harness.evaluate(() => {
  const cells = Array.from(document.querySelectorAll('[data-stat-id="hands"]'))
  let max = 0
  for (const cell of cells) {
    const match = (cell.textContent || '').match(/\d+/)
    const value = match ? parseInt(match[0], 10) : NaN
    if (!Number.isNaN(value)) max = Math.max(max, value)
  }
  return max
})

const run = async (): Promise<void> => {
  const { headed, screenshotDir, viewport } = parseArgs(process.argv.slice(2))
  mkdirSync(screenshotDir, { recursive: true })

  console.log('[playerid] building e2e extension...')
  const extensionDir = buildE2E()
  console.log(`[playerid] extension built at ${extensionDir}`)

  console.log(`[playerid] launching harness and replaying ${FIXTURE_PATH} (includes spectator-mode EVT_DEAL + EVT_SESSION_RESULTS/309)...`)
  let harness: Harness | undefined
  const checks: CheckResult[] = []
  const check = (name: string, pass: boolean, detail?: string) => {
    checks.push({ name, pass, detail })
    console.log(`[playerid] ${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`)
  }

  try {
    harness = await launchHarness({ headed, fixturePath: FIXTURE_PATH, extensionDir, viewport })

    // --- Phase 1: live session, ending in a spectator-mode deal + 309 ---
    try {
      await harness.waitForHudMount(20000)
      check('phase1: HUD mounts during live replay', true)
    } catch (e) {
      check('phase1: HUD mounts during live replay', false, (e as Error).message)
    }

    try {
      await withTimeout(harness.waitForReplayDone(), 20000, 'fixture replay')
      check('phase1: fixture replay completes (through session end 309)', true)
    } catch (e) {
      check('phase1: fixture replay completes (through session end 309)', false, (e as Error).message)
      await dumpFailureEvidence(harness, screenshotDir, 'replay-timeout')
      process.exitCode = 1
      return
    }

    // Give the background service worker time to process the trailing
    // events (spectator deal, 309) and flush its 500ms-debounced
    // chrome.storage.local persist of service.playerId -- see
    // PokerChaseService.persistState().
    await new Promise((resolve) => setTimeout(resolve, 1500))

    // NOTE (codex #177 P2): we intentionally do NOT assert `HAND > 0` here.
    // The fixture's final EVT_DEAL (303) is a spectator-mode deal with lineup
    // [2001,2002,2003,-1,-1,-1] (hero absent). AggregateEventsStream calls
    // `statsOutputStream.write(event.SeatUserIds)` for every EVT_DEAL once the
    // DB has hands (see aggregate-events-stream.ts's unconditional DB-count
    // check), regardless of whether `Player` is present -- so by the time this
    // 1.5s wait elapses, the live HUD has already been overwritten with stats
    // for the spectated table's playerIds (2001/2002/2003), which have no
    // history and render HAND=0. That is correct, current behavior (not a
    // regression this scenario is about) -- the pre-fix bug and its fix are
    // about whether `service.playerId`/`service.latestEvtDeal` survive this
    // spectator deal internally, not about what the live panel happens to
    // show for an unrelated table at this instant. The actual regression this
    // scenario guards is the POST-reload hero panel below, which is driven by
    // the #158 pre-game fallback (`getLatestSessionStats({ preGame: true })`)
    // and depends only on `service.playerId` having survived. We still
    // capture a screenshot here for debugging.
    await harness.screenshot(join(screenshotDir, 'playerid-before-reload.png'))

    // --- Phase 2: "browser reload" -- navigate to a fresh mount with zero
    // live events. Same tab/browser/extension instance, so the background
    // service worker's storage/DB survive (this is NOT a new harness
    // launch) -- exactly like sola's real reload after the session ended. ---
    console.log('[playerid] navigating to no-replay.html (fresh HUD mount, zero live events -- simulates sola\'s browser reload)...')
    await harness.gamePage.goto(`${harness.fixtureServer.origin}/no-replay.html`, { waitUntil: 'domcontentloaded' })

    try {
      await harness.waitForHudMount(20000)
      check('phase2: HUD mounts on no-replay.html with zero live events', true)
    } catch (e) {
      check('phase2: HUD mounts on no-replay.html with zero live events', false, (e as Error).message)
      await dumpFailureEvidence(harness, screenshotDir, 'no-replay-no-mount')
      process.exitCode = 1
      return
    }

    // A moment for the preGame:true requestLatestStats round-trip
    // (content_script.ts -> background -> getLatestSessionStats) to land.
    await new Promise((resolve) => setTimeout(resolve, 1000))

    const postReloadHandCount = await maxHandCount(harness)
    check(
      'phase2: hero panel (#158 pre-game stats) renders real HAND count WITHOUT any manual state surgery',
      postReloadHandCount > 0,
      `max HAND seen = ${postReloadHandCount}`
    )

    await harness.screenshot(join(screenshotDir, 'playerid-no-replay-hud.png'))
    const domText = await harness.domSnapshotText()
    writeFileSync(join(screenshotDir, 'playerid-no-replay-hud.txt'), domText)
    console.log(`[playerid] no-replay.html DOM text snapshot: ${join(screenshotDir, 'playerid-no-replay-hud.txt')}`)

    const failures = checks.filter((c) => !c.pass)
    if (failures.length > 0) {
      await dumpFailureEvidence(harness, screenshotDir, 'summary')
      console.error(`\n[playerid] FAILED: ${failures.length}/${checks.length} checks failed`)
      failures.forEach((f) => console.error(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`))
      process.exitCode = 1
      return
    }

    console.log(`\n[playerid] PASSED: all ${checks.length} checks passed`)
    console.log(
      `[playerid] screenshots: ${join(screenshotDir, 'playerid-before-reload.png')}, ` +
      `${join(screenshotDir, 'playerid-no-replay-hud.png')}`
    )
  } catch (err) {
    console.error('[playerid] unexpected error:', err)
    if (harness) await dumpFailureEvidence(harness, screenshotDir, 'unexpected')
    process.exitCode = 1
  } finally {
    await harness?.close()
  }
}

run()
