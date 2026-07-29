import * as Sentry from '@sentry/browser'
import { initSentry } from './sentry'

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

describe('Sentry content-script initialization', () => {
  it('uses the isolated session mirror without reading local auth storage', async () => {
    process.env.SENTRY_ENABLED = 'true'
    await chrome.storage.session.set({ sentryTelemetryConsent: true })

    await initSentry('content_script')

    expect(Sentry.init).toHaveBeenCalledTimes(1)
    expect(chrome.storage.local.get).not.toHaveBeenCalled()
    expect(chrome.permissions.contains).not.toHaveBeenCalled()
    delete process.env.SENTRY_ENABLED
  })
})
