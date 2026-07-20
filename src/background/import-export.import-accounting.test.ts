/**
 * importData() - successCount/storedKeys accounting on the bulkAdd-fallback
 * path (independent release-audit finding #13, hardened by PR #199 review
 * finding #2)
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
 * The second describe block below covers a DIFFERENT bug on the same
 * fallback path (PR #199 review, finding #2, P2): when `bulkAdd()` is called
 * outside an explicit transaction (as here), Dexie does not abort the whole
 * batch on a per-item failure -- rows that did NOT fail are already durably
 * persisted by the time the batch-level `Dexie.BulkError` is thrown (see
 * `BulkError` in `node_modules/dexie/dist/dexie.js`: `failuresByPos` maps
 * only the FAILED item indices to their errors). The fallback used to
 * blindly retry `add()` for every row in the chunk regardless, which for an
 * already-persisted row throws its own (very real) ConstraintError against
 * the row it just legitimately wrote -- misreported as a duplicate. That
 * both undercounts `successCount` and excludes the row's key from
 * `storedKeys`, so its corresponding valid application event is dropped from
 * `allNewEvents` and its derived hands/phases/actions are never generated
 * until a later full rebuild.
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import Dexie from 'dexie'
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

describe('importData() bulkAdd-fallback: rows already persisted by a partial Dexie.BulkError', () => {
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

  test('a row bulkAdd() actually persisted before throwing BulkError is counted as success and NOT re-added', async () => {
    const lines = [
      { timestamp: 2000, ApiTypeId: 9999, seq: 'a' }, // idx 0 -- durably persisted by bulkAdd itself, despite the batch overall throwing
      { timestamp: 2001, ApiTypeId: 9999, seq: 'b' }, // idx 1 -- reported failed by bulkAdd, but the individual retry succeeds
      { timestamp: 2002, ApiTypeId: 9999, seq: 'c' }, // idx 2 -- reported failed by bulkAdd, and genuinely a duplicate on retry
    ]
    const jsonl = lines.map(line => JSON.stringify(line)).join('\n')

    const originalAdd = db.apiEvents.add.bind(db.apiEvents)

    jest.spyOn(db.apiEvents, 'bulkAdd').mockImplementation((async (items: any[]) => {
      // Simulate Dexie's actual bulkAdd() semantics (outside an explicit
      // transaction): the item at index 0 lands in the DB for real BEFORE
      // the batch-level error is thrown -- only indices 1 and 2 are reported
      // as failed via `failuresByPos`.
      await originalAdd(items[0])
      throw new Dexie.BulkError('2 of 3 operations failed', {
        1: new Error('ConstraintError (simulated)'),
        2: new Error('ConstraintError (simulated)'),
      })
    }) as unknown as typeof db.apiEvents.bulkAdd)

    const addSpy = jest.spyOn(db.apiEvents, 'add').mockImplementation((async (item: any) => {
      if (item.timestamp === 2001) return originalAdd(item)
      throw new Error('Key already exists in the object store.')
    }) as typeof db.apiEvents.add)

    const handlers = createImportExportHandlers(service, db, 'https://example.com/*')
    const result = await handlers.importData(jsonl)

    // add() must only be retried for the positions bulkAdd() actually
    // reported as failed (idx 1, idx 2) -- NOT for idx 0, which was already
    // durably persisted by the partially-failed bulkAdd() call itself.
    expect(addSpy).toHaveBeenCalledTimes(2)
    expect(addSpy.mock.calls.map(([item]: any) => item.timestamp).sort()).toEqual([2001, 2002])

    expect(result.successCount).toBe(2) // idx 0 (via the partial bulkAdd) + idx 1 (individual retry)
    expect(result.duplicateCount).toBe(1) // idx 2 only -- a genuine duplicate
    expect(result.totalLines).toBe(3)

    const storedCount = await db.apiEvents.count()
    expect(storedCount).toBe(2)
  })
})
