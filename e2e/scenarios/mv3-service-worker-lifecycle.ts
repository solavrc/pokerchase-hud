/**
 * Real-extension MV3 lifecycle failure injection.
 *
 * The scenario kills the actual extension Service Worker through CDP while
 * fixture frames are still arriving. It then proves that:
 *   - frames really crossed the stopped-worker window;
 *   - RuntimePortManager reconnect delivered every raw event, exactly once;
 *   - a canonical rebuild recovered every hand from that exact Raw Lake and
 *     returned the shared operation state to idle;
 *   - a second idle eviction restored persisted hero/session state and served
 *     the pre-game HUD without replaying the fixture.
 *
 * No production test hook is used: Chrome performs the worker stop and the
 * normal Port disconnect/reconnect path must recover.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, Page } from 'puppeteer-core'
import { buildE2E } from '../tools/build-e2e.ts'
import {
  launchHarness,
  stopExtensionServiceWorker,
  type Harness
} from '../harness.ts'
import {
  DEFAULT_OUTPUT_DIR,
  DEFAULT_VIEWPORT,
  E2E_DIR,
  parseViewport
} from '../config.ts'

const FIXTURE_PATH = join(E2E_DIR, 'fixtures', 'session-3hands.ndjson')
const MID_REPLAY_RAW_COUNT = 8
const REPLAY_DELAY_MS = 150

interface DbSnapshot {
  rawEvents: Array<Record<string, unknown>>
  handCount: number
}

interface PersistedServiceState {
  playerId?: number
  latestEvtDeal?: { SeatUserIds?: number[] }
  lastUpdated?: number
}

interface RestoredWorkerState {
  isReady: boolean
  playerId?: number
  latestEvtDeal?: { SeatUserIds?: number[] }
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

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

const extensionIdFor = async (browser: Browser): Promise<string> => {
  const target = await browser.waitForTarget(
    (candidate) =>
      candidate.type() === 'service_worker' &&
      candidate.url().startsWith('chrome-extension://'),
    { timeout: 15_000 }
  )
  return new URL(target.url()).host
}

const openTrustedContext = async (browser: Browser, extensionId: string): Promise<Page> => {
  const page = await browser.newPage()
  await page.goto(`chrome-extension://${extensionId}/trusted-context.html`, {
    waitUntil: 'domcontentloaded'
  })
  return page
}

const readDatabase = async (page: Page): Promise<DbSnapshot> =>
  await page.evaluate(async () => {
    // Avoid becoming the creator of an empty unversioned database if this
    // probe wins the race against background bootstrap. Only open after the
    // real extension has created its schema.
    const databases = await indexedDB.databases()
    if (!databases.some((database) => database.name === 'PokerChaseDB')) {
      return { rawEvents: [], handCount: 0 }
    }

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('PokerChaseDB')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
      request.onblocked = () => reject(new Error('IndexedDB open was blocked'))
    })

    try {
      const transaction = db.transaction(['apiEvents', 'hands'], 'readonly')
      const rawRequest = transaction.objectStore('apiEvents').getAll()
      const handCountRequest = transaction.objectStore('hands').count()

      const [rawEvents, handCount] = await Promise.all([
        new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
          rawRequest.onsuccess = () =>
            resolve(rawRequest.result as Array<Record<string, unknown>>)
          rawRequest.onerror = () =>
            reject(rawRequest.error ?? new Error('apiEvents read failed'))
        }),
        new Promise<number>((resolve, reject) => {
          handCountRequest.onsuccess = () => resolve(handCountRequest.result)
          handCountRequest.onerror = () =>
            reject(handCountRequest.error ?? new Error('hands count failed'))
        })
      ])

      return { rawEvents, handCount }
    } finally {
      db.close()
    }
  })

const waitForRawCount = async (
  page: Page,
  predicate: (count: number) => boolean,
  timeoutMs: number,
  label: string
): Promise<DbSnapshot> => {
  const deadline = Date.now() + timeoutMs
  let latest = await readDatabase(page)
  while (!predicate(latest.rawEvents.length) && Date.now() < deadline) {
    await sleep(50)
    latest = await readDatabase(page)
  }
  if (!predicate(latest.rawEvents.length)) {
    throw new Error(`${label}: last raw count was ${latest.rawEvents.length}`)
  }
  return latest
}

const waitForHandCount = async (
  page: Page,
  expectedCount: number,
  timeoutMs: number
): Promise<DbSnapshot> => {
  const deadline = Date.now() + timeoutMs
  let latest = await readDatabase(page)
  while (latest.handCount !== expectedCount && Date.now() < deadline) {
    await sleep(50)
    latest = await readDatabase(page)
  }
  if (latest.handCount !== expectedCount) {
    throw new Error(
      `derived hand count mismatch after restart: expected ${expectedCount}, got ${latest.handCount}`
    )
  }
  return latest
}

const waitForPersistedServiceState = async (
  page: Page,
  expectedPlayerId: number,
  minimumUpdatedAt: number,
  timeoutMs: number
): Promise<PersistedServiceState> => {
  const deadline = Date.now() + timeoutMs
  let state: PersistedServiceState | undefined

  while (Date.now() < deadline) {
    state = await page.evaluate(async () => {
      const result = await chrome.storage.local.get('pokerChaseServiceState')
      return result.pokerChaseServiceState as PersistedServiceState | undefined
    })
    if (
      state?.playerId === expectedPlayerId &&
      state.latestEvtDeal?.SeatUserIds?.includes(expectedPlayerId) &&
      typeof state.lastUpdated === 'number' &&
      state.lastUpdated >= minimumUpdatedAt
    ) {
      return state
    }
    await sleep(50)
  }

  throw new Error(
    `rebuilt service state was not durably persisted before eviction: ${JSON.stringify(state)}`
  )
}

const receivedReplayEventCount = async (harness: Harness): Promise<number> =>
  await harness.evaluate(() =>
    (window as typeof window & { __e2eReplayEvents?: number }).__e2eReplayEvents ?? 0
  )

/**
 * Wakes the evicted worker with a message that does not inspect the database,
 * then reads PokerChaseService after its normal `ready` restoration finishes.
 *
 * This intentionally runs before the no-replay HUD mount. `requestLatestStats`
 * can infer playerId from IndexedDB when service state is absent, so the HUD
 * alone cannot distinguish a successful chrome.storage restore from that
 * fallback. Directly observing the fresh worker here closes that false pass.
 */
const readColdRestoredWorkerState = async (
  browser: Browser,
  trustedPage: Page,
  extensionId: string
): Promise<RestoredWorkerState> => {
  const wakeResponse = await trustedPage.evaluate(
    async () => await chrome.runtime.sendMessage({ action: 'getOperationState' })
  ) as { success?: boolean }
  if (!wakeResponse.success) {
    throw new Error(`failed to wake cold Service Worker: ${JSON.stringify(wakeResponse)}`)
  }

  const target = await browser.waitForTarget(
    async (candidate) => {
      if (
        candidate.type() !== 'service_worker' ||
        !candidate.url().startsWith(`chrome-extension://${extensionId}/`)
      ) {
        return false
      }
      return await candidate.worker() !== null
    },
    { timeout: 15_000 }
  )
  const worker = await target.worker()
  if (!worker) throw new Error('cold Service Worker target has no execution context')

  return await worker.evaluate(async () => {
    const scope = self as typeof self & {
      service?: {
        ready: Promise<void>
        isReady: boolean
        playerId?: number
        latestEvtDeal?: { SeatUserIds?: number[] }
      }
    }
    if (!scope.service) throw new Error('PokerChaseService is not exposed on the worker')
    await scope.service.ready
    return {
      isReady: scope.service.isReady,
      playerId: scope.service.playerId,
      latestEvtDeal: scope.service.latestEvtDeal
        ? { SeatUserIds: scope.service.latestEvtDeal.SeatUserIds }
        : undefined
    }
  })
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    )
  }
  return value
}

const canonicalEvent = (value: Record<string, unknown>): string => {
  // The real WebSocket interceptor deliberately replaces capture timestamps
  // with Date.now() at receipt time. Compare every stable payload field while
  // separately asserting the exact row count, so one loss plus one duplicate
  // still cannot cancel out.
  const {
    sequence: _sequence,
    timestamp: _receiptTimestamp,
    ...event
  } = value
  return JSON.stringify(canonicalize(event))
}

const maxHandCount = async (harness: Harness): Promise<number> =>
  await harness.evaluate(() => {
    const cells = Array.from(document.querySelectorAll('[data-stat-id="hands"]'))
    let max = 0
    for (const cell of cells) {
      const match = (cell.textContent || '').match(/\d+/)
      const value = match ? parseInt(match[0], 10) : NaN
      if (!Number.isNaN(value)) max = Math.max(max, value)
    }
    return max
  })

const dumpFailureEvidence = async (
  harness: Harness,
  screenshotDir: string
): Promise<void> => {
  mkdirSync(screenshotDir, { recursive: true })
  await harness.screenshot(join(screenshotDir, 'mv3-lifecycle-failure.png')).catch(() => {})
  const html = await harness.domSnapshotHtml().catch(() => '')
  if (html) writeFileSync(join(screenshotDir, 'mv3-lifecycle-failure.html'), html)
}

const run = async (): Promise<void> => {
  const { headed, screenshotDir, viewport } = parseArgs(process.argv.slice(2))
  const expectedEvents = readFileSync(FIXTURE_PATH, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const expectedCanonical = expectedEvents.map(canonicalEvent).sort()
  const playerDeal = expectedEvents.find(
    (event) => event.ApiTypeId === 303 && event.Player
  ) as {
    Player?: { SeatIndex?: number }
    SeatUserIds?: number[]
  } | undefined
  const playerSeatIndex = playerDeal?.Player?.SeatIndex
  const expectedPlayerId = typeof playerSeatIndex === 'number'
    ? playerDeal?.SeatUserIds?.[playerSeatIndex]
    : undefined
  if (typeof expectedPlayerId !== 'number' || expectedPlayerId < 0) {
    throw new Error('fixture does not identify a valid hero player')
  }

  console.log('[mv3-lifecycle] building e2e extension...')
  const extensionDir = buildE2E()
  let harness: Harness | undefined

  try {
    harness = await launchHarness({
      headed,
      extensionDir,
      fixturePath: FIXTURE_PATH,
      replayDelayMs: REPLAY_DELAY_MS,
      viewport
    })
    // Do not let the trusted probe page become the first opener of the DB:
    // an unversioned indexedDB.open() before background bootstrap would create
    // an empty v1 database with no stores. HUD mount proves the real extension
    // has initialized its schema and begun consuming the fixture.
    await harness.waitForHudMount(15_000)
    const extensionId = await extensionIdFor(harness.browser)
    const trustedPage = await openTrustedContext(harness.browser, extensionId)

    const beforeStop = await waitForRawCount(
      trustedPage,
      (count) => count >= MID_REPLAY_RAW_COUNT,
      15_000,
      'mid-replay raw threshold'
    )
    if (beforeStop.rawEvents.length >= expectedEvents.length) {
      throw new Error('fixture completed before the mid-replay failure injection')
    }

    const firstStop = await stopExtensionServiceWorker(harness.browser)
    // Capture only after CDP has confirmed `runningStatus: stopped`; frames
    // sent while Chrome was still locating/stopping the worker do not prove
    // the reconnect queue crossed an actual stopped-worker interval.
    const receivedBeforeStop = await receivedReplayEventCount(harness)
    console.log(
      `[mv3-lifecycle] stopped worker ${firstStop.versionId} after ` +
      `${beforeStop.rawEvents.length}/${expectedEvents.length} durable raw rows`
    )

    // RuntimePortManager waits 500ms before reconnecting. The fixture delay
    // guarantees at least one real WebSocket frame arrives inside this
    // stopped-worker window instead of merely testing a stop between events.
    await sleep(350)
    const receivedWhileStopped =
      await receivedReplayEventCount(harness) - receivedBeforeStop
    if (receivedWhileStopped < 1) {
      throw new Error('no page-received fixture frame crossed the stopped-worker window')
    }

    await withTimeout(harness.waitForReplayDone(), 20_000, 'fixture replay')
    const completed = await waitForRawCount(
      trustedPage,
      (count) => count >= expectedEvents.length,
      15_000,
      'post-restart raw drain'
    )

    const actualCanonical = completed.rawEvents.map(canonicalEvent).sort()
    if (actualCanonical.length !== expectedCanonical.length) {
      throw new Error(
        `raw event count mismatch after restart: expected ${expectedCanonical.length}, ` +
        `received ${actualCanonical.length}`
      )
    }
    if (JSON.stringify(actualCanonical) !== JSON.stringify(expectedCanonical)) {
      throw new Error('raw event multiset changed across Service Worker restart')
    }

    // The injected stop deliberately lands inside a hand, so volatile
    // AggregateEventsStream state is not expected to survive. Raw Event Lake
    // is the recovery boundary: a canonical rebuild must deterministically
    // restore every derived hand from the exact raw multiset.
    const persistenceFloor = Date.now()
    const rebuildResponse = await withTimeout(
      trustedPage.evaluate(
        async () => await chrome.runtime.sendMessage({ action: 'rebuildData' })
      ) as Promise<{ success?: boolean, error?: string }>,
      30_000,
      'canonical rebuild after worker restart'
    )
    if (!rebuildResponse.success) {
      throw new Error(`canonical rebuild failed: ${rebuildResponse.error ?? 'unknown error'}`)
    }
    const rebuilt = await waitForHandCount(trustedPage, 3, 5_000)

    const operationResponse = await trustedPage.evaluate(
      async () => await chrome.runtime.sendMessage({ action: 'getOperationState' })
    ) as {
      success?: boolean
      operationState?: { type?: string }
    }
    if (!operationResponse.success || operationResponse.operationState?.type !== 'idle') {
      throw new Error(
        `operation did not return to idle after rebuild: ${JSON.stringify(operationResponse)}`
      )
    }
    await waitForPersistedServiceState(
      trustedPage,
      expectedPlayerId,
      persistenceFloor,
      10_000
    )
    console.log(
      `[mv3-lifecycle] PASS - ${actualCanonical.length} raw events survived exactly once; ` +
      `${receivedWhileStopped} page-received frame(s) crossed the stopped-worker window; ` +
      `${rebuilt.handCount} hands recovered canonically`
    )

    // The poll above proves PokerChaseService's debounced, fire-and-forget
    // storage write completed. Now evict the idle worker and demand a cold
    // restore from a fresh mount.
    const secondStop = await stopExtensionServiceWorker(harness.browser)
    console.log(`[mv3-lifecycle] stopped idle worker ${secondStop.versionId}`)

    const restoredWorkerState = await readColdRestoredWorkerState(
      harness.browser,
      trustedPage,
      extensionId
    )
    if (
      !restoredWorkerState.isReady ||
      restoredWorkerState.playerId !== expectedPlayerId ||
      !restoredWorkerState.latestEvtDeal?.SeatUserIds?.includes(expectedPlayerId)
    ) {
      throw new Error(
        'cold worker did not restore persisted hero/deal state before DB fallback: ' +
        JSON.stringify(restoredWorkerState)
      )
    }

    await harness.gamePage.goto(`${harness.fixtureServer.origin}/no-replay.html`, {
      waitUntil: 'domcontentloaded'
    })
    await harness.waitForHudMount(20_000)
    await sleep(1_000)
    const restoredHandCount = await maxHandCount(harness)
    if (restoredHandCount !== rebuilt.handCount) {
      throw new Error(
        `cold-restored pre-game HUD is incomplete: expected ${rebuilt.handCount}, ` +
        `got ${restoredHandCount}`
      )
    }

    const afterRestore = await readDatabase(trustedPage)
    if (afterRestore.rawEvents.length !== expectedEvents.length) {
      throw new Error(
        `idle restart changed raw event count: expected ${expectedEvents.length}, ` +
        `got ${afterRestore.rawEvents.length}`
      )
    }
    console.log(
      `[mv3-lifecycle] PASS - idle worker restart restored HUD state ` +
      `(max HAND ${restoredHandCount}) without replay or duplicate raw rows`
    )
    console.log('[mv3-lifecycle] PASSED: all MV3 lifecycle invariants held')
  } catch (error) {
    console.error('[mv3-lifecycle] FAILED:', error)
    if (harness) await dumpFailureEvidence(harness, screenshotDir)
    process.exitCode = 1
  } finally {
    await harness?.close()
  }
}

run()
