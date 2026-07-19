/**
 * Unit tests for undecoded-event-tracker.ts (drop visibility, postmortem
 * docs/postmortems/2026-07-session-results-drop.md 再発防止#2)
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { PokerChaseDB } from '../db/poker-chase-db'
import { ApiType } from '../types'
import {
  classifyUndecodedApiTypeId,
  getUndecodedEventStats,
  recordUndecodedEvent,
  resetUndecodedEventStats,
  UNDECODED_EVENT_STATS_KEY
} from './undecoded-event-tracker'

// Debounce window in undecoded-event-tracker.ts is 500ms. fake-indexeddb relies
// on real macrotask scheduling (Immediate/setTimeout) to surface its own
// events, which conflicts with Jest's fake timers (see event-ingestion.test.ts
// for the same real-timer convention) -- so these tests wait out the real
// debounce window instead of faking it.
const FLUSH_WAIT_MS = 550
const flush = () => new Promise(resolve => setTimeout(resolve, FLUSH_WAIT_MS))

describe('undecoded-event-tracker', () => {
  let db: PokerChaseDB

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    // Start each test from a clean slate regardless of module-level cache
    // left over from a previous test's in-flight debounce.
    await resetUndecodedEventStats(db)
  })

  afterEach(async () => {
    db.close()
    await db.delete()
  })

  describe('classifyUndecodedApiTypeId', () => {
    it('classifies a known application ApiTypeId as appTypeParseFailed', () => {
      expect(classifyUndecodedApiTypeId(ApiType.EVT_SESSION_RESULTS)).toBe('appTypeParseFailed')
      expect(classifyUndecodedApiTypeId(ApiType.EVT_DEAL)).toBe('appTypeParseFailed')
    })

    it('classifies an ApiTypeId outside the ApiType enum as unknownApiType', () => {
      expect(classifyUndecodedApiTypeId(9999)).toBe('unknownApiType')
      // 202/205 are known non-application types but are NOT in the ApiType enum
      // (application types only) -- if they ever reached this classifier (they
      // shouldn't, since parseApiEvent succeeds for them), they'd read as
      // unknownApiType rather than the dangerous appTypeParseFailed class.
      expect(classifyUndecodedApiTypeId(202)).toBe('unknownApiType')
    })
  })

  describe('recordUndecodedEvent / getUndecodedEventStats', () => {
    it('accumulates per-ApiTypeId counts and lastSeen, debounced to a single write', async () => {
      await recordUndecodedEvent(db, ApiType.EVT_SESSION_RESULTS, 1000)
      await recordUndecodedEvent(db, ApiType.EVT_SESSION_RESULTS, 2000)
      await recordUndecodedEvent(db, 9999, 1500)

      // Before the debounce elapses, meta table should still reflect the
      // empty baseline written by the beforeEach's resetUndecodedEventStats
      // call, not these three in-flight (unflushed) records.
      expect((await db.meta.get(UNDECODED_EVENT_STATS_KEY))?.value).toEqual({ total: 0, perApiTypeId: {} })

      const stats = await getUndecodedEventStats(db)
      expect(stats.total).toBe(3)
      expect(stats.perApiTypeId[ApiType.EVT_SESSION_RESULTS]).toEqual({ count: 2, lastSeen: 2000 })
      expect(stats.perApiTypeId[9999]).toEqual({ count: 1, lastSeen: 1500 })

      // Flush the debounce timer
      await flush()

      const persisted = await db.meta.get(UNDECODED_EVENT_STATS_KEY)
      expect(persisted?.value).toEqual(stats)
    })

    it('coalesces bursts within the debounce window into one meta.put', async () => {
      const putSpy = jest.spyOn(db.meta, 'put')

      for (let i = 0; i < 5; i++) {
        await recordUndecodedEvent(db, ApiType.EVT_DEAL, 100 + i)
      }

      await flush()

      expect(putSpy).toHaveBeenCalledTimes(1)
      const stats = await getUndecodedEventStats(db)
      expect(stats.perApiTypeId[ApiType.EVT_DEAL]).toEqual({ count: 5, lastSeen: 104 })
    })
  })

  describe('resetUndecodedEventStats', () => {
    it('clears counters both in-memory and in the meta table', async () => {
      await recordUndecodedEvent(db, ApiType.EVT_SESSION_RESULTS, 1000)
      await flush()
      expect((await getUndecodedEventStats(db)).total).toBe(1)

      await resetUndecodedEventStats(db)

      expect(await getUndecodedEventStats(db)).toEqual({ total: 0, perApiTypeId: {} })
      expect((await db.meta.get(UNDECODED_EVENT_STATS_KEY))?.value).toEqual({ total: 0, perApiTypeId: {} })
    })

    it('cancels a pending debounced flush so it does not resurrect old counts', async () => {
      await recordUndecodedEvent(db, ApiType.EVT_SESSION_RESULTS, 1000)
      await resetUndecodedEventStats(db)

      // If the earlier flush timer were still pending, this would overwrite
      // the reset with the pre-reset stats.
      await flush()

      expect((await db.meta.get(UNDECODED_EVENT_STATS_KEY))?.value).toEqual({ total: 0, perApiTypeId: {} })
    })
  })
})
