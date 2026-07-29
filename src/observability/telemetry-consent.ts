export const SENTRY_HOST_PERMISSION =
  'https://o4507260715794432.ingest.us.sentry.io/*'
export const SENTRY_TELEMETRY_CONSENT_STORAGE_KEY =
  'sentryTelemetryConsent'
let permissionRevocationListenerRegistered = false
let consentBridgeListenerRegistered = false
let consentBridgeInitialization: Promise<void> | undefined

const localGet = (
  key: string
): Promise<Record<string, unknown>> =>
  new Promise(resolve => {
    chrome.storage.local.get(key, items => resolve(items))
  })

const localSet = (
  items: Record<string, unknown>
): Promise<void> =>
  new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      const error = chrome.runtime.lastError
      if (error) {
        reject(new Error(error.message))
        return
      }
      resolve()
    })
  })

const sessionGet = (
  key: string
): Promise<Record<string, unknown>> =>
  new Promise(resolve => {
    chrome.storage.session.get(key, items => resolve(items))
  })

const sessionSet = (
  items: Record<string, unknown>
): Promise<void> =>
  new Promise((resolve, reject) => {
    chrome.storage.session.set(items, () => {
      const error = chrome.runtime.lastError
      if (error) {
        reject(new Error(error.message))
        return
      }
      resolve()
    })
  })

export const readSentryTelemetryConsent = async (
  runtime: 'background' | 'content_script' | 'popup' = 'background'
): Promise<boolean> => {
  const result = runtime === 'content_script'
    ? await sessionGet(SENTRY_TELEMETRY_CONSENT_STORAGE_KEY)
    : await localGet(SENTRY_TELEMETRY_CONSENT_STORAGE_KEY)
  return result[SENTRY_TELEMETRY_CONSENT_STORAGE_KEY] === true
}

export const clearSentryTelemetryConsent = (): Promise<void> =>
  localSet({ [SENTRY_TELEMETRY_CONSENT_STORAGE_KEY]: false })

/**
 * Keep content-script consent in sync when the user revokes the optional host
 * from chrome://extensions instead of using the popup toggle. The background
 * service worker registers this synchronously during startup, so Chrome can
 * wake it for permissions.onRemoved and the resulting storage change reaches
 * every already-open content script.
 */
export const registerSentryPermissionRevocationSync = (): void => {
  if (
    permissionRevocationListenerRegistered ||
    !chrome.permissions?.onRemoved?.addListener
  ) {
    return
  }
  permissionRevocationListenerRegistered = true

  chrome.permissions.onRemoved.addListener(permissions => {
    if (!permissions.origins?.includes(SENTRY_HOST_PERMISSION)) return
    void clearSentryTelemetryConsent().catch(() => {
      console.warn('[Sentry] Failed to clear consent after permission removal')
    })
  })
}

/**
 * Content scripts do not expose the full permissions API. Their Sentry
 * transport is gated by the background-owned session mirror; extension pages
 * and the service worker additionally query the optional host grant directly.
 */
export const hasSentryHostPermission = async (
  runtime: 'background' | 'content_script' | 'popup' = 'background'
): Promise<boolean> => {
  // The content-readable session mirror is written by the trusted background
  // only after it verifies the optional host grant. Content scripts therefore
  // neither need nor attempt to call the unavailable permissions API.
  if (runtime === 'content_script') return true
  if (!chrome.permissions?.contains) return true
  return chrome.permissions.contains({
    origins: [SENTRY_HOST_PERMISSION]
  })
}

const updateSentryTelemetryConsentMirror = async (
  localConsent?: boolean
): Promise<void> => {
  const consent = localConsent ?? await readSentryTelemetryConsent()
  const enabled = consent && await hasSentryHostPermission()
  await sessionSet({
    [SENTRY_TELEMETRY_CONSENT_STORAGE_KEY]: enabled
  })
}

/**
 * Expose only the non-secret telemetry consent bit to content scripts.
 *
 * Firebase auth deliberately restricts chrome.storage.local to trusted
 * extension contexts, so widening that entire area would expose credentials.
 * The background instead owns a storage.session mirror whose value is true
 * only while both local consent and the optional Sentry host grant are valid.
 */
export const initializeSentryTelemetryConsentBridge = (): Promise<void> => {
  if (!consentBridgeListenerRegistered) {
    consentBridgeListenerRegistered = true
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (
        areaName !== 'local' ||
        !(SENTRY_TELEMETRY_CONSENT_STORAGE_KEY in changes)
      ) {
        return
      }
      const enabled =
        changes[SENTRY_TELEMETRY_CONSENT_STORAGE_KEY]?.newValue === true
      void updateSentryTelemetryConsentMirror(enabled).catch(() => {
        console.warn('[Sentry] Failed to update the consent mirror')
      })
    })
  }

  if (consentBridgeInitialization) return consentBridgeInitialization
  consentBridgeInitialization = chrome.storage.session.setAccessLevel({
    accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS'
  })
    .then(() => updateSentryTelemetryConsentMirror())
    .finally(() => {
      consentBridgeInitialization = undefined
    })
  return consentBridgeInitialization
}

export const readSentryTelemetryEnabled = async (): Promise<boolean> =>
  await readSentryTelemetryConsent() && await hasSentryHostPermission()

export const requestSentryTelemetry = async (): Promise<boolean> => {
  if (!chrome.permissions?.request) return false

  // Keep the permission request as the first async operation so Chrome still
  // recognizes the caller's checkbox click as the required user gesture.
  const granted = await chrome.permissions.request({
    origins: [SENTRY_HOST_PERMISSION]
  })
  if (!granted) return false

  try {
    await localSet({ [SENTRY_TELEMETRY_CONSENT_STORAGE_KEY]: true })
    return true
  } catch (error) {
    await chrome.permissions.remove({
      origins: [SENTRY_HOST_PERMISSION]
    })
    throw error
  }
}

export const revokeSentryTelemetry = async (): Promise<void> => {
  // Stop all runtimes through storage.onChanged before removing the network
  // grant. This remains safe if permission removal itself fails.
  await clearSentryTelemetryConsent()
  if (chrome.permissions?.remove) {
    await chrome.permissions.remove({
      origins: [SENTRY_HOST_PERMISSION]
    })
  }
}
