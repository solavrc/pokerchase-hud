/**
 * AutoSyncService - session start/end sync trigger tests
 *
 * postmortem docs/postmortems/2026-07-session-results-drop.md 再発防止#3:
 * EVT_SESSION_RESULTS (309) was a single point of failure for auto-sync --
 * when PokerChase's season-3 payload change broke its schema, sync silently
 * stopped firing for ~2 months. onNewSessionStart() is a fallback trigger
 * fired on EVT_ENTRY_QUEUED (201) / EVT_SESSION_DETAILS (308, session start)
 * that reuses the same 100+-event backlog threshold as onGameSessionEnd(),
 * so a broken 309 now costs at most one session's lag instead of silence
 * forever.
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { PokerChaseDB } from '../db/poker-chase-db'
import { ApiType, BattleType } from '../types'
import type { ApiEvent } from '../types'
import { AutoSyncService } from './auto-sync-service'
import { firebaseAuthService } from './firebase-auth-service'

const mockUser = { uid: 'test-user', email: 'test@example.com' } as any

const makeEvent = (timestamp: number): ApiEvent => ({
  ApiTypeId: ApiType.EVT_ENTRY_QUEUED,
  Code: 0,
  BattleType: BattleType.SIT_AND_GO,
  Id: `stage-${timestamp}`,
  IsRetire: false,
  timestamp
} as ApiEvent)

describe('AutoSyncService session start/end sync triggers', () => {
  let db: PokerChaseDB

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    jest.spyOn(firebaseAuthService, 'getCurrentUser').mockReturnValue(mockUser)
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    db.close()
    await db.delete()
  })

  test('onNewSessionStart triggers an upload sync when the backlog exceeds the threshold', async () => {
    const events = Array.from({ length: 120 }, (_, i) => makeEvent(i + 1))
    await db.apiEvents.bulkAdd(events)

    const service = new AutoSyncService(db)
    const performSyncSpy = jest.spyOn(service, 'performSync').mockResolvedValue(undefined)

    await service.onNewSessionStart()

    expect(performSyncSpy).toHaveBeenCalledWith('upload')
  })

  test('onNewSessionStart does not sync when the backlog is below the threshold', async () => {
    const events = Array.from({ length: 10 }, (_, i) => makeEvent(i + 1))
    await db.apiEvents.bulkAdd(events)

    const service = new AutoSyncService(db)
    const performSyncSpy = jest.spyOn(service, 'performSync').mockResolvedValue(undefined)

    await service.onNewSessionStart()

    expect(performSyncSpy).not.toHaveBeenCalled()
  })

  test('onGameSessionEnd (309) still triggers an upload sync when the backlog exceeds the threshold (unchanged behavior)', async () => {
    const events = Array.from({ length: 120 }, (_, i) => makeEvent(i + 1))
    await db.apiEvents.bulkAdd(events)

    const service = new AutoSyncService(db)
    const performSyncSpy = jest.spyOn(service, 'performSync').mockResolvedValue(undefined)

    await service.onGameSessionEnd()

    expect(performSyncSpy).toHaveBeenCalledWith('upload')
  })

  test('onNewSessionStart does not double-fire when a sync is already in-flight (in-flight guard)', async () => {
    const events = Array.from({ length: 120 }, (_, i) => makeEvent(i + 1))
    await db.apiEvents.bulkAdd(events)

    const service = new AutoSyncService(db)
    const performSyncSpy = jest.spyOn(service, 'performSync').mockResolvedValue(undefined)

    // Simulate a sync already in progress (e.g. 309's onGameSessionEnd fired
    // just before this session-start event arrived)
    ;(service as any).isSyncing = true

    await service.onNewSessionStart()

    expect(performSyncSpy).not.toHaveBeenCalled()
  })

  test('onNewSessionStart does not re-sync backlog a normal 309-triggered sync already cleared (no double-fire)', async () => {
    const events = Array.from({ length: 120 }, (_, i) => makeEvent(i + 1))
    await db.apiEvents.bulkAdd(events)

    const service = new AutoSyncService(db)
    const performSyncSpy = jest.spyOn(service, 'performSync').mockImplementation(async () => {
      // performSync('upload') succeeding advances lastSyncTime past the
      // backlog it just cleared -- mirror that here without exercising the
      // full Firestore path.
      ;(service as any).syncState.lastSyncTime = new Date(events[events.length - 1]!.timestamp!)
    })

    // 309 fires first (session end) and clears the backlog
    await service.onGameSessionEnd()
    expect(performSyncSpy).toHaveBeenCalledTimes(1)

    // 201/308 for the next session arrives right after -- backlog is now
    // empty relative to the just-updated lastSyncTime, so no second sync
    await service.onNewSessionStart()
    expect(performSyncSpy).toHaveBeenCalledTimes(1)
  })

  test('neither trigger syncs when the user is not authenticated', async () => {
    jest.spyOn(firebaseAuthService, 'getCurrentUser').mockReturnValue(null)
    const events = Array.from({ length: 120 }, (_, i) => makeEvent(i + 1))
    await db.apiEvents.bulkAdd(events)

    const service = new AutoSyncService(db)
    const performSyncSpy = jest.spyOn(service, 'performSync').mockResolvedValue(undefined)

    await service.onNewSessionStart()
    await service.onGameSessionEnd()

    expect(performSyncSpy).not.toHaveBeenCalled()
  })
})
