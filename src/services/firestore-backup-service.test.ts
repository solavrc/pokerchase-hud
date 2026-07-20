import { FirestoreBackupService } from './firestore-backup-service'
import { firebaseAuthService } from './firebase-auth-service'
import type { ApiEvent } from '../types'

describe('FirestoreBackupService', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    jest.spyOn(firebaseAuthService, 'ready').mockResolvedValue()
    jest.spyOn(firebaseAuthService, 'getCurrentUser').mockReturnValue({
      uid: 'XK00mmVIZdg8J52OlfyKvN467SK2',
      email: null,
      displayName: null,
      photoURL: null,
      getIdToken: jest.fn()
    })
    jest.spyOn(firebaseAuthService, 'getIdToken').mockResolvedValue('test-token')
  })

  afterEach(() => {
    jest.restoreAllMocks()
    if (originalFetch) {
      global.fetch = originalFetch
    } else {
      delete (global as { fetch?: typeof fetch }).fetch
    }
  })

  test('commitWrites uses a Firestore resource name instead of a REST URL', async () => {
    const fetchMock = jest.fn().mockImplementation(async (url: string) => ({
      ok: true,
      text: async () => String(url).endsWith(':commit')
        ? JSON.stringify({ writeResults: [{}], commitTime: '2026-07-18T00:00:00Z' })
        : '{}'
    } as Response))
    global.fetch = fetchMock
    const event = {
      timestamp: 1779859063171,
      ApiTypeId: 304
    } as unknown as ApiEvent

    await new FirestoreBackupService().syncToCloudBatch([event], null)

    const commitCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith(':commit'))
    expect(commitCall).toBeDefined()

    const [url, init] = commitCall!
    expect(url).toBe(
      'https://firestore.googleapis.com/v1/projects/pokerchase-hud/databases/(default)/documents:commit'
    )

    const body = JSON.parse(String(init?.body))
    expect(body.writes[0].update.name).toBe(
      'projects/pokerchase-hud/databases/(default)/documents/users/' +
      'XK00mmVIZdg8J52OlfyKvN467SK2/apiEvents/1779859063171_304'
    )
    expect(body.writes[0].update.name).not.toMatch(/^https?:\/\//)
  })

  test('commitWrites rejects when Firestore denies the write at the HTTP level (e.g. rules PERMISSION_DENIED)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({
        error: { code: 403, message: 'Missing or insufficient permissions.', status: 'PERMISSION_DENIED' }
      })
    } as Response)

    const event = { timestamp: 1779859063171, ApiTypeId: 304 } as unknown as ApiEvent
    await expect(new FirestoreBackupService().syncToCloudBatch([event], null))
      .rejects.toThrow('Firestore REST request failed: 403')
  })

  test('commitWrites retries on HTTP 429 RESOURCE_EXHAUSTED', async () => {
    let commitCalls = 0
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (!String(url).endsWith(':commit')) {
        return { ok: true, text: async () => '{}' } as Response
      }
      commitCalls++
      if (commitCalls === 1) {
        return {
          ok: false,
          status: 429,
          text: async () => JSON.stringify({
            error: { code: 429, message: 'RESOURCE_EXHAUSTED', status: 'RESOURCE_EXHAUSTED' }
          })
        } as Response
      }
      return {
        ok: true,
        text: async () => JSON.stringify({ writeResults: [{}], commitTime: '2026-07-18T00:00:00Z' })
      } as Response
    })

    const event = { timestamp: 1779859063171, ApiTypeId: 304 } as unknown as ApiEvent
    const summary = await new FirestoreBackupService().syncToCloudBatch([event], null)

    expect(summary.syncedEvents).toBe(1)
    expect(commitCalls).toBe(2)
  })

  test('syncFromCloud downloads matching events in bounded, cursor-based pages', async () => {
    const uid = 'XK00mmVIZdg8J52OlfyKvN467SK2'
    const documentName = (timestamp: number) =>
      `projects/pokerchase-hud/databases/(default)/documents/users/${uid}/apiEvents/${timestamp}_304`
    const queryBodies: any[] = []
    let aggregationBody: any
    let queryCount = 0

    global.fetch = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith(':runAggregationQuery')) {
        aggregationBody = JSON.parse(String(init?.body))
        return {
          ok: true,
          text: async () => JSON.stringify([{
            result: { aggregateFields: { eventCount: { integerValue: '1001' } } }
          }])
        } as Response
      }

      queryBodies.push(JSON.parse(String(init?.body)))
      queryCount++
      const timestamps = queryCount === 1
        ? Array.from({ length: 1000 }, (_, index) => 101 + index)
        : [1101]
      return {
        ok: true,
        text: async () => JSON.stringify(timestamps.map(timestamp => ({
          document: {
            name: documentName(timestamp),
            fields: {
              timestamp: { integerValue: String(timestamp) },
              ApiTypeId: { integerValue: '304' }
            }
          }
        })))
      } as Response
    })

    const receivedBatches: ApiEvent[][] = []
    const onProgress = jest.fn()
    await expect(new FirestoreBackupService().syncFromCloud({
      onBatch: async events => { receivedBatches.push(events) },
      onProgress
    })).resolves.toBe(1001)

    expect(receivedBatches.map(batch => batch.length)).toEqual([1000, 1])
    expect(onProgress).toHaveBeenLastCalledWith({ current: 1001, total: 1001 })

    expect(aggregationBody.structuredAggregationQuery.structuredQuery.startAt).toBeUndefined()

    const firstQuery = queryBodies[0].structuredQuery
    expect(firstQuery.limit).toBe(1000)
    expect(firstQuery.orderBy).toEqual([
      { field: { fieldPath: 'timestamp' }, direction: 'ASCENDING' },
      { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }
    ])
    expect(firstQuery.startAt).toBeUndefined()

    const secondQuery = queryBodies[1].structuredQuery
    expect(secondQuery.startAt).toEqual({
      values: [
        { integerValue: '1100' },
        { referenceValue: documentName(1100) }
      ],
      before: false
    })
  })

  test('getCloudMaxTimestamp rejects instead of swallowing to null when the REST query fails (codex review round 4 on PR #182)', async () => {
    // `null` from this method is load-bearing elsewhere (AutoSyncService's
    // one-time unparseable-floor backfill treats it as "cloud proven empty,
    // nothing to backfill past"). A transient auth/network/REST failure must
    // never be indistinguishable from that -- it has to throw instead.
    // (Small retryBaseDelayMs keeps the transient-retry backoff from slowing
    // the suite -- a persistent 500 is retried before the final throw.)
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({
        error: { code: 500, message: 'Internal error', status: 'INTERNAL' }
      })
    } as Response)

    await expect(new FirestoreBackupService({ retryBaseDelayMs: 1 }).getCloudMaxTimestamp())
      .rejects.toThrow('Firestore REST request failed: 500')
  })

  test('getCloudMaxTimestamp returns null when the cloud collection is proven empty', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      // Firestore's runQuery returns a readTime-only entry (no `document`)
      // for a query that matched nothing -- same shape asserted by the
      // "syncFromCloud treats ... as no events" cases below.
      text: async () => JSON.stringify([{ readTime: '2026-07-20T00:00:00Z' }])
    } as Response)

    await expect(new FirestoreBackupService().getCloudMaxTimestamp()).resolves.toBeNull()
  })

  test('getCloudMaxTimestamp returns the latest event timestamp when the cloud has data (proven watermark)', async () => {
    const uid = 'XK00mmVIZdg8J52OlfyKvN467SK2'
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify([{
        document: {
          name: `projects/pokerchase-hud/databases/(default)/documents/users/${uid}/apiEvents/12345_304`,
          fields: {
            timestamp: { integerValue: '12345' },
            ApiTypeId: { integerValue: '304' }
          }
        }
      }])
    } as Response)

    await expect(new FirestoreBackupService().getCloudMaxTimestamp()).resolves.toBe(12345)
  })

  test.each([
    ['an empty response body', ''],
    ['a metadata-only query response', JSON.stringify([{ readTime: '2026-07-15T00:00:00Z' }])]
  ])('syncFromCloud treats %s as no events', async (_description, responseBody) => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => ({
      ok: true,
      text: async () => String(url).endsWith(':runAggregationQuery')
        ? JSON.stringify([{ result: { aggregateFields: { eventCount: { integerValue: '0' } } } }])
        : responseBody
    } as Response))

    const onBatch = jest.fn()
    await expect(new FirestoreBackupService().syncFromCloud({ onBatch })).resolves.toBe(0)
    expect(onBatch).not.toHaveBeenCalled()
  })
})

describe('FirestoreBackupService transport hardening (release audit 2026-07-21: timeout/abort/retry/401-refresh)', () => {
  const originalFetch = global.fetch
  // Small values so timeout/backoff paths run in milliseconds. Retry budget
  // matches the production default shape: 1 initial attempt + 2 transient
  // retries = 3 attempts max.
  const fastTransport = { requestTimeoutMs: 30, retryBaseDelayMs: 1, maxTransientRetries: 2 }

  beforeEach(() => {
    jest.spyOn(firebaseAuthService, 'ready').mockResolvedValue()
    jest.spyOn(firebaseAuthService, 'getCurrentUser').mockReturnValue({
      uid: 'XK00mmVIZdg8J52OlfyKvN467SK2',
      email: null,
      displayName: null,
      photoURL: null,
      getIdToken: jest.fn()
    })
    jest.spyOn(firebaseAuthService, 'getIdToken').mockImplementation(
      async (forceRefresh?: boolean) => forceRefresh ? 'refreshed-token' : 'initial-token'
    )
    jest.spyOn(firebaseAuthService, 'getAuthGeneration').mockReturnValue(7)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    if (originalFetch) {
      global.fetch = originalFetch
    } else {
      delete (global as { fetch?: typeof fetch }).fetch
    }
  })

  test('a stalled fetch is aborted by the request timeout, retried with backoff, and rejects after the bounded retry budget', async () => {
    // Never-resolving fetch that only settles when the AbortController fires
    // -- the exact "stalled connection holds isSyncing forever" failure mode
    // the timeout exists to prevent.
    const fetchMock = jest.fn().mockImplementation((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
        })
      })
    )
    global.fetch = fetchMock

    await expect(new FirestoreBackupService(fastTransport).getCloudMaxTimestamp())
      .rejects.toThrow('Firestore REST request timed out after 30ms')
    // 1 initial attempt + 2 transient retries, then a terminal throw.
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test('401 force-refreshes the token via getIdToken(true) and retries exactly once with the refreshed token', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED' } })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{ readTime: '2026-07-21T00:00:00Z' }])
      } as Response)
    global.fetch = fetchMock

    await expect(new FirestoreBackupService(fastTransport).getCloudMaxTimestamp()).resolves.toBeNull()

    expect(firebaseAuthService.getIdToken).toHaveBeenCalledWith(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstHeaders = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
    const secondHeaders = (fetchMock.mock.calls[1]![1] as RequestInit).headers as Record<string, string>
    expect(firstHeaders['Authorization']).toBe('Bearer initial-token')
    expect(secondHeaders['Authorization']).toBe('Bearer refreshed-token')
  })

  test('a hung forced token refresh during 401 recovery is bounded by the transport timeout instead of stalling the request funnel (codex review r3617177865)', async () => {
    // FirebaseAuthService.getIdToken()'s internal Secure Token API fetch has
    // no AbortController -- simulate it stalling forever on the forced
    // refresh, while the initial (cached-token) call resolves normally.
    jest.spyOn(firebaseAuthService, 'getIdToken').mockImplementation(
      (forceRefresh?: boolean) => forceRefresh
        ? new Promise<string>(() => { }) // hangs forever
        : Promise.resolve('initial-token')
    )
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED' } })
    } as Response)
    global.fetch = fetchMock

    // Fails within the bound (30ms here) as an auth failure -- before this
    // fix the bare `await getIdToken(true)` hung the funnel indefinitely,
    // leaving AutoSyncService._isSyncing latched.
    await expect(new FirestoreBackupService(fastTransport).getCloudMaxTimestamp())
      .rejects.toThrow('forced token refresh timed out after 30ms')
    // Terminal: no retry was attempted after the timed-out refresh.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('a second 401 on the refreshed token is terminal (no refresh loop)', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED' } })
    } as Response)
    global.fetch = fetchMock

    await expect(new FirestoreBackupService(fastTransport).getCloudMaxTimestamp())
      .rejects.toThrow('Firestore REST request failed: 401')
    // Exactly one refresh, exactly two attempts -- 401 is not in the
    // transient-retry class, so no backoff retries pile on top.
    expect(firebaseAuthService.getIdToken).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('the 401 retry is aborted without a token refresh when the signed-in account changed mid-request (auth generation gate)', async () => {
    // Generation moves between the request-start snapshot and the 401
    // handling -- an account switch landed while the request was in flight.
    // A uid comparison could be fooled by an A -> B -> A round trip; the
    // generation counter cannot. Reads in order: pass-start snapshot (7),
    // the fail-fast check after the initial token acquisition (still 7 --
    // the switch lands later, mid-request), then the 401 gate (9).
    const generationSpy = firebaseAuthService.getAuthGeneration as jest.Mock
    generationSpy.mockReturnValueOnce(7).mockReturnValueOnce(7).mockReturnValue(9)

    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED' } })
    } as Response)
    global.fetch = fetchMock

    await expect(new FirestoreBackupService(fastTransport).getCloudMaxTimestamp())
      .rejects.toThrow('the signed-in account changed while the request was in flight')
    // Aborted WITHOUT committing to a retry: no forced refresh, no second fetch.
    expect(firebaseAuthService.getIdToken).not.toHaveBeenCalledWith(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('persistent 5xx is retried with backoff but strictly bounded', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE' } })
    } as Response)
    global.fetch = fetchMock

    await expect(new FirestoreBackupService(fastTransport).getCloudMaxTimestamp())
      .rejects.toThrow('Firestore REST request failed: 503')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test('a transient 5xx recovers on retry without failing the call', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: { code: 500, status: 'INTERNAL' } })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{ readTime: '2026-07-21T00:00:00Z' }])
      } as Response)
    global.fetch = fetchMock

    await expect(new FirestoreBackupService(fastTransport).getCloudMaxTimestamp()).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('an account switch DURING the initial token acquisition aborts before any request is issued (codex review r3617090425)', async () => {
    // getIdToken() internally awaits a network refresh when the cached token
    // is expired -- an account switch landing inside that await used to slip
    // past the gate entirely, because the generation snapshot was taken
    // AFTER the token await (against the NEW account's baseline). Reads in
    // order: pass-start snapshot (7), then the post-acquisition check (9 --
    // the switch landed while the token was being refreshed).
    const generationSpy = firebaseAuthService.getAuthGeneration as jest.Mock
    generationSpy.mockReturnValueOnce(7).mockReturnValue(9)

    const fetchMock = jest.fn()
    global.fetch = fetchMock

    await expect(new FirestoreBackupService(fastTransport).getCloudMaxTimestamp())
      .rejects.toThrow('the signed-in account changed while the request was in flight')
    // Fails fast: nothing is ever sent under the ambiguous identity, and no
    // forced refresh is attempted.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(firebaseAuthService.getIdToken).not.toHaveBeenCalledWith(true)
  })

  test('a persistent 429 on a write batch is retried by exactly one layer -- the transport budget, not writeBatch times transport (codex review r3617090429)', async () => {
    let commitCalls = 0
    const fetchMock = jest.fn().mockImplementation(async (url: string) => {
      if (!String(url).endsWith(':commit')) {
        return { ok: true, status: 200, text: async () => '{}' } as Response
      }
      commitCalls++
      return {
        ok: false,
        status: 429,
        text: async () => JSON.stringify({
          error: { code: 429, message: 'RESOURCE_EXHAUSTED', status: 'RESOURCE_EXHAUSTED' }
        })
      } as Response
    })
    global.fetch = fetchMock

    const event = { timestamp: 1779859063171, ApiTypeId: 304 } as unknown as ApiEvent

    await expect(new FirestoreBackupService(fastTransport).syncToCloudBatch([event], null))
      .rejects.toThrow('Cloud sync failed')
    // Exactly the transport's budget (1 initial + 2 transient retries).
    // Before r3617090429's fix, writeBatch ran its OWN 3-attempt rate-limit
    // loop on top of the transport's, hammering the throttled backend with
    // up to 9 commit attempts for a single batch.
    expect(commitCalls).toBe(3)
  })

  test('a non-retryable 4xx (400) fails immediately with no retry and no token refresh', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT' } })
    } as Response)
    global.fetch = fetchMock

    await expect(new FirestoreBackupService(fastTransport).getCloudMaxTimestamp())
      .rejects.toThrow('Firestore REST request failed: 400')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(firebaseAuthService.getIdToken).not.toHaveBeenCalledWith(true)
  })
})
