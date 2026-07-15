import { FirestoreBackupService } from './firestore-backup-service'
import { firebaseAuthService } from './firebase-auth-service'
import type { ApiEvent } from '../types'

describe('FirestoreBackupService', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    jest.restoreAllMocks()
    if (originalFetch) {
      global.fetch = originalFetch
    } else {
      delete (global as { fetch?: typeof fetch }).fetch
    }
  })

  test('batchWrite uses a Firestore resource name instead of a REST URL', async () => {
    jest.spyOn(firebaseAuthService, 'ready').mockResolvedValue()
    jest.spyOn(firebaseAuthService, 'getCurrentUser').mockReturnValue({
      uid: 'XK00mmVIZdg8J52OlfyKvN467SK2',
      email: null,
      displayName: null,
      photoURL: null,
      getIdToken: jest.fn()
    })
    jest.spyOn(firebaseAuthService, 'getIdToken').mockResolvedValue('test-token')

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({})
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
})
