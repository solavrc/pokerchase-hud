import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import type { ChromeMessage, MessageResponse } from '../types/messages'
import { registerMessageRouter } from './message-router'
import { setOperationState } from './operation-state'

describe('message-router import notifications', () => {
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
    setOperationState({ type: 'idle' })
    ;(chrome.runtime.onMessage.addListener as jest.Mock).mockClear()
    registerMessageRouter(service, db, 'https://example.com/*')
    listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0]
  })

  afterEach(async () => {
    setOperationState({ type: 'idle' })
    jest.restoreAllMocks()
    db.close()
    await db.delete()
  })

  test('missing popup receivers do not reject a successful background import', async () => {
    ;(chrome.runtime.sendMessage as jest.Mock).mockRejectedValue(
      new Error('Could not establish connection. Receiving end does not exist.')
    )
    const response = new Promise<MessageResponse>(resolve => {
      listener({
        action: 'importData',
        data: JSON.stringify({ timestamp: 1_000, ApiTypeId: 9_999, marker: 'raw-only' })
      }, {}, resolve)
    })

    await expect(response).resolves.toEqual({ success: true })
    await Promise.resolve()
    expect(await db.apiEvents.count()).toBe(1)
  })
})
