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
import {
  __resetPendingStorageWritesForTests,
  getPendingStorageWriteTail,
} from './pending-storage-writes'
import { UI_SCALE_STORAGE_KEY } from '../utils/ui-config-storage'
import { DEFAULT_UI_CONFIG } from '../types/hand-log'

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
    __resetPendingStorageWritesForTests()
    ;(chrome.tabs.query as jest.Mock).mockImplementation((_query, callback) => callback([]))
    ;(chrome.tabs.sendMessage as jest.Mock).mockResolvedValue(undefined)
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

  test('waits for a device-position write before reloading', async () => {
    markSessionInactive()
    const storageSet = chrome.storage.local.set as jest.Mock
    const defaultSet = storageSet.getMockImplementation()!
    let finishPositionWrite!: () => void
    storageSet.mockImplementationOnce((items, callback) => {
      finishPositionWrite = () => defaultSet(items, callback)
    })

    const positionResponse = jest.fn()
    listener({
      action: 'setDeviceHudPosition',
      seatIndex: 2,
      position: { top: '20%', left: '30%' },
    }, {}, positionResponse)
    await Promise.resolve()

    const applyResponse = jest.fn()
    listener({ action: 'applyPendingUpdate' } as ChromeMessage, {}, applyResponse)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(chrome.runtime.reload).not.toHaveBeenCalled()

    finishPositionWrite()
    await getPendingStorageWriteTail()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(positionResponse).toHaveBeenCalledWith({ success: true })
    expect(chrome.runtime.reload).toHaveBeenCalledTimes(1)
  })

  test('waits for a synchronized config write before reloading', async () => {
    markSessionInactive()
    const syncSet = chrome.storage.sync.set as jest.Mock
    const defaultSet = syncSet.getMockImplementation()!
    let finishSyncWrite!: () => void
    syncSet.mockImplementationOnce((items, callback) => {
      finishSyncWrite = () => defaultSet(items, callback)
    })

    const configResponse = jest.fn()
    listener({
      action: 'setSyncedUIConfig',
      config: { ...DEFAULT_UI_CONFIG, displayEnabled: false },
    }, {}, configResponse)
    await Promise.resolve()

    const applyResponse = jest.fn()
    listener({ action: 'applyPendingUpdate' } as ChromeMessage, {}, applyResponse)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(chrome.runtime.reload).not.toHaveBeenCalled()

    finishSyncWrite()
    await getPendingStorageWriteTail()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(configResponse).toHaveBeenCalledWith({ success: true })
    expect(chrome.runtime.reload).toHaveBeenCalledTimes(1)
  })

  test('waits for every queued device-scale write before reloading', async () => {
    markSessionInactive()
    const storageSet = chrome.storage.local.set as jest.Mock
    const defaultSet = storageSet.getMockImplementation()!
    const pendingWrites: Array<() => void> = []
    storageSet
      .mockImplementationOnce((items, callback) => {
        pendingWrites.push(() => defaultSet(items, callback))
      })
      .mockImplementationOnce((items, callback) => {
        pendingWrites.push(() => defaultSet(items, callback))
      })

    const firstScaleResponse = jest.fn()
    const latestScaleResponse = jest.fn()
    listener({ action: 'setDeviceUIScale', scale: 1.2 }, {}, firstScaleResponse)
    listener({ action: 'setDeviceUIScale', scale: 1.8 }, {}, latestScaleResponse)
    await Promise.resolve()
    expect(pendingWrites).toHaveLength(1)

    const applyResponse = jest.fn()
    listener({ action: 'applyPendingUpdate' } as ChromeMessage, {}, applyResponse)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(chrome.runtime.reload).not.toHaveBeenCalled()

    pendingWrites[0]!()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(firstScaleResponse).toHaveBeenCalledWith({ success: true })
    expect(pendingWrites).toHaveLength(2)
    expect(chrome.runtime.reload).not.toHaveBeenCalled()

    pendingWrites[1]!()
    await getPendingStorageWriteTail()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(latestScaleResponse).toHaveBeenCalledWith({ success: true })
    expect(await chrome.storage.local.get(UI_SCALE_STORAGE_KEY)).toEqual({
      [UI_SCALE_STORAGE_KEY]: 1.8,
    })
    expect(applyResponse).toHaveBeenCalledWith({
      success: true,
      applied: true,
      reason: undefined,
    })
    expect(chrome.runtime.reload).toHaveBeenCalledTimes(1)
  })
})
