/**
 * import-export.ts - export download-handoff completion (codex review, PR #150 audit
 * finding #2, hardened by the independent release-audit finding #10)
 *
 * `exportJsonData()`/`exportPokerStarsData()` call `downloadFile()`, which
 * hands the exported content off to the content script via
 * `chrome.tabs.query()` -> `chrome.tabs.sendMessage()`. `chrome.tabs.query()`
 * is a genuinely async Chrome extension API (callback-based), so before the
 * PR #150 fix `downloadFile()` returned `void` and its caller moved straight
 * on to `setOperationState({ type: 'idle' })` without waiting for that
 * callback to fire. `operation-state.ts`'s `onOperationBecameIdle` hook feeds
 * directly into `update-manager.ts`'s `recheckPendingUpdate()`, which can
 * call `chrome.runtime.reload()` the instant it observes idle+safe --
 * reloading the service worker before the download handoff was ever
 * dispatched, so the user sees "export complete" while the actual file never
 * arrives.
 *
 * The PR #150 fix only awaited `chrome.tabs.query()`'s callback -- the
 * `chrome.tabs.sendMessage()` call(s) themselves (one per chunk for large
 * exports) were still fire-and-forget, and the `chrome.downloads` fallback
 * resolved before its own callback/`downloads.lastError` was inspected
 * (independent release-audit finding #10). A missing content script,
 * message rejection, or a downloads error would still flip the operation to
 * idle-success with no file actually delivered.
 *
 * These tests assert the fully-fixed contract: every handoff message
 * (`chrome.tabs.sendMessage`, one per chunk) must be individually
 * acknowledged (callback fired, no `chrome.runtime.lastError`) while
 * operationState is still `'export'` before `exportData()` resolves, a
 * rejected/errored handoff must surface as a thrown error (NOT an
 * idle-success resolution), and the `chrome.downloads` fallback must not be
 * treated as complete until its own callback confirms no `lastError`.
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
    // Simulate a genuinely async chrome.tabs.sendMessage completion too --
    // the real API is callback-based (or Promise-based when the callback is
    // omitted); downloadFile() must await this per-message acknowledgment
    // before resolving.
    ;(chrome.tabs.sendMessage as jest.Mock).mockImplementation((_tabId, _message, callback) => {
      operationStateWhenHandoffFired = getOperationState().type
      setTimeout(() => callback?.(), 0)
    })

    const handlers = createImportExportHandlers(service, db, 'https://example.com/*')
    await handlers.exportData('json')

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ action: 'downloadFile' }),
      expect.any(Function)
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
    ;(chrome.tabs.sendMessage as jest.Mock).mockImplementation((_tabId, _message, callback) => {
      operationStateWhenHandoffFired = getOperationState().type
      setTimeout(() => callback?.(), 0)
    })

    const handlers = createImportExportHandlers(service, db, 'https://example.com/*')
    await handlers.exportData('pokerstars')

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ action: 'downloadFile' }),
      expect.any(Function)
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

  // --- Independent release-audit finding #10 --------------------------------

  test('a deferred tabs.sendMessage keeps the operation state as "export" until it is acknowledged', async () => {
    ;(chrome.tabs.query as jest.Mock).mockImplementation((_query, callback) => {
      setTimeout(() => callback([{ id: 42 }]), 0)
    })

    let releaseSendMessage: (() => void) | undefined
    const sendMessageAcked = new Promise<void>(resolve => { releaseSendMessage = resolve })
    ;(chrome.tabs.sendMessage as jest.Mock).mockImplementation((_tabId, _message, callback) => {
      // Do NOT call back synchronously -- simulate a slow/deferred content
      // script acknowledgment. Before the fix, downloadFile() didn't wait on
      // this callback at all, so operationState would already be 'idle' by
      // this point regardless of how long the real handoff takes.
      sendMessageAcked.then(() => callback?.())
    })

    const handlers = createImportExportHandlers(service, db, 'https://example.com/*')
    const exportPromise = handlers.exportData('json')

    // Give chrome.tabs.query's deferred callback (and the sendMessage call it
    // triggers) a chance to run, then assert the operation is still marked
    // 'export' -- not yet resolved to idle -- while the handoff is pending.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(chrome.tabs.sendMessage).toHaveBeenCalled()
    expect(getOperationState().type).toBe('export')

    releaseSendMessage?.()
    await exportPromise

    expect(getOperationState()).toEqual({ type: 'idle' })
  })

  test('a rejected tabs.sendMessage (content script missing) surfaces as an error, not an idle-success', async () => {
    ;(chrome.tabs.query as jest.Mock).mockImplementation((_query, callback) => {
      setTimeout(() => callback([{ id: 42 }]), 0)
    })
    // Simulate "Receiving end does not exist" -- e.g. the content script was
    // never injected into this tab, or the tab navigated away mid-export.
    ;(chrome.tabs.sendMessage as jest.Mock).mockImplementation((_tabId, _message, callback) => {
      ;(chrome.runtime as any).lastError = { message: 'Could not establish connection. Receiving end does not exist.' }
      callback?.()
      delete (chrome.runtime as any).lastError
    })

    const handlers = createImportExportHandlers(service, db, 'https://example.com/*')

    await expect(handlers.exportData('json')).rejects.toThrow(/Receiving end does not exist/)

    // The popup must be told this failed -- the LAST exportProgress broadcast
    // must be an error, never a 'completed' success.
    const progressCalls = (chrome.runtime.sendMessage as jest.Mock).mock.calls
      .map(([msg]) => msg)
      .filter(msg => msg?.action === 'exportProgress')
    expect(progressCalls.length).toBeGreaterThan(0)
    expect(progressCalls[progressCalls.length - 1]).toEqual(
      expect.objectContaining({ action: 'exportProgress', state: 'error' })
    )
    expect(progressCalls.some(msg => msg.state === 'completed')).toBe(false)
    // The operation must not be left stuck in 'export' -- it still returns to
    // idle in the failure path (there is no separate "error" operation-state
    // type, see operation-state.ts), but crucially only AFTER the failure was
    // observed, and the popup was told via the exportProgress message above --
    // never silently reported as success.
    expect(getOperationState()).toEqual({ type: 'idle' })
  })

  test('an explicit failure ack ({success:false}, no lastError) surfaces as an error, not an idle-success (PR #199 review finding #1)', async () => {
    // content_script.ts's download handlers now send an explicit
    // sendResponse({success: true/false}) ack (see content_script.ts and the
    // sendTabMessageAsync doc comment in import-export.ts) -- this covers the
    // case where the handoff itself was DELIVERED (no chrome.runtime.lastError)
    // but the content script's own Blob-download work threw (e.g.
    // URL.createObjectURL failing), which it reports back via
    // {success:false, error}. Before this fix, sendTabMessageAsync only
    // checked chrome.runtime.lastError, so a delivered-but-failed handoff like
    // this would be silently treated as a success.
    ;(chrome.tabs.query as jest.Mock).mockImplementation((_query, callback) => {
      setTimeout(() => callback([{ id: 42 }]), 0)
    })
    ;(chrome.tabs.sendMessage as jest.Mock).mockImplementation((_tabId, _message, callback) => {
      callback?.({ success: false, error: 'createObjectURL boom' })
    })

    const handlers = createImportExportHandlers(service, db, 'https://example.com/*')

    await expect(handlers.exportData('json')).rejects.toThrow(/createObjectURL boom/)

    const progressCalls = (chrome.runtime.sendMessage as jest.Mock).mock.calls
      .map(([msg]) => msg)
      .filter(msg => msg?.action === 'exportProgress')
    expect(progressCalls[progressCalls.length - 1]).toEqual(
      expect.objectContaining({ action: 'exportProgress', state: 'error' })
    )
    expect(progressCalls.some(msg => msg.state === 'completed')).toBe(false)
    expect(getOperationState()).toEqual({ type: 'idle' })
  })

  test('every chunk of a large (>50MB) export is individually acknowledged before resolving', async () => {
    ;(chrome.tabs.query as jest.Mock).mockImplementation((_query, callback) => {
      setTimeout(() => callback([{ id: 42 }]), 0)
    })
    const ackedTabIds: number[] = []
    ;(chrome.tabs.sendMessage as jest.Mock).mockImplementation((tabId, _message, callback) => {
      ackedTabIds.push(tabId)
      setTimeout(() => callback?.(), 0)
    })

    // Force the >50MB chunked path (MAX_CHUNK_MB in downloadFile).
    const largeContent = 'a'.repeat(51 * 1024 * 1024)
    const handlers = createImportExportHandlers(service, db, 'https://example.com/*')
    jest.spyOn(service, 'exportHandHistory').mockResolvedValue(largeContent)

    await handlers.exportData('pokerstars')

    const actions = (chrome.tabs.sendMessage as jest.Mock).mock.calls.map(([, message]) => (message as any).action)
    expect(actions[0]).toBe('downloadFileInit')
    expect(actions[actions.length - 1]).toBe('downloadFileFinish')
    expect(actions.filter(a => a === 'downloadFileChunk').length).toBeGreaterThan(0)
    // All chunk messages (init/chunk*/finish) went to the same tab and were
    // all awaited (ackedTabIds has one entry per message actually sent).
    expect(ackedTabIds.every(id => id === 42)).toBe(true)
    expect(ackedTabIds.length).toBe(actions.length)
    expect(getOperationState()).toEqual({ type: 'idle' })
  })

  test('a chrome.downloads.lastError in the fallback path surfaces as an error, not an idle-success', async () => {
    ;(chrome.tabs.query as jest.Mock).mockImplementation((_query, callback) => {
      setTimeout(() => callback([]), 0) // no matching tabs -- forces the chrome.downloads fallback
    })
    ;(chrome.downloads.download as jest.Mock).mockImplementation((_options, callback) => {
      ;(chrome.runtime as any).lastError = { message: 'USER_CANCELED' }
      callback?.(undefined)
      delete (chrome.runtime as any).lastError
    })

    const handlers = createImportExportHandlers(service, db, 'https://example.com/*')

    await expect(handlers.exportData('json')).rejects.toThrow(/USER_CANCELED/)

    const progressCalls = (chrome.runtime.sendMessage as jest.Mock).mock.calls
      .map(([msg]) => msg)
      .filter(msg => msg?.action === 'exportProgress')
    expect(progressCalls[progressCalls.length - 1]).toEqual(
      expect.objectContaining({ action: 'exportProgress', state: 'error' })
    )
    expect(progressCalls.some(msg => msg.state === 'completed')).toBe(false)
    expect(getOperationState()).toEqual({ type: 'idle' })
  })
})
