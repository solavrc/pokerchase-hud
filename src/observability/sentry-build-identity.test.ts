/**
 * A working build must never claim the published release's identity: its stack
 * traces would be resolved against source maps uploaded for different code, and
 * its events would be counted toward the release users actually run.
 * scripts/build-extension.ts injects both values; jest exercises the same
 * process.env reads directly.
 */
import * as Sentry from '@sentry/browser'
import manifest from '../../manifest.json'

jest.mock('@sentry/browser', () => ({
  init: jest.fn(),
  close: jest.fn().mockResolvedValue(true),
  globalHandlersIntegration: jest.fn(() => ({ name: 'GlobalHandlers' })),
  linkedErrorsIntegration: jest.fn(() => ({ name: 'LinkedErrors' })),
  dedupeIntegration: jest.fn(() => ({ name: 'Dedupe' })),
  withScope: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn()
}))

const startBackgroundSentry = async (
  build: { release?: string, environment?: string }
) => {
  process.env.SENTRY_ENABLED = 'true'
  if (build.release) process.env.SENTRY_RELEASE = build.release
  else delete process.env.SENTRY_RELEASE
  if (build.environment) process.env.SENTRY_ENVIRONMENT = build.environment
  else delete process.env.SENTRY_ENVIRONMENT

  await chrome.storage.local.set({ sentryTelemetryConsent: true })
  ;(chrome.permissions.contains as jest.Mock).mockResolvedValue(true)

  let init: jest.Mock | undefined
  await jest.isolateModulesAsync(async () => {
    init = require('@sentry/browser').init
    const { initSentry } = require('./sentry')
    await initSentry('background')
  })
  return init as jest.Mock
}

describe('Sentry build identity', () => {
  // Only clears call records; test-setup.ts owns the chrome mock behaviours.
  beforeEach(() => { jest.clearAllMocks() })

  afterEach(() => {
    delete process.env.SENTRY_ENABLED
    delete process.env.SENTRY_RELEASE
    delete process.env.SENTRY_ENVIRONMENT
  })

  it('reports a release build under the plain versioned release', async () => {
    const init = await startBackgroundSentry({
      release: `pokerchase-hud@${manifest.version}`,
      environment: 'production'
    })

    expect(init).toHaveBeenCalledWith(expect.objectContaining({
      release: `pokerchase-hud@${manifest.version}`,
      environment: 'production'
    }))
  })

  it('keeps a working build off the published release identity', async () => {
    const init = await startBackgroundSentry({
      release: `pokerchase-hud@${manifest.version}+dev.abc1234-dirty`,
      environment: 'development'
    })

    expect(init).toHaveBeenCalledWith(expect.objectContaining({
      release: `pokerchase-hud@${manifest.version}+dev.abc1234-dirty`,
      environment: 'development'
    }))
    const [{ release }] = init.mock.calls.at(-1) as [{ release: string }]
    expect(release).not.toBe(`pokerchase-hud@${manifest.version}`)
  })

  it('defaults to development when the build injected nothing', async () => {
    const init = await startBackgroundSentry({})

    // Never fall back to `production`: an un-injected build is, by definition,
    // not the release whose source maps are on file.
    expect(init).toHaveBeenCalledWith(expect.objectContaining({
      release: `pokerchase-hud@${manifest.version}`,
      environment: 'development'
    }))
  })

  it('keeps Sentry unused when telemetry is compiled out', async () => {
    delete process.env.SENTRY_ENABLED
    await chrome.storage.local.set({ sentryTelemetryConsent: true })

    await jest.isolateModulesAsync(async () => {
      const { initSentry } = require('./sentry')
      await initSentry('background')
    })

    expect(Sentry.init).not.toHaveBeenCalled()
  })
})
