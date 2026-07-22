import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import type { AuthUser } from '../services/firebase-auth-service'
import { firebaseAuthService } from '../services/firebase-auth-service'
import { autoSyncService } from '../services/auto-sync-service'
import type { ChromeMessage, MessageResponse } from '../types/messages'
import { registerMessageRouter } from './message-router'

describe('message-router firebaseSignOut auth-transition ordering', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let listener: (
    request: ChromeMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: MessageResponse) => void
  ) => boolean | void

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = new PokerChaseService({ db })
    await service.ready

    ;(chrome.runtime.onMessage.addListener as jest.Mock).mockClear()
    registerMessageRouter(service, db, 'https://example.com/*')
    listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0]
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    db.close()
    await db.delete()
  })

  test('does not apply a stale signed-out sync reset after a newer account becomes current', async () => {
    const newerUser: AuthUser = {
      uid: 'user-b',
      email: 'b@example.com',
      displayName: null,
      photoURL: null,
      getIdToken: async () => 'b-token'
    }
    jest.spyOn(firebaseAuthService, 'signOut').mockResolvedValue()
    jest.spyOn(firebaseAuthService, 'getCurrentUser').mockReturnValue(newerUser)
    const authStateChanged = jest.spyOn(autoSyncService, 'onAuthStateChanged').mockResolvedValue()
    const sendResponse = jest.fn()

    expect(listener({ action: 'firebaseSignOut' }, {}, sendResponse)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(authStateChanged).not.toHaveBeenCalledWith(null)
    expect(sendResponse).toHaveBeenCalledWith({ success: true })
  })

  test('still resets sync state when sign-out leaves no current user', async () => {
    jest.spyOn(firebaseAuthService, 'signOut').mockResolvedValue()
    jest.spyOn(firebaseAuthService, 'getCurrentUser').mockReturnValue(null)
    const authStateChanged = jest.spyOn(autoSyncService, 'onAuthStateChanged').mockResolvedValue()
    const sendResponse = jest.fn()

    expect(listener({ action: 'firebaseSignOut' }, {}, sendResponse)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(authStateChanged).toHaveBeenCalledWith(null)
    expect(sendResponse).toHaveBeenCalledWith({ success: true })
  })
})
