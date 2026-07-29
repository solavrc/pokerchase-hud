import * as Sentry from '@sentry/browser'
import { SENTRY_TELEMETRY_REVOKED_MESSAGE } from './telemetry-consent'

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

describe('Sentry content-script direct revocation race', () => {
  it('does not initialize from a stale mirror read after direct revocation', async () => {
    process.env.SENTRY_ENABLED = 'true'
    ;(chrome.runtime.sendMessage as jest.Mock).mockResolvedValue({
      sentryTelemetryEnabled: true
    })
    let completeInitialRead: (() => void) | undefined
    let readCount = 0
    let onRuntimeMessage:
      ((message: unknown) => void) | undefined

    ;(chrome.storage.session.get as jest.Mock).mockImplementation(
      (
        key: string,
        callback: (items: Record<string, unknown>) => void
      ) => {
        if (readCount++ === 0) {
          completeInitialRead = () => callback({ [key]: true })
          return
        }
        callback({ [key]: true })
      }
    )
    ;(chrome.runtime.onMessage.addListener as jest.Mock)
      .mockImplementation(listener => {
        onRuntimeMessage = listener
      })

    const { initSentry } = await import('./sentry')
    const initialization = initSentry('content_script')
    onRuntimeMessage?.({ type: SENTRY_TELEMETRY_REVOKED_MESSAGE })
    completeInitialRead?.()
    await initialization

    expect(Sentry.init).not.toHaveBeenCalled()
    delete process.env.SENTRY_ENABLED
  })
})
