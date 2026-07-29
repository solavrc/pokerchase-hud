import * as Sentry from '@sentry/browser'
import { initSentry } from './sentry'
import { requestSentryTelemetry } from './telemetry-consent'

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

describe('Sentry opt-in initialization', () => {
  afterEach(() => {
    delete process.env.SENTRY_ENABLED
  })

  it('initializes only after consent and leaves keepalive sizing to the SDK', async () => {
    process.env.SENTRY_ENABLED = 'true'
    ;(chrome.permissions.request as jest.Mock).mockResolvedValue(true)
    ;(chrome.permissions.contains as jest.Mock).mockResolvedValue(true)

    await expect(requestSentryTelemetry()).resolves.toBe(true)
    await initSentry('background')

    expect(Sentry.init).toHaveBeenCalledTimes(1)
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({ defaultIntegrations: false })
    )
    const options = (Sentry.init as jest.Mock).mock.calls[0]?.[0]
    expect(options.transportOptions).toBeUndefined()
  })
})
