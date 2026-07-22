import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import type { ChromeMessage, MessageResponse } from '../types/messages'
import { clearImportSession, getCurrentImportSession } from './import-export'
import { registerMessageRouter } from './message-router'
import { getOperationState, setOperationState } from './operation-state'

describe('message-router operation exclusivity', () => {
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

  test('rejects a direct import while cloud sync owns the shared operation slot', () => {
    const setBatchMode = jest.spyOn(service, 'setBatchMode')
    const sendResponse = jest.fn()
    setOperationState({ type: 'sync' })

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

  test('chunk-session initialization claims the slot until processing starts', () => {
    const initResponse = jest.fn()
    listener({ action: 'importDataInit', totalChunks: 2, fileName: 'data.ndjson' }, {}, initResponse)

    expect(initResponse).toHaveBeenCalledWith({ success: true })
    expect(getOperationState()).toMatchObject({ type: 'import', processed: 0, total: 2 })

    const exportResponse = jest.fn()
    listener({ action: 'exportData', format: 'json' }, {}, exportResponse)
    expect(exportResponse).toHaveBeenCalledWith({ success: false, error: '別の処理が実行中です' })
  })

  test('does not mistake a sparse final-index chunk for a complete import', () => {
    listener({ action: 'importDataInit', totalChunks: 2, fileName: 'data.ndjson' }, {}, jest.fn())
    listener({ action: 'importDataChunk', chunkIndex: 1, chunkData: 'second' }, {}, jest.fn())
    const processResponse = jest.fn()

    listener({ action: 'importDataProcess' }, {}, processResponse)

    expect(processResponse).toHaveBeenCalledWith({ success: false, error: 'Import session incomplete' })
    expect(getCurrentImportSession()).toMatchObject({ receivedChunks: 1, chunks: [undefined, 'second'] })
    expect(getOperationState().type).toBe('import')
  })

  test('releases an abandoned chunk-session slot after inactivity', () => {
    jest.useFakeTimers()
    try {
      listener({ action: 'importDataInit', totalChunks: 2, fileName: 'data.ndjson' }, {}, jest.fn())
      expect(getOperationState().type).toBe('import')

      jest.advanceTimersByTime(5 * 60 * 1000)

      expect(getCurrentImportSession()).toBeNull()
      expect(getOperationState().type).toBe('idle')
    } finally {
      jest.useRealTimers()
    }
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

  test('claims the operation slot synchronously when export starts', async () => {
    ;(chrome.runtime.sendMessage as jest.Mock).mockResolvedValue(undefined)
    ;(chrome.tabs.query as jest.Mock).mockImplementation((_query, callback) => callback([{ id: 1 }]))
    ;(chrome.tabs.sendMessage as jest.Mock).mockImplementation((_tabId, _message, callback) => {
      callback({ success: true })
    })
    const completion = new Promise<MessageResponse>(resolve => {
      listener({ action: 'exportData', format: 'json' }, {}, resolve)
    })

    expect(getOperationState()).toMatchObject({ type: 'export', format: 'json' })
    await expect(completion).resolves.toEqual({ success: true })
  })

  test('rejects local deletion while another operation is active', () => {
    const deleteSpy = jest.spyOn(db, 'delete')
    const sendResponse = jest.fn()
    setOperationState({ type: 'sync' })

    listener({ action: 'deleteAllData' }, {}, sendResponse)

    expect(sendResponse).toHaveBeenCalledWith({ success: false, error: '別の処理が実行中です' })
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  test('claims the operation slot synchronously when local deletion starts', () => {
    jest.spyOn(db, 'delete').mockImplementation(() => new Promise<void>(() => {}) as any)

    listener({ action: 'deleteAllData' }, {}, jest.fn())

    expect(getOperationState()).toEqual({ type: 'delete' })
  })

  test('waits for the live transform pipeline before deleting the database', async () => {
    let releasePipeline!: () => void
    const pipelineIdle = new Promise<void>(resolve => { releasePipeline = resolve })
    jest.spyOn(service.handAggregateStream, 'whenIdle').mockReturnValue(pipelineIdle)
    const deleteSpy = jest.spyOn(db, 'delete')
    const response = new Promise<MessageResponse>(resolve => {
      listener({ action: 'deleteAllData' }, {}, resolve)
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(deleteSpy).not.toHaveBeenCalled()

    releasePipeline()
    await expect(response).resolves.toEqual({ success: true })
    expect(deleteSpy).toHaveBeenCalledTimes(1)
  })

  test('reloads after database deletion even when advisory cleanup fails', async () => {
    ;(chrome.storage.local.set as jest.Mock).mockRejectedValueOnce(new Error('simulated advisory storage failure'))
    const reload = chrome.runtime.reload as jest.Mock
    const response = new Promise<MessageResponse>(resolve => {
      listener({ action: 'deleteAllData' }, {}, resolve)
    })

    await expect(response).resolves.toEqual({ success: true })
    expect(reload).toHaveBeenCalled()
    expect(getOperationState()).toEqual({ type: 'delete' })
  })
})
