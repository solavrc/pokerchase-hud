import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { createImportExportHandlers } from './import-export'
import { getOperationState, setOperationState } from './operation-state'

describe('importData cleanup', () => {
  let db: PokerChaseDB
  let service: PokerChaseService

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = new PokerChaseService({ db })
    await service.ready
    setOperationState({ type: 'idle' })
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    db.close()
    await db.delete()
  })

  test('disables batch mode before returning to idle when an import fails', async () => {
    const setBatchMode = jest.spyOn(service, 'setBatchMode')
    ;(chrome.runtime.sendMessage as jest.Mock).mockImplementation(() => {
      throw new Error('runtime unavailable')
    })
    const handlers = createImportExportHandlers(service, db, 'https://example.com/*')

    await expect(handlers.importData('not-json')).rejects.toThrow('runtime unavailable')

    expect(setBatchMode.mock.calls).toEqual([[true], [false]])
    expect(getOperationState()).toEqual({ type: 'idle' })
  })
})
