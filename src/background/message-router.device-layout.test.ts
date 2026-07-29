import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import type { ChromeMessage, MessageResponse } from '../types/messages'
import { DEFAULT_UI_CONFIG } from '../types/hand-log'
import {
  HAND_LOG_LAYOUT_STORAGE_KEY,
  hudPositionStorageKey,
  LEGACY_SYNC_UI_SCALE_KEY,
  UI_SCALE_STORAGE_KEY,
} from '../utils/ui-config-storage'
import { registerMessageRouter } from './message-router'
import {
  __resetPendingStorageWritesForTests,
  getPendingStorageWriteTail,
} from './pending-storage-writes'

describe('message-router device-local UI layout', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let listener: (
    request: ChromeMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: MessageResponse) => void
  ) => boolean | void

  beforeEach(async () => {
    __resetPendingStorageWritesForTests()
    ;(chrome.tabs.query as jest.Mock).mockImplementation((_query, callback) => callback([]))
    ;(chrome.tabs.sendMessage as jest.Mock).mockResolvedValue(undefined)
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = new PokerChaseService({ db })
    await service.ready

    ;(chrome.runtime.onMessage.addListener as jest.Mock).mockClear()
    registerMessageRouter(service, db, 'https://example.com/*')
    listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0]
  })

  afterEach(async () => {
    db.close()
    await db.delete()
  })

  it('端末ローカルのscaleと指定席位置だけを返す', async () => {
    const position = { top: '42.5%', left: '18%' }
    await chrome.storage.local.set({
      [UI_SCALE_STORAGE_KEY]: 1.4,
      [hudPositionStorageKey(2)]: position,
    })
    const sendResponse = jest.fn()

    expect(listener(
      { action: 'getDeviceUILayout', seatIndex: 2 },
      {},
      sendResponse
    )).toBe(true)

    expect(sendResponse).toHaveBeenCalledWith({
      success: true,
      scale: 1.4,
      position,
    })
  })

  it('scaleとHUD位置を検証して端末ローカルへ保存する', async () => {
    const scaleResponse = jest.fn()
    const positionResponse = jest.fn()
    const position = { top: '12%', left: '67.5%' }

    listener({ action: 'setDeviceUIScale', scale: 1.3 }, {}, scaleResponse)
    listener({
      action: 'setDeviceHudPosition',
      seatIndex: 4,
      position,
    }, {}, positionResponse)
    await getPendingStorageWriteTail()

    expect(scaleResponse).toHaveBeenCalledWith({ success: true })
    expect(positionResponse).toHaveBeenCalledWith({ success: true })
    expect(await chrome.storage.local.get([
      UI_SCALE_STORAGE_KEY,
      hudPositionStorageKey(4),
    ])).toEqual({
      [UI_SCALE_STORAGE_KEY]: 1.3,
      [hudPositionStorageKey(4)]: position,
    })
  })

  it('重なったscale保存を受信順に直列化する', async () => {
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
    const firstResponse = jest.fn()
    const secondResponse = jest.fn()

    listener({ action: 'setDeviceUIScale', scale: 1.1 }, {}, firstResponse)
    listener({ action: 'setDeviceUIScale', scale: 1.2 }, {}, secondResponse)
    await Promise.resolve()

    expect(pendingWrites).toHaveLength(1)
    expect(firstResponse).not.toHaveBeenCalled()
    expect(secondResponse).not.toHaveBeenCalled()

    pendingWrites[0]!()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(firstResponse).toHaveBeenCalledWith({ success: true })
    expect(pendingWrites).toHaveLength(2)
    expect(secondResponse).not.toHaveBeenCalled()

    pendingWrites[1]!()
    await getPendingStorageWriteTail()
    expect(secondResponse).toHaveBeenCalledWith({ success: true })
    expect(await chrome.storage.local.get(UI_SCALE_STORAGE_KEY)).toEqual({
      [UI_SCALE_STORAGE_KEY]: 1.2,
    })
  })

  it('scale保存成功をbackgroundからゲームタブへ通知する', async () => {
    ;(chrome.tabs.query as jest.Mock).mockImplementation((_query, callback) => {
      callback([{ id: 42 }])
    })
    const sendResponse = jest.fn()

    listener({ action: 'setDeviceUIScale', scale: 1.6 }, {}, sendResponse)
    await getPendingStorageWriteTail()

    expect(chrome.tabs.query).toHaveBeenCalledWith(
      { url: 'https://example.com/*' },
      expect.any(Function)
    )
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, {
      action: 'updateDeviceUIScale',
      scale: 1.6,
    })
    expect(sendResponse).toHaveBeenCalledWith({ success: true })
    expect((chrome.tabs.sendMessage as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan(sendResponse.mock.invocationCallOrder[0]!)
  })

  it('先に待機中のユーザーscaleを後発legacy移行で上書きしない', async () => {
    await chrome.storage.sync.set({
      [LEGACY_SYNC_UI_SCALE_KEY]: 1.3,
      uiConfig: { displayEnabled: true },
    })
    const storageSet = chrome.storage.local.set as jest.Mock
    const defaultSet = storageSet.getMockImplementation()!
    let finishUserWrite!: () => void
    storageSet.mockImplementationOnce((items, callback) => {
      finishUserWrite = () => defaultSet(items, callback)
    })
    const userResponse = jest.fn()
    const layoutResponse = jest.fn()

    listener({ action: 'setDeviceUIScale', scale: 1.8 }, {}, userResponse)
    await Promise.resolve()
    ;(chrome.storage.sync.get as jest.Mock).mockClear()

    listener({ action: 'getDeviceUILayout' }, {}, layoutResponse)
    expect(layoutResponse).not.toHaveBeenCalled()
    expect(chrome.storage.sync.get).not.toHaveBeenCalled()

    finishUserWrite()
    await getPendingStorageWriteTail()
    await Promise.resolve()

    expect(userResponse).toHaveBeenCalledWith({ success: true })
    expect(layoutResponse).toHaveBeenCalledWith({
      success: true,
      scale: 1.8,
    })
    expect(chrome.storage.sync.get).not.toHaveBeenCalled()
    expect(await chrome.storage.local.get(UI_SCALE_STORAGE_KEY)).toEqual({
      [UI_SCALE_STORAGE_KEY]: 1.8,
    })
  })

  it('リアルタイムHUDの位置名前空間も保存・読込できる', async () => {
    const position = { top: '64%', left: '22%' }
    const positionResponse = jest.fn()
    const loadResponse = jest.fn()

    listener({
      action: 'setDeviceHudPosition',
      seatIndex: 102,
      position,
    }, {}, positionResponse)
    listener({
      action: 'getDeviceUILayout',
      seatIndex: 102,
    }, {}, loadResponse)
    await getPendingStorageWriteTail()
    await Promise.resolve()

    expect(positionResponse).toHaveBeenCalledWith({ success: true })
    expect(loadResponse).toHaveBeenCalledWith({
      success: true,
      scale: 1,
      position,
    })
  })

  it('ハンドログの位置とサイズを端末ローカルへ保存・読込する', async () => {
    const layout = { left: -120, top: 40, width: 640, height: 320 }
    const saveResponse = jest.fn()
    const loadResponse = jest.fn()

    listener({ action: 'setDeviceHandLogLayout', layout }, {}, saveResponse)
    listener({ action: 'getDeviceHandLogLayout' }, {}, loadResponse)
    await getPendingStorageWriteTail()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(saveResponse).toHaveBeenCalledWith({ success: true })
    expect(loadResponse).toHaveBeenCalledWith({
      success: true,
      layout,
    })
    expect(await chrome.storage.local.get(HAND_LOG_LAYOUT_STORAGE_KEY)).toEqual({
      [HAND_LOG_LAYOUT_STORAGE_KEY]: layout,
    })
  })

  it('ハンドログの端末ローカルlayoutだけを削除する', async () => {
    const position = { top: '12%', left: '20%' }
    await chrome.storage.local.set({
      [HAND_LOG_LAYOUT_STORAGE_KEY]: {
        left: 10,
        top: 20,
        width: 400,
        height: 100,
      },
      [hudPositionStorageKey(0)]: position,
    })
    const resetResponse = jest.fn()

    listener({ action: 'resetDeviceHandLogLayout' }, {}, resetResponse)
    await getPendingStorageWriteTail()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(resetResponse).toHaveBeenCalledWith({ success: true })
    expect(await chrome.storage.local.get([
      HAND_LOG_LAYOUT_STORAGE_KEY,
      hudPositionStorageKey(0),
    ])).toEqual({
      [HAND_LOG_LAYOUT_STORAGE_KEY]: undefined,
      [hudPositionStorageKey(0)]: position,
    })
  })

  it('遅延resetより新しいlayout保存を優先する', async () => {
    const oldLayout = { left: 10, top: 20, width: 400, height: 100 }
    const newLayout = { left: 80, top: 60, width: 520, height: 240 }
    await chrome.storage.local.set({
      [HAND_LOG_LAYOUT_STORAGE_KEY]: oldLayout,
    })
    let finishDelayedReset!: () => void
    ;(chrome.storage.local.remove as jest.Mock).mockImplementationOnce(
      (_key, callback) => {
        finishDelayedReset = callback
      }
    )
    const resetResponse = jest.fn()
    const saveResponse = jest.fn()

    listener({ action: 'resetDeviceHandLogLayout' }, {}, resetResponse)
    listener({
      action: 'setDeviceHandLogLayout',
      layout: newLayout,
    }, {}, saveResponse)
    await Promise.resolve()

    expect(resetResponse).not.toHaveBeenCalled()
    expect(saveResponse).not.toHaveBeenCalled()

    finishDelayedReset()
    await getPendingStorageWriteTail()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(resetResponse).toHaveBeenCalledWith({
      success: false,
      error: 'Superseded by newer hand log layout',
    })
    expect(saveResponse).toHaveBeenCalledWith({ success: true })
    expect(await chrome.storage.local.get(HAND_LOG_LAYOUT_STORAGE_KEY)).toEqual({
      [HAND_LOG_LAYOUT_STORAGE_KEY]: newLayout,
    })
  })

  it('pending layout保存後の最新値をreadへ返す', async () => {
    const oldLayout = { left: 10, top: 20, width: 400, height: 100 }
    const newLayout = { left: 80, top: 60, width: 520, height: 240 }
    await chrome.storage.local.set({
      [HAND_LOG_LAYOUT_STORAGE_KEY]: oldLayout,
    })
    let delayedItems!: Record<string, unknown>
    let finishDelayedSet!: () => void
    ;(chrome.storage.local.set as jest.Mock).mockImplementationOnce(
      (items, callback) => {
        delayedItems = items
        finishDelayedSet = callback
      }
    )
    const saveResponse = jest.fn()
    const loadResponse = jest.fn()

    listener({
      action: 'setDeviceHandLogLayout',
      layout: newLayout,
    }, {}, saveResponse)
    listener({ action: 'getDeviceHandLogLayout' }, {}, loadResponse)
    await Promise.resolve()

    expect(saveResponse).not.toHaveBeenCalled()
    expect(loadResponse).not.toHaveBeenCalled()

    await chrome.storage.local.set(delayedItems)
    finishDelayedSet()
    await getPendingStorageWriteTail()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(saveResponse).toHaveBeenCalledWith({ success: true })
    expect(loadResponse).toHaveBeenCalledWith({
      success: true,
      layout: newLayout,
    })
  })

  it('同期UI設定をbackgroundで保存し旧版互換scaleも保持する', async () => {
    await chrome.storage.sync.set({
      uiConfig: { ...DEFAULT_UI_CONFIG, scale: 1.6 },
    })
    const sendResponse = jest.fn()
    const config = {
      ...DEFAULT_UI_CONFIG,
      scale: 1.2,
      displayEnabled: false,
    }

    listener({ action: 'setSyncedUIConfig', config }, {}, sendResponse)
    await getPendingStorageWriteTail()

    expect(sendResponse).toHaveBeenCalledWith({ success: true })
    expect(await chrome.storage.sync.get([
      'uiConfig',
      LEGACY_SYNC_UI_SCALE_KEY,
    ])).toEqual({
      uiConfig: {
        ...config,
        scale: 1.6,
      },
      [LEGACY_SYNC_UI_SCALE_KEY]: 1.6,
    })
  })

  it('同期UI設定のstorage failureを呼出元へ返す', async () => {
    ;(chrome.storage.sync.set as jest.Mock).mockImplementationOnce(
      (_items, callback) => {
        ;(chrome.runtime as any).lastError = { message: 'quota' }
        callback()
        delete (chrome.runtime as any).lastError
      }
    )
    const sendResponse = jest.fn()

    listener({
      action: 'setSyncedUIConfig',
      config: DEFAULT_UI_CONFIG,
    }, {}, sendResponse)
    await getPendingStorageWriteTail()

    expect(sendResponse).toHaveBeenCalledWith({
      success: false,
      error: 'Failed to save synchronized UI config',
    })
  })

  it('ショートカットpatchを保存時点の最新同期設定へmergeする', async () => {
    await chrome.storage.sync.set({
      uiConfig: {
        ...DEFAULT_UI_CONFIG,
        scale: 1.6,
        displayEnabled: false,
        hudColorCoding: false,
      },
    })
    const sendResponse = jest.fn()
    const toggleShortcut = {
      code: 'KeyY',
      key: 'y',
      ctrl: false,
      alt: false,
      shift: true,
      meta: false,
    }

    listener({
      action: 'setSyncedUIConfig',
      patch: { toggleShortcut },
    }, {}, sendResponse)
    await getPendingStorageWriteTail()

    expect(sendResponse).toHaveBeenCalledWith({ success: true })
    expect(await chrome.storage.sync.get('uiConfig')).toEqual({
      uiConfig: {
        ...DEFAULT_UI_CONFIG,
        scale: 1.6,
        displayEnabled: false,
        hudColorCoding: false,
        toggleShortcut,
      },
    })
  })

  it('local値がない初回だけlegacy syncのscaleをlocalへ移す', async () => {
    const legacyPosition = { top: '28%', left: '73%' }
    await chrome.storage.sync.set({
      uiConfig: { scale: 1.7, displayEnabled: true },
      [hudPositionStorageKey(3)]: legacyPosition,
    })
    const sendResponse = jest.fn()

    listener({
      action: 'getDeviceUILayout',
      seatIndex: 3,
    }, {}, sendResponse)
    await getPendingStorageWriteTail()

    expect(sendResponse).toHaveBeenCalledWith({
      success: true,
      scale: 1.7,
    })
    expect(await chrome.storage.local.get([
      UI_SCALE_STORAGE_KEY,
      hudPositionStorageKey(3),
    ])).toEqual({
      [UI_SCALE_STORAGE_KEY]: 1.7,
    })
    expect(await chrome.storage.sync.get(LEGACY_SYNC_UI_SCALE_KEY)).toEqual({
      [LEGACY_SYNC_UI_SCALE_KEY]: 1.7,
    })
  })

  it.each([3, 102])(
    '別端末由来のlegacy sync HUD位置 %p はlocalへ移行しない',
    async (seatIndex) => {
      const legacyPosition = { top: '28%', left: '73%' }
      await chrome.storage.local.set({
        [UI_SCALE_STORAGE_KEY]: 1.4,
      })
      await chrome.storage.sync.set({
        [hudPositionStorageKey(seatIndex)]: legacyPosition,
      })
      const sendResponse = jest.fn()

      listener({
        action: 'getDeviceUILayout',
        seatIndex,
      }, {}, sendResponse)

      expect(sendResponse).toHaveBeenCalledWith({
        success: true,
        scale: 1.4,
      })
      expect(await chrome.storage.local.get(
        hudPositionStorageKey(seatIndex)
      )).toEqual({})
      expect(await chrome.storage.sync.get(
        hudPositionStorageKey(seatIndex)
      )).toEqual({
        [hudPositionStorageKey(seatIndex)]: legacyPosition,
      })
    }
  )

  it('local layout read失敗時は呼出元へ失敗を返す', async () => {
    ;(chrome.storage.local.get as jest.Mock).mockImplementationOnce(
      (_keys, callback) => {
        ;(chrome.runtime as any).lastError = { message: 'local unavailable' }
        callback({})
        delete (chrome.runtime as any).lastError
      }
    )
    const sendResponse = jest.fn()

    listener({ action: 'getDeviceUILayout', seatIndex: 2 }, {}, sendResponse)

    expect(sendResponse).toHaveBeenCalledWith({
      success: false,
      error: 'local unavailable',
    })
    expect(chrome.storage.sync.get).not.toHaveBeenCalled()
  })

  it('legacy scale sync read失敗時は呼出元へ失敗を返す', async () => {
    ;(chrome.storage.sync.get as jest.Mock).mockImplementationOnce(
      (_keys, callback) => {
        ;(chrome.runtime as any).lastError = { message: 'sync unavailable' }
        callback({})
        delete (chrome.runtime as any).lastError
      }
    )
    const sendResponse = jest.fn()

    listener({ action: 'getDeviceUILayout', seatIndex: 2 }, {}, sendResponse)

    expect(sendResponse).toHaveBeenCalledWith({
      success: false,
      error: 'sync unavailable',
    })
  })

  it('uiConfigからscaleが除かれた後も移行用scaleをlocalへコピーできる', async () => {
    await chrome.storage.sync.set({
      [LEGACY_SYNC_UI_SCALE_KEY]: 1.5,
      uiConfig: { displayEnabled: false },
    })
    const sendResponse = jest.fn()

    listener({ action: 'getDeviceUILayout' }, {}, sendResponse)
    await getPendingStorageWriteTail()

    expect(sendResponse).toHaveBeenCalledWith({
      success: true,
      scale: 1.5,
    })
    expect(await chrome.storage.local.get(UI_SCALE_STORAGE_KEY)).toEqual({
      [UI_SCALE_STORAGE_KEY]: 1.5,
    })
  })

  it('旧版端末が後から更新したuiConfig.scaleを移行用snapshotより優先する', async () => {
    await chrome.storage.sync.set({
      [LEGACY_SYNC_UI_SCALE_KEY]: 1.3,
      uiConfig: { scale: 1.8, displayEnabled: true },
    })
    const sendResponse = jest.fn()

    listener({ action: 'getDeviceUILayout' }, {}, sendResponse)
    await getPendingStorageWriteTail()

    expect(sendResponse).toHaveBeenCalledWith({
      success: true,
      scale: 1.8,
    })
    expect(await chrome.storage.local.get(UI_SCALE_STORAGE_KEY)).toEqual({
      [UI_SCALE_STORAGE_KEY]: 1.8,
    })
    expect(await chrome.storage.sync.get(LEGACY_SYNC_UI_SCALE_KEY)).toEqual({
      [LEGACY_SYNC_UI_SCALE_KEY]: 1.8,
    })
  })

  it('legacy移行待ちの間に選ばれた新しいscaleを上書きしない', async () => {
    let resolveMigration!: (result: Record<string, unknown>) => void
    ;(chrome.storage.sync.get as jest.Mock).mockImplementationOnce(
      (_keys, callback) => {
        resolveMigration = callback
      }
    )
    const loadResponse = jest.fn()
    const saveResponse = jest.fn()

    listener({ action: 'getDeviceUILayout' }, {}, loadResponse)
    listener({
      action: 'setDeviceUIScale',
      scale: 1.8,
    }, {}, saveResponse)
    resolveMigration({
      [LEGACY_SYNC_UI_SCALE_KEY]: 1.3,
      uiConfig: { displayEnabled: true },
    })
    await getPendingStorageWriteTail()

    expect(saveResponse).toHaveBeenCalledWith({ success: true })
    expect(loadResponse).toHaveBeenCalledWith({
      success: true,
      scale: 1.8,
    })
    expect(await chrome.storage.local.get(UI_SCALE_STORAGE_KEY)).toEqual({
      [UI_SCALE_STORAGE_KEY]: 1.8,
    })
  })

  it('開始済みのlegacy移行write後にユーザーscaleを直列保存する', async () => {
    await chrome.storage.sync.set({
      [LEGACY_SYNC_UI_SCALE_KEY]: 1.3,
      uiConfig: { displayEnabled: true },
    })
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
    const migrationResponse = jest.fn()
    const userResponse = jest.fn()

    listener({ action: 'getDeviceUILayout' }, {}, migrationResponse)
    listener({
      action: 'setDeviceUIScale',
      scale: 1.8,
    }, {}, userResponse)
    await Promise.resolve()

    expect(pendingWrites).toHaveLength(1)
    expect(migrationResponse).not.toHaveBeenCalled()
    expect(userResponse).not.toHaveBeenCalled()

    pendingWrites[0]!()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(migrationResponse).toHaveBeenCalledWith({
      success: true,
      scale: 1.3,
    })
    expect(pendingWrites).toHaveLength(2)
    expect(userResponse).not.toHaveBeenCalled()

    pendingWrites[1]!()
    await getPendingStorageWriteTail()
    expect(userResponse).toHaveBeenCalledWith({ success: true })
    expect(await chrome.storage.local.get(UI_SCALE_STORAGE_KEY)).toEqual({
      [UI_SCALE_STORAGE_KEY]: 1.8,
    })
  })

  it.each([
    { action: 'setDeviceUIScale', scale: 1.4 },
    {
      action: 'setDeviceHudPosition',
      seatIndex: 2,
      position: { top: '20%', left: '30%' },
    },
  ] as ChromeMessage[])('local storage failureを呼出元へ返す: %p', async (message) => {
    ;(chrome.storage.local.set as jest.Mock).mockImplementationOnce(
      (_items, callback) => {
        ;(chrome.runtime as any).lastError = { message: 'quota' }
        callback()
        delete (chrome.runtime as any).lastError
      }
    )
    const sendResponse = jest.fn()

    listener(message, {}, sendResponse)
    await getPendingStorageWriteTail()

    expect(sendResponse).toHaveBeenCalledWith({
      success: false,
      error: 'quota',
    })
  })

  it.each([
    { action: 'setDeviceUIScale', scale: 3 },
    {
      action: 'setDeviceHudPosition',
      seatIndex: 9,
      position: { top: '10%', left: '10%' },
    },
    {
      action: 'setDeviceHudPosition',
      seatIndex: 1,
      position: { top: '-1%', left: '10%' },
    },
    {
      action: 'setDeviceHandLogLayout',
      layout: { left: 0, top: 0, width: 199, height: 80 },
    },
    {
      action: 'setDeviceHandLogLayout',
      layout: { left: 0, top: 0, width: 400, height: Number.NaN },
    },
  ] as ChromeMessage[])('不正なlayout書き込みを拒否する: %p', (message) => {
    const sendResponse = jest.fn()
    ;(chrome.storage.local.set as jest.Mock).mockClear()

    expect(listener(message, {}, sendResponse)).toBe(true)
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
    }))
    expect(chrome.storage.local.set).not.toHaveBeenCalled()
  })
})
