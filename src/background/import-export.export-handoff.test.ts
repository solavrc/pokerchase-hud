/**
 * import-export.ts - export download-handoff completion (codex review, PR #150 audit finding #2)
 *
 * `exportJsonData()`/`exportPokerStarsData()` call `downloadFile()`, which
 * hands the exported content off to the content script via
 * `chrome.tabs.query()` -> `chrome.tabs.sendMessage()`. `chrome.tabs.query()`
 * is a genuinely async Chrome extension API (callback-based), so before this
 * fix `downloadFile()` returned `void` and its caller moved straight on to
 * `setOperationState({ type: 'idle' })` without waiting for that callback to
 * fire. `operation-state.ts`'s `onOperationBecameIdle` hook feeds directly
 * into `update-manager.ts`'s `recheckPendingUpdate()`, which can call
 * `chrome.runtime.reload()` the instant it observes idle+safe -- reloading
 * the service worker before the download handoff was ever dispatched, so
 * the user sees "export complete" while the actual file never arrives.
 *
 * These tests assert the fixed ordering: the handoff (`chrome.tabs.sendMessage`)
 * must fire while operationState is still `'export'`, and `exportData()` must
 * not resolve until after that handoff was dispatched.
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { createImportExportHandlers } from './import-export'
import { getOperationState, setOperationState } from './operation-state'

describe('export download-handoff completion', () => {
  let db: PokerChaseDB
  let service: PokerChaseService

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = new PokerChaseService({ db })
    await service.ready
    setOperationState({ type: 'idle' })
    jest.clearAllMocks()
    // exportJsonData/exportPokerStarsData chain .catch() off every
    // chrome.runtime.sendMessage() progress-broadcast call.
    ;(chrome.runtime.sendMessage as jest.Mock).mockReturnValue(Promise.resolve())
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    db.close()
    await db.delete()
  })

  test('NDJSON export (json format) dispatches the tabs.sendMessage handoff before returning to idle', async () => {
    let operationStateWhenHandoffFired: string | undefined
    // Simulate a genuinely async chrome.tabs.query completion (a real
    // extension API call is callback-based and never resolves synchronously)
    // -- a caller that doesn't await the handoff would already have flipped
    // operationState back to idle by the time this callback runs.
    ;(chrome.tabs.query as jest.Mock).mockImplementation((_query, callback) => {
      setTimeout(() => callback([{ id: 42 }]), 0)
    })
    ;(chrome.tabs.sendMessage as jest.Mock).mockImplementation(() => {
      operationStateWhenHandoffFired = getOperationState().type
    })

    const handlers = createImportExportHandlers(service, db, 'https://example.com/*')
    await handlers.exportData('json')

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ action: 'downloadFile' })
    )
    // The handoff must be dispatched while the operation is still marked
    // 'export' -- NOT 'idle' -- or update-manager's operation-idle recheck
    // could race a reload() in ahead of it.
    expect(operationStateWhenHandoffFired).toBe('export')
    expect(getOperationState()).toEqual({ type: 'idle' })
  })

  test('PokerStars export dispatches the tabs.sendMessage handoff before returning to idle', async () => {
    jest.spyOn(service, 'exportHandHistory').mockResolvedValue('PokerStars Hand #1: ...')

    let operationStateWhenHandoffFired: string | undefined
    ;(chrome.tabs.query as jest.Mock).mockImplementation((_query, callback) => {
      setTimeout(() => callback([{ id: 7 }]), 0)
    })
    ;(chrome.tabs.sendMessage as jest.Mock).mockImplementation(() => {
      operationStateWhenHandoffFired = getOperationState().type
    })

    const handlers = createImportExportHandlers(service, db, 'https://example.com/*')
    await handlers.exportData('pokerstars')

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ action: 'downloadFile' })
    )
    expect(operationStateWhenHandoffFired).toBe('export')
    expect(getOperationState()).toEqual({ type: 'idle' })
  })

  test('falls back to a data-URL download (and still awaits it) when no game tab is open', async () => {
    ;(chrome.tabs.query as jest.Mock).mockImplementation((_query, callback) => {
      setTimeout(() => callback([]), 0) // no matching tabs
    })

    const handlers = createImportExportHandlers(service, db, 'https://example.com/*')
    await handlers.exportData('json')

    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled()
    expect(chrome.downloads.download).toHaveBeenCalledTimes(1)
    expect(getOperationState()).toEqual({ type: 'idle' })
  })
})
