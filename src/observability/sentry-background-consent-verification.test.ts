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

describe('Sentry background consent verification', () => {
  it('answers stale-mirror checks from current local and permission truth', async () => {
    await chrome.storage.local.set({ sentryTelemetryConsent: true })
    ;(chrome.permissions.contains as jest.Mock).mockResolvedValue(false)
    let listener:
      ((
        message: unknown,
        sender: unknown,
        sendResponse: (response: unknown) => void
      ) => boolean) | undefined
    ;(chrome.runtime.onMessage.addListener as jest.Mock)
      .mockImplementation(candidate => {
        listener = candidate
      })

    const { initSentry } = await import('./sentry')
    await initSentry('background')

    const sendResponse = jest.fn()
    expect(listener?.(
      { type: SENTRY_TELEMETRY_STATUS_MESSAGE },
      {},
      sendResponse
    )).toBe(true)
    await waitForResponse(sendResponse)
    expect(sendResponse).toHaveBeenCalledWith({
      sentryTelemetryEnabled: false
    })
    expect(Sentry.init).not.toHaveBeenCalled()
  })
})

const waitForResponse = async (response: jest.Mock): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (response.mock.calls.length > 0) return
    await Promise.resolve()
  }
  throw new Error('Background consent response was not sent')
}
