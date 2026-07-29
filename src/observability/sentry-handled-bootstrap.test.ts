import * as Sentry from '@sentry/browser'
import {
  captureHandledException,
  initSentry
} from './sentry'
import { requestSentryTelemetry } from './telemetry-consent'

const mockScope = {
  setTag: jest.fn()
}

jest.mock('@sentry/browser', () => ({
  init: jest.fn(),
  close: jest.fn().mockResolvedValue(true),
  globalHandlersIntegration: jest.fn(() => ({ name: 'GlobalHandlers' })),
  linkedErrorsIntegration: jest.fn(() => ({ name: 'LinkedErrors' })),
  dedupeIntegration: jest.fn(() => ({ name: 'Dedupe' })),
  withScope: jest.fn(callback => callback(mockScope)),
  captureException: jest.fn(),
  captureMessage: jest.fn()
}))

describe('Sentry handled bootstrap failures', () => {
  it('buffers bounded explicit captures while initialization is pending', async () => {
    process.env.SENTRY_ENABLED = 'true'
    ;(chrome.permissions.request as jest.Mock).mockResolvedValue(true)
    ;(chrome.permissions.contains as jest.Mock).mockResolvedValue(true)
    await requestSentryTelemetry()

    let resolvePermission: ((granted: boolean) => void) | undefined
    ;(chrome.permissions.contains as jest.Mock).mockReturnValue(
      new Promise<boolean>(resolve => {
        resolvePermission = resolve
      })
    )
    const initialization = initSentry('background')
    const handledErrors = Array.from(
      { length: 7 },
      (_, index) => new Error(`service construction failed ${index}`)
    )

    for (const [index, handledError] of handledErrors.entries()) {
      captureHandledException(handledError, {
        operation: `service.ready.${index}`,
        errorType: 'initialization'
      })
    }
    expect(Sentry.captureException).not.toHaveBeenCalled()

    resolvePermission?.(true)
    await initialization

    expect(Sentry.captureException).toHaveBeenCalledTimes(5)
    expect(Sentry.captureException).toHaveBeenCalledWith(handledErrors[0])
    expect(Sentry.captureException).not.toHaveBeenCalledWith(handledErrors[5])
    expect(mockScope.setTag).toHaveBeenCalledWith(
      'operation',
      'service.ready.0'
    )
    expect(mockScope.setTag).toHaveBeenCalledWith(
      'error_type',
      'initialization'
    )
    delete process.env.SENTRY_ENABLED
  })
})
