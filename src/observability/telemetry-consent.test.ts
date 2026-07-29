import {
  SENTRY_HOST_PERMISSION,
  SENTRY_TELEMETRY_CONSENT_STORAGE_KEY,
  initializeSentryTelemetryConsentBridge,
  readSentryTelemetryConsent,
  readSentryTelemetryEnabled,
  registerSentryPermissionRevocationSync,
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
  beforeEach(() => {
    ;(chrome.permissions.contains as jest.Mock).mockResolvedValue(true)
    ;(chrome.runtime.sendMessage as jest.Mock).mockResolvedValue({
      sentryTelemetryEnabled: true
    })
  })

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

  it('exposes only a permission-validated session mirror to content scripts', async () => {
    ;(chrome.permissions.request as jest.Mock).mockResolvedValue(true)
    ;(chrome.permissions.contains as jest.Mock).mockResolvedValue(true)
    await requestSentryTelemetry()

    await initializeSentryTelemetryConsentBridge()

    expect(chrome.storage.session.setAccessLevel).toHaveBeenCalledWith({
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS'
    })
    await expect(
      readSentryTelemetryConsent('content_script')
    ).resolves.toBe(true)

    await revokeSentryTelemetry()
    await Promise.resolve()
    await expect(
      readSentryTelemetryConsent('content_script')
    ).resolves.toBe(false)
  })

  it('does not let a stale enable permission check overwrite a later disable', async () => {
    ;(chrome.permissions.request as jest.Mock).mockResolvedValue(true)
    await requestSentryTelemetry()

    let resolvePermission: ((granted: boolean) => void) | undefined
    ;(chrome.permissions.contains as jest.Mock).mockReturnValueOnce(
      new Promise<boolean>(resolve => {
        resolvePermission = resolve
      })
    )
    const staleEnable = initializeSentryTelemetryConsentBridge()
    await waitForPermissionCheck()

    await revokeSentryTelemetry()
    resolvePermission?.(true)
    await staleEnable

    await expect(
      readSentryTelemetryConsent('content_script')
    ).resolves.toBe(false)
  })

  it('does not persist consent when the optional host is denied', async () => {
    ;(chrome.permissions.request as jest.Mock).mockResolvedValue(false)

    await expect(requestSentryTelemetry()).resolves.toBe(false)
    await expect(readLocal()).resolves.toEqual({
      [SENTRY_TELEMETRY_CONSENT_STORAGE_KEY]: undefined
    })
  })

  it('rolls back opt-in when a live content script does not acknowledge enablement', async () => {
    ;(chrome.permissions.request as jest.Mock).mockResolvedValue(true)
    ;(chrome.tabs.query as jest.Mock).mockResolvedValue([{ id: 11 }])
    ;(chrome.tabs.sendMessage as jest.Mock).mockImplementation(
      (_tabId, message, callback) => {
        if (message.type === 'pokerchase:sentry-telemetry-revoked') {
          callback({ sentryTelemetryStateApplied: message.type })
          return
        }
        callback()
      }
    )

    await expect(requestSentryTelemetry()).rejects.toThrow(
      'Content script did not acknowledge telemetry state'
    )
    await expect(readLocal()).resolves.toEqual({
      [SENTRY_TELEMETRY_CONSENT_STORAGE_KEY]: false
    })
    expect(chrome.permissions.remove).toHaveBeenCalledWith({
      origins: [SENTRY_HOST_PERMISSION]
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

  it('runs direct and permission shutdown but rejects when the durable mirror write fails', async () => {
    ;(chrome.permissions.request as jest.Mock).mockResolvedValue(true)
    await requestSentryTelemetry()
    ;(chrome.tabs.query as jest.Mock).mockResolvedValue([{ id: 17 }])
    ;(chrome.tabs.sendMessage as jest.Mock).mockImplementation(
      (_tabId, message, callback) => callback({
        sentryTelemetryStateApplied: message.type
      })
    )
    ;(chrome.storage.session.set as jest.Mock).mockImplementation(
      (_items, callback) => {
        ;(chrome.runtime as unknown as {
          lastError?: { message: string }
        }).lastError = { message: 'session write failed' }
        callback()
        delete (chrome.runtime as unknown as {
          lastError?: { message: string }
        }).lastError
      }
    )

    await expect(revokeSentryTelemetry()).rejects.toThrow(
      'Failed to fully revoke Sentry telemetry'
    )

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      17,
      { type: 'pokerchase:sentry-telemetry-revoked' },
      expect.any(Function)
    )
    expect(chrome.permissions.remove).toHaveBeenCalledWith({
      origins: [SENTRY_HOST_PERMISSION]
    })
  })

  it('removes the host permission without waiting for content shutdown ACK', async () => {
    ;(chrome.permissions.request as jest.Mock).mockResolvedValue(true)
    await requestSentryTelemetry()
    ;(chrome.tabs.query as jest.Mock).mockResolvedValue([{ id: 18 }])
    let acknowledgeShutdown: (() => void) | undefined
    ;(chrome.tabs.sendMessage as jest.Mock).mockImplementation(
      (_tabId, message, callback) => {
        acknowledgeShutdown = () => callback({
          sentryTelemetryStateApplied: message.type
        })
      }
    )

    const revocation = revokeSentryTelemetry()
    await waitForPendingTabMessage()
    expect(chrome.permissions.remove).toHaveBeenCalledWith({
      origins: [SENTRY_HOST_PERMISSION]
    })

    acknowledgeShutdown?.()
    await expect(revocation).resolves.toBeUndefined()
  })

  it('fails revocation when Chrome keeps the optional host permission', async () => {
    ;(chrome.permissions.request as jest.Mock).mockResolvedValue(true)
    await requestSentryTelemetry()
    ;(chrome.permissions.remove as jest.Mock).mockResolvedValue(false)
    ;(chrome.permissions.contains as jest.Mock).mockResolvedValue(true)

    await expect(revokeSentryTelemetry()).rejects.toThrow(
      'Failed to fully revoke Sentry telemetry'
    )
  })

  it('fails revocation when persisted consent cannot be cleared', async () => {
    ;(chrome.permissions.request as jest.Mock).mockResolvedValue(true)
    await requestSentryTelemetry()
    ;(chrome.storage.local.set as jest.Mock).mockImplementation(
      (_items, callback) => {
        ;(chrome.runtime as unknown as {
          lastError?: { message: string }
        }).lastError = { message: 'local write failed' }
        callback()
        delete (chrome.runtime as unknown as {
          lastError?: { message: string }
        }).lastError
      }
    )

    await expect(revokeSentryTelemetry()).rejects.toThrow(
      'Failed to fully revoke Sentry telemetry'
    )
  })

  it('fails revocation when neither direct shutdown nor mirror shutdown completes', async () => {
    ;(chrome.permissions.request as jest.Mock).mockResolvedValue(true)
    await requestSentryTelemetry()
    ;(chrome.tabs.query as jest.Mock).mockResolvedValue([{ id: 19 }])
    ;(chrome.tabs.sendMessage as jest.Mock).mockImplementation(
      (_tabId, _message, callback) => {
        ;(chrome.runtime as unknown as {
          lastError?: { message: string }
        }).lastError = { message: 'unexpected tab messaging failure' }
        callback()
        delete (chrome.runtime as unknown as {
          lastError?: { message: string }
        }).lastError
      }
    )
    ;(chrome.storage.session.set as jest.Mock).mockImplementation(
      (_items, callback) => {
        ;(chrome.runtime as unknown as {
          lastError?: { message: string }
        }).lastError = { message: 'session write failed' }
        callback()
        delete (chrome.runtime as unknown as {
          lastError?: { message: string }
        }).lastError
      }
    )

    await expect(revokeSentryTelemetry()).rejects.toThrow(
      'Failed to fully revoke Sentry telemetry'
    )
  })

  it('directly stops content scripts when Chrome settings revoke the optional host', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    let onRemoved:
      ((permissions: chrome.permissions.Permissions) => void) | undefined
    ;(chrome.permissions.onRemoved.addListener as jest.Mock)
      .mockImplementation(listener => {
        onRemoved = listener
      })
    ;(chrome.permissions.request as jest.Mock).mockResolvedValue(true)
    await requestSentryTelemetry()
    ;(chrome.tabs.query as jest.Mock).mockResolvedValue([{ id: 23 }])
    ;(chrome.tabs.sendMessage as jest.Mock).mockImplementation(
      (_tabId, message, callback) => callback({
        sentryTelemetryStateApplied: message.type
      })
    )
    ;(chrome.permissions.remove as jest.Mock).mockResolvedValue(false)
    ;(chrome.permissions.contains as jest.Mock).mockResolvedValue(false)
    ;(chrome.storage.session.set as jest.Mock).mockImplementation(
      (_items, callback) => {
        ;(chrome.runtime as unknown as {
          lastError?: { message: string }
        }).lastError = { message: 'session write failed' }
        callback()
        delete (chrome.runtime as unknown as {
          lastError?: { message: string }
        }).lastError
      }
    )

    registerSentryPermissionRevocationSync()
    onRemoved?.({ origins: [SENTRY_HOST_PERMISSION] })

    await waitForTabMessage('pokerchase:sentry-telemetry-revoked')
    await expect(readLocal()).resolves.toEqual({
      [SENTRY_TELEMETRY_CONSENT_STORAGE_KEY]: false
    })
  })
})

const waitForPermissionCheck = async (): Promise<void> => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if ((chrome.permissions.contains as jest.Mock).mock.calls.length > 0) return
    await Promise.resolve()
  }
  throw new Error('permission check did not start')
}

const waitForTabMessage = async (type: string): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (
      (chrome.tabs.sendMessage as jest.Mock).mock.calls.some(
        ([, message]) => message?.type === type
      )
    ) {
      return
    }
    await Promise.resolve()
  }
  throw new Error(`Tab message ${type} was not sent`)
}

const waitForPendingTabMessage = async (): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((chrome.tabs.sendMessage as jest.Mock).mock.calls.length > 0) return
    await Promise.resolve()
  }
  throw new Error('Tab message did not start')
}
