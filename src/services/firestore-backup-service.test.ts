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

  test('batchWrite uses a Firestore resource name instead of a REST URL', async () => {
    const fetchMock = jest.fn().mockImplementation(async (url: string) => ({
      ok: true,
      text: async () => String(url).endsWith(':batchWrite')
        ? JSON.stringify({ status: [{}] })
        : '{}'
    } as Response))
    global.fetch = fetchMock
    const event = {
      timestamp: 1779859063171,
      ApiTypeId: 304
    } as unknown as ApiEvent

    await new FirestoreBackupService().syncToCloudBatch([event], null)

    const batchWriteCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith(':batchWrite'))
    expect(batchWriteCall).toBeDefined()

    const [url, init] = batchWriteCall!
    expect(url).toBe(
      'https://firestore.googleapis.com/v1/projects/pokerchase-hud/databases/(default)/documents:batchWrite'
    )

    const body = JSON.parse(String(init?.body))
    expect(body.writes[0].update.name).toBe(
      'projects/pokerchase-hud/databases/(default)/documents/users/' +
      'XK00mmVIZdg8J52OlfyKvN467SK2/apiEvents/1779859063171_304'
    )
    expect(body.writes[0].update.name).not.toMatch(/^https?:\/\//)
  })

  test('batchWrite rejects an individual write failure returned with HTTP 200', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        status: [{ code: 7, message: 'Missing or insufficient permissions.' }]
      })
    } as Response)

    const event = { timestamp: 1779859063171, ApiTypeId: 304 } as unknown as ApiEvent
    await expect(new FirestoreBackupService().syncToCloudBatch([event], null))
      .rejects.toThrow('Firestore batchWrite failed for 1/1 writes')
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
