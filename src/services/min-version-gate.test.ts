/**
 * Unit tests for the remote min-version gate (src/services/min-version-gate.ts).
 *
 * Covers the fail-open matrix (fetch error, non-OK response, invalid JSON,
 * missing/malformed field), the supported/unsupported comparison paths, the
 * 12h TTL cache, and the isCloudSyncBlockedByMinVersionGate() convenience guard.
 */
import {
  checkMinVersionGate,
  getCachedMinVersionGateState,
  isCloudSyncBlockedByMinVersionGate,
  MIN_VERSION_GATE_STORAGE_KEY,
} from './min-version-gate'

const jsonResponse = (body: unknown, ok = true, status = 200): Response => ({
  ok,
  status,
  json: async () => body,
} as unknown as Response)

describe('min-version-gate', () => {
  const originalFetch = global.fetch

  beforeEach(async () => {
    await chrome.storage.local.set({ [MIN_VERSION_GATE_STORAGE_KEY]: undefined })
    jest.clearAllMocks()
  })

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch
    } else {
      delete (global as { fetch?: typeof fetch }).fetch
    }
  })

  describe('fail-open matrix', () => {
    it('fails open when fetch itself throws (network error)', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('network down'))

      const state = await checkMinVersionGate('5.1.0')

      expect(state.supported).toBe(true)
      expect(global.fetch).toHaveBeenCalledTimes(1)
    })

    it('fails open on a non-OK response (e.g. 404 -- doc does not exist yet)', async () => {
      global.fetch = jest.fn().mockResolvedValue(jsonResponse({}, false, 404))

      const state = await checkMinVersionGate('5.1.0')

      expect(state.supported).toBe(true)
    })

    it('fails open when the response body is not valid JSON', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError('Unexpected token') },
      } as unknown as Response)

      const state = await checkMinVersionGate('5.1.0')

      expect(state.supported).toBe(true)
    })

    it('fails open when the minSupportedVersion field is missing', async () => {
      global.fetch = jest.fn().mockResolvedValue(jsonResponse({ fields: {} }))

      const state = await checkMinVersionGate('5.1.0')

      expect(state.supported).toBe(true)
    })

    it('fails open when the minSupportedVersion field is malformed (non-numeric segments)', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse({ fields: { minSupportedVersion: { stringValue: 'not-a-version' } } })
      )

      const state = await checkMinVersionGate('5.1.0')

      // compareVersions returns null for non-numeric segments -> isVersionBelow() is false -> supported
      expect(state.supported).toBe(true)
      expect(state.minSupportedVersion).toBe('not-a-version')
    })
  })

  describe('supported/unsupported comparison', () => {
    it('is supported when current version >= minSupportedVersion', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse({ fields: { minSupportedVersion: { stringValue: '5.0.0' } } })
      )

      const state = await checkMinVersionGate('5.1.0')

      expect(state.supported).toBe(true)
      expect(state.minSupportedVersion).toBe('5.0.0')
    })

    it('is unsupported when current version < minSupportedVersion', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse({ fields: { minSupportedVersion: { stringValue: '6.0.0' } } })
      )

      const state = await checkMinVersionGate('5.1.0')

      expect(state.supported).toBe(false)
      expect(state.minSupportedVersion).toBe('6.0.0')
    })

    it('requests the public REST URL with an API key and no Authorization header', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        jsonResponse({ fields: { minSupportedVersion: { stringValue: '5.0.0' } } })
      )
      global.fetch = fetchMock

      await checkMinVersionGate('5.1.0')

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe(
        'https://firestore.googleapis.com/v1/projects/pokerchase-hud/databases/(default)/documents/config/client?key=AIzaSyDflMV4xVPhKxsN_k0daWFOsCLn3CEtDAs'
      )
      expect(init).toBeUndefined()
    })
  })

  describe('caching (12h TTL)', () => {
    it('does not re-fetch within the TTL window', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        jsonResponse({ fields: { minSupportedVersion: { stringValue: '5.0.0' } } })
      )
      global.fetch = fetchMock

      const now = Date.now()
      await checkMinVersionGate('5.1.0', now)
      await checkMinVersionGate('5.1.0', now + 60 * 60 * 1000) // +1h, still within 12h

      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('re-fetches once the TTL expires', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        jsonResponse({ fields: { minSupportedVersion: { stringValue: '5.0.0' } } })
      )
      global.fetch = fetchMock

      const now = Date.now()
      await checkMinVersionGate('5.1.0', now)
      await checkMinVersionGate('5.1.0', now + 13 * 60 * 60 * 1000) // +13h, past 12h TTL

      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('persists the fetched state so getCachedMinVersionGateState reflects it', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse({ fields: { minSupportedVersion: { stringValue: '5.0.0' } } })
      )

      await checkMinVersionGate('5.1.0')
      const cached = await getCachedMinVersionGateState()

      expect(cached?.supported).toBe(true)
      expect(cached?.minSupportedVersion).toBe('5.0.0')
    })
  })

  describe('isCloudSyncBlockedByMinVersionGate', () => {
    it('is false (not blocked) when supported', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse({ fields: { minSupportedVersion: { stringValue: '1.0.0' } } })
      )

      await expect(isCloudSyncBlockedByMinVersionGate()).resolves.toBe(false)
    })

    it('is true (blocked) when the current version is below the remote minimum', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse({ fields: { minSupportedVersion: { stringValue: '999.0.0' } } })
      )

      await expect(isCloudSyncBlockedByMinVersionGate()).resolves.toBe(true)
    })

    it('is false (fail-open) when the fetch fails', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('offline'))

      await expect(isCloudSyncBlockedByMinVersionGate()).resolves.toBe(false)
    })
  })
})
