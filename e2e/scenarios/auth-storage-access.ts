/**
 * Real-Chrome boundary test for persisted Firebase REST credentials.
 *
 * Verifies all three security/compatibility invariants:
 *   1. the injected content-script world cannot read chrome.storage.local;
 *   2. the same content-script world can still read chrome.storage.sync,
 *      where its HUD settings live;
 *   3. a persisted legacy/untrusted access level is re-restricted on browser
 *      restart while trusted pages and the Service Worker restore auth.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'puppeteer-core'
import { buildE2E } from '../tools/build-e2e.ts'
import { launchHarness, type Harness } from '../harness.ts'

interface ContextProbe {
  runtimeId: string | null
  hasLocal: boolean
}

interface StorageRead {
  value?: Record<string, unknown>
  error?: string
}

const AUTH_KEY = 'firebaseRestAuthState'
const SYNC_PROBE_KEY = 'authStorageSyncProbe'
const SYNTHETIC_STATE = {
  uid: 'e2e-auth-storage-user',
  email: 'synthetic-auth-storage@example.com',
  displayName: 'Synthetic Auth Storage User',
  photoURL: null,
  idToken: 'synthetic-id-token-not-a-real-credential',
  refreshToken: 'synthetic-refresh-token-not-a-real-credential',
  expiresAt: 4_102_444_800_000
}

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

const evaluateInContentScript = async <T>(
  page: Page,
  extensionId: string,
  expression: string
): Promise<T> => {
  const session = await page.createCDPSession()
  const contexts: Array<{ id: number }> = []
  session.on('Runtime.executionContextCreated', ({ context }) => {
    contexts.push({ id: context.id })
  })
  await session.send('Runtime.enable')

  try {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      for (const context of contexts) {
        try {
          const probe = await session.send('Runtime.evaluate', {
            contextId: context.id,
            expression:
              '({ runtimeId: globalThis.chrome?.runtime?.id ?? null, ' +
              'hasLocal: Boolean(globalThis.chrome?.storage?.local) })',
            returnByValue: true
          })
          const value = probe.result.value as ContextProbe | undefined
          if (value?.runtimeId !== extensionId) continue

          const evaluated = await session.send('Runtime.evaluate', {
            contextId: context.id,
            expression,
            awaitPromise: true,
            returnByValue: true
          })
          return evaluated.result.value as T
        } catch {
          // A navigation can invalidate a context between discovery and use.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('Could not find the injected extension content-script execution context')
  } finally {
    await session.detach()
  }
}

const assertContentBoundary = async (harness: Harness, extensionId: string): Promise<void> => {
  const localRead = await evaluateInContentScript<StorageRead>(
    harness.gamePage,
    extensionId,
    `(async () => {
      try {
        return { value: await chrome.storage.local.get(${JSON.stringify(AUTH_KEY)}) }
      } catch (error) {
        return { error: String(error) }
      }
    })()`
  )
  if (localRead.value?.[AUTH_KEY] !== undefined) {
    throw new Error('content script exposed firebaseRestAuthState from chrome.storage.local')
  }
  if (!localRead.error?.includes('Access to storage is not allowed from this context')) {
    throw new Error(
      `content script did not receive the expected local-storage denial: ${JSON.stringify(localRead)}`
    )
  }

  const syncRead = await evaluateInContentScript<StorageRead>(
    harness.gamePage,
    extensionId,
    `(async () => {
      try {
        return { value: await chrome.storage.sync.get(${JSON.stringify(SYNC_PROBE_KEY)}) }
      } catch (error) {
        return { error: String(error) }
      }
    })()`
  )
  if (syncRead.value?.[SYNC_PROBE_KEY] !== 'sync-remains-visible') {
    throw new Error(
      `content script lost required chrome.storage.sync access: ${JSON.stringify(syncRead)}`
    )
  }
}

const stageLegacyUntrustedAccess = async (
  harness: Harness,
  trustedPage: Page,
  extensionId: string
): Promise<void> => {
  await trustedPage.evaluate(async () => {
    await chrome.storage.local.setAccessLevel({
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS'
    })
  })
  const exposed = await evaluateInContentScript<StorageRead>(
    harness.gamePage,
    extensionId,
    `(async () => ({ value: await chrome.storage.local.get(${JSON.stringify(AUTH_KEY)}) }))()`
  )
  if (exposed.value?.[AUTH_KEY] === undefined) {
    throw new Error(
      `could not stage the legacy content-script-readable state: ${JSON.stringify(exposed)}`
    )
  }
}

const run = async (): Promise<void> => {
  const extensionDir = buildE2E()
  const profileDir = mkdtempSync(join(tmpdir(), 'pokerchase-hud-auth-storage-'))
  let harness: Harness | undefined

  try {
    harness = await launchHarness({ extensionDir, userDataDir: profileDir })
    const extensionId = await extensionIdFor(harness.browser)
    const trustedPage = await openTrustedContext(harness.browser, extensionId)

    await trustedPage.evaluate(
      async (authKey, authState, syncProbeKey) => {
        await chrome.storage.local.set({
          [authKey]: authState,
          [`autoSyncLastTime:${authState.uid}`]: new Date().toISOString()
        })
        await chrome.storage.sync.set({ [syncProbeKey]: 'sync-remains-visible' })
      },
      AUTH_KEY,
      SYNTHETIC_STATE,
      SYNC_PROBE_KEY
    )

    const trustedRead = await trustedPage.evaluate(
      async (authKey) => await chrome.storage.local.get(authKey),
      AUTH_KEY
    )
    if (trustedRead[AUTH_KEY]?.idToken !== SYNTHETIC_STATE.idToken) {
      throw new Error('trusted extension page could not read persisted auth state')
    }

    await assertContentBoundary(harness, extensionId)
    console.log('[auth-storage] PASS - content script denied local auth and retained sync settings')

    // Simulate a profile left by the vulnerable version: both credentials and
    // the default untrusted local-area access level persist across restart.
    // The fixed Service Worker must re-establish TRUSTED_CONTEXTS before it
    // restores those credentials.
    await stageLegacyUntrustedAccess(harness, trustedPage, extensionId)
    await trustedPage.close()
    await harness.close()
    harness = undefined

    harness = await launchHarness({ extensionDir, userDataDir: profileDir })
    // Assert the upgraded profile's boundary before an explicit auth-status
    // message or popup navigation deliberately wakes/uses the Service Worker.
    await assertContentBoundary(harness, extensionId)
    const restartedExtensionId = await extensionIdFor(harness.browser)
    if (restartedExtensionId !== extensionId) {
      throw new Error(`extension id changed across restart: ${extensionId} -> ${restartedExtensionId}`)
    }

    const restartedTrustedPage = await openTrustedContext(harness.browser, restartedExtensionId)
    const authStatus = await restartedTrustedPage.evaluate(
      async () => await chrome.runtime.sendMessage({ action: 'firebaseAuthStatus' })
    ) as {
      success?: boolean
      isSignedIn?: boolean
      userInfo?: { uid?: string, email?: string | null }
      error?: string
    }
    if (
      !authStatus.success ||
      !authStatus.isSignedIn ||
      authStatus.userInfo?.uid !== SYNTHETIC_STATE.uid ||
      authStatus.userInfo.email !== SYNTHETIC_STATE.email
    ) {
      throw new Error(`Service Worker did not restore auth after restart: ${JSON.stringify(authStatus)}`)
    }

    const popup = await harness.openPopup()
    await popup.waitForFunction(
      (email) => document.body.innerText.includes(email),
      { timeout: 15_000 },
      SYNTHETIC_STATE.email
    )

    console.log('[auth-storage] PASS - Service Worker and popup restored auth after browser restart')
    console.log('[auth-storage] PASSED: all real-Chrome storage boundary checks passed')
  } finally {
    await harness?.close()
    rmSync(profileDir, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error('[auth-storage] FAILED:', error)
  process.exitCode = 1
})
