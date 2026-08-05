/**
 * message-router 「直近ハンド」パネル設定 (#341件数 / #353参加のみ)
 *
 * `storage.local`は`setAccessLevel('TRUSTED_CONTEXTS')`でcontent scriptから
 * 遮断されているため（#274）、パネル設定の読み書きはここ（信頼できる
 * background）が唯一の入口。読みは既定値へのresolve込み、書きは検証・
 * 永続化・全ゲームタブへのbroadcastまでを固定する。
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { trackServiceForTeardown } from '../utils/test-service-teardown'
import type { ChromeMessage, MessageResponse } from '../types/messages'
import {
  DEFAULT_RECENT_HANDS_LIMIT,
  DEFAULT_RECENT_HANDS_PARTICIPATION_ONLY,
  RECENT_HANDS_LIMIT_STORAGE_KEY,
  RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY,
} from '../utils/recent-hands-config'
import { registerMessageRouter } from './message-router'
import {
  __resetPendingStorageWritesForTests,
  getPendingStorageWriteTail,
} from './pending-storage-writes'

describe('message-router recent hands panel config', () => {
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
    service = trackServiceForTeardown(new PokerChaseService({ db }))
    await service.ready

    ;(chrome.runtime.onMessage.addListener as jest.Mock).mockClear()
    registerMessageRouter(service, db, 'https://example.com/*')
    listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0]
  })

  afterEach(async () => {
    await chrome.storage.local.remove([
      RECENT_HANDS_LIMIT_STORAGE_KEY,
      RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY,
    ])
    db.close()
    await db.delete()
  })

  it('未設定なら既定値へresolveして返す', async () => {
    const sendResponse = jest.fn()

    expect(listener({ action: 'getRecentHandsPanelConfig' }, {}, sendResponse)).toBe(true)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(sendResponse).toHaveBeenCalledWith({
      success: true,
      config: {
        limit: DEFAULT_RECENT_HANDS_LIMIT,
        participationOnly: DEFAULT_RECENT_HANDS_PARTICIPATION_ONLY,
      },
    })
  })

  it('保存済みの値を返し、壊れた値は既定値へ倒す', async () => {
    await chrome.storage.local.set({
      [RECENT_HANDS_LIMIT_STORAGE_KEY]: 50,
      [RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY]: 'yes',
    })
    const sendResponse = jest.fn()

    listener({ action: 'getRecentHandsPanelConfig' }, {}, sendResponse)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(sendResponse).toHaveBeenCalledWith({
      success: true,
      config: {
        limit: 50,
        participationOnly: DEFAULT_RECENT_HANDS_PARTICIPATION_ONLY,
      },
    })
  })

  it('patchを検証して永続化し、全ゲームタブへbroadcastする', async () => {
    ;(chrome.tabs.query as jest.Mock).mockImplementation((_query, callback) =>
      callback([{ id: 7 }, { id: 8 }]))
    const sendResponse = jest.fn()

    expect(listener({
      action: 'setRecentHandsPanelConfig',
      patch: { limit: 100, participationOnly: false },
    }, {}, sendResponse)).toBe(true)
    await getPendingStorageWriteTail()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(sendResponse).toHaveBeenCalledWith({ success: true })
    expect(await chrome.storage.local.get([
      RECENT_HANDS_LIMIT_STORAGE_KEY,
      RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY,
    ])).toEqual({
      [RECENT_HANDS_LIMIT_STORAGE_KEY]: 100,
      [RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY]: false,
    })
    // 永続化に成功した変更はゲームタブのパネルへ配られる（クロスパネル同期の
    // 唯一の経路。storage.onChangedはTRUSTED_CONTEXTSゲートで届かない）。
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      action: 'updateRecentHandsPanelConfig',
      patch: { limit: 100, participationOnly: false },
    })
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(8, {
      action: 'updateRecentHandsPanelConfig',
      patch: { limit: 100, participationOnly: false },
    })
  })

  it('部分patch（片方のキーだけ）はそのキーだけを書く', async () => {
    await chrome.storage.local.set({ [RECENT_HANDS_LIMIT_STORAGE_KEY]: 50 })
    const sendResponse = jest.fn()

    listener({ action: 'setRecentHandsPanelConfig', patch: { participationOnly: false } }, {}, sendResponse)
    await getPendingStorageWriteTail()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(sendResponse).toHaveBeenCalledWith({ success: true })
    expect(await chrome.storage.local.get([
      RECENT_HANDS_LIMIT_STORAGE_KEY,
      RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY,
    ])).toEqual({
      [RECENT_HANDS_LIMIT_STORAGE_KEY]: 50,
      [RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY]: false,
    })
  })

  it('不正なpatchは書かずにエラーを返す（不正なキーは落とす）', async () => {
    const sendResponse = jest.fn()

    expect(listener({
      action: 'setRecentHandsPanelConfig',
      patch: { limit: 7 },
    }, {}, sendResponse)).toBe(true)

    expect(sendResponse).toHaveBeenCalledWith({
      success: false,
      error: 'Invalid recent hands panel config',
    })
    expect(await chrome.storage.local.get([
      RECENT_HANDS_LIMIT_STORAGE_KEY,
      RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY,
    ])).toEqual({})
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled()
  })

  it('書き込み失敗はエラーを返し、broadcastしない', async () => {
    const storageSet = chrome.storage.local.set as jest.Mock
    storageSet.mockImplementationOnce((_items, callback) => {
      ;(global.chrome.runtime as any).lastError = { message: 'quota exceeded' }
      callback?.()
      delete (global.chrome.runtime as any).lastError
    })
    const sendResponse = jest.fn()

    listener({ action: 'setRecentHandsPanelConfig', patch: { limit: 100 } }, {}, sendResponse)
    await getPendingStorageWriteTail()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(sendResponse).toHaveBeenCalledWith({ success: false, error: 'quota exceeded' })
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled()
  })
})
