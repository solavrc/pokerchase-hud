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
import {
  SYNC_RESCAN_BACKFILL_DONE_META_KEY,
  SYNC_RESCAN_FLOOR_META_KEY
} from '../constants/sync'

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

  test('stores an imported application row atomically with every reconciled account watermark floor', async () => {
    const imported = {
      timestamp: 100,
      ApiTypeId: 201,
      Code: 0,
      BattleType: 0,
      Id: 'imported-stage',
      IsRetire: false
    }
    await db.meta.bulkPut([
      { id: `${SYNC_RESCAN_BACKFILL_DONE_META_KEY}:user-a`, value: true, updatedAt: 1 },
      { id: `${SYNC_RESCAN_BACKFILL_DONE_META_KEY}:user-b`, value: true, updatedAt: 1 },
      { id: `${SYNC_RESCAN_FLOOR_META_KEY}:user-b`, value: 50, updatedAt: 1 }
    ])
    const handlers = createImportExportHandlers(service, db, 'https://example.com/*')

    const realPut = db.meta.put.bind(db.meta)
    const putSpy = jest.spyOn(db.meta, 'put').mockImplementation((record: any) => {
      if (record.id === `${SYNC_RESCAN_FLOOR_META_KEY}:user-a`) {
        return Promise.reject(new Error('synthetic floor persistence failure')) as any
      }
      return realPut(record) as any
    })

    await expect(handlers.importData(JSON.stringify(imported)))
      .rejects.toThrow('synthetic floor persistence failure')
    expect(await db.apiEvents.count()).toBe(0)

    putSpy.mockRestore()
    await expect(handlers.importData(JSON.stringify(imported))).resolves.toMatchObject({ successCount: 1 })
    expect((await db.meta.get(`${SYNC_RESCAN_FLOOR_META_KEY}:user-a`))?.value).toBe(100)
    // Never raise an already-earlier protection floor.
    expect((await db.meta.get(`${SYNC_RESCAN_FLOOR_META_KEY}:user-b`))?.value).toBe(50)
  })
})
