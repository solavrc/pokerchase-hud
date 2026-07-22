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
import { EntityConverter } from '../entity-converter'
import { ApiType } from '../types'
import type { ApiEvent } from '../types'
import { HandLogExporter } from '../utils/hand-log-exporter'

const rank = {
  RankId: 'rank-id',
  RankName: '',
  RankLvId: 'rank-lv-id',
  RankLvName: ''
}

const tableUser = (userId: number, userName: string) => ({
  UserId: userId,
  UserName: userName,
  FavoriteCharaId: '',
  CostumeId: '',
  EmblemId: '',
  IsCpu: false,
  IsOfficial: false,
  SettingDecoIds: ['', '', '', '', '', '', ''],
  Rank: rank
})

const olderNameEventCases: Array<[string, ApiEvent, number]> = [
  ['EVT_PLAYER_SEAT_ASSIGNED (313)', {
    ApiTypeId: ApiType.EVT_PLAYER_SEAT_ASSIGNED,
    timestamp: 100,
    IsLeave: false,
    IsRetire: false,
    ProcessType: 0,
    SeatUserIds: [1001, 1002, 1003, 1004],
    TableUsers: [
      tableUser(1001, 'backfilled-seat-name'),
      tableUser(1002, 'seat-2'),
      tableUser(1003, 'seat-3'),
      tableUser(1004, 'seat-4')
    ]
  } as ApiEvent, 1001],
  ['EVT_PLAYER_JOIN (301)', {
    ApiTypeId: ApiType.EVT_PLAYER_JOIN,
    timestamp: 100,
    JoinUser: tableUser(2001, 'backfilled-join-name'),
    JoinPlayer: {
      BetChip: 0,
      BetStatus: 0,
      Chip: 10_000,
      SeatIndex: 0,
      Status: 0
    }
  } as ApiEvent, 2001]
]

describe('importData() legacy sequence assignment and content dedup', () => {
  let db: PokerChaseDB
  let service: PokerChaseService

  beforeEach(async () => {
    HandLogExporter.clearCache()
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = new PokerChaseService({ db })
    await service.ready
    setOperationState({ type: 'idle' })
    ;(chrome.runtime.sendMessage as jest.Mock).mockResolvedValue(undefined)
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    HandLogExporter.clearCache()
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

  test.each(olderNameEventCases)('rebuilds the hand-log name cache when import backfills an older %s', async (_label, importedEvent, expectedUserId) => {
    // Warm the incremental cache past the event that will be imported. Before
    // this regression fix, the next lookup resumed above timestamp 200 and
    // could never discover the newly inserted timestamp-100 name event.
    await db.apiEvents.put({ timestamp: 200, ApiTypeId: 9999, sequence: 0 } as unknown as ApiEvent)
    const buildPlayerNamesMap = (HandLogExporter as any).buildPlayerNamesMap.bind(HandLogExporter) as
      (targetDb: PokerChaseDB) => Promise<Map<number, { name: string, rank: string }>>
    expect(await buildPlayerNamesMap(db)).toEqual(new Map())

    const clearCache = jest.spyOn(HandLogExporter, 'clearCache')
    const handlers = createImportExportHandlers(service, db, 'https://example.com/*')
    await expect(handlers.importData(JSON.stringify(importedEvent))).resolves.toMatchObject({ successCount: 1 })

    expect(clearCache).toHaveBeenCalledTimes(1)
    const names = await buildPlayerNamesMap(db)
    expect(names.get(expectedUserId)?.name).toMatch(/^backfilled-/)

    clearCache.mockClear()
    await expect(handlers.importData(JSON.stringify(importedEvent))).resolves.toMatchObject({ successCount: 0 })
    expect(clearCache).not.toHaveBeenCalled()
  })

  test('does not clear the hand-log name cache when a post-import rebuild fails', async () => {
    await db.apiEvents.put({ timestamp: 200, ApiTypeId: 9999, sequence: 0 } as unknown as ApiEvent)
    const clearCache = jest.spyOn(HandLogExporter, 'clearCache')
    jest.spyOn(EntityConverter.prototype, 'convertEventChunk').mockImplementation(() => {
      throw new Error('synthetic rebuild failure')
    })
    const handlers = createImportExportHandlers(service, db, 'https://example.com/*')

    await expect(handlers.importData(JSON.stringify(olderNameEventCases[0]![1])))
      .rejects.toThrow('synthetic rebuild failure')
    expect(clearCache).not.toHaveBeenCalled()
  })
})
