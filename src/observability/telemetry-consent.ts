export const SENTRY_HOST_PERMISSION =
  'https://o4507260715794432.ingest.us.sentry.io/*'
export const SENTRY_TELEMETRY_CONSENT_STORAGE_KEY =
  'sentryTelemetryConsent'

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

export const readSentryTelemetryConsent = async (): Promise<boolean> => {
  const result = await localGet(SENTRY_TELEMETRY_CONSENT_STORAGE_KEY)
  return result[SENTRY_TELEMETRY_CONSENT_STORAGE_KEY] === true
}

/**
 * Content scripts do not expose the full permissions API. Their Sentry
 * transport is still gated by the same local consent bit; extension pages and
 * the service worker additionally require the optional host grant.
 */
export const hasSentryHostPermission = async (): Promise<boolean> => {
  if (!chrome.permissions?.contains) return true
  return chrome.permissions.contains({
    origins: [SENTRY_HOST_PERMISSION]
  })
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
  await localSet({ [SENTRY_TELEMETRY_CONSENT_STORAGE_KEY]: false })
  if (chrome.permissions?.remove) {
    await chrome.permissions.remove({
      origins: [SENTRY_HOST_PERMISSION]
    })
  }
}
