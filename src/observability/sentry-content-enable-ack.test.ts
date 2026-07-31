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
  /**
   * How many leading status probes reject before the background answers.
   * `Infinity` reproduces a background that never confirms the mirror.
   */
  statusProbeFailures?: number
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
    backgroundReportsEnabled = true,
    statusProbeFailures = 0
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

  let probeCount = 0
  ;(chrome.runtime.sendMessage as jest.Mock).mockImplementation(async () => {
    probeCount += 1
    if (probeCount <= statusProbeFailures) {
      throw new Error('Could not establish connection.')
    }
    return { sentryTelemetryEnabled: backgroundReportsEnabled }
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

  // A refused read is not an absent mirror: the same access gate withholds
  // storage.onChanged, so acknowledging it would report success for a tab that
  // can never be told the mirror appeared.
  it('refuses while the consent mirror cannot be read at all', async () => {
    const { optedIn, error } = await optInFromPopupWithLiveGameTab({
      telemetryCompiledIn: true,
      consentMirrorReadable: false
    })

    expect(optedIn).toBeUndefined()
    expect(error).toEqual(
      expect.objectContaining({
        message: 'Content script did not acknowledge telemetry state'
      })
    )
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

  // A mirror that already reads `true` produces no further change event, so an
  // unconfirmed probe must not be acknowledged like a missing mirror: the tab
  // would stay dark until a reload while the popup reported success.
  it('refuses when the background never confirms the consent mirror', async () => {
    const { optedIn, error, contentSentryInit } =
      await optInFromPopupWithLiveGameTab({
        telemetryCompiledIn: true,
        statusProbeFailures: Infinity
      })

    expect(contentSentryInit).not.toHaveBeenCalled()
    expect(optedIn).toBeUndefined()
    expect(error).toEqual(
      expect.objectContaining({
        message: 'Content script did not acknowledge telemetry state'
      })
    )
    expect(chrome.permissions.remove).toHaveBeenCalled()
  })
})

/**
 * Drive the acknowledgement handler on its own, with the mirror already stored
 * before the content script starts, so the handler cannot borrow a start
 * attempt from an incidental storage.onChanged wake.
 *
 * The probe budget is scoped to the dispatch, not counted from the beginning:
 * src/test-setup.ts never clears its storage.onChanged registry, so content
 * script instances from earlier tests in this file stay subscribed and would
 * otherwise consume probes and shift the numbering. Nothing writes to storage
 * during the dispatch, so only the instance under test probes in that window.
 */
const acknowledgeEnableDirectly = async (
  { failuresDuringDispatch = 0, seedMirror = true } = {}
) => {
  const contentListeners: MessageListener[] = []
  ;(chrome.runtime.onMessage.addListener as jest.Mock).mockImplementation(
    (listener: MessageListener) => { contentListeners.push(listener) }
  )
  process.env.SENTRY_ENABLED = 'true'

  let failingProbes = Infinity
  ;(chrome.runtime.sendMessage as jest.Mock).mockImplementation(async () => {
    if (failingProbes > 0) {
      failingProbes -= 1
      throw new Error('Could not establish connection.')
    }
    return { sentryTelemetryEnabled: true }
  })
  if (seedMirror) {
    await chrome.storage.session.set({ sentryTelemetryConsent: true })
  }

  // Starts unverified: every probe fails while the instance boots.
  let contentSentryInit: jest.Mock | undefined
  await jest.isolateModulesAsync(async () => {
    contentSentryInit = require('@sentry/browser').init
    const { initSentry } = require('./sentry')
    await initSentry('content_script')
  })
  expect(contentSentryInit).not.toHaveBeenCalled()

  failingProbes = failuresDuringDispatch
  const response = await new Promise<unknown>(resolve => {
    const handled = contentListeners
      .map(listener => listener(
        { type: 'pokerchase:sentry-telemetry-enabled' },
        { id: 'ext' },
        resolve
      ))
      .some(Boolean)
    if (!handled) resolve(undefined)
  })
  return { response, contentSentryInit }
}

describe('Sentry content-script status-probe retry', () => {
  afterEach(() => { delete process.env.SENTRY_ENABLED })

  it('retries once past a transient probe failure', async () => {
    // The acknowledgement path's first attempt spends the one failing probe;
    // only the retry can still reach a confirming one.
    const { response, contentSentryInit } = await acknowledgeEnableDirectly({
      failuresDuringDispatch: 1
    })

    expect(response).toEqual({
      sentryTelemetryStateApplied: 'pokerchase:sentry-telemetry-enabled'
    })
    expect(contentSentryInit).toHaveBeenCalled()
  })

  it('refuses once the retry is also unconfirmed', async () => {
    const { response, contentSentryInit } = await acknowledgeEnableDirectly({
      failuresDuringDispatch: Infinity
    })

    expect(response).toEqual({
      sentryTelemetryStateFailed: 'pokerchase:sentry-telemetry-enabled'
    })
    expect(contentSentryInit).not.toHaveBeenCalled()
  })

  // The one honored not-started outcome. The read succeeding is what makes it
  // safe: it proves this runtime has session access, so creating the mirror
  // will deliver a change event here and start the transport.
  it('acknowledges an absent mirror that was read successfully', async () => {
    const { response, contentSentryInit } = await acknowledgeEnableDirectly({
      failuresDuringDispatch: Infinity,
      seedMirror: false
    })

    expect(response).toEqual({
      sentryTelemetryStateApplied: 'pokerchase:sentry-telemetry-enabled'
    })
    expect(contentSentryInit).not.toHaveBeenCalled()
  })
})
