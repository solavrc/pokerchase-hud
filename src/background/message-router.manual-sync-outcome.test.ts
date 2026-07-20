/**
 * message-router.ts - manual sync response truthfulness (independent
 * release-audit finding #12, "manual sync reports success on internal
 * failure")
 *
 * `autoSyncService.performSync()` has a long-standing never-throw contract
 * on its own internal failure paths (the remote min-version gate blocking
 * sync, or `syncToCloud()`/`syncFromCloud()` throwing) -- `initialize()` and
 * `syncIfBacklogExceedsThreshold()` both rely on it resolving cleanly on
 * every path so their own retry/backoff logic keeps running. Before this
 * fix, `performSync()` returned `Promise<void>`, so a caller checking only
 * resolve-vs-reject (as `message-router.ts`'s manual-sync handlers did) had
 * no way to see those internal failures: `firebaseSyncToCloud`/
 * `firebaseSyncFromCloud`/`manualSyncUpload`/`manualSyncDownload` all did
 * `.then(() => sendResponse({ success: true }))` unconditionally on
 * resolution, so a Firestore failure or a min-version-gate block --
 * `updateSyncState({ status: 'error', ... })` ran internally -- was still
 * reported to the popup as `{ success: true }`.
 *
 * `performSync()` now resolves with a structured `SyncOutcome`
 * (`{ success: boolean, error?: string }`) instead, and message-router.ts's
 * manual-sync handlers build their response from it. These tests assert the
 * manual sync response is truthful for both failure modes the audit named,
 * using `jest.spyOn(autoSyncService, 'performSync')` to simulate each
 * (rather than driving real Firestore/min-version-gate failures, which
 * belong to auto-sync-service.ts's own test suite) -- this test's job is
 * only to verify message-router.ts's contract with whatever performSync()
 * resolves.
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { registerMessageRouter } from './message-router'
import { setOperationState } from './operation-state'
import { autoSyncService, MIN_VERSION_SYNC_BLOCKED_MESSAGE } from '../services/auto-sync-service'
import type { ChromeMessage, MessageResponse } from '../types/messages'

describe('message-router manual sync response truthfulness', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let listener: (request: ChromeMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: MessageResponse) => void) => boolean | void

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
    jest.restoreAllMocks()
    db.close()
    await db.delete()
  })

  describe.each([
    ['firebaseSyncToCloud' as const],
    ['manualSyncUpload' as const],
    ['manualSyncDownload' as const],
  ])('%s', (action) => {
    test('reports failure (not success) when performSync resolves with an internal Firestore-style error', async () => {
      jest.spyOn(autoSyncService, 'performSync').mockResolvedValue({
        success: false,
        error: 'Firestore write failed: permission-denied'
      })

      const sendResponse = jest.fn()
      const handled = listener({ action } as ChromeMessage, {}, sendResponse)
      expect(handled).toBe(true)

      await new Promise(resolve => setTimeout(resolve, 0))

      expect(sendResponse).toHaveBeenCalledWith({
        success: false,
        error: 'Firestore write failed: permission-denied'
      })
    })

    test('reports failure (not success) when performSync resolves min-version-gate-blocked', async () => {
      jest.spyOn(autoSyncService, 'performSync').mockResolvedValue({
        success: false,
        error: MIN_VERSION_SYNC_BLOCKED_MESSAGE
      })

      const sendResponse = jest.fn()
      const handled = listener({ action } as ChromeMessage, {}, sendResponse)
      expect(handled).toBe(true)

      await new Promise(resolve => setTimeout(resolve, 0))

      expect(sendResponse).toHaveBeenCalledWith({
        success: false,
        error: MIN_VERSION_SYNC_BLOCKED_MESSAGE
      })
    })

    test('reports success when performSync resolves successfully', async () => {
      jest.spyOn(autoSyncService, 'performSync').mockResolvedValue({ success: true })

      const sendResponse = jest.fn()
      const handled = listener({ action } as ChromeMessage, {}, sendResponse)
      expect(handled).toBe(true)

      await new Promise(resolve => setTimeout(resolve, 0))

      expect(sendResponse).toHaveBeenCalledWith({ success: true })
    })
  })
})
