/**
 * importData() legacy-export sequence assignment and content deduplication.
 *
 * Exports created before database v6 have no `sequence`. Import must preserve
 * distinct same-millisecond/same-type payloads by assigning sequence values,
 * while an exact replay of either payload remains idempotent.
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { createImportExportHandlers } from './import-export'
import { setOperationState } from './operation-state'

describe('importData() legacy sequence assignment and content dedup', () => {
  let db: PokerChaseDB
  let service: PokerChaseService

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = new PokerChaseService({ db })
    await service.ready
    setOperationState({ type: 'idle' })
    ;(chrome.runtime.sendMessage as jest.Mock).mockReturnValue(undefined)
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    db.close()
    await db.delete()
  })

  test('legacy rows sharing timestamp+ApiTypeId get distinct sequences and replay as duplicates', async () => {
    // Unknown ApiTypeId keeps this focused on Raw Lake storage. Both rows are
    // valid legacy export records, but intentionally have no sequence field.
    const first = { timestamp: 1000, ApiTypeId: 9999, marker: 'first' }
    const second = { timestamp: 1000, ApiTypeId: 9999, marker: 'second' }
    const handlers = createImportExportHandlers(service, db, 'https://example.com/*')

    const initial = await handlers.importData([
      JSON.stringify(first),
      JSON.stringify(second),
      JSON.stringify(first)
    ].join('\n'))

    expect(initial).toMatchObject({ successCount: 2, duplicateCount: 1, totalLines: 3 })
    expect(await db.apiEvents.orderBy('[timestamp+ApiTypeId+sequence]').toArray()).toEqual([
      { ...first, sequence: 0 },
      { ...second, sequence: 1 }
    ])

    const replay = await handlers.importData([
      JSON.stringify(first),
      JSON.stringify(second)
    ].join('\n'))

    expect(replay).toMatchObject({ successCount: 0, duplicateCount: 2, totalLines: 2 })
    expect(await db.apiEvents.count()).toBe(2)
  })
})
