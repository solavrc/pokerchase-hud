import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import type { ChromeMessage, MessageResponse } from '../types/messages'
import { clearImportSession, getCurrentImportSession } from './import-export'
import { registerMessageRouter } from './message-router'
import { setOperationState } from './operation-state'

describe('message-router import operation exclusivity', () => {
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
    setOperationState({ type: 'idle' })
    clearImportSession()

    ;(chrome.runtime.onMessage.addListener as jest.Mock).mockClear()
    registerMessageRouter(service, db, 'https://example.com/*')
    listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0]
  })

  afterEach(async () => {
    setOperationState({ type: 'idle' })
    clearImportSession()
    jest.restoreAllMocks()
    db.close()
    await db.delete()
  })

  test('rejects a direct import while another operation is active', () => {
    const setBatchMode = jest.spyOn(service, 'setBatchMode')
    const sendResponse = jest.fn()
    setOperationState({ type: 'export', format: 'json' })

    const handled = listener({ action: 'importData', data: '{}' }, {}, sendResponse)

    expect(handled).toBe(true)
    expect(sendResponse).toHaveBeenCalledWith({ success: false, error: '別の処理が実行中です' })
    expect(setBatchMode).not.toHaveBeenCalled()
  })

  test('rejects chunk-session initialization while another operation is active', () => {
    const sendResponse = jest.fn()
    setOperationState({ type: 'rebuild' })

    listener({ action: 'importDataInit', totalChunks: 1, fileName: 'data.ndjson' }, {}, sendResponse)

    expect(sendResponse).toHaveBeenCalledWith({ success: false, error: '別の処理が実行中です' })
    expect(getCurrentImportSession()).toBeNull()
  })

  test('preserves a completed chunk session when processing is blocked', () => {
    listener(
      { action: 'importDataInit', totalChunks: 1, fileName: 'data.ndjson' },
      {},
      jest.fn()
    )
    listener(
      { action: 'importDataChunk', chunkIndex: 0, chunkData: '{}' },
      {},
      jest.fn()
    )
    setOperationState({ type: 'export', format: 'pokerstars' })
    const sendResponse = jest.fn()

    listener({ action: 'importDataProcess' }, {}, sendResponse)

    expect(sendResponse).toHaveBeenCalledWith({ success: false, error: '別の処理が実行中です' })
    expect(getCurrentImportSession()?.chunks).toEqual(['{}'])
  })
})
