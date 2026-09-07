import { webcrypto } from 'crypto'
import { TextEncoder } from 'util'
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { PokerChaseDB } from '../db/poker-chase-db'
import { mergeApiEvents } from '../utils/api-event-key'
import { isApplicationApiEvent, type ApiEvent } from '../types'
import { setOperationState } from '../background/operation-state'
import { PRIVATE_MTT_LIFECYCLE_FIXTURE } from '../test-fixtures/private-mtt-lifecycle'
import { StatsLedger } from '../stats/stat-ledger'
import { AutoSyncService } from './auto-sync-service'
import {
  FirestoreBackupService,
  getFirestoreContentDocumentId,
  getFirestoreEventDocumentId,
} from './firestore-backup-service'
import { firebaseAuthService } from './firebase-auth-service'
import * as minVersionGate from './min-version-gate'

const root = 'projects/pokerchase-hud/databases/(default)/documents/users/collision-test/apiEvents/'
type TestDocument = { name: string, fields: Record<string, any> }
type TestWrite = { update: TestDocument, currentDocument?: { exists?: boolean } }

const encode = (value: any): any => {
  if (value === null) return { nullValue: null }
  if (typeof value === 'number') return { integerValue: String(value) }
  if (typeof value === 'boolean') return { booleanValue: value }
  if (typeof value === 'string') return { stringValue: value }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } }
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)])) } }
}

const decode = (value: any): any => {
  if ('integerValue' in value) return Number(value.integerValue)
  if ('stringValue' in value) return value.stringValue
  if ('booleanValue' in value) return value.booleanValue
  if ('nullValue' in value) return null
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(decode)
  return Object.fromEntries(Object.entries(value.mapValue.fields ?? {}).map(([key, item]) => [key, decode(item)]))
}

const response = (body: unknown, status = 200): Response => ({
  ok: status < 400, status, text: async () => JSON.stringify(body),
} as Response)

/** transportだけを置き換え、順不同batchGet・条件付きatomic commitを再現する。 */
class MemoryFirestore {
  readonly documents = new Map<string, TestDocument>()
  readonly commits: TestWrite[][] = []
  onRead?: () => Promise<void> | void
  beforeCommit?: (writes: TestWrite[]) => Response | undefined
  afterCommit?: () => void
  truncateRead = false

  seed(event: ApiEvent, id = getFirestoreEventDocumentId(event)): void {
    const name = `${root}${id}`
    this.documents.set(name, { name, fields: encode(event).mapValue.fields })
  }

  events(): ApiEvent[] {
    return [...this.documents.values()].map(document => decode({ mapValue: { fields: document.fields } }))
  }

  fetch = jest.fn(async (url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body))
    if (url.endsWith(':batchGet')) {
      const result = (body.documents as string[]).map(name => {
        const found = this.documents.get(name)
        return found ? { found: structuredClone(found) } : { missing: name }
      }).reverse()
      await this.onRead?.()
      return response(this.truncateRead ? result.slice(1) : result)
    }
    if (url.endsWith(':commit')) {
      const writes: TestWrite[] = body.writes
      this.commits.push(writes)
      const failure = this.beforeCommit?.(writes)
      if (failure) return failure
      if (writes.some(write => write.currentDocument?.exists === false && this.documents.has(write.update.name))) {
        return response({ error: { status: 'ALREADY_EXISTS' } }, 409)
      }
      for (const write of writes) this.documents.set(write.update.name, write.update)
      this.afterCommit?.()
      return response({ writeResults: writes.map(() => ({})) })
    }
    if (url.endsWith(':runAggregationQuery')) {
      return response([{ result: { aggregateFields: { eventCount: { integerValue: String(this.documents.size) } } } }])
    }
    if (url.endsWith(':runQuery')) {
      const query = body.structuredQuery
      let documents = [...this.documents.values()].sort((a, b) =>
        Number(a.fields.timestamp.integerValue) - Number(b.fields.timestamp.integerValue) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      )
      if (query.orderBy[0].direction === 'DESCENDING') documents.reverse()
      if (query.startAt) {
        const timestamp = Number(query.startAt.values[0].integerValue)
        const name = query.startAt.values[1].referenceValue
        documents = documents.filter(document => Number(document.fields.timestamp.integerValue) > timestamp ||
          (Number(document.fields.timestamp.integerValue) === timestamp && document.name > name))
      }
      return response(documents.slice(0, query.limit ?? documents.length).map(document => ({ document })))
    }
    if (init.method === 'PATCH') return response({})
    throw new Error('Unexpected REST operation in collision test')
  })
}

const action = (timestamp: number, seatIndex: number, sequence?: number): ApiEvent & { timestamp: number } => ({
  timestamp, ApiTypeId: 304, ActionType: 0, BetChip: 0, Chip: 1000, SeatIndex: seatIndex,
  Progress: {
    MinRaise: 100, NextActionSeat: seatIndex + 1, NextActionTypes: [0, 1, 2],
    NextExtraLimitSeconds: 0, Phase: 1, Pot: 200, SidePot: [],
  },
  ...(sequence === undefined ? {} : { sequence }),
} as ApiEvent & { timestamp: number })

describe('Firestore event content preservation', () => {
  const originalFetch = global.fetch
  let cloud: MemoryFirestore
  let db: PokerChaseDB

  beforeAll(() => {
    Object.assign(global, { TextEncoder })
    Object.defineProperty(crypto, 'subtle', { value: webcrypto.subtle, configurable: true })
  })

  beforeEach(async () => {
    cloud = new MemoryFirestore()
    global.fetch = cloud.fetch as unknown as typeof fetch
    ;(chrome.runtime.sendMessage as jest.Mock).mockResolvedValue(undefined)
    jest.spyOn(firebaseAuthService, 'ready').mockResolvedValue()
    jest.spyOn(firebaseAuthService, 'getCurrentUser').mockReturnValue({ uid: 'collision-test' } as any)
    jest.spyOn(firebaseAuthService, 'getIdToken').mockResolvedValue('test-token')
    jest.spyOn(minVersionGate, 'isCloudSyncBlockedByMinVersionGate').mockResolvedValue(false)
    setOperationState({ type: 'idle' })
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
  })

  afterEach(async () => {
    db.close()
    await db.delete()
    setOperationState({ type: 'idle' })
    jest.restoreAllMocks()
    global.fetch = originalFetch
  })

  test.each(['upload', 'both'] as const)('%s preserves a cloud row when a legacy partial import allocates its sequence', async direction => {
    const earlier = action(100, 0, 0)
    const imported = action(100, 1)
    expect(isApplicationApiEvent(earlier)).toBe(true)
    expect(isApplicationApiEvent(imported)).toBe(true)
    cloud.seed(earlier)
    const originalDocument = structuredClone(cloud.documents.get(`${root}100_304`))
    const merge = await mergeApiEvents(db, [imported], { protectAddedApplicationEventsFromCloudWatermark: true })
    expect(merge.added[0]?.sequence).toBe(0)

    const sync = new AutoSyncService(db)
    await expect(sync.performSync(direction)).resolves.toEqual({ success: true })
    expect(cloud.documents.get(`${root}100_304`)).toEqual(originalDocument)
    expect(cloud.events().map((event: any) => event.SeatIndex).sort()).toEqual([0, 1])

    // downloadは旧Aをローカルで再採番する。旧IDを逆引きしないため、最初の
    // 再uploadでAの内容IDが1件増えるが、その後は増殖しない。
    await expect(sync.performSync('download')).resolves.toEqual({ success: true })
    expect((await db.apiEvents.toArray()).map((event: any) => event.SeatIndex).sort()).toEqual([0, 1])
    await expect(sync.performSync('upload')).resolves.toEqual({ success: true })
    expect(cloud.documents.size).toBe(3)
    for (let repeat = 0; repeat < 2; repeat++) {
      await expect(sync.performSync('both')).resolves.toEqual({ success: true })
      expect(cloud.documents.size).toBe(3)
      expect(await db.apiEvents.count()).toBe(2)
    }
  })

  test('unchanged legacy and sequence-suffix documents are acknowledged without rewriting them', async () => {
    const events = [action(100, 0), action(100, 1, 1)]
    for (const event of events) cloud.seed(event)
    const initial = structuredClone([...cloud.documents])
    await expect(new FirestoreBackupService().syncToCloudBatch(events, null)).resolves.toMatchObject({ syncedEvents: 2 })
    expect([...cloud.documents]).toEqual(initial)
    expect(cloud.commits).toHaveLength(0)
  })

  test('content IDs ignore property order and locally reassigned sequences', async () => {
    const event = action(100, 0, 0)
    const reordered = Object.fromEntries(Object.entries({ ...event, sequence: 7 }).reverse()) as ApiEvent
    const uploader = new FirestoreBackupService()
    await uploader.syncToCloudBatch([event], null)
    await uploader.syncToCloudBatch([reordered], null)
    expect(cloud.documents.size).toBe(1)
    expect(cloud.commits).toHaveLength(1)
    expect(await getFirestoreContentDocumentId(event)).toBe(await getFirestoreContentDocumentId(reordered))
  })

  test('a legacy/content duplicate is deduplicated in the Lake and leaves hand statistics unchanged', async () => {
    const events = PRIVATE_MTT_LIFECYCLE_FIXTURE.events.slice(0, 4)
    for (const event of events) cloud.seed(event)
    const sync = new AutoSyncService(db)
    await expect(sync.performSync('download')).resolves.toEqual({ success: true })
    const ledger = new StatsLedger(db)
    const baseline = await ledger.readPlayerSnapshot(PRIVATE_MTT_LIFECYCLE_FIXTURE.heroId)
    expect(baseline.totalHands).toBe(1)

    const deal = events.find(event => event.ApiTypeId === 303)!
    const uploader = new FirestoreBackupService()
    await uploader.syncToCloudBatch([{ ...deal, sequence: 7 }], null)
    expect(cloud.documents.size).toBe(events.length + 1)
    for (const sequence of [8, 9]) {
      await uploader.syncToCloudBatch([{ ...deal, sequence }], null)
      await expect(sync.performSync('download')).resolves.toEqual({ success: true })
      expect(cloud.documents.size).toBe(events.length + 1)
      expect(await db.apiEvents.count()).toBe(events.length)
      expect(await db.hands.count()).toBe(1)
      const restored = await ledger.readPlayerSnapshot(PRIVATE_MTT_LIFECYCLE_FIXTURE.heroId)
      expect(restored.totalHands).toBe(baseline.totalHands)
      expect(restored.counters).toEqual(baseline.counters)
    }
  })

  test.each([false, true])('concurrent clients preserve content with a shared local sequence; same content=%s', async same => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let reads = 0
    cloud.onRead = async () => {
      if (++reads === 2) release()
      if (reads <= 2) await gate
    }
    const a = action(100, 0, 0)
    const b = action(100, same ? 0 : 1, same ? 9 : 0)
    await Promise.all([
      new FirestoreBackupService().syncToCloudBatch([a], null),
      new FirestoreBackupService().syncToCloudBatch([b], null),
    ])
    expect(cloud.documents.size).toBe(same ? 1 : 2)
    expect(cloud.commits.flat().every(write => write.currentDocument?.exists === false)).toBe(true)
  })

  test('an acknowledged-lost commit is confirmed by content after its conditional retry conflicts', async () => {
    let lostResponse = false
    cloud.afterCommit = () => {
      if (!lostResponse) {
        lostResponse = true
        throw new TypeError('Network response lost after durable commit')
      }
    }
    const events = [action(100, 0, 0), action(100, 1, 1)]
    const uploader = new FirestoreBackupService({ retryBaseDelayMs: 1 })
    await expect(uploader.syncToCloudBatch(events, null)).resolves.toMatchObject({ syncedEvents: 2 })
    expect(cloud.documents.size).toBe(2)
    expect(cloud.commits).toHaveLength(2)
  })

  test('an atomic batch conflict retries only the entries another client has not created', async () => {
    cloud.beforeCommit = writes => {
      if (cloud.commits.length === 1) cloud.documents.set(writes[0]!.update.name, writes[0]!.update)
      return undefined
    }
    await new FirestoreBackupService().syncToCloudBatch([action(100, 0), action(100, 1)], null)
    expect(cloud.commits.map(writes => writes.length)).toEqual([2, 1])
    expect(cloud.documents.size).toBe(2)
  })

  test('repeated document conflicts exhaust a bounded budget without reporting success', async () => {
    cloud.beforeCommit = () => response({ error: { status: 'ALREADY_EXISTS' } }, 409)
    await expect(new FirestoreBackupService().syncToCloudBatch([action(100, 0)], null)).rejects.toThrow('409')
    expect(cloud.commits).toHaveLength(3)
    expect(cloud.documents.size).toBe(0)
  })

  test('a durable final create with a lost response is confirmed after two earlier conflicts', async () => {
    cloud.beforeCommit = () => cloud.commits.length <= 2
      ? response({ error: { status: 'ALREADY_EXISTS' } }, 409)
      : undefined
    cloud.afterCommit = () => { throw new TypeError('Network response lost after final durable commit') }
    const uploader = new FirestoreBackupService({ retryBaseDelayMs: 1 })
    await expect(uploader.syncToCloudBatch([action(100, 0)], null)).resolves.toMatchObject({ syncedEvents: 1 })
    // 3 create試行 + 応答喪失に対する既存transportの1 retry。最後の409を再照合する。
    expect(cloud.commits).toHaveLength(4)
    expect(cloud.documents.size).toBe(1)
  })

  test('a failed later batch leaves the cloud prefix recoverable by a watermark retry', async () => {
    const uploader = new FirestoreBackupService({ maxTransientRetries: 0 })
    const events = Array.from({ length: 301 }, (_, index) => action(index + 1, 0, 0))
    cloud.beforeCommit = () => cloud.commits.length === 2
      ? response({ error: { status: 'UNAVAILABLE' } }, 503)
      : undefined
    await expect(uploader.syncToCloudBatch(events, null)).rejects.toThrow('503')
    expect(cloud.documents.size).toBe(300)
    const watermark = await uploader.getCloudMaxTimestamp()
    expect(watermark).toBe(300)
    cloud.beforeCommit = undefined
    await uploader.syncToCloudBatch(events, watermark)
    expect(cloud.documents.size).toBe(301)
    expect(await uploader.getCloudMaxTimestamp()).toBe(301)
  })

  test('an incomplete content lookup fails before any write or sync-success bookkeeping', async () => {
    cloud.truncateRead = true
    await mergeApiEvents(db, [action(100, 0, 0)])
    await expect(new AutoSyncService(db).performSync('upload')).resolves.toMatchObject({ success: false })
    expect(cloud.commits).toHaveLength(0)
    expect(await chrome.storage.local.get('autoSyncLastTime:collision-test')).toEqual({ 'autoSyncLastTime:collision-test': undefined })
  })

  test('a different payload already stored at the content ID is never overwritten', async () => {
    const incoming = action(100, 0, 0)
    cloud.seed(action(100, 1, 0), await getFirestoreContentDocumentId(incoming))
    await expect(new FirestoreBackupService().syncToCloudBatch([incoming], null)).rejects.toThrow('content identity collision')
    expect(cloud.commits).toHaveLength(0)
    expect((cloud.events()[0] as any).SeatIndex).toBe(1)
  })

  test('an account change during content lookup aborts before event creation', async () => {
    let generation = 1
    jest.spyOn(firebaseAuthService, 'getAuthGeneration').mockImplementation(() => generation)
    cloud.onRead = () => { generation++ }
    await expect(new FirestoreBackupService().syncToCloudBatch([action(100, 0)], null)).rejects.toThrow('account changed')
    expect(cloud.commits).toHaveLength(0)
  })

  test('an account change during a successful create does not report sync success', async () => {
    let generation = 1
    jest.spyOn(firebaseAuthService, 'getAuthGeneration').mockImplementation(() => generation)
    cloud.afterCommit = () => { generation++ }
    await expect(new FirestoreBackupService().syncToCloudBatch([action(100, 0)], null)).rejects.toThrow('account changed')
    expect(cloud.documents.size).toBe(1)
    expect(cloud.fetch.mock.calls.some(([, init]) => init.method === 'PATCH')).toBe(false)
  })
})
