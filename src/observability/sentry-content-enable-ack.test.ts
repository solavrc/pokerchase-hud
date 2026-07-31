/**
 * The popup's opt-in rolls back — and revokes the optional host permission the
 * user just granted — whenever a live content script fails to acknowledge
 * SENTRY_TELEMETRY_ENABLED_MESSAGE. Only a genuine refusal may report failure:
 * "telemetry is compiled out of this build" and "the consent mirror is not
 * readable yet" are not refusals, and previously surfaced in the popup as
 * 「診断情報の設定を更新できませんでした。」 with the opt-in silently reverted.
 */
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

type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void
) => boolean | undefined

interface Scenario {
  /** false reproduces a local `npm run build` (SENTRY_ENABLED unset). */
  telemetryCompiledIn: boolean
  /** false reproduces storage.session before the background grants access. */
  consentMirrorReadable?: boolean
  /** What the background reports for the content script's status probe. */
  backgroundReportsEnabled?: boolean
}

/**
 * Wire a real content-script sentry.ts instance to a real popup-side
 * telemetry-consent.ts instance, the way the shipped extension does: the popup
 * opts in, then reaches the content script through chrome.tabs.sendMessage.
 */
const optInFromPopupWithLiveGameTab = async (scenario: Scenario) => {
  const {
    telemetryCompiledIn,
    consentMirrorReadable = true,
    backgroundReportsEnabled = true
  } = scenario
  const contentListeners: MessageListener[] = []
  ;(chrome.runtime.onMessage.addListener as jest.Mock).mockImplementation(
    (listener: MessageListener) => { contentListeners.push(listener) }
  )

  if (telemetryCompiledIn) process.env.SENTRY_ENABLED = 'true'
  else delete process.env.SENTRY_ENABLED

  // The content script's own module registry, so its Sentry client is
  // observable independently of the popup instance loaded further down.
  let contentSentryInit: jest.Mock | undefined
  await jest.isolateModulesAsync(async () => {
    contentSentryInit = require('@sentry/browser').init
    const { initSentry } = require('./sentry')
    await initSentry('content_script')
  })

  ;(chrome.runtime.sendMessage as jest.Mock).mockResolvedValue({
    sentryTelemetryEnabled: backgroundReportsEnabled
  })
  if (!consentMirrorReadable) {
    ;(chrome.storage.session.get as jest.Mock).mockImplementation(
      (_keys: unknown, callback: (items?: unknown) => void) => {
        ;(chrome.runtime as { lastError?: { message: string } }).lastError = {
          message: 'Access to storage is not allowed from this context.'
        }
        callback(undefined)
        delete (chrome.runtime as { lastError?: unknown }).lastError
      }
    )
  }

  ;(chrome.permissions.request as jest.Mock).mockResolvedValue(true)
  ;(chrome.permissions.contains as jest.Mock).mockResolvedValue(true)
  ;(chrome.tabs.query as jest.Mock).mockResolvedValue([{ id: 11 }])
  ;(chrome.tabs.sendMessage as jest.Mock).mockImplementation(
    (
      _tabId: number,
      message: unknown,
      callback: (response?: unknown) => void
    ) => {
      let responded = false
      const sendResponse = (response?: unknown) => {
        responded = true
        callback(response)
      }
      const keepsPortOpen = contentListeners
        .map(listener => listener(message, { id: 'ext' }, sendResponse))
        .some(Boolean)
      if (!keepsPortOpen && !responded) callback(undefined)
    }
  )

  let optedIn: boolean | undefined
  let error: unknown
  await jest.isolateModulesAsync(async () => {
    const { requestSentryTelemetry } = require('./telemetry-consent')
    try {
      optedIn = await requestSentryTelemetry()
    } catch (thrown) {
      error = thrown
    }
  })
  return { optedIn, error, contentSentryInit }
}

describe('Sentry content-script enablement acknowledgement', () => {
  afterEach(() => { delete process.env.SENTRY_ENABLED })

  it('keeps the opt-in when telemetry is compiled out of the build', async () => {
    const { optedIn, error } = await optInFromPopupWithLiveGameTab({
      telemetryCompiledIn: false
    })

    expect(error).toBeUndefined()
    expect(optedIn).toBe(true)
    expect(chrome.permissions.remove).not.toHaveBeenCalled()
  })

  it('keeps the opt-in while the consent mirror is not readable yet', async () => {
    const { optedIn, error } = await optInFromPopupWithLiveGameTab({
      telemetryCompiledIn: true,
      consentMirrorReadable: false
    })

    expect(error).toBeUndefined()
    expect(optedIn).toBe(true)
    expect(chrome.permissions.remove).not.toHaveBeenCalled()
  })

  it('starts telemetry and keeps the opt-in on the healthy path', async () => {
    const { optedIn, error, contentSentryInit } =
      await optInFromPopupWithLiveGameTab({ telemetryCompiledIn: true })

    expect(error).toBeUndefined()
    expect(optedIn).toBe(true)
    expect(contentSentryInit).toHaveBeenCalled()
  })

  it('does not start a client when telemetry is compiled out', async () => {
    const { contentSentryInit } = await optInFromPopupWithLiveGameTab({
      telemetryCompiledIn: false
    })

    expect(contentSentryInit).not.toHaveBeenCalled()
  })

  it('still rolls the opt-in back when the content script refuses', async () => {
    const { optedIn, error } = await optInFromPopupWithLiveGameTab({
      telemetryCompiledIn: true,
      backgroundReportsEnabled: false
    })

    expect(optedIn).toBeUndefined()
    expect(error).toEqual(
      expect.objectContaining({
        message: 'Content script did not acknowledge telemetry state'
      })
    )
  })
})
