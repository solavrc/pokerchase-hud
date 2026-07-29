import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import type { ChromeMessage, MessageResponse } from '../types/messages'
import { DEFAULT_UI_CONFIG } from '../types/hand-log'
import {
  hudPositionStorageKey,
  hudPositionMigrationStorageKey,
  LEGACY_SYNC_UI_SCALE_KEY,
  UI_SCALE_STORAGE_KEY,
} from '../utils/ui-config-storage'
import { registerMessageRouter } from './message-router'

describe('message-router device-local UI layout', () => {
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
    expect(await chrome.storage.local.get(
      hudPositionMigrationStorageKey(2)
    )).toEqual({
      [hudPositionMigrationStorageKey(2)]: true,
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

    expect(positionResponse).toHaveBeenCalledWith({ success: true })
    expect(loadResponse).toHaveBeenCalledWith({
      success: true,
      scale: 1,
      position,
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

  it('同期UI設定のstorage failureを呼出元へ返す', () => {
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

    expect(sendResponse).toHaveBeenCalledWith({
      success: false,
      error: 'Failed to save synchronized UI config',
    })
  })

  it('local値がない初回だけlegacy syncのscaleとHUD位置をlocalへ移す', async () => {
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

    expect(sendResponse).toHaveBeenCalledWith({
      success: true,
      scale: 1.7,
      position: legacyPosition,
    })
    expect(await chrome.storage.local.get([
      UI_SCALE_STORAGE_KEY,
      hudPositionStorageKey(3),
      hudPositionMigrationStorageKey(3),
    ])).toEqual({
      [UI_SCALE_STORAGE_KEY]: 1.7,
      [hudPositionStorageKey(3)]: legacyPosition,
      [hudPositionMigrationStorageKey(3)]: true,
    })
    expect(await chrome.storage.sync.get(LEGACY_SYNC_UI_SCALE_KEY)).toEqual({
      [LEGACY_SYNC_UI_SCALE_KEY]: 1.7,
    })
  })

  it.each([3, 102])(
    'scale移行済みでもlegacy syncのHUD位置 %p を独立して移行する',
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
        position: legacyPosition,
      })
      expect(await chrome.storage.local.get([
        hudPositionStorageKey(seatIndex),
        hudPositionMigrationStorageKey(seatIndex),
      ])).toEqual({
        [hudPositionStorageKey(seatIndex)]: legacyPosition,
        [hudPositionMigrationStorageKey(seatIndex)]: true,
      })
    }
  )

  it('legacy位置がない初回readもmarkerを残し、その後のsync値を取り込まない', async () => {
    const firstResponse = jest.fn()
    listener({ action: 'getDeviceUILayout', seatIndex: 2 }, {}, firstResponse)

    expect(firstResponse).toHaveBeenCalledWith({
      success: true,
      scale: 1,
    })
    expect(await chrome.storage.local.get(
      hudPositionMigrationStorageKey(2)
    )).toEqual({
      [hudPositionMigrationStorageKey(2)]: true,
    })

    await chrome.storage.sync.set({
      [hudPositionStorageKey(2)]: { top: '20%', left: '30%' },
    })
    const secondResponse = jest.fn()
    listener({ action: 'getDeviceUILayout', seatIndex: 2 }, {}, secondResponse)

    expect(secondResponse).toHaveBeenCalledWith({
      success: true,
      scale: 1,
    })
    expect(await chrome.storage.local.get(hudPositionStorageKey(2))).toEqual({})
  })

  it('legacy位置read待ちの間に保存した現在位置を上書きしない', async () => {
    let resolveMigration!: (result: Record<string, unknown>) => void
    ;(chrome.storage.sync.get as jest.Mock).mockImplementationOnce(
      (_keys, callback) => {
        resolveMigration = callback
      }
    )
    const loadResponse = jest.fn()
    const saveResponse = jest.fn()
    const currentPosition = { top: '44%', left: '55%' }

    listener({ action: 'getDeviceUILayout', seatIndex: 4 }, {}, loadResponse)
    listener({
      action: 'setDeviceHudPosition',
      seatIndex: 4,
      position: currentPosition,
    }, {}, saveResponse)
    resolveMigration({
      [hudPositionStorageKey(4)]: { top: '10%', left: '20%' },
    })

    expect(saveResponse).toHaveBeenCalledWith({ success: true })
    expect(loadResponse).toHaveBeenCalledWith({
      success: true,
      scale: 1,
      position: currentPosition,
    })
    expect(await chrome.storage.local.get([
      hudPositionStorageKey(4),
      hudPositionMigrationStorageKey(4),
    ])).toEqual({
      [hudPositionStorageKey(4)]: currentPosition,
      [hudPositionMigrationStorageKey(4)]: true,
    })
  })

  it('local layout read失敗時は移行せず呼出元へ失敗を返す', async () => {
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
    expect(await chrome.storage.local.get(
      hudPositionMigrationStorageKey(2)
    )).toEqual({})
  })

  it('legacy sync read失敗時はmarkerを確定せず再試行可能にする', async () => {
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
    expect(await chrome.storage.local.get(
      hudPositionMigrationStorageKey(2)
    )).toEqual({})
  })

  it('uiConfigからscaleが除かれた後も移行用scaleをlocalへコピーできる', async () => {
    await chrome.storage.sync.set({
      [LEGACY_SYNC_UI_SCALE_KEY]: 1.5,
      uiConfig: { displayEnabled: false },
    })
    const sendResponse = jest.fn()

    listener({ action: 'getDeviceUILayout' }, {}, sendResponse)

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

    expect(saveResponse).toHaveBeenCalledWith({ success: true })
    expect(loadResponse).toHaveBeenCalledWith({
      success: true,
      scale: 1.8,
    })
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
  ] as ChromeMessage[])('local storage failureを呼出元へ返す: %p', (message) => {
    ;(chrome.storage.local.set as jest.Mock).mockImplementationOnce(
      (_items, callback) => {
        ;(chrome.runtime as any).lastError = { message: 'quota' }
        callback()
        delete (chrome.runtime as any).lastError
      }
    )
    const sendResponse = jest.fn()

    listener(message, {}, sendResponse)

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
