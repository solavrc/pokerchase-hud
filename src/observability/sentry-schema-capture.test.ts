import * as Sentry from '@sentry/browser'
import {
  captureSchemaValidationFailure,
  initSentry
} from './sentry'
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

describe('Sentry schema capture gating', () => {
  it('constructs a diagnostic only for the first enabled event of an API type', async () => {
    process.env.SENTRY_ENABLED = 'true'
    const buildDiagnostic = jest.fn(() => ({
      issues: [],
      payloadShape: [],
      sanitizedPayload: {},
      shapeTruncated: false,
      payloadTruncated: false
    }))

    captureSchemaValidationFailure(303, buildDiagnostic)
    expect(buildDiagnostic).not.toHaveBeenCalled()

    ;(chrome.permissions.request as jest.Mock).mockResolvedValue(true)
    ;(chrome.permissions.contains as jest.Mock).mockResolvedValue(true)
    await requestSentryTelemetry()
    await initSentry('background')

    captureSchemaValidationFailure(303, buildDiagnostic)
    captureSchemaValidationFailure(303, buildDiagnostic)

    expect(buildDiagnostic).toHaveBeenCalledTimes(1)
    expect(Sentry.withScope).toHaveBeenCalledTimes(1)
    delete process.env.SENTRY_ENABLED
  })
})
