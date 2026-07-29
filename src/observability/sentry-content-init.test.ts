import * as Sentry from '@sentry/browser'
import { initSentry } from './sentry'
import {
  SENTRY_TELEMETRY_CONSENT_STORAGE_KEY,
  SENTRY_TELEMETRY_ENABLED_MESSAGE,
  SENTRY_TELEMETRY_REVOKED_MESSAGE
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

describe('Sentry content-script initialization', () => {
  it('uses the isolated session mirror without reading local auth storage', async () => {
    process.env.SENTRY_ENABLED = 'true'
    await chrome.storage.session.set({ sentryTelemetryConsent: true })
    ;(chrome.runtime.sendMessage as jest.Mock).mockResolvedValue({
      sentryTelemetryEnabled: true
    })
    let onRuntimeMessage:
      ((
        message: unknown,
        sender?: unknown,
        sendResponse?: (response: unknown) => void
      ) => void) | undefined
    let onStorageChanged:
      ((changes: Record<string, { newValue?: unknown }>, area: string) => void) |
      undefined
    ;(chrome.runtime.onMessage.addListener as jest.Mock)
      .mockImplementation(listener => {
        onRuntimeMessage = listener
      })
    ;(chrome.storage.onChanged.addListener as jest.Mock)
      .mockImplementation(listener => {
        onStorageChanged = listener
      })

    await initSentry('content_script')

    expect(Sentry.init).toHaveBeenCalledTimes(1)
    expect(chrome.storage.local.get).not.toHaveBeenCalled()
    expect(chrome.permissions.contains).not.toHaveBeenCalled()

    let completeClose: (() => void) | undefined
    ;(Sentry.close as jest.Mock).mockReturnValueOnce(
      new Promise<boolean>(resolve => {
        completeClose = () => resolve(true)
      })
    )
    const revokeResponse = jest.fn()
    onRuntimeMessage?.(
      { type: SENTRY_TELEMETRY_REVOKED_MESSAGE },
      undefined,
      revokeResponse
    )
    await waitForSentryClose()
    expect(Sentry.close).toHaveBeenCalledWith(0)
    expect(revokeResponse).not.toHaveBeenCalled()

    onStorageChanged?.({
      [SENTRY_TELEMETRY_CONSENT_STORAGE_KEY]: { newValue: false }
    }, 'session')
    onStorageChanged?.({
      [SENTRY_TELEMETRY_CONSENT_STORAGE_KEY]: { newValue: true }
    }, 'session')
    await flushPromises()
    expect(Sentry.init).toHaveBeenCalledTimes(1)

    completeClose?.()
    await waitForResponse(revokeResponse)
    expect(revokeResponse).toHaveBeenCalledWith({
      sentryTelemetryStateApplied: SENTRY_TELEMETRY_REVOKED_MESSAGE
    })

    const enableResponse = jest.fn()
    onRuntimeMessage?.(
      { type: SENTRY_TELEMETRY_ENABLED_MESSAGE },
      undefined,
      enableResponse
    )
    await flushPromises()
    expect(Sentry.init).toHaveBeenCalledTimes(1)
    await waitForSentryInitCount(2)
    await waitForResponse(enableResponse)
    expect(Sentry.init).toHaveBeenCalledTimes(2)
    expect(enableResponse).toHaveBeenCalledWith({
      sentryTelemetryStateApplied: SENTRY_TELEMETRY_ENABLED_MESSAGE
    })
    delete process.env.SENTRY_ENABLED
  })
})

const waitForSentryClose = async (): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((Sentry.close as jest.Mock).mock.calls.length > 0) return
    await Promise.resolve()
  }
  throw new Error('Sentry did not close')
}

const waitForSentryInitCount = async (count: number): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((Sentry.init as jest.Mock).mock.calls.length >= count) return
    await Promise.resolve()
  }
  throw new Error(`Sentry did not initialize ${count} times`)
}

const waitForResponse = async (response: jest.Mock): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (response.mock.calls.length > 0) return
    await Promise.resolve()
  }
  throw new Error('Telemetry state response was not sent')
}

const flushPromises = async (): Promise<void> => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await Promise.resolve()
  }
}
