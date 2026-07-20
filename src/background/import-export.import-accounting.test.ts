/**
 * importData() - successCount accounting on the bulkAdd-fallback path
 * (independent release-audit finding #13)
 *
 * `importData()` bulk-stores an import chunk's raw events via
 * `db.apiEvents.bulkAdd()`. Because a single failing row aborts the whole
 * IndexedDB transaction (no rows land), a `bulkAdd()` failure falls back to
 * adding each row individually via `db.apiEvents.add()` -- this is the only
 * path exercised here, e.g. when a live event ingested concurrently with the
 * import already claimed one of the chunk's keys (a race the pre-loaded
 * `existingKeys` snapshot at import start cannot see, since it can only
 * reflect what's already in the DB *before* the import started).
 *
 * On that fallback path, `successCount` is only ever incremented when an
 * individual `add()` call actually succeeds. Before this fix, the `catch`
 * branch for a duplicate-key failure ALSO decremented `successCount` --
 * except a row that failed `add()` never incremented it in the first place
 * (increment and decrement are on opposite branches of the same try/catch).
 * With enough duplicate-key failures on this fallback path, `successCount`
 * could go negative and be reported to the user as such.
 *
 * This test forces the fallback path (bulkAdd rejects) and simulates two of
 * three rows failing as duplicates at the individual-add layer -- asserting
 * the reported successCount reflects only the one row that actually
 * persisted (never negative, never below zero).
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { createImportExportHandlers } from './import-export'
import { setOperationState } from './operation-state'

describe('importData() bulkAdd-fallback successCount accounting', () => {
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

  test('duplicate-heavy fallback imports never report a negative successCount', async () => {
    // Unknown ApiTypeId: stored as raw Lake rows (numeric timestamp+ApiTypeId
    // is the only storage requirement -- see docs/architecture.md "Raw Event
    // Lake"), but not a known application event, so this stays entirely on
    // the raw-storage accounting path under test and never touches
    // EntityConverter/entity-generation semantics (out of scope here).
    const lines = [
      { timestamp: 1000, ApiTypeId: 9999, seq: 1 },
      { timestamp: 1001, ApiTypeId: 9999, seq: 2 },
      { timestamp: 1002, ApiTypeId: 9999, seq: 3 },
    ]
    const jsonl = lines.map(line => JSON.stringify(line)).join('\n')

    // Force the whole chunk onto the individual-add fallback path (simulates
    // e.g. a quota error, or any other reason bulkAdd() aborts the batch).
    jest.spyOn(db.apiEvents, 'bulkAdd').mockRejectedValue(new Error('forced bulkAdd failure for test'))

    // Simulate the fallback's per-row add(): the first row genuinely
    // persists: the other two fail as duplicates -- e.g. a live event
    // ingested concurrently with this import already claimed that
    // [timestamp+ApiTypeId] key after the import's existingKeys snapshot was
    // taken, which is exactly the race description in the audit finding.
    const originalAdd = db.apiEvents.add.bind(db.apiEvents)
    let addCallCount = 0
    jest.spyOn(db.apiEvents, 'add').mockImplementation((async (item: unknown) => {
      addCallCount++
      if (addCallCount === 1) return originalAdd(item as never)
      throw new Error('Key already exists in the object store.')
    }) as typeof db.apiEvents.add)

    const handlers = createImportExportHandlers(service, db, 'https://example.com/*')
    const result = await handlers.importData(jsonl)

    expect(addCallCount).toBe(3)
    // Exactly one row actually persisted -- successCount must reflect that,
    // and must never dip below zero regardless of how many of the OTHER
    // rows failed as duplicates on the fallback path.
    expect(result.successCount).toBe(1)
    expect(result.successCount).toBeGreaterThanOrEqual(0)
    expect(result.duplicateCount).toBe(2)
    expect(result.totalLines).toBe(3)

    // Cross-check against the DB itself: exactly one row should be stored.
    const storedCount = await db.apiEvents.count()
    expect(storedCount).toBe(1)
  })
})
