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

describe('Sentry content-script explicit opt-out bootstrap', () => {
  it('discards buffered errors when the session mirror becomes false', async () => {
    process.env.SENTRY_ENABLED = 'true'
    let consentState: boolean | undefined
    let onStorageChanged:
      ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void)
      | undefined

    ;(chrome.storage.session.get as jest.Mock).mockImplementation(
      (key: string, callback: (items: Record<string, unknown>) => void) => {
        callback({ [key]: consentState })
      }
    )
    ;(chrome.storage.onChanged.addListener as jest.Mock).mockImplementation(
      listener => {
        onStorageChanged = listener
      }
    )

    const { initSentry } = await import('./sentry')
    await initSentry('content_script')

    globalThis.dispatchEvent(new ErrorEvent('error', {
      error: new Error('do not report')
    }))

    consentState = false
    onStorageChanged?.({
      [SENTRY_TELEMETRY_CONSENT_STORAGE_KEY]: {
        oldValue: undefined,
        newValue: false
      }
    }, 'session')

    consentState = true
    onStorageChanged?.({
      [SENTRY_TELEMETRY_CONSENT_STORAGE_KEY]: {
        oldValue: false,
        newValue: true
      }
    }, 'session')
    await waitForSentryInitialization()

    expect(Sentry.init).toHaveBeenCalledTimes(1)
    expect(Sentry.captureException).not.toHaveBeenCalled()
    delete process.env.SENTRY_ENABLED
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
