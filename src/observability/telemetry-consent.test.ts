import {
  SENTRY_HOST_PERMISSION,
  SENTRY_TELEMETRY_CONSENT_STORAGE_KEY,
  readSentryTelemetryEnabled,
  requestSentryTelemetry,
  revokeSentryTelemetry
} from './telemetry-consent'
import manifest from '../../manifest.json'

const readLocal = (): Promise<Record<string, unknown>> =>
  new Promise(resolve => {
    ;(chrome.storage.local.get as any)(
      SENTRY_TELEMETRY_CONSENT_STORAGE_KEY,
      (items: Record<string, unknown>) => resolve(items)
    )
  })

describe('Sentry telemetry consent', () => {
  it('keeps the Sentry host optional so updates do not disable existing installs', () => {
    expect(manifest.host_permissions).not.toContain(SENTRY_HOST_PERMISSION)
    expect(manifest.optional_host_permissions).toContain(SENTRY_HOST_PERMISSION)
  })

  it('is disabled by default without requesting the optional host', async () => {
    await expect(readSentryTelemetryEnabled()).resolves.toBe(false)
    expect(chrome.permissions.contains).not.toHaveBeenCalled()
  })

  it('persists consent only after Chrome grants the optional host', async () => {
    ;(chrome.permissions.request as jest.Mock).mockResolvedValue(true)
    ;(chrome.permissions.contains as jest.Mock).mockResolvedValue(true)

    await expect(requestSentryTelemetry()).resolves.toBe(true)

    expect(chrome.permissions.request).toHaveBeenCalledWith({
      origins: [SENTRY_HOST_PERMISSION]
    })
    await expect(readLocal()).resolves.toEqual({
      [SENTRY_TELEMETRY_CONSENT_STORAGE_KEY]: true
    })
    await expect(readSentryTelemetryEnabled()).resolves.toBe(true)
  })

  it('does not persist consent when the optional host is denied', async () => {
    ;(chrome.permissions.request as jest.Mock).mockResolvedValue(false)

    await expect(requestSentryTelemetry()).resolves.toBe(false)
    await expect(readLocal()).resolves.toEqual({
      [SENTRY_TELEMETRY_CONSENT_STORAGE_KEY]: undefined
    })
  })

  it('disables telemetry before removing the optional host', async () => {
    ;(chrome.permissions.request as jest.Mock).mockResolvedValue(true)
    await requestSentryTelemetry()

    await revokeSentryTelemetry()

    await expect(readLocal()).resolves.toEqual({
      [SENTRY_TELEMETRY_CONSENT_STORAGE_KEY]: false
    })
    expect(chrome.permissions.remove).toHaveBeenCalledWith({
      origins: [SENTRY_HOST_PERMISSION]
    })
  })
})
