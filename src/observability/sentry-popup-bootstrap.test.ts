import * as Sentry from '@sentry/browser'
import { initSentry } from './sentry'
import { requestSentryTelemetry } from './telemetry-consent'

jest.mock('@sentry/browser', () => ({
  init: jest.fn(),
  close: jest.fn().mockResolvedValue(true),
  globalHandlersIntegration: jest.fn(() => ({ name: 'GlobalHandlers' })),
  linkedErrorsIntegration: jest.fn(() => ({ name: 'LinkedErrors' })),
  dedupeIntegration: jest.fn(() => ({ name: 'Dedupe' })),
  withScope: jest.fn(callback => callback({
    setTag: jest.fn()
  })),
  captureException: jest.fn(),
  captureMessage: jest.fn()
}))

describe('Sentry popup bootstrap buffer', () => {
  it('reports an error raised while consent initialization is pending', async () => {
    process.env.SENTRY_ENABLED = 'true'
    ;(chrome.permissions.request as jest.Mock).mockResolvedValue(true)
    await requestSentryTelemetry()

    let resolvePermission: ((granted: boolean) => void) | undefined
    ;(chrome.permissions.contains as jest.Mock).mockReturnValue(
      new Promise<boolean>(resolve => {
        resolvePermission = resolve
      })
    )

    const initialization = initSentry('popup')
    const bootstrapError = new Error('popup render failed')
    globalThis.dispatchEvent(new ErrorEvent('error', {
      error: bootstrapError
    }))

    resolvePermission?.(true)
    await initialization

    expect(Sentry.init).toHaveBeenCalledTimes(1)
    expect(Sentry.captureException).toHaveBeenCalledWith(bootstrapError)
    delete process.env.SENTRY_ENABLED
  })
})
