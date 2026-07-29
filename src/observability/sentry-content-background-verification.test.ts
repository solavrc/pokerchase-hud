import * as Sentry from '@sentry/browser'
import {
  SENTRY_TELEMETRY_STATUS_MESSAGE
} from './telemetry-consent'

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

describe('Sentry content-script background consent verification', () => {
  it('fails closed when a new content script sees a stale true mirror after revoke', async () => {
    process.env.SENTRY_ENABLED = 'true'
    await chrome.storage.session.set({ sentryTelemetryConsent: true })
    ;(chrome.runtime.sendMessage as jest.Mock).mockResolvedValue({
      sentryTelemetryEnabled: false
    })

    const { initSentry } = await import('./sentry')
    await initSentry('content_script')

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: SENTRY_TELEMETRY_STATUS_MESSAGE
    })
    expect(Sentry.init).not.toHaveBeenCalled()
    delete process.env.SENTRY_ENABLED
  })
})
