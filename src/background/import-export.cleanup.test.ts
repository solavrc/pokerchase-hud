import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { createImportExportHandlers } from './import-export'
import { getOperationState, setOperationState } from './operation-state'
import { mergeApiEvents, type RawApiEvent } from '../utils/api-event-key'
import { withRawEventSessionContext } from '../utils/raw-event-session-context'
import { MTT_TABLE_MOVE_FIXTURE } from '../test-fixtures/mtt-table-move-lifecycle'
import { BattleType } from '../types'

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

  test('keeps import successful when no popup receives best-effort progress', async () => {
    ;(chrome.runtime.sendMessage as jest.Mock).mockRejectedValue(
      new Error('Could not establish connection. Receiving end does not exist.')
    )
    const handlers = createImportExportHandlers(service, db, 'https://example.com/*')

    await expect(handlers.importData(JSON.stringify({
      timestamp: 1_000,
      ApiTypeId: 9_999,
      marker: 'raw-only'
    }))).resolves.toMatchObject({ successCount: 1, totalLines: 1 })

    // Flush the rejection handler. Without `.catch()`, Jest observes the
    // same unhandled Promise rejection printed by the Service Worker.
    await Promise.resolve()
    expect(getOperationState()).toEqual({ type: 'idle' })
  })

  test('context enrichment counts as a dirty import and rebuilds stale hand attribution', async () => {
    ;(chrome.runtime.sendMessage as jest.Mock).mockResolvedValue(undefined)
    const rawEvents = MTT_TABLE_MOVE_FIXTURE.events
      .slice(3, 6)
      .map(event => structuredClone(event))
    await mergeApiEvents(db, rawEvents as unknown as RawApiEvent[])
    const context = {
      scopeKey: 'run:4:shared-room:1000',
      id: 'shared-room',
      battleType: BattleType.RING_GAME,
      startedAt: 1000,
    }
    const handlers = createImportExportHandlers(service, db, 'https://example.com/*')

    const result = await handlers.importData(
      rawEvents
        .map(event => JSON.stringify(withRawEventSessionContext(event, context)))
        .join('\n')
    )
    await service.statsOutputStream.whenIdle()

    expect(result.successCount).toBe(rawEvents.length)
    const rebuiltHand = await db.hands.get(MTT_TABLE_MOVE_FIXTURE.handIds.oldAccepted)
    expect(rebuiltHand?.session).toMatchObject({
      scopeKey: context.scopeKey,
      id: context.id,
      battleType: context.battleType,
    })
  })
})
