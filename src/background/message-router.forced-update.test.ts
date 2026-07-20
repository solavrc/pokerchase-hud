/**
 * message-router.ts - applyPendingUpdate plumbing
 *
 * Verifies the popup's "今すぐ適用" button message is wired end-to-end:
 * registerMessageRouter() dispatches 'applyPendingUpdate' to
 * update-manager.ts's applyUpdateNow(), and relays its {applied, reason} result.
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { registerMessageRouter } from './message-router'
import { markSessionActive, markSessionInactive, __resetUpdateManagerStateForTests } from './update-manager'
import { setOperationState } from './operation-state'
import { autoSyncService } from '../services/auto-sync-service'
import type { ChromeMessage, MessageResponse } from '../types/messages'

describe('message-router applyPendingUpdate', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let listener: (request: ChromeMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: MessageResponse) => void) => boolean | void

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = new PokerChaseService({ db })
    await service.ready

    __resetUpdateManagerStateForTests()
    setOperationState({ type: 'idle' })
    ;(autoSyncService as any)._isSyncing = false

    ;(chrome.runtime.onMessage.addListener as jest.Mock).mockClear()
    ;(chrome.runtime.reload as jest.Mock).mockClear()
    registerMessageRouter(service, db, 'https://example.com/*')
    listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0]
  })

  afterEach(async () => {
    db.close()
    await db.delete()
  })

  test('applies and reloads when safe', async () => {
    markSessionInactive()

    const sendResponse = jest.fn()
    const handled = listener({ action: 'applyPendingUpdate' } as ChromeMessage, {}, sendResponse)
    expect(handled).toBe(true)

    await new Promise(resolve => setTimeout(resolve, 20))

    expect(sendResponse).toHaveBeenCalledWith({ success: true, applied: true, reason: undefined })
    expect(chrome.runtime.reload).toHaveBeenCalledTimes(1)
  })

  test('responds with applied:false and a reason when unsafe (session active), without reloading', async () => {
    markSessionActive()

    const sendResponse = jest.fn()
    listener({ action: 'applyPendingUpdate' } as ChromeMessage, {}, sendResponse)

    await new Promise(resolve => setTimeout(resolve, 20))

    expect(sendResponse).toHaveBeenCalledWith({
      success: true,
      applied: false,
      reason: 'ゲームセッション中のため適用できません'
    })
    expect(chrome.runtime.reload).not.toHaveBeenCalled()
  })
})
