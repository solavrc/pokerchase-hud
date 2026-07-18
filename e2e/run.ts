#!/usr/bin/env -S npx tsx
/**
 * Step-by-step CLI for the E2E QA harness -- the primary interface for an
 * AI agent (or a human) doing exploratory QA: launch once, then issue any
 * number of small commands against the *same* running browser/HUD, in any
 * order, with normal shell tool calls.
 *
 *   npx tsx e2e/run.ts launch [--headed] [--fixture <path>] [--replay-delay <ms>] [--build]
 *   npx tsx e2e/run.ts status
 *   npx tsx e2e/run.ts wait-hud [--timeout <ms>]
 *   npx tsx e2e/run.ts screenshot <out.png>
 *   npx tsx e2e/run.ts dom-text
 *   npx tsx e2e/run.ts dom-html
 *   npx tsx e2e/run.ts eval "<js expression, evaluated in the fixture page>"
 *   npx tsx e2e/run.ts popup-screenshot <out.png>
 *   npx tsx e2e/run.ts close
 *
 * `launch` starts a detached background process (so it survives the CLI
 * invocation that started it) hosting the fixture server + Chrome, and
 * records its CDP WebSocket endpoint in e2e/.build/session.json. Every
 * other subcommand connects to that same browser via
 * `puppeteer.connect()`, so state (HUD, hand log, drilldown panels you've
 * opened, etc.) persists across calls until you run `close`.
 */
import { spawn, execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchHarness, attachHarness } from './harness.ts'
import { buildE2E } from './tools/build-e2e.ts'
import { BUILD_DIR, DEFAULT_FIXTURE, DEFAULT_OUTPUT_DIR, E2E_DIR } from './config.ts'

const SESSION_FILE = join(BUILD_DIR, 'session.json')

interface SessionState {
  browserWSEndpoint: string
  fixtureOrigin: string
  pid: number
  fixturePath: string
  startedAt: string
}

const readSession = (): SessionState => {
  if (!existsSync(SESSION_FILE)) {
    throw new Error(`No active session (${SESSION_FILE} not found). Run "launch" first.`)
  }
  return JSON.parse(readFileSync(SESSION_FILE, 'utf-8'))
}

const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

// --- `--daemon` mode: runs as a detached background process, keeps the
// browser + fixture server alive, and exits cleanly on SIGTERM (sent by the
// `close` subcommand). Not meant to be invoked directly. ---------------
const runDaemon = async (argv: string[]): Promise<void> => {
  const headed = argv.includes('--headed')
  const fixturePath = flag(argv, '--fixture') ?? DEFAULT_FIXTURE
  const replayDelayMs = flag(argv, '--replay-delay') ? Number(flag(argv, '--replay-delay')) : 0

  const harness = await launchHarness({ headed, fixturePath, replayDelayMs })
  const state: SessionState = {
    browserWSEndpoint: harness.browser.wsEndpoint(),
    fixtureOrigin: harness.fixtureServer.origin,
    pid: process.pid,
    fixturePath,
    startedAt: new Date().toISOString(),
  }
  mkdirSync(BUILD_DIR, { recursive: true })
  writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2))
  console.error(`[run daemon] ready: ${JSON.stringify(state)}`)

  const shutdown = async () => {
    await harness.close().catch(() => {})
    rmSync(SESSION_FILE, { force: true })
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  await new Promise(() => {}) // keep alive until killed
}

// --- public subcommands -------------------------------------------------

const cmdLaunch = async (argv: string[]): Promise<void> => {
  if (existsSync(SESSION_FILE)) {
    console.error(`A session already looks active (${SESSION_FILE} exists). Run "close" first, or delete the file if it's stale.`)
    process.exitCode = 1
    return
  }
  if (argv.includes('--build')) {
    console.log('[run launch] building e2e extension...')
    buildE2E()
  } else if (!existsSync(join(BUILD_DIR, 'extension', 'manifest.json'))) {
    console.log('[run launch] no e2e build found, building (pass --build explicitly to always rebuild)...')
    buildE2E()
  }

  // Resolve `--fixture` against the invoker's cwd *before* daemonizing --
  // the daemon child process runs with `cwd: E2E_DIR`, so a relative path
  // (e.g. the documented `e2e/fixtures/session-3hands.ndjson`, typed from
  // the repo root) would otherwise be re-resolved from inside `e2e/`,
  // silently looking under `e2e/e2e/fixtures/...` and failing to start.
  const invokerCwd = process.cwd()
  const daemonArgv = [...argv]
  const fixtureFlagIndex = daemonArgv.indexOf('--fixture')
  if (fixtureFlagIndex >= 0 && daemonArgv[fixtureFlagIndex + 1] !== undefined) {
    const rawFixturePath = daemonArgv[fixtureFlagIndex + 1]!
    daemonArgv[fixtureFlagIndex + 1] = isAbsolute(rawFixturePath)
      ? rawFixturePath
      : resolve(invokerCwd, rawFixturePath)
  }

  console.log('[run launch] starting detached session daemon...')
  const runScript = fileURLToPath(import.meta.url)
  const child = spawn('npx', ['tsx', runScript, '--daemon', ...daemonArgv], {
    cwd: E2E_DIR,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  // Poll for the session file the daemon writes once Chrome + the fixture
  // server are up.
  const deadline = Date.now() + 30000
  while (!existsSync(SESSION_FILE)) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the session daemon to start')
    await new Promise((r) => setTimeout(r, 100))
  }
  const state = readSession()
  console.log(`[run launch] session ready (pid ${state.pid}): ${state.fixtureOrigin}`)
  console.log('[run launch] next: npx tsx e2e/run.ts wait-hud')
}

const cmdStatus = async (): Promise<void> => {
  if (!existsSync(SESSION_FILE)) {
    console.log('no active session')
    return
  }
  console.log(JSON.stringify(readSession(), null, 2))
}

const cmdWaitHud = async (argv: string[]): Promise<void> => {
  const session = readSession()
  const h = await attachHarness(session.browserWSEndpoint, session.fixtureOrigin)
  const timeout = flag(argv, '--timeout') ? Number(flag(argv, '--timeout')) : 15000
  await h.waitForHudMount(timeout)
  console.log('HUD mounted')
  h.browser.disconnect()
}

const cmdScreenshot = async (argv: string[]): Promise<void> => {
  const outPath = argv[0] ?? join(DEFAULT_OUTPUT_DIR, `screenshot-${Date.now()}.png`)
  const session = readSession()
  const h = await attachHarness(session.browserWSEndpoint, session.fixtureOrigin)
  await h.screenshot(outPath)
  console.log(outPath)
  h.browser.disconnect()
}

const cmdPopupScreenshot = async (argv: string[]): Promise<void> => {
  const outPath = argv[0] ?? join(DEFAULT_OUTPUT_DIR, `popup-${Date.now()}.png`)
  const session = readSession()
  const h = await attachHarness(session.browserWSEndpoint, session.fixtureOrigin)
  const popup = await h.openPopup()
  await new Promise((r) => setTimeout(r, 500))
  mkdirSync(join(outPath, '..'), { recursive: true })
  await popup.screenshot({ path: outPath as `${string}.png` })
  console.log(outPath)
  h.browser.disconnect()
}

const cmdDomText = async (): Promise<void> => {
  const session = readSession()
  const h = await attachHarness(session.browserWSEndpoint, session.fixtureOrigin)
  console.log(await h.domSnapshotText())
  h.browser.disconnect()
}

const cmdDomHtml = async (): Promise<void> => {
  const session = readSession()
  const h = await attachHarness(session.browserWSEndpoint, session.fixtureOrigin)
  console.log(await h.domSnapshotHtml())
  h.browser.disconnect()
}

const cmdEval = async (argv: string[]): Promise<void> => {
  const expression = argv.join(' ')
  if (!expression.trim()) throw new Error('Usage: run.ts eval "<js expression>"')
  const session = readSession()
  const h = await attachHarness(session.browserWSEndpoint, session.fixtureOrigin)
  // eslint-disable-next-line no-new-func
  const result = await h.gamePage.evaluate(new Function(`return (${expression})`) as any)
  console.log(JSON.stringify(result, null, 2))
  h.browser.disconnect()
}

/**
 * Best-effort check that `pid` is still our session daemon before we send it
 * a signal. If `session.json` is stale (the daemon crashed without cleaning
 * up) the OS may since have reused that PID for an unrelated process; a bare
 * `process.kill(pid)` would then SIGTERM a stranger. We only have a PID (not
 * a full process handle) to go on, so verify identity by inspecting the
 * live process's command line for markers unique to how the daemon was
 * spawned (this file's path, invoked with `--daemon`).
 */
const isOurDaemonProcess = (pid: number): boolean => {
  try {
    const command = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf-8' }).trim()
    if (!command) return false // no such process
    return command.includes('run.ts') && command.includes('--daemon')
  } catch {
    // `ps` exits non-zero when the PID doesn't exist -- treat as "not ours".
    return false
  }
}

const cmdClose = async (): Promise<void> => {
  if (!existsSync(SESSION_FILE)) {
    console.log('no active session')
    return
  }
  const session = readSession()
  if (!isOurDaemonProcess(session.pid)) {
    console.error(
      `[run close] pid ${session.pid} from ${SESSION_FILE} is no longer (or never was) the session daemon -- ` +
      'not signaling it, just clearing the stale session file.'
    )
    rmSync(SESSION_FILE, { force: true })
    return
  }
  try {
    process.kill(session.pid, 'SIGTERM')
  } catch (e) {
    console.error(`[run close] could not signal pid ${session.pid}: ${(e as Error).message}`)
  }
  // The daemon removes the session file itself on clean shutdown; wait
  // briefly for that, then force-remove as a fallback.
  const deadline = Date.now() + 5000
  while (existsSync(SESSION_FILE) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }
  rmSync(SESSION_FILE, { force: true })
  console.log('session closed')
}

const HELP = `Usage: npx tsx e2e/run.ts <command> [args]

Commands:
  launch [--headed] [--fixture <path>] [--replay-delay <ms>] [--build]
  status
  wait-hud [--timeout <ms>]
  screenshot [out.png]
  popup-screenshot [out.png]
  dom-text
  dom-html
  eval "<js expression>"
  close
`

const main = async (): Promise<void> => {
  const [, , cmd, ...rest] = process.argv
  if (cmd === '--daemon') return runDaemon(rest)

  switch (cmd) {
    case 'launch': return cmdLaunch(rest)
    case 'status': return cmdStatus()
    case 'wait-hud': return cmdWaitHud(rest)
    case 'screenshot': return cmdScreenshot(rest)
    case 'popup-screenshot': return cmdPopupScreenshot(rest)
    case 'dom-text': return cmdDomText()
    case 'dom-html': return cmdDomHtml()
    case 'eval': return cmdEval(rest)
    case 'close': return cmdClose()
    default:
      console.log(HELP)
      process.exitCode = cmd ? 1 : 0
  }
}

main().catch((err) => {
  console.error(`[run] ${err.message}`)
  process.exitCode = 1
})
