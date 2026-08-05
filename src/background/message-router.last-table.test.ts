/**
 * message-router —「最後の卓の復元」スナップショットの読み書き。
 *
 * ゲームタブは`chrome.storage.local`を直接触れない（起動時の
 * `setAccessLevel('TRUSTED_CONTEXTS')`で遮断、#274）ので、`hudPosition_*`や
 * `handLogLayout`と同じくここが唯一の入出口になる。ここで守る性質:
 *  - 読み: 壊れた/バージョン違いの記録は`snapshot`を省いて成功を返す
 *    （フェイルクローズ。復元しないだけで、HUDの起動は妨げない）
 *  - 書き: 検証を通らない値は書かない（次回必ず捨てる記録を残さない）
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { trackServiceForTeardown } from '../utils/test-service-teardown'
import type { ChromeMessage, MessageResponse } from '../types/messages'
import {
  LAST_TABLE_SNAPSHOT_STORAGE_KEY,
  LAST_TABLE_SNAPSHOT_VERSION,
  type LastTableSnapshot,
} from '../utils/last-table-storage'
import { registerMessageRouter } from './message-router'
import { __resetPendingStorageWritesForTests } from './pending-storage-writes'

const snapshot: LastTableSnapshot = {
  version: LAST_TABLE_SNAPSHOT_VERSION,
  savedAt: 1_700_000_000_000,
  seats: [{
    seatIndex: 1,
    playerId: 201,
    playerName: 'オポーネントA',
    statResults: [{ id: 'hands', name: 'HAND', value: 120, formatted: '120' }],
  }],
}

describe('message-router —「最後の卓」スナップショット', () => {
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
    db.close()
    await db.delete()
  })

  const flush = () => new Promise(resolve => setTimeout(resolve, 0))

  it('保存が無ければsnapshot省略で成功を返す（復元しない）', () => {
    const sendResponse = jest.fn()
    expect(listener({ action: 'getLastTableSnapshot' }, {}, sendResponse)).toBe(true)
    expect(sendResponse).toHaveBeenCalledWith({ success: true })
  })

  it('書いた記録をそのまま読み戻せる', async () => {
    const writeResponse = jest.fn()
    listener({ action: 'setLastTableSnapshot', snapshot }, {}, writeResponse)
    await flush()
    expect(writeResponse).toHaveBeenCalledWith({ success: true })

    const readResponse = jest.fn()
    listener({ action: 'getLastTableSnapshot' }, {}, readResponse)
    expect(readResponse).toHaveBeenCalledWith({ success: true, snapshot })
  })

  it('検証を通らない記録は書かない', async () => {
    const sendResponse = jest.fn()
    listener(
      { action: 'setLastTableSnapshot', snapshot: { version: 999, savedAt: 1, seats: [] } },
      {},
      sendResponse
    )
    await flush()
    expect(sendResponse).toHaveBeenCalledWith({
      success: false,
      error: 'Invalid last table snapshot',
    })
    expect(await chrome.storage.local.get(LAST_TABLE_SNAPSHOT_STORAGE_KEY))
      .toEqual({ [LAST_TABLE_SNAPSHOT_STORAGE_KEY]: undefined })
  })

  it('保存済みの値が壊れていれば読み出しでも捨てる（フェイルクローズ）', async () => {
    await chrome.storage.local.set({
      [LAST_TABLE_SNAPSHOT_STORAGE_KEY]: { version: LAST_TABLE_SNAPSHOT_VERSION, savedAt: 1, seats: 'nope' },
    })
    const sendResponse = jest.fn()
    listener({ action: 'getLastTableSnapshot' }, {}, sendResponse)
    expect(sendResponse).toHaveBeenCalledWith({ success: true })
  })
})
