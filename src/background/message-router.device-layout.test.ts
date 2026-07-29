import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import type { ChromeMessage, MessageResponse } from '../types/messages'
import {
  HAND_LOG_LAYOUT_STORAGE_KEY,
  hudPositionStorageKey,
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

  it('ハンドログの位置とサイズを端末ローカルへ保存・読込する', async () => {
    const layout = { left: -120, top: 40, width: 640, height: 320 }
    const saveResponse = jest.fn()
    const loadResponse = jest.fn()

    listener({ action: 'setDeviceHandLogLayout', layout }, {}, saveResponse)
    listener({ action: 'getDeviceHandLogLayout' }, {}, loadResponse)

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

    expect(resetResponse).toHaveBeenCalledWith({ success: true })
    expect(await chrome.storage.local.get([
      HAND_LOG_LAYOUT_STORAGE_KEY,
      hudPositionStorageKey(0),
    ])).toEqual({
      [HAND_LOG_LAYOUT_STORAGE_KEY]: undefined,
      [hudPositionStorageKey(0)]: position,
    })
  })

  it('local値がない初回だけlegacy syncのscaleを移行用キーへ保持してlocalへ移す', async () => {
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

  it('別端末由来か判別できないlegacy syncのHUD位置は移行しない', async () => {
    const legacyPosition = { top: '28%', left: '73%' }
    await chrome.storage.sync.set({
      [hudPositionStorageKey(3)]: legacyPosition,
    })
    const sendResponse = jest.fn()

    listener({
      action: 'getDeviceUILayout',
      seatIndex: 3,
    }, {}, sendResponse)

    expect(sendResponse).toHaveBeenCalledWith({
      success: true,
      scale: 1,
    })
    expect(await chrome.storage.local.get(hudPositionStorageKey(3))).toEqual({})
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
