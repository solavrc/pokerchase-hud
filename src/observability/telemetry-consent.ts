export const SENTRY_HOST_PERMISSION =
  'https://o4507260715794432.ingest.us.sentry.io/*'
export const SENTRY_TELEMETRY_CONSENT_STORAGE_KEY =
  'sentryTelemetryConsent'
export const SENTRY_TELEMETRY_REVOKED_MESSAGE =
  'pokerchase:sentry-telemetry-revoked'
export const SENTRY_TELEMETRY_ENABLED_MESSAGE =
  'pokerchase:sentry-telemetry-enabled'
export const SENTRY_TELEMETRY_STATUS_MESSAGE =
  'pokerchase:sentry-telemetry-status'
let permissionRevocationListenerRegistered = false
let consentBridgeListenerRegistered = false
let consentBridgeInitialization: Promise<void> | undefined
let consentMirrorGeneration = 0
let consentMirrorWriteQueue: Promise<boolean | undefined> =
  Promise.resolve(undefined)

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
    chrome.storage.session.get(key, items => {
      // A content script can race the background worker's setAccessLevel().
      // Chrome then reports lastError and may omit the items argument. Treat
      // that state like a not-yet-created mirror so initSentry retains its
      // bounded bootstrap buffer until storage.onChanged supplies the value.
      const error = chrome.runtime.lastError
      resolve(error || !items ? {} : items)
    })
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
): Promise<boolean> =>
  await readSentryTelemetryConsentState(runtime) === true

export const readSentryTelemetryConsentState = async (
  runtime: 'background' | 'content_script' | 'popup' = 'background'
): Promise<boolean | undefined> => {
  const result = runtime === 'content_script'
    ? await sessionGet(SENTRY_TELEMETRY_CONSENT_STORAGE_KEY)
    : await localGet(SENTRY_TELEMETRY_CONSENT_STORAGE_KEY)
  const value = result[SENTRY_TELEMETRY_CONSENT_STORAGE_KEY]
  const storedState = typeof value === 'boolean' ? value : undefined
  if (runtime !== 'content_script' || storedState !== true) {
    return storedState
  }

  // storage.session is a wake-up mirror, not the final authorization source:
  // a failed revoke write can leave stale true for a content script injected
  // after the direct tab snapshot. Wake the background and require its current
  // local-consent + optional-permission decision before enabling transport.
  try {
    const response = await chrome.runtime.sendMessage({
      type: SENTRY_TELEMETRY_STATUS_MESSAGE
    })
    if (
      response &&
      typeof response === 'object' &&
      typeof (response as {
        sentryTelemetryEnabled?: unknown
      }).sentryTelemetryEnabled === 'boolean'
    ) {
      return (response as {
        sentryTelemetryEnabled: boolean
      }).sentryTelemetryEnabled
    }
  } catch {
    // Fail closed. A later content reload or mirror transition can retry.
  }
  return undefined
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
    void revokeSentryTelemetry().catch(() => {
      console.warn('[Sentry] Failed to synchronize permission removal')
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
): Promise<boolean | undefined> => {
  const generation = ++consentMirrorGeneration
  const consent = await readSentryTelemetryConsent()
  if (consent) await hasSentryHostPermission()
  if (generation !== consentMirrorGeneration) return

  // Serialize only the storage commits, not the permission reads. A newer
  // disable can therefore invalidate a slow older enable immediately; if an
  // older write is already in flight, the newer generation commits after it.
  const write = consentMirrorWriteQueue
    .catch(() => undefined)
    .then(async () => {
      if (generation !== consentMirrorGeneration) return
      const currentConsent = await readSentryTelemetryConsent()
      const currentEnabled =
        currentConsent && await hasSentryHostPermission()
      if (generation !== consentMirrorGeneration) return
      await sessionSet({
        [SENTRY_TELEMETRY_CONSENT_STORAGE_KEY]: currentEnabled
      })
      return currentEnabled
    })
  consentMirrorWriteQueue = write
  return await write
}

const commitSentryTelemetryConsentMirror = async (
  expectedEnabled: boolean
): Promise<void> => {
  // Another same-context refresh can supersede a generation before it reaches
  // the serialized storage commit. Retry from current local+permission truth;
  // each successful return is backed by either our commit or the superseding
  // commit already visible in storage.session.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const committed = await updateSentryTelemetryConsentMirror()
    if (committed === expectedEnabled) return
    await consentMirrorWriteQueue.catch(() => undefined)
    const mirror = await sessionGet(SENTRY_TELEMETRY_CONSENT_STORAGE_KEY)
    if (
      mirror[SENTRY_TELEMETRY_CONSENT_STORAGE_KEY] === expectedEnabled
    ) {
      return
    }
  }
  throw new Error(
    `Failed to commit Sentry telemetry mirror=${expectedEnabled}`
  )
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
      void updateSentryTelemetryConsentMirror().catch(() => {
        console.warn('[Sentry] Failed to update the consent mirror')
      })
    })
  }

  if (consentBridgeInitialization) return consentBridgeInitialization
  consentBridgeInitialization = chrome.storage.session.setAccessLevel({
    accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS'
  })
    .then(async () => {
      await updateSentryTelemetryConsentMirror()
    })
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
    await commitSentryTelemetryConsentMirror(true)
    await notifyContentScriptsTelemetryState(
      SENTRY_TELEMETRY_ENABLED_MESSAGE
    )
    return true
  } catch (error) {
    try {
      await revokeSentryTelemetry()
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Failed to enable Sentry telemetry and fully roll it back'
      )
    }
    throw error
  }
}

const EXPECTED_MISSING_RECEIVER =
  /(?:Receiving end does not exist|No tab with id)/i

const notifyContentScriptsTelemetryState = async (
  type: typeof SENTRY_TELEMETRY_REVOKED_MESSAGE |
    typeof SENTRY_TELEMETRY_ENABLED_MESSAGE
): Promise<void> => {
  if (!chrome.tabs?.query || !chrome.tabs?.sendMessage) {
    throw new Error('tabs messaging is unavailable')
  }
  const tabs = await chrome.tabs.query({
    url: 'https://game.poker-chase.com/*'
  })
  if (!Array.isArray(tabs)) {
    throw new Error('tabs query did not return an array')
  }

  await Promise.all(tabs.flatMap(tab => {
    if (tab.id === undefined) return []
    return [new Promise<void>((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id as number, {
        type
      }, response => {
        const error = chrome.runtime.lastError
        if (error) {
          const message = error.message ?? 'Unknown tab messaging failure'
          if (EXPECTED_MISSING_RECEIVER.test(message)) {
            // With no receiving content script there is no live Sentry client
            // in this tab to transition.
            resolve()
          } else {
            reject(new Error(message))
          }
          return
        }
        if (
          !response ||
          typeof response !== 'object' ||
          (response as {
            sentryTelemetryStateApplied?: unknown
          }).sentryTelemetryStateApplied !== type
        ) {
          reject(new Error('Content script did not acknowledge telemetry state'))
          return
        }
        resolve()
      })
    })]
  }))
}

const removeSentryHostPermission = async (): Promise<boolean> => {
  if (!chrome.permissions?.remove) return false
  const removed = await chrome.permissions.remove({
    origins: [SENTRY_HOST_PERMISSION]
  })
  if (removed) return true
  if (!chrome.permissions.contains) return false
  return !await chrome.permissions.contains({
    origins: [SENTRY_HOST_PERMISSION]
  })
}

export const revokeSentryTelemetry = async (): Promise<void> => {
  const failures: unknown[] = []
  const attempt = async <T>(
    operation: () => Promise<T>
  ): Promise<{ ok: true, value: T } | { ok: false }> => {
    try {
      return { ok: true, value: await operation() }
    } catch (error) {
      failures.push(error)
      return { ok: false }
    }
  }

  // Initiate every independent fail-closed path before the first await. This
  // matters for permissions.onRemoved in an MV3 worker: tab shutdown and host
  // removal must not wait behind a storage callback before Chrome can observe
  // their extension API operations. The mirror refresh waits only for local
  // consent and permission truth, never for a slow content-script close.
  const localClearPromise = attempt(clearSentryTelemetryConsent)
  const directShutdownPromise = attempt(async () =>
    await notifyContentScriptsTelemetryState(
      SENTRY_TELEMETRY_REVOKED_MESSAGE
    )
  )
  const permissionRemovalPromise = attempt(removeSentryHostPermission)
  const mirrorShutdownPromise = Promise.all([
    localClearPromise,
    permissionRemovalPromise
  ]).then(async () =>
    await attempt(async () =>
      await commitSentryTelemetryConsentMirror(false)
    )
  )
  const [
    localClear,
    directShutdown,
    permissionRemoval,
    mirrorShutdown
  ] = await Promise.all([
    localClearPromise,
    directShutdownPromise,
    permissionRemovalPromise,
    mirrorShutdownPromise
  ])
  const permissionRemovalCompleted =
    permissionRemoval.ok && permissionRemoval.value
  const mirrorShutdownCompleted = mirrorShutdown.ok

  if (
    !localClear.ok ||
    !permissionRemovalCompleted ||
    !directShutdown.ok ||
    !mirrorShutdownCompleted
  ) {
    throw new AggregateError(
      failures,
      'Failed to fully revoke Sentry telemetry'
    )
  }
  if (failures.length > 0) {
    console.warn(
      '[Sentry] Telemetry revoked with a degraded shutdown path'
    )
  }
}
