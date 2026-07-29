import * as Sentry from '@sentry/browser'
import {
  SENTRY_TELEMETRY_CONSENT_STORAGE_KEY
} from './telemetry-consent'

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

describe('Sentry content-script consent mirror bootstrap', () => {
  let consentState: boolean | undefined
  let onStorageChanged:
    ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void)
    | undefined
  let completeInitialRead: (() => void) | undefined
  let sessionReadCount: number

  beforeEach(() => {
    process.env.SENTRY_ENABLED = 'true'
    consentState = undefined
    onStorageChanged = undefined
    completeInitialRead = undefined
    sessionReadCount = 0
    ;(chrome.runtime.sendMessage as jest.Mock).mockResolvedValue({
      sentryTelemetryEnabled: true
    })

    ;(chrome.storage.session.get as jest.Mock).mockImplementation(
      (
        key: string,
        callback: (items?: Record<string, unknown>) => void
      ) => {
        if (sessionReadCount++ === 0) {
          completeInitialRead = () => {
            ;(chrome.runtime as unknown as {
              lastError?: { message: string }
            }).lastError = { message: 'session storage is not accessible' }
            callback()
            delete (chrome.runtime as unknown as {
              lastError?: { message: string }
            }).lastError
          }
          return
        }
        callback({ [key]: consentState })
      }
    )
    ;(chrome.storage.onChanged.addListener as jest.Mock).mockImplementation(
      listener => {
        onStorageChanged = listener
      }
    )
  })

  afterEach(() => {
    delete process.env.SENTRY_ENABLED
  })

  it('retains bootstrap errors when the session mirror is not yet accessible', async () => {
    const { initSentry } = await import('./sentry')
    const initialInitialization = initSentry('content_script')

    const bootstrapError = new Error('content construction failed')
    globalThis.dispatchEvent(new ErrorEvent('error', {
      error: bootstrapError
    }))
    expect(Sentry.captureException).not.toHaveBeenCalled()

    consentState = true
    onStorageChanged?.({
      [SENTRY_TELEMETRY_CONSENT_STORAGE_KEY]: {
        oldValue: undefined,
        newValue: true
      }
    }, 'session')
    completeInitialRead?.()
    await initialInitialization
    await waitForSentryInitialization()

    expect(Sentry.init).toHaveBeenCalledTimes(1)
    expect(Sentry.captureException).toHaveBeenCalledTimes(1)
    expect(Sentry.captureException).toHaveBeenCalledWith(bootstrapError)
  })
})

const waitForSentryInitialization = async (): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((Sentry.init as jest.Mock).mock.calls.length > 0) {
      await Promise.resolve()
      return
    }
    await Promise.resolve()
  }
  throw new Error('Sentry initialization did not complete')
}
