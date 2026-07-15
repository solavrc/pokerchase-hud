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
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => '{}'
    } as Response)
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

  test.each([
    ['an empty response body', ''],
    ['a metadata-only query response', JSON.stringify([{ readTime: '2026-07-15T00:00:00Z' }])]
  ])('syncFromCloud treats %s as no events', async (_description, responseBody) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => responseBody
    } as Response)

    await expect(new FirestoreBackupService().syncFromCloud()).resolves.toEqual([])
  })
})
